#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Neutralizza FORCE_COLOR (v. scripts/scheduler.sh): impedisce a `node` di
# colorizzare l'output su pipe e rompere grep/aritmetica shell. Lo scheduler
# che lanciamo da qui eredita questo env pulito.
unset FORCE_COLOR
export NO_COLOR=1

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"

# Palette + info/ok/warn/err/step condivisi.
source "$DIR/scripts/lib/ui.sh"

PID_FILE=".autoplay_pid"
LOCK_CLI="$DIR/scripts/lib/runtime-lock-cli.js"
OUT_FILE="logs/autoplay.out"

mkdir -p logs

IGNORE_HOURS=false
if [ "${1:-}" = "--ignore-hours" ]; then
  IGNORE_HOURS=true
  warn "Modalità IGNORE-HOURS: avvia anche fuori orario lavorativo."
fi

ui_header "Avvio GSD Campus Autoplay" "versione $(ui_version "$DIR")"

# Verifica che config.json esista e non sia placeholder
step "1/5" "Verifica configurazione"
if [ ! -f "$DIR/config.json" ]; then
  err "config.json non trovato."
  info "Esegui una volta: cd $DIR && ./scripts/setup.sh"
  exit 1
fi

if ! node "$SCHEDULE_CLI" is-work-time >/dev/null 2>&1; then
  warn "config.json presente ma non valido o incompleto."
  info "Esegui: cd $DIR && ./scripts/setup.sh"
  exit 1
fi

ok "Configurazione trovata."
info "Orario configurato: $(node "$SCHEDULE_CLI" describe 2>/dev/null || echo 'non disponibile')"

# F2 fleet: merge banca pubblica → trusted (throttle 6h, best-effort offline).
if [ -f "$DIR/src/lib/bank-sync.js" ]; then
  node -e "
    const { syncPublicBank } = require('./src/lib/bank-sync');
    syncPublicBank('.', { log: (m) => console.log(m) }).then((r) => {
      if (r.skipped) process.exit(0);
      if (r.ok && r.added > 0) console.log('[bank-sync] +' + r.added + ' da public');
      else if (!r.ok) console.log('[bank-sync] skip: ' + (r.error || 'fail'));
    }).catch(() => {});
  " 2>/dev/null || true
fi
# Gate locale: una stessa domanda con due risposte diverse può consumare un
# tentativo anche se entrambe le banche hanno lo stesso numero di voci.
if [ -f "$DIR/scripts/lib/answers-cli.js" ]; then
  if ! node "$DIR/scripts/lib/answers-cli.js" verify >> "$OUT_FILE" 2>&1; then
    err "Conflitto nella banca risposte: avvio bloccato per proteggere i quiz."
    info "Diagnosi: node scripts/lib/answers-cli.js audit"
    exit 1
  fi
fi

echo ""
step "2/5" "Verifica requisiti"
if [ -f "$DIR/scripts/check-requirements.sh" ]; then
  if ! "$DIR/scripts/check-requirements.sh" --runtime >> "$OUT_FILE" 2>&1; then
    echo ""
    err "Requisiti mancanti. L'autoplay non può partire automaticamente."
    info "Esegui una volta: ./scripts/setup.sh"
    info "Dettagli: tail -f $OUT_FILE"
    exit 1
  fi
  ok "Requisiti soddisfatti."
else
  warn "check-requirements.sh non trovato, procedo comunque."
fi

echo ""
step "3/5" "Controllo istanze attive"
source "$DIR/scripts/lib/pid-utils.sh"
if autoplay_instance_alive "$DIR"; then
  OLD_PID=$(autoplay_instance_pid "$DIR" 2>/dev/null || echo "?")
  warn "Autoplay già in esecuzione (PID $OLD_PID, identità verificata)."
  info "Monitor: ./status.sh"
  info "Ferma:   ./stop.sh"
  exit 1
fi
autoplay_clean_stale_lock "$DIR" >/dev/null 2>&1 || true
if [ -f "$PID_FILE" ]; then
  ok "Nessuna istanza attiva (PID file orfano rimosso)."
  rm -f "$PID_FILE"
else
  ok "Nessuna istanza attiva."
fi
# Pulisce status.json se un run precedente ha lasciato running:true orfano.
if [ -f "$DIR/scripts/lib/status-cli.js" ]; then
  node "$DIR/scripts/lib/status-cli.js" reconcile >/dev/null 2>&1 || true
