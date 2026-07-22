#!/bin/zsh
set -u -o pipefail

# Avvia Claude Code soltanto quando l'inbox quiz contiene lavoro nuovo.
# Ollama e il proxy budget sono lazy e vengono chiusi se avviati da questo batch.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
unset FORCE_COLOR
export NO_COLOR=1

RUNNER="$DIR/scripts/lib/claude-quiz-runner.js"
CHECK_REQ="$DIR/scripts/check-requirements.sh"
PROXY="$DIR/scripts/lib/ollama-cloud-proxy.js"
LOCK_DIR="$DIR/logs/.claude-quiz-batch.lock"
PROXY_PID_FILE="$DIR/.ai_proxy_pid"
BATCH_PID_FILE="$DIR/.claude_batch_pid"
RUNNER_PID_FILE="$DIR/.claude_runner_pid"
NON_INTERACTIVE=false
FORCE=false
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --force) FORCE=true ;;
    *) echo "[claude-batch] opzione sconosciuta: $arg" >&2; exit 24 ;;
  esac
done
[ -t 0 ] || NON_INTERACTIVE=true

mkdir -p "$DIR/logs"
source "$DIR/scripts/lib/pid-utils.sh"

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s\n' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  local owner
  owner="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
    echo "[claude-batch] un batch e gia in esecuzione; non ne avvio un secondo."
    return 21
  fi
  rm -rf "$LOCK_DIR" 2>/dev/null || true
  mkdir "$LOCK_DIR" 2>/dev/null || return 21
  printf '%s\n' "$$" > "$LOCK_DIR/pid"
}

AI_PROXY_PID=""
CLAUDE_RUNNER_PID=""
OLLAMA_STARTED=false
CLEANUP_DONE=false
stop_proxy_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  stop_pid_tree "$pid" "ollama-cloud-proxy\\.js" || true
}
stop_runner_pid() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 0
  stop_pid_tree "$pid" "claude-quiz-runner\\.js" || true
}
cleanup() {
  [ "${CLEANUP_DONE:-false}" = true ] && return 0
  CLEANUP_DONE=true
  stop_runner_pid "${CLAUDE_RUNNER_PID:-}"
  stop_proxy_pid "${AI_PROXY_PID:-}"
  if [ -f "$PROXY_PID_FILE" ] && [ "$(cat "$PROXY_PID_FILE" 2>/dev/null || true)" = "${AI_PROXY_PID:-}" ]; then
    rm -f "$PROXY_PID_FILE"
  fi
  if [ "$OLLAMA_STARTED" = true ] && [ -x "$DIR/scripts/ollama-daemon.sh" ]; then
    "$DIR/scripts/ollama-daemon.sh" stop >/dev/null 2>&1 || true
  fi
  rm -f "$BATCH_PID_FILE" "$RUNNER_PID_FILE"
  rm -rf "$LOCK_DIR" 2>/dev/null || true
}
handle_signal() {
  local signal="$1" code=143
  [ "$signal" = INT ] && code=130
  # Un trap di segnale ritorna normalmente in zsh: disabilita i soli segnali,
  # ripulisci ed esci esplicitamente per non proseguire dopo uno stop. Il trap
  # EXIT richiama cleanup una seconda volta, ma il guard lo rende idempotente.
  trap - INT TERM
  cleanup
  exit "$code"
}

acquire_lock || exit $?
printf '%s\n' "$$" > "$BATCH_PID_FILE"
trap cleanup EXIT
trap 'handle_signal INT' INT
trap 'handle_signal TERM' TERM

# Il file pubblico tracciato viene sempre mergiato prima dell'eventuale fetch.
# Se copre gia l'handoff, il runner lo risolve senza aprire Claude.
if [ -x "$DIR/scripts/update-known-answers.sh" ]; then
  "$DIR/scripts/update-known-answers.sh" >/dev/null 2>&1 || true
fi

# Un errore Worker precedente lascia un marker senza payload. Ritentalo anche
# quando non serve una nuova chiamata AI: il receiver e additivo/idempotente.
SHARE_RETRY_RC=0
if [ -f "$DIR/logs/.answers-share-pending.json" ]; then
  echo "[claude-batch] ritento una distribuzione fleet rimasta pending..."
  node "$DIR/scripts/lib/answers-cli.js" share || SHARE_RETRY_RC=$?
fi

CHECK_ARGS=(--check)
[ "$FORCE" = true ] && CHECK_ARGS+=(--force)
CHECK_RC=0
node "$RUNNER" "${CHECK_ARGS[@]}" || CHECK_RC=$?
case "$CHECK_RC" in
  0) ;;
  20)
    echo "[claude-batch] nessuna domanda aperta: zero chiamate AI."
    [ "$SHARE_RETRY_RC" -eq 0 ] || exit 25
    exit 20
    ;;
  21)
    echo "[claude-batch] inbox invariata e gia elaborata: zero nuove chiamate AI."
    [ "$SHARE_RETRY_RC" -eq 0 ] || exit 25
    exit 21
    ;;
  *)
    echo "[claude-batch] inbox non elaborabile (codice $CHECK_RC); Claude non avviato." >&2
    exit "$CHECK_RC"
    ;;
