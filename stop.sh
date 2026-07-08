#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

ok() { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err() { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }
step() { echo -e "${BOLD}[PASSO $1]${NC} $2"; }

PID_FILE=".autoplay_pid"
STOP_FILE=".scheduler_stop"

# pid_matches <PID> <pattern>: il PID esiste E la sua command line contiene il
# pattern. Protegge dal PID recycling: un PID recyclato a un processo non nostro
# non verrebbe segnalato (kill -0 puro direbbe solo "esiste un processo").
pid_matches() {
  local p="$1"; local pat="$2"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  ps -o command= -p "$p" 2>/dev/null | grep -qE "$pat" || return 1
  return 0
}

echo ""
echo "============================================"
echo -e "${BOLD}  Arresto GSD Campus Autoplay${NC}"
echo "============================================"
echo ""

# 1. Segnala allo scheduler di fermarsi se in attesa
touch "$DIR/$STOP_FILE"

step "1/3" "Lettura PID dello scheduler"
PID=""
if [ ! -f "$PID_FILE" ]; then
  warn "Nessun PID file trovato. Procedo con pulizia orfani."
else
  PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
  if [ -z "$PID" ]; then
    warn "PID file vuoto."
    rm -f "$PID_FILE"
  elif pid_matches "$PID" "scheduler|autoplay"; then
    ok "Trovato scheduler PID $PID."
  else
    warn "PID $PID nel file non corrisponde a scheduler/autoplay (probabile PID recycling). Non lo kill: pulisco il file."
    PID=""
    rm -f "$PID_FILE"
  fi
fi

echo ""
step "2/3" "Arresto processi"
if [ -n "$PID" ]; then
  echo "Arresto PID $PID con SIGTERM..."
  kill "$PID" 2>/dev/null || true
  for i in {1..10}; do
    if ! kill -0 "$PID" 2>/dev/null; then
      ok "Scheduler fermato con successo."
      rm -f "$PID_FILE"
      PID=""
      break
    fi
    sleep 1
  done

  if [ -n "$PID" ]; then
    warn "Forzo chiusura con SIGKILL su PID $PID..."
    kill -9 "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    ok "Processo terminato."
  fi
fi

# Cleanup orfani di autoplay e scheduler
echo ""
step "3/3" "Pulizia eventuali processi orfani"
# Pattern path-indipendente: lo scheduler lancia `node /abs/path/src/autoplay.js`,
# quindi "node src/autoplay.js" (sottostringa) NON matchava mai. Usiamo il nome
# file, che matcha qualsiasi path. Esclude autoplay.log (grep su "autoplay\.js").
ORPHANS=$(pgrep -f "autoplay\.js" 2>/dev/null || true)
if [ -n "$ORPHANS" ]; then
  echo "$ORPHANS" | while read orphan; do
    [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
  done
  ok "Orfani autoplay rimossi."
fi

SCH_ORPHANS=$(pgrep -f "scheduler.sh" 2>/dev/null || true)
if [ -n "$SCH_ORPHANS" ]; then
  echo "$SCH_ORPHANS" | while read orphan; do
    [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
  done
  ok "Orfani scheduler rimossi."
fi

# Rimuovi il segnale di stop se ancora presente
rm -f "$DIR/$STOP_FILE"

echo ""
echo "============================================"
echo -e "${GREEN}${BOLD}  Autoplay fermato${NC}"
echo "============================================"
