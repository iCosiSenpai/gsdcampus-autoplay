#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Legge il modello Ollama da config.json (campo `ollamaModel`).
# Fallback a costante letterale (NON a ${OLLAMA_MODEL}: circolare — vedi check-requirements.sh).
MODEL_FALLBACK="gemma4:cloud"
get_ollama_model() {
  node -e "try { const c=require('./config.json'); console.log(c.ollamaModel || '${MODEL_FALLBACK}'); } catch(e){ console.log('${MODEL_FALLBACK}'); }" 2>/dev/null || echo "${MODEL_FALLBACK}"
}
OLLAMA_MODEL="$(get_ollama_model)"

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; NC='\033[0m'
ok()   { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err()  { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }

# ask_yes "prompt" "default(y|n)" -> ritorna 0 se l'utente sceglie sì.
# Default = comportamento di "disinstallazione completa": se il collega preme solo
# Invio, viene applicato il default. Le conferme per-item servono proprio a lasciar
# fuori ciò che gli serve ancora (es. Claude Code o Ollama usati per altro).
ask_yes() {
  local prompt="$1" def="$2"
  local REPLY=""
  if [ "$def" = "y" ]; then
    read -q "REPLY?$prompt [Y/n] " || true
  else
    read -q "REPLY?$prompt [y/N] " || true
  fi
  echo ""
  if [ -z "$REPLY" ]; then
    [ "$def" = "y" ] && return 0 || return 1
  fi
  [[ "$REPLY" =~ ^[Yy]$ ]]
}

echo "============================================"
echo " Disinstallazione gsdcampus-autoplay"
echo "============================================"
echo ""
echo "Ti chiedo conferma per ogni componente, così tieni ciò che ti serve ancora."
echo "Il DEFAULT è 'sì' (rimuovi): premi Invio per accettarlo, oppure 'n' per conservare."
echo ""
echo "Posso rimuovere:"
echo "  - browser di Playwright + cache (~500 MB)"
echo "  - dipendenze npm (node_modules)"
echo "  - Ollama: app/binario, modelli scaricati e ~/.ollama (anche diversi GB)"
echo "  - Claude Code CLI"
echo "  - log, dump, screenshot, backup e file temporanei"
echo "  - riga PATH aggiunta da setup.sh nei file dello shell"
echo "  - la cartella del progetto $DIR"
echo ""
echo "NON tocchiamo in ogni caso (per non rompere altri software): Homebrew, Node.js, Google Chrome."
echo ""

if ! ask_yes "Procedere con la disinstallazione?" "n"; then
  echo "Uscita. Niente è stato modificato."
  exit 0
fi

# 0. Ferma processi attivi (sempre, indipendente dalle conferme: è harmless)
echo ""
ok "Arresto processi attivi..."
"$DIR/stop.sh" 2>/dev/null || true
"$DIR/scripts/ollama-daemon.sh" stop 2>/dev/null || true

# 1. Browser di Playwright + cache
echo ""
if ask_yes "Rimuovere i browser di Playwright + la loro cache (~500 MB)?" "y"; then
  echo "-> Rimozione browser Playwright..."
  if [ -d "$DIR/node_modules/playwright" ] || [ -d "$DIR/node_modules/playwright-core" ]; then
    (cd "$DIR" && npx --no-install playwright uninstall --all 2>/dev/null) || true
  fi
  if [ -d "$HOME/Library/Caches/ms-playwright" ]; then
    echo "   Pulizia cache browser (~$(du -sh "$HOME/Library/Caches/ms-playwright" 2>/dev/null | cut -f1))..."
    rm -rf "$HOME/Library/Caches/ms-playwright"
  fi
  ok "Browser Playwright rimossi."
else
  warn "Browser Playwright conservati."
fi

# 2. Dipendenze npm
echo ""
if [ -d "$DIR/node_modules" ]; then
  if ask_yes "Rimuovere le dipendenze npm (node_modules)?" "y"; then
    echo "-> Rimozione node_modules..."
    rm -rf "$DIR/node_modules"
    ok "node_modules rimosso."
  else
    warn "node_modules conservato."
  fi
fi

# 3. Ollama (modelli, binario, app, ~/.ollama)
echo ""
HAS_OLLAMA=false
if command -v ollama &>/dev/null || [ -d /Applications/Ollama.app ] || [ -d "$HOME/.ollama" ]; then
  HAS_OLLAMA=true
fi
if [ "$HAS_OLLAMA" = true ]; then
  if ask_yes "Rimuovere Ollama (app, binario, modelli e ~/.ollama, anche GB)?" "y"; then
    echo "-> Rimozione modelli Ollama..."
    if command -v ollama &>/dev/null; then
      ollama rm ${OLLAMA_MODEL} 2>/dev/null || true
    fi
    echo "-> Rimozione Ollama..."
    if command -v brew &>/dev/null && brew list ollama &>/dev/null; then
      brew uninstall ollama 2>/dev/null || true
    fi
    [ -f /usr/local/bin/ollama ] && sudo rm -f /usr/local/bin/ollama 2>/dev/null || true
    [ -f /opt/homebrew/bin/ollama ] && rm -f /opt/homebrew/bin/ollama 2>/dev/null || true
    [ -d /Applications/Ollama.app ] && sudo rm -rf /Applications/Ollama.app 2>/dev/null || true
    rm -rf "$HOME/.ollama" 2>/dev/null || true
    ok "Ollama rimosso."
  else
    warn "Ollama conservato (lo usi anche per altro, lo lascio stare)."
  fi
fi

# 4. Claude Code CLI
echo ""
if command -v claude &>/dev/null || [ -x "$HOME/.local/bin/claude" ]; then
  if ask_yes "Rimuovere Claude Code CLI?" "y"; then
    echo "-> Rimozione Claude Code CLI..."
    rm -f "$HOME/.local/bin/claude" 2>/dev/null || true
    brew uninstall --cask claude 2>/dev/null || true
    ok "Claude Code CLI rimosso."
  else
    warn "Claude Code CLI conservato (lo usi anche per altro, lo lascio stare)."
  fi
fi

# 5. Log, dump, screenshot, backup, pid (roba interna al progetto)
echo ""
# LaunchAgent dell'auto-update notturno: va sempre rimosso (altrimenti launchd
# continuerebbe a lanciare uno script che non esiste più).
echo "-> Rimozione auto-update notturno (launchd)..."
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.gsdcampus.autoplay.autoupdate.plist" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/com.gsdcampus.autoplay.autoupdate.plist" 2>/dev/null || true

if ask_yes "Rimuovere log, dump, screenshot, backup e file temporanei del progetto?" "y"; then
  echo "-> Pulizia log/dump/backup..."
  rm -rf "$DIR/logs" 2>/dev/null || true
  rm -rf "$DIR/debug" 2>/dev/null || true
  rm -rf "$DIR/backups" 2>/dev/null || true
  rm -f "$DIR/.autoplay_pid" 2>/dev/null || true
  rm -f "$DIR/.ollama_pid" 2>/dev/null || true
  rm -f "$DIR/.scheduler_stop" 2>/dev/null || true
  ok "File temporanei rimossi."
else
  warn "Log e file temporanei conservati."
fi

# 6. Riga PATH aggiunta da setup.sh nei file di shell
echo ""
if ask_yes "Rimuovere la riga PATH (~/.local/bin) aggiunta da setup.sh nei file di shell?" "y"; then
  echo "-> Rimozione riga PATH..."
  local_path_line='export PATH="$HOME/.local/bin:$PATH"'
  for f in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc"; do
    if [ -f "$f" ] && grep -qF "$local_path_line" "$f" 2>/dev/null; then
      human="${f/#$HOME/~}"
      echo "   Rimuovo da $human"
      grep -vF "$local_path_line" "$f" > "$f.tmp"
      mv "$f.tmp" "$f"
    fi
  done
  ok "Riga PATH rimossa."
else
  warn "Riga PATH conservata (utile se hai altri tool in ~/.local/bin)."
fi

# 7. Cartella del progetto (la cosa più distruttiva: la chiedo per ultima)
echo ""
if ask_yes "Rimuovere ANCHE la cartella del progetto $DIR (tutto il codice e config.json)?" "y"; then
  echo "-> Rimozione cartella progetto..."
  cd ..
  rm -rf "$DIR"
  ok "Cartella progetto rimossa."
else
  warn "Cartella progetto conservata in $DIR."
fi

echo ""
echo "============================================"
ok "Disinstallazione completata."
echo "============================================"
echo ""