esac

if [ ! -x "$CHECK_REQ" ] || ! "$CHECK_REQ" --ai >/dev/null 2>&1; then
  echo "[claude-batch] Ollama o Claude Code mancanti. Rilancia il comando curl per completare il setup." >&2
  exit 24
fi

OLLAMA_WAS_RUNNING=false
if curl -fsS "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  OLLAMA_WAS_RUNNING=true
else
  if [ ! -x "$DIR/scripts/ollama-daemon.sh" ] || ! "$DIR/scripts/ollama-daemon.sh" start >/dev/null 2>&1; then
    echo "[claude-batch] impossibile avviare Ollama locale." >&2
    exit 24
  fi
  OLLAMA_STARTED=true
fi

MODEL="$(node -e "try{const c=require('./config.json');process.stdout.write(c.ollamaModel||'gemma4:31b-cloud')}catch(e){process.stdout.write('gemma4:31b-cloud')}" 2>/dev/null)"
echo "[claude-batch] preparo il modello Cloud configurato..."
if ! ollama pull "$MODEL" >/dev/null 2>&1; then
  if [ "$NON_INTERACTIVE" = true ]; then
    echo "[claude-batch] login Ollama necessario: rilancia il comando curl per aprire il browser." >&2
    exit 24
  fi
  echo "[claude-batch] si apre il login Ollama nel browser; non serve alcuna API key."
  ollama signin || true
  if ! ollama pull "$MODEL" >/dev/null 2>&1; then
    echo "[claude-batch] modello Cloud non disponibile dopo il login." >&2
    exit 24
  fi
fi

PROXY_PORT="$(node -e "try{const c=require('./config.json');process.stdout.write(String(c.aiCloudProxyPort||11435))}catch(e){process.stdout.write('11435')}" 2>/dev/null)"
OLD_PROXY_PID="$(cat "$PROXY_PID_FILE" 2>/dev/null || true)"
stop_proxy_pid "$OLD_PROXY_PID"
rm -f "$PROXY_PID_FILE"
if command -v lsof >/dev/null 2>&1; then
  LISTENING_PID="$(lsof -tiTCP:"$PROXY_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$LISTENING_PID" ]; then
    if pid_matches "$LISTENING_PID" "ollama-cloud-proxy\\.js"; then
      stop_proxy_pid "$LISTENING_PID"
    else
      echo "[claude-batch] porta proxy 127.0.0.1:${PROXY_PORT} occupata; non termino processi estranei." >&2
      exit 24
    fi
  fi
fi

GSD_AI_PROXY_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export GSD_AI_PROXY_TOKEN
node "$PROXY" --root "$DIR" --port "$PROXY_PORT" > "$DIR/logs/ai-cloud-proxy.log" 2>&1 &
AI_PROXY_PID=$!
printf '%s\n' "$AI_PROXY_PID" > "$PROXY_PID_FILE"
READY=false
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.2
done
if [ "$READY" != true ]; then
  echo "[claude-batch] proxy budget non avviato; vedi logs/ai-cloud-proxy.log." >&2
  exit 24
fi
BRIDGE_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' -H "x-api-key: ${GSD_AI_PROXY_TOKEN}" "http://127.0.0.1:${PROXY_PORT}/v1/models" 2>/dev/null || echo 000)"
if [ "$BRIDGE_STATUS" != 200 ]; then
  echo "[claude-batch] collegamento Claude -> proxy -> Ollama fallito (HTTP $BRIDGE_STATUS)." >&2
  exit 24
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:${PROXY_PORT}"
export ANTHROPIC_API_KEY="$GSD_AI_PROXY_TOKEN"
export ANTHROPIC_AUTH_TOKEN="$GSD_AI_PROXY_TOKEN"
RUN_ARGS=()
[ "$FORCE" = true ] && RUN_ARGS+=(--force)
RUN_RC=0
node "$RUNNER" "${RUN_ARGS[@]}" &
CLAUDE_RUNNER_PID=$!
printf '%s\n' "$CLAUDE_RUNNER_PID" > "$RUNNER_PID_FILE"
wait "$CLAUDE_RUNNER_PID" || RUN_RC=$?
rm -f "$RUNNER_PID_FILE"
CLAUDE_RUNNER_PID=""
if [ "$RUN_RC" -eq 0 ]; then
  echo "[claude-batch] risposte valide applicate; distribuzione fleet in corso..."
  if ! node "$DIR/scripts/lib/answers-cli.js" share; then
    echo "[claude-batch] share remoto non riuscito; risposte locali salve e retry persistente attivo." >&2
    exit 25
  fi
fi
exit "$RUN_RC"
