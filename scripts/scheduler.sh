#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"

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

PID_FILE="$DIR/.autoplay_pid"
LOG_FILE="$DIR/logs/scheduler.log"
STOP_FILE="$DIR/.scheduler_stop"

mkdir -p "$DIR/logs"

log() {
  local line="$(date '+%Y-%m-%d %H:%M:%S') | $1"
  echo "$line" | tee -a "$LOG_FILE"
}

info() { log "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { log "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { log "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }

# Pulizia file di controllo in uscita
cleanup() {
  rm -f "$STOP_FILE"
}
trap cleanup EXIT INT TERM

# Calcola i millisecondi fino al prossimo inizio turno lavorativo
ms_until_next_start() {
  node -e "
    const { nextWorkStart, msUntil } = require('./src/lib/schedule');
    const d = nextWorkStart(new Date());
    console.log(d ? msUntil(d) : 0);
  " 2>/dev/null
}

# Restituisce l'ora del prossimo avvio in formato leggibile
next_start_readable() {
  node "$SCHEDULE_CLI" next-start 2>/dev/null || echo "sconosciuto"
}

# Aspetta un certo numero di millisecondi, controllando periodicamente se lo scheduler deve fermarsi
wait_ms() {
  local total_ms="$1"
  local step_ms=60000 # 1 minuto
  local elapsed=0

  # Evita attese nulle o negative
  if [[ -z "$total_ms" || "$total_ms" -le 1000 ]]; then
    sleep 1
    return 0
  fi

  while [[ "$elapsed" -lt "$total_ms" ]]; do
    if [[ -f "$STOP_FILE" ]]; then
      log "Ricevuto segnale di stop. Fermo lo scheduler."
      rm -f "$STOP_FILE"
      exit 0
    fi

    local wait=$((step_ms))
    if [[ "$((elapsed + step_ms))" -gt "$total_ms" ]]; then
      wait=$((total_ms - elapsed))
    fi

    sleep $((wait / 1000))
    elapsed=$((elapsed + wait))
  done
}

# Controlla se siamo in orario lavorativo
is_in_hours() {
  node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -q '^yes$'
}

log "Scheduler avviato. IGNORE_HOURS=$IGNORE_HOURS"

while true; do
  if [[ "$IGNORE_HOURS" = true ]]; then
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
  if [[ -z "$NEXT_MS" || "$NEXT_MS" -le 0 ]]; then
    NEXT_MS=60000
  fi
  NEXT_MIN=$((NEXT_MS / 60000))
  NEXT_START=$(next_start_readable)
  log "Prossimo avvio: ${NEXT_START} (fra circa ${NEXT_MIN} minuti)."
  wait_ms "$NEXT_MS"
done
