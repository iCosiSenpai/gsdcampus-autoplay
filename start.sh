#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

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
step "1/5" "Verifica requisiti"
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
step "2/5" "Controllo istanze attive"
if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Autoplay già in esecuzione (PID $OLD_PID)."
    info "Monitor: ./status.sh"
    info "Ferma:   ./stop.sh"
    exit 1
  fi
  ok "Nessuna istanza attiva."
fi

echo ""
step "3/5" "Rotazione log precedenti"
if [ -f "$OUT_FILE" ]; then
  mv "$OUT_FILE" "logs/autoplay.out.$(date +%Y%m%d-%H%M%S).old"
  ok "Vecchio log rinominato."
fi

echo ""
step "4/5" "Avvio scheduler in background"
if [ "$IGNORE_HOURS" = true ]; then
  nohup "$DIR/scripts/scheduler.sh" --ignore-hours > "$OUT_FILE" 2>&1 &
else
  nohup "$DIR/scripts/scheduler.sh" > "$OUT_FILE" 2>&1 &
fi
echo $! > "$PID_FILE"
PID=$(cat "$PID_FILE")

echo ""
step "5/5" "Conferma avvio"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  ok "Scheduler autoplay avviato in background. PID: $PID"
  echo ""
  echo "────────────────────────────"
  echo -e "${BOLD}Comandi utili:${NC}"
  echo "  ./status.sh                 → stato e log"
  echo "  ./stop.sh                   → ferma tutto"
  echo "  tail -f logs/autoplay.log   → log in tempo reale"
  echo "  tail -f logs/scheduler.log  → log scheduler"
  echo "────────────────────────────"
else
  err "Avvio fallito. Controlla $OUT_FILE"
  exit 1
fi
