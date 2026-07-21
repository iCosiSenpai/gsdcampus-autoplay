#!/bin/zsh
# Niente `set -e`: è uno script diagnostico che deve eseguire TUTTI i check e
# riportare ogni mancanza, non fermarsi al primo comando in errore. L'esito
# finale è deciso dal flag `missing` e dagli exit espliciti in fondo.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# shellcheck source=scripts/setup/package-hash.sh
. "$DIR/scripts/setup/package-hash.sh"
. "$DIR/scripts/setup/browser-check.sh"
. "$DIR/scripts/setup/versions.sh"

missing=0

log_missing() {
  echo "❌ MANCANTE: $1"
  missing=1
}

log_ok() {
  echo "✅ OK: $1"
}

MODEL_FALLBACK="gemma4:31b-cloud"
get_ollama_model() {
  node -e "try { const c=require('./config.json'); console.log(c.ollamaModel || '${MODEL_FALLBACK}'); } catch(e){ console.log('${MODEL_FALLBACK}'); }" 2>/dev/null || echo "${MODEL_FALLBACK}"
}
OLLAMA_MODEL="$(get_ollama_model)"

# 1. Homebrew (opzionale, serve per Node.js/Ollama su alcuni sistemi)
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

# 4. Browser: Chrome consigliato, Chromium ok
if ! report_browser_status; then
  :
fi

# 5. Ollama CLI + daemon + modello Cloud registrato localmente
if command -v ollama &>/dev/null; then
  OLLAMA_VER=$(ollama --version 2>/dev/null | extract_version)
  if [ -z "$OLLAMA_VER" ] || ! version_ge "$OLLAMA_VER" "$MIN_OLLAMA"; then
    log_missing "Ollama >= $MIN_OLLAMA (versione attuale: ${OLLAMA_VER:-sconosciuta})"
  else
    log_ok "Ollama v$OLLAMA_VER"
  fi
  if ! curl -fsS "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    log_missing "Server Ollama su 127.0.0.1:11434 (verrà avviato dal launcher)"
  elif ollama list 2>/dev/null | grep -F -c "$OLLAMA_MODEL" >/dev/null; then
    log_ok "Modello Ollama $OLLAMA_MODEL"
  else
    log_missing "Modello Ollama $OLLAMA_MODEL (il launcher aprirà ollama signin se necessario)"
  fi
else
  log_missing "Ollama CLI"
fi

# 6. OpenCode CLI
export PATH="$HOME/.opencode/bin:$HOME/.local/bin:$PATH"
if command -v opencode &>/dev/null; then
  OPENCODE_VER=$(opencode --version 2>/dev/null | extract_version)
  if [ -n "$OPENCODE_VER" ] && version_ge "$OPENCODE_VER" "$MIN_OPENCODE"; then
    log_ok "OpenCode v$OPENCODE_VER"
  else
    log_missing "OpenCode >= $MIN_OPENCODE (versione attuale: ${OPENCODE_VER:-sconosciuta})"
  fi
else
  log_missing "OpenCode CLI"
fi

# 7. osascript (macOS)
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
