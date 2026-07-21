#!/bin/zsh
# Niente `set -e`: è uno script diagnostico che deve eseguire TUTTI i check e
# riportare ogni mancanza, non fermarsi al primo comando in errore (es.
# `ollama --version` che torna non-zero abortirebbe la diagnostica). L'esito
# finale è deciso dal flag `missing` e dagli exit espliciti in fondo.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# shellcheck source=scripts/setup/package-hash.sh
. "$DIR/scripts/setup/package-hash.sh"
. "$DIR/scripts/setup/browser-check.sh"
. "$DIR/scripts/lib/keychain-secret.sh"

missing=0

log_missing() {
  echo "❌ MANCANTE: $1"
  missing=1
}

log_ok() {
  echo "✅ OK: $1"
}

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

# 4. Browser: Chrome consigliato, Chromium ok (scripts/setup/browser-check.sh)
if ! report_browser_status; then
  : # log_missing già chiamato da report_browser_status
fi
# 5. Ollama
if command -v ollama &>/dev/null; then
  log_ok "Ollama ($(ollama --version | head -1))"
else
  log_missing "Ollama"
fi

# 6. Chiave Ollama Cloud nel Portachiavi (nessun segreto stampato)
if ollama_api_key_present; then
  log_ok "Chiave Ollama Cloud nel Portachiavi macOS"
else
  log_missing "Chiave Ollama Cloud (viene richiesta da ./launch-ai-supervisor.sh)"
fi

# 7. OpenCode CLI
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
if command -v opencode &>/dev/null; then
  log_ok "OpenCode ($(opencode --version 2>/dev/null | head -1))"
else
  log_missing "OpenCode CLI"
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
