#!/bin/zsh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
HEALTHCHECK_CLI="$DIR/scripts/lib/healthcheck-cli.js"

# --check / --live: esegue anche la sonda LIVE dell'autologin (apre un browser
# headless, ~30s). Senza il flag, la sonda parte da sola solo quando lo stato
# salvato segnala problemi di autologin (per smentire/confermare un falso allarme).
LIVE_CHECK=false
for arg in "$@"; do
  case "$arg" in
    --check|--live) LIVE_CHECK=true ;;
  esac
done

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok() { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err() { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }
info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }

echo ""
echo "============================================"
echo -e "${BOLD}  Stato GSD Campus Autoplay${NC}"
echo "============================================"
echo ""

PID_FILE=".autoplay_pid"

# ── Stato scheduler ──
info "Processo scheduler"
SCHED_ACTIVE=false
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    SCHED_ACTIVE=true
    # Calcola durata attività dal tempo trascorso (etime), più robusto di lstart.
    # Niente `local` (siamo a top-level, non in una funzione: anti-pattern che in
    # bash rompe; in zsh crea variabili di scope script, ma le evitiamo per
    # portabilità coerente con il resto del file).
    etime=""
    etime=$(ps -o etime= -p "$PID" 2>/dev/null | tr -d ' ' || echo "")
    if [ -n "$etime" ]; then
      uptime_min=""
      uptime_min=$(node -e "
        const t = '$etime';
        const m = t.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
        if (!m) { console.log(''); process.exit(0); }
        let sec = 0;
        if (m[1]) sec += parseInt(m[1],10) * 86400;
        if (m[2]) sec += parseInt(m[2],10) * 3600;
        sec += parseInt(m[3],10) * 60;
        sec += parseInt(m[4],10);
        console.log(Math.floor(sec / 60));
      " 2>/dev/null)
      if [ -n "$uptime_min" ]; then
        ok "Scheduler attivo: PID $PID (attivo da ${uptime_min} min)"
      else
        ok "Scheduler attivo: PID $PID"
      fi
    else
      ok "Scheduler attivo: PID $PID"
    fi
  else
    warn "Scheduler NON attivo (PID file presente: $PID) — pulisco."
    rm -f "$PID_FILE"
  fi
else
  warn "Nessun scheduler in esecuzione."
fi

# ── Orario lavorativo ──
echo ""
info "Orario lavorativo"
if [ -f "$DIR/config.json" ]; then
  SCHED_DESC=$(node "$SCHEDULE_CLI" describe 2>/dev/null || echo "non disponibile")
  info "Configurazione: $SCHED_DESC"
  if node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -q '^yes$'; then
    ok "Adesso è ORARIO LAVORATIVO."
    NEXT_END=$(node "$SCHEDULE_CLI" next-end 2>/dev/null || echo "")
    [ -n "$NEXT_END" ] && info "Fine turno prevista: $NEXT_END"
  else
    warn "Adesso è FUORI ORARIO."
    NEXT_START=$(node "$SCHEDULE_CLI" next-start 2>/dev/null || echo "")
    [ -n "$NEXT_START" ] && info "Prossimo inizio turno: $NEXT_START"
  fi
else
  warn "config.json non trovato."
fi

# ── Stato runtime ──
echo ""
info "Stato runtime"

# Fase salvata e freschezza dello status.json: se il file è vecchio (nessun
# aggiornamento da minuti) significa che descrive un run ORMAI TERMINATO, non lo
# stato attuale. Senza questa distinzione si rischia di riportare all'utente un
# "autologin scaduto" di giorni fa come se fosse adesso.
STATUS_PHASE=""
STATUS_STALE=false
STATUS_AGE_MIN=""
if [ -f logs/status.json ] && node -e "JSON.parse(require('fs').readFileSync('logs/status.json','utf8'))" 2>/dev/null; then
  STATUS_PHASE=$(node -e "try{console.log(require('./logs/status.json').phase||'')}catch(e){}" 2>/dev/null)
  STATUS_AGE_MIN=$(node -e "
    try {
      const s = require('./logs/status.json');
      if (!s.lastUpdate) { console.log(''); process.exit(0); }
      console.log(Math.floor((Date.now() - new Date(s.lastUpdate).getTime()) / 60000));
    } catch(e) { console.log(''); }
  " 2>/dev/null)
  if [ -n "$STATUS_AGE_MIN" ] && [ "$STATUS_AGE_MIN" -gt 3 ] 2>/dev/null; then
    STATUS_STALE=true
  fi
fi

if [ -f logs/status.json ]; then
  if ! node -e "JSON.parse(require('fs').readFileSync('logs/status.json','utf8'))" 2>/dev/null; then
    warn "status.json presente ma non valido."
  else
    if [ "$STATUS_STALE" = true ]; then
      warn "Lo stato qui sotto è VECCHIO (ultimo aggiornamento ${STATUS_AGE_MIN} min fa): descrive un run terminato, non la situazione attuale. NON dedurne lo stato corrente — usa la verifica live più sotto."
    fi
    node "$DIR/scripts/lib/status-print.js" 2>/dev/null || warn "Impossibile leggere status.json."
  fi
else
  warn "Nessun status.json trovato."
fi

# ── Verifica LIVE autologin ──
# Si attiva con --check, oppure automaticamente quando lo stato salvato segnala
# un problema di autologin/sessione: in quel caso vale la pena verificare DAVVERO
# se il link funziona, invece di fidarsi di uno status.json che può essere vecchio.
RUN_LIVE=false
if [ "$LIVE_CHECK" = true ]; then
  RUN_LIVE=true
elif [ "$STATUS_PHASE" = "autologin_invalid" ] || [ "$STATUS_PHASE" = "session_lost" ]; then
  RUN_LIVE=true
fi

if [ "$RUN_LIVE" = true ] && [ -f "$HEALTHCHECK_CLI" ]; then
  echo ""
  info "Verifica LIVE del link autologin (apro un browser headless, ~30s)..."
  if HC_OUT=$(node "$HEALTHCHECK_CLI" 2>&1); then
    ok "Link autologin VALIDO. $HC_OUT"
    if [ "$STATUS_PHASE" = "autologin_invalid" ] || [ "$STATUS_PHASE" = "session_lost" ]; then
      warn "Nota: lo stato salvato diceva '$STATUS_PHASE', ma la verifica live dice che il link FUNZIONA. Era un falso allarme/stato vecchio: basta riavviare con ./start.sh."
      # Auto-correzione: se nessuno scheduler è attivo, ripuliamo il segnale ormai
      # falso da status.json, così chi lo legge (anche l'AI) non viene più ingannato.
      if [ "$SCHED_ACTIVE" = false ]; then
        node -e "
          const fs=require('fs');const p='logs/status.json';
          let s={};try{s=JSON.parse(fs.readFileSync(p,'utf8'))}catch(e){}
          s.phase='idle';s.running=false;s.lastError=null;
          s.lastUpdate=new Date().toISOString();
          s.note='Autologin verificato VALIDO con healthcheck (stato precedente obsoleto).';
          s.autologinHealth={ok:true,checkedAt:s.lastUpdate};
          fs.writeFileSync(p,JSON.stringify(s,null,2));
        " 2>/dev/null && info "Stato salvato corretto (autologin risulta valido)."
      fi
    fi
  else
    err "Link autologin NON valido. $HC_OUT"
    info "Aggiorna l'account: node scripts/lib/members-cli.js set-active <CF>  (oppure reimporta il CSV)."
  fi
fi

# ── Heartbeat ──
echo ""
info "Heartbeat"
if [ -f logs/heartbeat.txt ]; then
  cat logs/heartbeat.txt
  echo ""
else
  warn "Nessun heartbeat trovato."
fi

# ── Log recenti ──
echo ""
info "Ultimi 20 log autoplay"
if [ -f logs/autoplay.log ]; then
  tail -n 20 logs/autoplay.log
else
  warn "Nessun log autoplay trovato."
fi

echo ""
info "Ultimi 20 log scheduler"
if [ -f logs/scheduler.log ]; then
  tail -n 20 logs/scheduler.log
else
  warn "Nessun scheduler log trovato."
fi

echo ""
