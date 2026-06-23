#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

IGNORE_HOURS=false
if [ "$1" = "--ignore-hours" ]; then
  IGNORE_HOURS=true
fi

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') | $1" | tee -a "$LOG_FILE"
}

info() { log "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { log "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { log "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }

LOG_FILE="$DIR/logs/scheduler.log"
mkdir -p "$DIR/logs"

# Calcola i millisecondi fino al prossimo inizio turno lavorativo
ms_until_next_start() {
  node -e "
    const { nextWorkStart, msUntil } = require('./src/lib/schedule');
    const d = nextWorkStart(new Date());
    console.log(d ? msUntil(d) : 0);
  "
}

# Aspetta un certo numero di millisecondi, ma controlla periodicamente se lo scheduler deve fermarsi
wait_ms() {
  local total_ms="$1"
  local step_ms=60000 # 1 minuto
  local elapsed=0
  while [ "$elapsed" -lt "$total_ms" ]; do
    if [ -f "$DIR/.scheduler_stop" ]; then
      log "Ricevuto segnale di stop. Fermo lo scheduler."
      rm -f "$DIR/.scheduler_stop"
      exit 0
    fi
    local wait=$((step_ms))
    if [ "$((elapsed + step_ms))" -gt "$total_ms" ]; then
      wait=$((total_ms - elapsed))
    fi
    sleep $((wait / 1000))
    elapsed=$((elapsed + wait))
  done
}

# Controlla se siamo in orario lavorativo in modo robusto
is_in_hours() {
  local out
  out=$(node -e "const { isWorkTime } = require('./src/lib/schedule'); console.log(isWorkTime() ? 'yes' : 'no');" 2>/dev/null)
  [ "$out" = "yes" ]
}

log "Scheduler avviato. IGNORE_HOURS=$IGNORE_HOURS"

while true; do
  if [ "$IGNORE_HOURS" = true ]; then
    log "Avvio autoplay (modalità ignore-hours)..."
    node "$DIR/src/autoplay.js" --ignore-hours 2>&1 | tee -a "$LOG_FILE"
    log "Autoplay terminato. Riavvio tra 60 secondi..."
    sleep 60
    continue
  fi

  if is_in_hours; then
    log "In orario lavorativo. Avvio autoplay..."
    node "$DIR/src/autoplay.js" 2>&1 | tee -a "$LOG_FILE"
    log "Autoplay terminato (fine turno o errore). Calcolo prossimo turno..."
  else
    log "Fuori orario lavorativo. Attendo prossimo turno..."
  fi

  NEXT_MS=$(ms_until_next_start)
  if [ -z "$NEXT_MS" ] || [ "$NEXT_MS" -le 0 ]; then
    NEXT_MS=60000
  fi
  NEXT_MIN=$((NEXT_MS / 60000))
  log "Prossimo avvio fra circa $NEXT_MIN minuti."
  wait_ms "$NEXT_MS"
done
