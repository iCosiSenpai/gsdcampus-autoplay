#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

missing=0

log_missing() {
  echo "❌ MANCANTE: $1"
  missing=1
}

log_ok() {
  echo "✅ OK: $1"
}

# 1. Homebrew (opzionale, serve per node/ollama su alcuni sistemi)
if command -v brew &>/dev/null; then
  log_ok "Homebrew ($(brew --version | head -1))"
else
  log_missing "Homebrew"
fi

# 2. Node.js / npm
if command -v node &>/dev/null; then
  log_ok "Node ($(node -v))"
else
  log_missing "Node.js"
fi

# 3. npm dependencies (playwright)
if [ -d "$DIR/node_modules/playwright" ]; then
  log_ok "Playwright npm package"
else
  log_missing "Playwright npm package (esegui: npm install)"
fi

# 4. Chromium / Chrome browser for Playwright
if command -v chromium &>/dev/null || \
   [ -d "$HOME/Library/Caches/ms-playwright" ] || \
   [ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] || \
   [ -f "/Applications/Google Chrome.app/Contents/MacOS/Chrome" ] || \
   [ -d "$HOME/Applications/Google Chrome.app" ]; then
  log_ok "Playwright browsers / Google Chrome"
else
  log_missing "Playwright browsers / Google Chrome (esegui: npx playwright install chromium oppure installa Chrome)"
fi

# 5. Ollama
if command -v ollama &>/dev/null; then
  log_ok "Ollama ($(ollama --version | head -1))"
else
  log_missing "Ollama"
fi

# 6. Ollama modello gemma4:31b-cloud (richiede login cloud)
if command -v ollama &>/dev/null; then
  if ollama list 2>/dev/null | grep -q "gemma4:31b-cloud"; then
    log_ok "Modello Ollama gemma4:31b-cloud"
  else
    log_missing "Modello Ollama gemma4:31b-cloud (modello cloud; esegui ./launch-ai-supervisor.sh oppure ollama login + ollama pull gemma4:31b-cloud)"
  fi
fi

# 7. Claude Code CLI
if command -v claude &>/dev/null; then
  log_ok "Claude Code ($(claude --version 2>/dev/null | head -1))"
else
  log_missing "Claude Code CLI"
fi

# 8. expect / osascript (macOS)
if command -v osascript &>/dev/null; then
  log_ok "osascript"
else
  log_missing "osascript (richiesto su macOS)"
fi

if [ "$missing" -eq 0 ]; then
  echo ""
  echo "🟢 Tutti i requisiti sono soddisfatti."
  exit 0
else
  echo ""
  echo "🔴 Requisiti mancanti. Esegui ./scripts/setup.sh per installarli."
  exit 1
fi
