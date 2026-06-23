#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
CHECK_REQ="$DIR/scripts/check-requirements.sh"

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err() { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }
step() { echo -e "${BOLD}[PASSO $1]${NC} $2"; }

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

# Controlla se tutti i requisiti sono già soddisfatti (senza output)
requirements_satisfied() {
  [ -f "$CHECK_REQ" ] || return 1
  "$CHECK_REQ" >/dev/null 2>&1
}

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

# 1. Verifica configurazione iniziale
step "1/5" "Verifica configurazione"
CONFIG_OK=false
if [ -f "$DIR/config.json" ]; then
  if node "$SCHEDULE_CLI" is-work-time >/dev/null 2>&1; then
    CONFIG_OK=true
    ok "config.json valido."
    info "Orario configurato: $(node "$SCHEDULE_CLI" describe 2>/dev/null || echo 'non disponibile')"
  else
    warn "config.json presente ma non valido o incompleto."
  fi
else
  warn "config.json non trovato."
fi

if [ "$CONFIG_OK" = false ]; then
  warn "Eseguo il setup interattivo per configurare autologin e orari."
  if [ -f "$DIR/scripts/setup.sh" ]; then
    "$DIR/scripts/setup.sh"
  else
    err "Errore: scripts/setup.sh non trovato."
    exit 1
  fi
fi

# 2. Manutenzione pre-avvio (rotazione log, pulizia vecchi dump)
step "2/5" "Manutenzione pre-avvio"
if [ -f "$DIR/scripts/maintenance.sh" ]; then
  "$DIR/scripts/maintenance.sh" &>/dev/null || true
fi
ok "Manutenzione completata."

# 3. Verifica/installa requisiti: fast-path se tutto è già a posto
step "3/5" "Verifica requisiti"
if requirements_satisfied; then
  ok "Tutti i requisiti sono già soddisfatti. Salto l'installazione."
else
  warn "Requisiti mancanti o da verificare. Avvio setup..."
  # Richiedi sudo solo se serve davvero installare qualcosa
  info "Richiesta privilegi amministrativi (sudo) per l'installazione..."
  sudo -v
  ok "Privilegi sudo acquisiti."

  if [ -f "$DIR/scripts/setup.sh" ]; then
    "$DIR/scripts/setup.sh" --yes
  else
    err "Errore: scripts/setup.sh non trovato."
    exit 1
  fi
fi

# 4. Avvia Ollama se necessario
step "4/5" "Avvio/controllo Ollama"
if [ -f "$DIR/scripts/ollama-daemon.sh" ]; then
  "$DIR/scripts/ollama-daemon.sh" start
fi
ok "Ollama pronto."

# 5. Verifica che Claude Code CLI sia accessibile
step "5/5" "Claude Code CLI"
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

# Verifica login Ollama e modello cloud (rapida, nessun download se già presente)
if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo ""
  warn "Il modello $MODEL è un modello CLOUD e richiede il login Ollama."
  warn "Apro il login interattivo. Inserisci le tue credenziali..."
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

# Avvia Claude con skip permessi e modello Ollama
info "Avvio Claude Code con modello $MODEL..."
ollama launch claude --model "$MODEL" -- --dangerously-skip-permissions
