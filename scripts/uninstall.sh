#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Legge il modello Ollama da config.json (campo `ollamaModel`).
get_ollama_model() {
  node -e "try { const c=require('./config.json'); console.log(c.ollamaModel || '${OLLAMA_MODEL}'); } catch(e){ console.log('${OLLAMA_MODEL}'); }" 2>/dev/null || echo '${OLLAMA_MODEL}'
}
OLLAMA_MODEL=$(get_ollama_model)

echo "============================================"
echo " Disinstallazione gsdcampus-autoplay"
echo "============================================"
echo ""
echo "Questo script RIMUOVE:"
echo "  - dipendenze npm (node_modules)"
echo "  - browser di Playwright + relativa cache (~500 MB)"
echo "  - Ollama: app/binario, modelli scaricati e ~/.ollama (anche diversi GB)"
echo "  - Claude Code CLI"
echo "  - la riga PATH aggiunta da setup.sh ai file dello shell"
echo "  - log, dump, screenshot, backup e file temporanei (.pid, ...)"
echo "  - la cartella del progetto (a parte, con conferma)"
echo ""
echo "NON rimuove (per non rompere altri software del Mac):"
echo "  - Homebrew e Node.js"
echo "  - Google Chrome (è il tuo browser, non lo tocchiamo)"
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

# 2. Rimuovi i browser di Playwright — PRIMA di cancellare node_modules, altrimenti
#    `npx playwright` non troverebbe più il pacchetto e dovrebbe riscaricarlo (o
#    fallire in silenzio), lasciando sul disco la cache dei browser (~500+ MB).
echo "-> Rimozione browser Playwright..."
if [ -d "$DIR/node_modules/playwright" ] || [ -d "$DIR/node_modules/playwright-core" ]; then
  (cd "$DIR" && npx --no-install playwright uninstall --all 2>/dev/null) || true
fi
# Fallback esplicito: rimuovi comunque la cache dei browser di Playwright, che è
# il grosso dello spazio occupato. `playwright uninstall` da solo a volte non la
# svuota del tutto, e questo copre anche il caso in cui il comando sopra fallisca.
if [ -d "$HOME/Library/Caches/ms-playwright" ]; then
  echo "   Pulizia cache browser (~$(du -sh "$HOME/Library/Caches/ms-playwright" 2>/dev/null | cut -f1))..."
  rm -rf "$HOME/Library/Caches/ms-playwright"
fi

# 3. Rimuovi dipendenze npm
if [ -d "$DIR/node_modules" ]; then
  echo "-> Rimozione dipendenze npm..."
  rm -rf "$DIR/node_modules"
fi

# 4. Rimuovi Ollama (modelli inclusi)
if command -v ollama &>/dev/null; then
  echo "-> Rimozione modelli Ollama..."
  ollama rm ${OLLAMA_MODEL} 2>/dev/null || true

  echo "-> Rimozione Ollama..."
  # Se installato via Homebrew, disinstallalo da lì (altrimenti resterebbe).
  if command -v brew &>/dev/null && brew list ollama &>/dev/null; then
    brew uninstall ollama 2>/dev/null || true
  fi
  if [ -f /usr/local/bin/ollama ]; then
    sudo rm -f /usr/local/bin/ollama 2>/dev/null || true
  fi
  if [ -f /opt/homebrew/bin/ollama ]; then
    rm -f /opt/homebrew/bin/ollama 2>/dev/null || true
  fi
  if [ -d /Applications/Ollama.app ]; then
    sudo rm -rf /Applications/Ollama.app 2>/dev/null || true
  fi
  # Modelli scaricati + config (~/.ollama può pesare diversi GB).
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

# 7. Rimuovi la riga PATH che lo script aveva aggiunto ai file di configurazione
#    dello shell, per non lasciare tracce (non tocca altre righe PATH).
echo "-> Rimozione riga PATH aggiunta da setup.sh..."
local_path_line='export PATH="$HOME/.local/bin:$PATH"'
for f in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc"; do
  if [ -f "$f" ] && grep -qF "$local_path_line" "$f" 2>/dev/null; then
    human="${f/#$HOME/~}"
    echo "   Rimuovo da $human"
    grep -vF "$local_path_line" "$f" > "$f.tmp"
    mv "$f.tmp" "$f"
  fi
done

# 8. Opzionale: rimozione cartella progetto
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
