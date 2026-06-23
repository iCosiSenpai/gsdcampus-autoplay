#!/bin/zsh

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

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

info "Processo scheduler"
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    ok "Scheduler attivo: PID $PID"
  else
    warn "Scheduler NON attivo (PID file presente: $PID) — pulisco."
    rm -f "$PID_FILE"
  fi
else
  warn "Nessun scheduler in esecuzione."
fi

echo ""
info "Heartbeat"
if [ -f logs/heartbeat.txt ]; then
  cat logs/heartbeat.txt
  echo ""
else
  warn "Nessun heartbeat trovato."
fi

echo ""
info "Stato corrente"
if [ -f logs/status.json ]; then
  cat logs/status.json
  echo ""
else
  warn "Nessun status.json trovato."
fi

echo ""
info "Ultimi 30 log autoplay"
if [ -f logs/autoplay.log ]; then
  tail -n 30 logs/autoplay.log
else
  warn "Nessun log autoplay trovato."
fi

echo ""
info "Ultimi 20 log stdout/stderr"
if [ -f logs/autoplay.out ]; then
  tail -n 20 logs/autoplay.out
else
  warn "Nessun out trovato."
fi

echo ""
info "Ultimi 20 log scheduler"
if [ -f logs/scheduler.log ]; then
  tail -n 20 logs/scheduler.log
else
  warn "Nessun scheduler log trovato."
fi

echo ""
