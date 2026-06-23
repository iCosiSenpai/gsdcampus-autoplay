#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }

export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# Se ~/.local/bin non è ancora nel PATH di questo processo, aggiungilo
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

MODEL="gemma4:31b-cloud"

echo ""
echo "============================================"
echo -e "${BOLD}  gsdcampus-autoplay — AI Supervisor${NC}"
echo "============================================"
echo ""

# 0. Richiedi password sudo all'inizio per mantenere il ticket attivo per tutta la sessione
info "Richiesta privilegi amministrativi (sudo) per l'installazione..."
sudo -v
ok "Privilegi sudo acquisiti."

# 1. Manutenzione pre-avvio (rotazione log, pulizia vecchi dump)
info "Manutenzione pre-avvio..."
if [ -f "$DIR/scripts/maintenance.sh" ]; then
  "$DIR/scripts/maintenance.sh" &>/dev/null || true
fi
ok "Manutenzione completata."

# 2. Verifica/installa requisiti
info "Verifica e installazione requisiti in corso..."
if [ -f "$DIR/scripts/setup.sh" ]; then
  "$DIR/scripts/setup.sh" --yes
else
  err "Errore: scripts/setup.sh non trovato."
  exit 1
fi

# 3. Avvia Ollama se necessario
info "Avvio/controllo Ollama..."
if [ -f "$DIR/scripts/ollama-daemon.sh" ]; then
  "$DIR/scripts/ollama-daemon.sh" start
fi
ok "Ollama pronto."

# 4. Verifica login Ollama e modello cloud
if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo ""
  warn "Il modello $MODEL è un modello CLOUD e richiede il login Ollama."
  warn "Apro il login interattivo. Inserisci le credenziali..."
  echo ""
  ollama login
  echo ""
  info "Download modello $MODEL..."
  ollama pull "$MODEL"

  if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
    warn "Download fallito. Riesegui ./launch-ai-supervisor.sh dopo aver verificato il login."
    exit 1
  fi
fi
ok "Modello $MODEL pronto."

echo ""
echo "============================================"
echo -e "${GREEN}${BOLD}  AI Supervisor pronto${NC}"
echo "  Modello: $MODEL"
echo "============================================"
echo ""
echo -e "${BOLD}Scrivi in chat:${NC}"
echo "  • 'controlla il corso'"
echo "  • 'come sta andando?'"
echo "  • 'avvia il corso'"
echo "  • 'ferma tutto'"
echo ""

# 5. Avvia Claude con skip permessi e modello Ollama
ollama launch claude --model "$MODEL" -- --dangerously-skip-permissions