fi
# Lock directory atomica + token nella command line dello scheduler. Un PID
# riciclato non basta più a impersonare la nostra istanza.
LOCK_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(18).toString('hex'))")
START_COMPLETE=false
if ! node "$LOCK_CLI" acquire "$DIR" "$$" "$LOCK_TOKEN" >/dev/null 2>&1; then
  err "Impossibile acquisire il lock single-instance (avvio concorrente?)."
  exit 1
fi
cleanup_start_lock() {
  if [ "$START_COMPLETE" != true ]; then
    node "$LOCK_CLI" release "$DIR" "$LOCK_TOKEN" >/dev/null 2>&1 || true
    if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null || echo '')" = "$$" ]; then rm -f "$PID_FILE"; fi
  fi
}
trap cleanup_start_lock EXIT INT TERM
echo "$$" > "$PID_FILE"

echo ""
step "4/5" "Rotazione log precedenti"
if [ -f "$OUT_FILE" ]; then
  mv "$OUT_FILE" "logs/autoplay.out.$(date +%Y%m%d-%H%M%S).old"
  ok "Vecchio log rinominato."
fi
# Pota i .old oltre gli ultimi 5: prima si accumulavano all'infinito (uno per
# ogni avvio). ls -t = più recenti prima; tail -n +6 = dal 6° in poi.
ls -t logs/autoplay.out.*.old 2>/dev/null | tail -n +6 | while read -r oldlog; do
  rm -f "$oldlog"
done || true

echo ""
step "5/5" "Avvio scheduler in background"
if [ "$IGNORE_HOURS" = true ]; then
  nohup "$DIR/scripts/scheduler.sh" --ignore-hours --lock-token "$LOCK_TOKEN" > "$OUT_FILE" 2>&1 &
else
  # grep -c >/dev/null (NON -q): sotto pipefail, grep -q esce al primo match
  # chiudendo la pipe -> SIGPIPE (141) al comando a sinistra -> pipeline fallita
  # anche col match trovato. grep -c legge fino a EOF: stessa semantica, zero SIGPIPE.
  if node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -c '^yes$' >/dev/null; then
    info "Siamo in orario lavorativo: l'autoplay partirà subito."
  else
    NEXT_START=$(node "$SCHEDULE_CLI" next-start 2>/dev/null || echo "")
    if [ -n "$NEXT_START" ]; then
      info "Siamo fuori orario. Primo avvio previsto: $NEXT_START"
      info "Lo scheduler attenderà automaticamente."
    else
      warn "Impossibile calcolare il prossimo turno; lo scheduler riproverà a breve."
    fi
  fi
  nohup "$DIR/scripts/scheduler.sh" --lock-token "$LOCK_TOKEN" > "$OUT_FILE" 2>&1 &
fi
PID=$!
echo "$PID" > "$PID_FILE"
if ! node "$LOCK_CLI" promote "$DIR" "$LOCK_TOKEN" "$PID" >/dev/null 2>&1; then
  kill "$PID" 2>/dev/null || true
  rm -f "$PID_FILE"
  err "Scheduler avviato ma lock identità non registrato: arresto per sicurezza."
  exit 1
fi
START_COMPLETE=true

# macOS: tieni il Mac sveglio finché gira lo scheduler. I Mac sono sempre accesi,
# ma lo sleep di sistema (idle/display su batteria, sospensione notturna) bloccherebbe
# l'autoplay. `caffeinate` è built-in su macOS: -i (no idle sleep), -s (no system
# sleep su corrente), -m (no disk idle), -w <PID> (esce da solo quando lo scheduler
# termina, rilasciando l'assertion di sleep). Non usiamo il PID file: stop.sh uccide
# per pattern (scheduler|autoplay), e caffeinate -w segue la vita del PID scheduler.
# Se caffeinate manca (non macOS) lo saltiamo silenziosamente.
if command -v caffeinate >/dev/null 2>&1 && [ -n "$PID" ]; then
  nohup caffeinate -i -s -m -w "$PID" >/dev/null 2>&1 &
  info "Caffeinate attivo: il Mac resta sveglio finché gira lo scheduler."
fi

echo ""
ui_hr
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  ok "Scheduler autoplay avviato in background ${DIM}(PID $PID)${NC}"
  echo ""
  echo -e " ${BOLD}Comandi utili${NC}"
  ui_kv "Stato" "./status.sh"
  ui_kv "Ferma" "./stop.sh"
  ui_kv "Log live" "tail -f logs/autoplay.log"
else
  err "Avvio fallito. Controlla $OUT_FILE"
  exit 1
fi
ui_hr
