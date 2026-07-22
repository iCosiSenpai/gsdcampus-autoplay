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
PID=$(autoplay_instance_pid "$DIR" 2>/dev/null || echo "")
if [ -n "$PID" ]; then
  ok "Trovato scheduler PID $PID (identità lock verificata)."
else
  warn "Nessuna istanza verificata. Procedo con la pulizia dei soli orfani del progetto."
  autoplay_clean_stale_lock "$DIR" >/dev/null 2>&1 || true
  rm -f "$PID_FILE"
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
AUTO_ORPHANS=$(pgrep -f "$DIR/src/autoplay\.js" 2>/dev/null || true)
if [ -n "$AUTO_ORPHANS" ]; then
  echo "$AUTO_ORPHANS" | while read orphan; do
    [ "$orphan" != "$$" ] && kill -TERM "$orphan" 2>/dev/null || true
  done
  echo "Attesa graceful shutdown (max 8s, Invio nel frattempo non serve)..."
  for i in {1..8}; do
    AUTO_ORPHANS=$(pgrep -f "$DIR/src/autoplay\.js" 2>/dev/null || true)
    [ -z "$AUTO_ORPHANS" ] && break
    sleep 1
  done
  AUTO_ORPHANS=$(pgrep -f "$DIR/src/autoplay\.js" 2>/dev/null || true)
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
SCH_ORPHANS=$(pgrep -f "$DIR/scripts/scheduler\.sh" 2>/dev/null || true)
if [ -n "$SCH_ORPHANS" ]; then
  echo "$SCH_ORPHANS" | while read orphan; do
    [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
  done
  ok "Orfani scheduler rimossi."
fi

# 3d. Componenti Claude on-demand registrati dal progetto. I PID file evitano
# di toccare Claude/Ollama usati dall'utente per altri progetti. L'ordine e
# intenzionale: runner e batch devono uscire prima dei servizi da cui dipendono.
stop_tracked_component() {
  local file="$1" pattern="$2" label="$3"
  if stop_tracked_pid_file "$file" "$pattern"; then
    ok "$label arrestato."
  fi
}
stop_tracked_component "$DIR/.claude_runner_pid" "claude-quiz-runner\\.js" "Runner Claude"
stop_tracked_component "$DIR/.claude_batch_pid" "run-claude-quiz-batch\\.sh" "Batch Claude"
stop_tracked_component "$DIR/.ai_proxy_pid" "ollama-cloud-proxy\\.js" "Proxy budget"
stop_tracked_component "$DIR/.ollama_pid" "ollama|Ollama" "Daemon Ollama del progetto"
rm -rf "$DIR/logs/.claude-quiz-batch.lock" 2>/dev/null || true

# Rimuovi il segnale di stop se ancora presente
rm -f "$DIR/$STOP_FILE"
autoplay_clean_stale_lock "$DIR" >/dev/null 2>&1 || true

# Status: forza running=false / phase stopped se erano rimasti "in corso"
if [ -f "$DIR/scripts/lib/status-cli.js" ]; then
  node "$DIR/scripts/lib/status-cli.js" reconcile --force-stopped >/dev/null 2>&1 || true
fi

echo ""
ui_hr
ok "${GREEN}${BOLD}Autoplay fermato${NC}"
ui_hr
