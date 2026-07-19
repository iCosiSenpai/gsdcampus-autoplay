#!/bin/zsh
# Niente `set -e`: è uno script diagnostico che deve eseguire TUTTI i check e
# riportare ogni mancanza, non fermarsi al primo comando in errore (es.
# `ollama --version` che torna non-zero abortirebbe la diagnostica). L'esito
# finale è deciso dal flag `missing` e dagli exit espliciti in fondo.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# shellcheck source=scripts/setup/package-hash.sh
. "$DIR/scripts/setup/package-hash.sh"

missing=0

log_missing() {
  echo "❌ MANCANTE: $1"
  missing=1
}

log_ok() {
  echo "✅ OK: $1"
}

# Legge il modello Ollama da config.json (campo `ollamaModel`).
# Fallback a costante letterale (NON a ${OLLAMA_MODEL}: sarebbe circolare, perché
# OLLAMA_MODEL viene valorizzato proprio da questa funzione → restituirebbe la
# stringa vuota se config.json manca/corrotto). Stessa costante di launch-ai-supervisor.sh.
MODEL_FALLBACK="gemma4:cloud"
get_ollama_model() {
  node -e "try { const c=require('./config.json'); console.log(c.ollamaModel || '${MODEL_FALLBACK}'); } catch(e){ console.log('${MODEL_FALLBACK}'); }" 2>/dev/null || echo "${MODEL_FALLBACK}"
}
OLLAMA_MODEL="$(get_ollama_model)"

# package_hash_ok da scripts/setup/package-hash.sh

# 1. Homebrew (opzionale, serve per node/ollama su alcuni sistemi)
if command -v brew &>/dev/null; then
  log_ok "Homebrew ($(brew --version | head -1))"
else
  log_missing "Homebrew"
fi

# 2. Node.js / npm
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

# 3. npm dependencies
if [ ! -d "$DIR/node_modules" ]; then
  log_missing "Dipendenze npm (esegui: npm install)"
elif package_hash_ok; then
  log_ok "Dipendenze npm allineate"
else
  log_missing "Dipendenze npm obsolete (esegui: npm install o ./scripts/setup.sh)"
fi

# 4. Browser: preferito Google Chrome di sistema; fallback Chromium Playwright
# (src/lib/browser.js). Chrome assente NON è più bloccante se Chromium bundled
# è installato (npx playwright install chromium / setup).
CHROME_APP=""
[ -f "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ] && CHROME_APP="/Applications/Google Chrome.app"
[ -z "$CHROME_APP" ] && [ -f "/Applications/Google Chrome.app/Contents/MacOS/Chrome" ] && CHROME_APP="/Applications/Google Chrome.app"
[ -z "$CHROME_APP" ] && [ -d "$HOME/Applications/Google Chrome.app" ] && CHROME_APP="$HOME/Applications/Google Chrome.app"
PLAYWRIGHT_CHROMIUM_OK=false
if node -e "const {chromium}=require('playwright'); const p=chromium.executablePath(); require('fs').accessSync(p); console.log('ok')" >/dev/null 2>&1; then
  PLAYWRIGHT_CHROMIUM_OK=true
fi
if [ -n "$CHROME_APP" ]; then
  log_ok "Google Chrome ($CHROME_APP)"
elif [ "$PLAYWRIGHT_CHROMIUM_OK" = true ]; then
  log_ok "Browser: Chromium Playwright (Chrome di sistema assente — fallback automatico)"
else
  log_missing "Browser (installa Google Chrome OPPURE: npx playwright install chromium / ./scripts/setup.sh)"
fi

# 5. Ollama
if command -v ollama &>/dev/null; then
  log_ok "Ollama ($(ollama --version | head -1))"
else
  log_missing "Ollama"
fi

# 6. Ollama modello ${OLLAMA_MODEL} (richiede login cloud)
if command -v ollama &>/dev/null; then
  if ! curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
    log_missing "Server Ollama attivo su 127.0.0.1:11434 (esegui: ollama serve oppure ./scripts/ollama-daemon.sh start)"
  elif ollama list 2>/dev/null | grep -c "${OLLAMA_MODEL}" >/dev/null; then
    log_ok "Modello Ollama ${OLLAMA_MODEL}"
  else
    log_missing "Modello Ollama ${OLLAMA_MODEL} (modello cloud; esegui ./launch-ai-supervisor.sh oppure ollama signin + ollama pull ${OLLAMA_MODEL})"
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
