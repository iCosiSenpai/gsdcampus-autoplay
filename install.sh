#!/bin/bash
#
# install.sh — installer "una riga" per i colleghi.
#
# Uso (incolla nel Terminale del Mac, una sola riga):
#   curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
#
# Cosa fa:
#   1. Verifica che git sia disponibile (lo installa via Command Line Tools se manca).
#   2. Clona il progetto in ~/gsdcampus-autoplay, oppure lo aggiorna (git pull) se già presente.
#      L'aggiornamento NON tocca config.json (è in .gitignore): autologin e orari restano.
#   3. Avvia ./launch-ai-supervisor.sh, che installa il resto (Node, Playwright, Ollama, Claude)
#      e apre l'AI. La parte Ollama/Claude non viene modificata da questo script.
#
# Idempotente: puoi rilanciare lo stesso comando per ricevere fix e banca risposte aggiornati.

set -euo pipefail

REPO_URL="https://github.com/iCosiSenpai/gsdcampus-autoplay.git"
BRANCH="main"
TARGET="$HOME/gsdcampus-autoplay"

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
info() { printf "${BLUE}${BOLD}[INFO]${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}${BOLD}[OK]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}${BOLD}[ATTENZIONE]${NC} %s\n" "$1"; }
err()  { printf "${RED}${BOLD}[ERRORE]${NC} %s\n" "$1"; }

# Quando lo script arriva da "curl | bash", lo stdin è la pipe, non il Terminale.
# Gli script interattivi (sudo, ollama login, incolla autologin) devono leggere da /dev/tty.
TTY_REDIR=""
if [ -e /dev/tty ]; then
  TTY_REDIR="/dev/tty"
fi

echo ""
echo "============================================"
printf "${BOLD}  GSD Campus Autopilot — Installer${NC}\n"
echo "============================================"
echo ""

# 1. git
if ! command -v git >/dev/null 2>&1; then
  warn "git non trovato. Avvio l'installazione dei Command Line Tools di macOS..."
  xcode-select --install 2>/dev/null || true
  err "Completa l'installazione di 'Command Line Tools' nella finestra appena aperta, poi rilancia questo comando."
  exit 1
fi
ok "git disponibile."

# 2. Clona o aggiorna
if [ -d "$TARGET/.git" ]; then
  info "Progetto già presente in $TARGET. Aggiorno (git pull)..."
  git -C "$TARGET" fetch --quiet origin "$BRANCH" || warn "fetch non riuscito, proseguo con la versione locale."
  # Aggiorna senza toccare i file ignorati (config.json, sessioni, log).
  if git -C "$TARGET" merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
    ok "Progetto aggiornato all'ultima versione."
  else
    warn "Impossibile fare un fast-forward pulito (modifiche locali?). Uso la versione attuale."
  fi
elif [ -d "$TARGET" ]; then
  warn "Esiste già $TARGET ma non è una copia git. Non la sovrascrivo: uso il contenuto attuale."
else
  info "Scarico il progetto in $TARGET..."
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$TARGET"
  ok "Progetto scaricato."
fi

cd "$TARGET"
chmod +x ./launch-ai-supervisor.sh ./start.sh ./stop.sh ./status.sh 2>/dev/null || true
chmod +x ./scripts/*.sh 2>/dev/null || true

echo ""
ok "Installazione base completata. Avvio il supervisore AI..."
echo ""

# 3. Avvia il launcher in modo interattivo (legge da terminale anche se siamo in pipe)
if [ -n "$TTY_REDIR" ]; then
  exec ./launch-ai-supervisor.sh < "$TTY_REDIR"
else
  warn "Nessun terminale interattivo rilevato."
  info "Apri il Terminale ed esegui:  cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh"
fi
