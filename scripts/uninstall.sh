#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

echo "============================================"
echo " Disinstallazione gsdcampus-autoplay"
echo "============================================"
echo ""
echo "Questo script rimuove:"
echo "  - dipendenze npm"
echo "  - browser Playwright installati"
echo "  - Ollama (inclusi modelli)"
echo "  - Claude Code CLI"
echo "  - log, dump, screenshot e backup"
echo "  - la cartella del progetto (opzionale)"
echo ""
echo "NOTA: non rimuove Homebrew nè Node.js, per non compromettere altri software."
echo ""

read -q "REPLY?Procedere con la disinstallazione? [y/N] "
echo ""
if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
  echo "Uscita."
  exit 1
fi

# 1. Ferma processi attivi
echo ""
echo "-> Arresto processi attivi..."
"$DIR/stop.sh" 2>/dev/null || true
"$DIR/scripts/ollama-daemon.sh" stop 2>/dev/null || true

# 2. Rimuovi dipendenze npm
if [ -d "$DIR/node_modules" ]; then
  echo "-> Rimozione dipendenze npm..."
  rm -rf "$DIR/node_modules"
fi

# 3. Rimuovi browser Playwright
if command -v npx &>/dev/null; then
  echo "-> Rimozione browser Playwright..."
  npx playwright uninstall --all 2>/dev/null || true
fi

# 4. Rimuovi Ollama (modelli inclusi)
if command -v ollama &>/dev/null; then
  echo "-> Rimozione modelli Ollama..."
  ollama rm gemma4:31b-cloud 2>/dev/null || true

  echo "-> Rimozione Ollama..."
  if [ -f /usr/local/bin/ollama ]; then
    sudo rm -f /usr/local/bin/ollama 2>/dev/null || true
  fi
  if [ -d /Applications/Ollama.app ]; then
    sudo rm -rf /Applications/Ollama.app 2>/dev/null || true
  fi
  rm -rf "$HOME/.ollama" 2>/dev/null || true
fi

# 5. Rimuovi Claude Code CLI
if command -v claude &>/dev/null; then
  echo "-> Rimozione Claude Code CLI..."
  rm -f "$HOME/.local/bin/claude" 2>/dev/null || true
  brew uninstall --cask claude 2>/dev/null || true
fi

# 6. Pulizia log, dump, screenshot, backup, pid
echo "-> Pulizia log, dump, screenshot e file temporanei..."
rm -rf "$DIR/logs"
rm -rf "$DIR/debug"
rm -rf "$DIR/backups"
rm -f "$DIR/.autoplay_pid"
rm -f "$DIR/.ollama_pid"
rm -f "$DIR/.scheduler_stop"

# 7. Opzionale: rimozione cartella progetto
echo ""
read -q "REPLY?Rimuovere anche la cartella del progetto $DIR? [y/N] "
echo ""
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  echo "-> Rimozione cartella progetto..."
  cd ..
  rm -rf "$DIR"
  echo "Cartella progetto rimossa."
else
  echo "Cartella progetto conservata."
fi

echo ""
echo "============================================"
echo " Disinstallazione completata."
echo "============================================"
echo ""
