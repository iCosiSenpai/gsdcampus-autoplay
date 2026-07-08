#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err() { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }
step() { echo -e "${BOLD}[PASSO $1]${NC} $2"; }

PID_FILE=".autoplay_pid"
OUT_FILE="logs/autoplay.out"

mkdir -p logs

IGNORE_HOURS=false
if [ "$1" = "--ignore-hours" ]; then
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
# pid_matches <PID> <pattern>: verifica che il PID esista E che la sua command
# line contenga il pattern. Protegge dal PID recycling (un PID recyclato a un
# processo non nostro verrebbe scambiato per un'istanza attiva).
pid_matches() {
  local p="$1"; local pat="$2"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  ps -o command= -p "$p" 2>/dev/null | grep -qE "$pat" || return 1
  return 0
}
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
if ! (set -o noclobber; : > "$PID_FILE") 2>/dev/null; then
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

echo ""
step "5/5" "Avvio scheduler in background"
if [ "$IGNORE_HOURS" = true ]; then
  nohup "$DIR/scripts/scheduler.sh" --ignore-hours > "$OUT_FILE" 2>&1 &
else
  if node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -q '^yes$'; then
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
