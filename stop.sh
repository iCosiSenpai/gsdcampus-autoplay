#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Palette + info/ok/warn/err/step condivisi.
source "$DIR/scripts/lib/ui.sh"

PID_FILE=".autoplay_pid"
STOP_FILE=".scheduler_stop"

source "$DIR/scripts/lib/pid-utils.sh"

ui_header "Arresto GSD Campus Autoplay"

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
step "3/3" "Arresto graceful + pulizia orfani"

# 3a. Graceful shutdown dei processi autoplay (node .../autoplay.js): SIGTERM
# prima così autoplay.js gracefulShutdown() esegue browser.close() (niente leak
# di processi chromium), poi SIGKILL solo se ancora vivi dopo ~8s. Pattern
# path-indipendente ("autoplay\.js" matcha qualsiasi path; esclude autoplay.log).
AUTO_ORPHANS=$(pgrep -f "autoplay\.js" 2>/dev/null || true)
if [ -n "$AUTO_ORPHANS" ]; then
  echo "$AUTO_ORPHANS" | while read orphan; do
    [ "$orphan" != "$$" ] && kill -TERM "$orphan" 2>/dev/null || true
  done
  echo "Attesa graceful shutdown (max 8s, Invio nel frattempo non serve)..."
  for i in {1..8}; do
    AUTO_ORPHANS=$(pgrep -f "autoplay\.js" 2>/dev/null || true)
    [ -z "$AUTO_ORPHANS" ] && break
    sleep 1
  done
  AUTO_ORPHANS=$(pgrep -f "autoplay\.js" 2>/dev/null || true)
  if [ -n "$AUTO_ORPHANS" ]; then
    warn "Ancora attivi dopo 8s. SIGKILL dei processi autoplay..."
    echo "$AUTO_ORPHANS" | while read orphan; do
      [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
    done
  fi
  ok "Processi autoplay arrestati."
fi

# 3b. Orfani Chrome/Chromium lanciati dall'autoplay: riconosciuti dal flag
# --remote-debugging-port (Playwright lo usa per channel 'chrome'; il Chrome
# normale dell'utente non lo ha). Solo DOPO il grace period: se browser.close()
# è girato, qui non resta nulla. matcha solo debug-port per non toccare Chrome utente.
CHROME_ORPHANS=$(pgrep -f "remote-debugging-port" 2>/dev/null || true)
if [ -n "$CHROME_ORPHANS" ]; then
  echo "$CHROME_ORPHANS" | while read orphan; do
    [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
  done
  ok "Orfani Chrome (remote-debugging) rimossi."
fi

# 3c. Orfani scheduler (non hanno browser da chiudere graceful): SIGKILL diretto.
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
ui_hr
ok "${GREEN}${BOLD}Autoplay fermato${NC}"
ui_hr
