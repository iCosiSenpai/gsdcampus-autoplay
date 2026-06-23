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
err() { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }

# Assicurati che ~/.local/bin sia nel PATH, anche se .zshrc non è ancora stato sourceato
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Tenta di sourceare .zshrc per ereditare eventuali PATH aggiuntivi, silenziosamente
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc" >/dev/null 2>&1 || true
fi

MODEL="gemma4:31b-cloud"

echo ""
echo "============================================"
echo -e "${BOLD}  gsdcampus-autoplay — AI Supervisor${NC}"
echo "============================================"
echo ""

# 0. Ferma eventuali istanze precedenti per evitare conflitti tra codice vecchio e nuovo
info "Controllo e arresto eventuali istanze precedenti..."
if [ -f "$DIR/.autoplay_pid" ]; then
  OLD_PID=$(cat "$DIR/.autoplay_pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    warn "Trovato scheduler precedente (PID $OLD_PID). Arresto in corso..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
    kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$DIR/.autoplay_pid"
fi
pgrep -f "node src/autoplay.js" 2>/dev/null | while read orphan; do
  kill -9 "$orphan" 2>/dev/null || true
done
pgrep -f "scheduler.sh" 2>/dev/null | while read orphan; do
  [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
done
ok "Pulizia istanze precedenti completata."

# 1. Richiedi password sudo all'inizio per mantenere il ticket attivo per tutta la sessione
info "Richiesta privilegi amministrativi (sudo) per l'installazione..."
sudo -v
ok "Privilegi sudo acquisiti."

# 2. Manutenzione pre-avvio (rotazione log, pulizia vecchi dump)
info "Manutenzione pre-avvio..."
if [ -f "$DIR/scripts/maintenance.sh" ]; then
  "$DIR/scripts/maintenance.sh" &>/dev/null || true
fi
ok "Manutenzione completata."

# 3. Verifica/installa requisiti
info "Verifica e installazione requisiti in corso..."
if [ -f "$DIR/scripts/setup.sh" ]; then
  "$DIR/scripts/setup.sh" --yes
else
  err "Errore: scripts/setup.sh non trovato."
  exit 1
fi

# 4. Avvia Ollama se necessario
info "Avvio/controllo Ollama..."
if [ -f "$DIR/scripts/ollama-daemon.sh" ]; then
  "$DIR/scripts/ollama-daemon.sh" start
fi
ok "Ollama pronto."

# 5. Verifica che Claude Code CLI sia accessibile
step "5/5 - Claude Code CLI"
if command -v claude &>/dev/null; then
  ok "Claude Code CLI trovato: $(claude --version 2>/dev/null | head -1)."
else
  warn "Claude Code CLI non trovato nel PATH. Forzo ~/.local/bin..."
  if [ -x "$HOME/.local/bin/claude" ]; then
    export PATH="$HOME/.local/bin:$PATH"
    ok "Claude Code CLI trovato in ~/.local/bin."
  else
    err "Claude Code CLI non trovato. Esegui ./scripts/setup.sh o riapri il Terminale."
    exit 1
  fi
fi

# 6. Verifica login Ollama e modello cloud
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

# 6. Avvia Claude con skip permessi e modello Ollama
info "Avvio Claude Code con modello $MODEL..."
ollama launch claude --model "$MODEL" -- --dangerously-skip-permissions
