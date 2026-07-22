#!/bin/zsh
# Diagnostico requisiti: default runtime (non esegue CLI AI); --ai e usato
# soltanto dal batch dopo openQuizRequests > 0. Non usa set -e per riportare
# tutte le mancanze del profilo scelto.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
. "$DIR/scripts/setup/package-hash.sh"
. "$DIR/scripts/setup/browser-check.sh"
. "$DIR/scripts/setup/versions.sh"

PROFILE="runtime"
for arg in "$@"; do
  case "$arg" in
    --runtime) PROFILE="runtime" ;;
    --ai) PROFILE="ai" ;;
    *) echo "Uso: $0 [--runtime|--ai]" >&2; exit 2 ;;
  esac
done

missing=0
log_missing() { echo "❌ MANCANTE: $1"; missing=1; }
log_ok() { echo "✅ OK: $1"; }

want_runtime() { [ "$PROFILE" = "all" ] || [ "$PROFILE" = "runtime" ]; }
want_ai() { [ "$PROFILE" = "all" ] || [ "$PROFILE" = "ai" ]; }

# Node serve sia al runtime sia al batch AI deterministico.
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
    log_ok "Node ($(node -v))"
  else
    log_missing "Node.js >= 22 (versione attuale: $(node -v))"
  fi
else
  log_missing "Node.js"
fi

if want_runtime; then
  if command -v brew &>/dev/null; then
    log_ok "Homebrew ($(brew --version | head -1))"
  else
    log_missing "Homebrew"
  fi

  if [ ! -d "$DIR/node_modules" ]; then
    log_missing "Dipendenze npm (esegui: npm install)"
  elif package_hash_ok; then
    log_ok "Dipendenze npm allineate"
  else
    log_missing "Dipendenze npm obsolete (esegui: npm install o ./scripts/setup.sh)"
  fi

  if ! report_browser_status; then :; fi

  if command -v osascript &>/dev/null; then
    log_ok "osascript"
  else
    log_missing "osascript (richiesto su macOS)"
  fi
fi

if want_ai; then
  export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
  AI_OPEN_REQUESTS=$(node -e "try{const t=require('./src/lib/ai-todo').buildAiTodo(process.cwd());process.stdout.write(String(t.openQuizRequests||0))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0)
  if [ "$AI_OPEN_REQUESTS" -gt 0 ] 2>/dev/null; then
    if command -v ollama &>/dev/null; then
      OLLAMA_VER=$(ollama --version 2>/dev/null | extract_version)
      if [ -n "$OLLAMA_VER" ] && version_ge "$OLLAMA_VER" "$MIN_OLLAMA"; then
        log_ok "Ollama v$OLLAMA_VER (daemon e login avviati solo dal batch)"
      else
        log_missing "Ollama >= $MIN_OLLAMA (versione attuale: ${OLLAMA_VER:-sconosciuta})"
      fi
    else
      log_missing "Ollama CLI"
    fi

    if command -v claude &>/dev/null; then
      CLAUDE_VER=$(claude --version 2>/dev/null | extract_version)
      if [ -n "$CLAUDE_VER" ] && version_ge "$CLAUDE_VER" "$MIN_CLAUDE"; then
        log_ok "Claude Code v$CLAUDE_VER"
      else
        log_missing "Claude Code >= $MIN_CLAUDE (versione attuale: ${CLAUDE_VER:-sconosciuta})"
      fi
    else
      log_missing "Claude Code CLI"
    fi
  else
    command -v ollama >/dev/null 2>&1 \
      && log_ok "Ollama presente; versione non eseguita con inbox vuota" \
      || log_ok "Ollama assente; installazione differita al primo quiz"
    command -v claude >/dev/null 2>&1 \
      && log_ok "Claude Code presente; versione non eseguita con inbox vuota" \
      || log_ok "Claude Code assente; installazione differita al primo quiz"
  fi

  if node "$DIR/scripts/lib/ai-budget-cli.js" --json >/dev/null 2>&1; then
    log_ok "Budget AI locale leggibile"
  else
    log_missing "Budget AI locale"
  fi
fi

if [ "$missing" -eq 0 ]; then
  echo ""
  case "$PROFILE" in
    runtime) echo "🟢 Requisiti runtime autoplay soddisfatti." ;;
    ai) echo "🟢 Requisiti Claude on-demand soddisfatti." ;;
    *) echo "🟢 Tutti i requisiti sono soddisfatti." ;;
  esac
  exit 0
fi

echo ""
echo "🔴 Requisiti mancanti. Esegui ./scripts/setup.sh per installarli."
exit 1
