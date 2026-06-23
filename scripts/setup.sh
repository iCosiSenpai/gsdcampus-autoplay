#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Colori per output interattivo
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

AUTO_YES=false
if [ "$1" = "--yes" ]; then
  AUTO_YES=true
fi

info() {
  echo -e "${BLUE}${BOLD}[INFO]${NC} $1"
}
ok() {
  echo -e "${GREEN}${BOLD}[OK]${NC} $1"
}
warn() {
  echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"
}
err() {
  echo -e "${RED}${BOLD}[ERRORE]${NC} $1"
}
step() {
  echo ""
  echo -e "${BOLD}▶ $1${NC}"
}

print_header() {
  echo ""
  echo "============================================"
  echo -e "${BOLD}  Setup gsdcampus-autoplay${NC}"
  echo "============================================"
  echo ""
  echo "Questo script aggiorna/verifica:"
  echo "  • Homebrew e formule installate"
  echo "  • Node.js e npm"
  echo "  • Dipendenze npm (Playwright)"
  echo "  • Browser per Playwright / Google Chrome"
  echo "  • Ollama"
  echo "  • Modello Ollama gemma4:31b-cloud"
  echo "  • Claude Code CLI"
  echo ""
  warn "Se il Terminale chiede di installare/aggiornare qualcosa (anche 'y/n'), conferma SEMPRE."
  warn "Non avere paura: serve tutto per automatizzare il corso."
  echo ""
}

print_footer() {
  echo ""
  echo "============================================"
  ok "Setup completato con successo."
  echo "============================================"
  echo ""
}

print_header

# Se richiesto dall'utente, chiedi sudo all'inizio per mantenere il ticket attivo
if [ "$AUTO_YES" = true ]; then
  info "Richiesta privilegi sudo all'inizio per tutta la sessione..."
  sudo -v 2>/dev/null || true
fi

if [ "$AUTO_YES" = false ]; then
  read -q "REPLY?Procedere? [y/N] "
  echo ""
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    info "Uscita."
    exit 1
  fi
fi

# 1. Homebrew
step "1/7 - Homebrew"
if ! command -v brew &>/dev/null; then
  info "Homebrew non trovato. Installazione in corso..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
else
  ok "Homebrew già installato: $(brew --version | head -1)"
fi
info "Aggiornamento Homebrew..."
brew update
brew upgrade
ok "Homebrew aggiornato."

# 2. Node.js
step "2/7 - Node.js"
if command -v node &>/dev/null; then
  info "Node.js presente: $(node -v). Verifica aggiornamento..."
else
  info "Node.js non trovato. Installazione in corso..."
fi
brew install node 2>/dev/null || true
brew upgrade node 2>/dev/null || true
ok "Node.js pronto: $(node -v)"

# 3. npm dependencies
step "3/7 - Dipendenze npm"
info "Installazione/aggiornamento dipendenze..."
npm install
ok "Dipendenze npm aggiornate."

# 4. Playwright browsers / Chrome
step "4/7 - Browser per Playwright"
info "Installazione/aggiornamento Chromium..."
npx playwright install chromium
ok "Browser Playwright pronto."

# 5. Ollama
step "5/7 - Ollama"
if command -v ollama &>/dev/null; then
  info "Ollama presente: $(ollama --version | head -1). Reinstallazione/aggiornamento..."
else
  info "Ollama non trovato. Installazione in corso..."
fi
curl -fsSL https://ollama.com/install.sh | sh
ok "Ollama pronto."

# 6. Modello gemma4:31b-cloud (cloud, richiede login Ollama)
step "6/7 - Modello Ollama gemma4:31b-cloud"
if ! ollama list 2>/dev/null | grep -q "gemma4:31b-cloud"; then
  warn "Il modello gemma4:31b-cloud è un modello CLOUD e richiede il login Ollama."
  warn "Verrà aperto il login interattivo. Inserisci le tue credenziali."
  echo ""
  # Esegue ollama login in modo interattivo, collegando stdin/stderr correttamente
  ollama login

  info "Download modello gemma4:31b-cloud in corso..."
  ollama pull gemma4:31b-cloud

  if ! ollama list 2>/dev/null | grep -q "gemma4:31b-cloud"; then
    err "Download fallito. Se il login non è andato a buon fine, riesegui ./launch-ai-supervisor.sh."
    exit 1
  fi
else
  ok "Modello gemma4:31b-cloud presente."
fi

# 7. Claude Code CLI
step "7/7 - Claude Code CLI"
if command -v claude &>/dev/null; then
  ok "Claude Code CLI presente: $(claude --version 2>/dev/null | head -1)."
else
  info "Claude Code CLI non trovato. Installazione in corso..."
  curl -fsSL https://claude.ai/install.sh | bash
  ok "Claude Code CLI installato."
fi

# Assicurarsi che ~/.local/bin sia nel PATH (solo se non già presente)
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  info "Aggiunta ~/.local/bin al PATH in .zshrc..."
  export PATH="$HOME/.local/bin:$PATH"
  if [ -f "$HOME/.zshrc" ] && ! grep -q 'export PATH="\$HOME/.local/bin:\$PATH"' "$HOME/.zshrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
  fi
  ok "PATH aggiornato."
fi

print_footer
