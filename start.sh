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
OUT_FILE="logs/autoplay.out"

mkdir -p logs

IGNORE_HOURS=false
if [ "${1:-}" = "--ignore-hours" ]; then
  IGNORE_HOURS=true
  warn "Modalità IGNORE-HOURS: avvia anche fuori orario lavorativo."
fi

echo ""
echo "============================================"
echo -e "${BOLD}  Avvio GSD Campus Autoplay${NC}"
echo "============================================"
echo ""

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

echo ""
step "2/5" "Verifica requisiti"
if [ -f "$DIR/scripts/check-requirements.sh" ]; then
  if ! "$DIR/scripts/check-requirements.sh" >> "$OUT_FILE" 2>&1; then
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
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if pid_matches "$OLD_PID" "scheduler|autoplay"; then
    warn "Autoplay già in esecuzione (PID $OLD_PID)."
    info "Monitor: ./status.sh"
    info "Ferma:   ./stop.sh"
    exit 1
  fi
  ok "Nessuna istanza attiva (PID file orfano rimosso)."
  rm -f "$PID_FILE"
else
  ok "Nessuna istanza attiva."
fi
# Lock atomica anti-doppio-avvio: noclobber crea il PID file solo se non esiste,
# in modo esclusivo. Previene che due start.sh lanciati in rapida successione
# passino entrambi il check "nessuna istanza" e avviino due scheduler concorrenti.
# Scriviamo subito il PID di start.sh ($$) invece di un file vuoto: nella finestra
# prima che lo scheduler parta, un lettore concorrente (stop/status) trova un PID
# reale che NON matcha "scheduler|autoplay" → stato "fermo", mai `kill -0 ""`.
if ! (set -o noclobber; echo "$$" > "$PID_FILE") 2>/dev/null; then
  err "Impossibile acquisire il lock su $PID_FILE (avvio concorrente?)."
  info "Se sei sicuro che non ci sia un'istanza attiva: rm -f $PID_FILE e riprova."
  exit 1
fi

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
  nohup "$DIR/scripts/scheduler.sh" --ignore-hours > "$OUT_FILE" 2>&1 &
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
  nohup "$DIR/scripts/scheduler.sh" > "$OUT_FILE" 2>&1 &
fi
PID=$!
echo "$PID" > "$PID_FILE"

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
echo "────────────────────────────"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  ok "Scheduler autoplay avviato in background. PID: $PID"
  echo -e "${BOLD}Comandi utili:${NC}"
  echo "  ./status.sh                 → stato e log"
  echo "  ./stop.sh                   → ferma tutto"
  echo "  tail -f logs/autoplay.log   → log in tempo reale"
  echo "  tail -f logs/scheduler.log  → log scheduler"
else
  err "Avvio fallito. Controlla $OUT_FILE"
  exit 1
fi
echo "────────────────────────────"
