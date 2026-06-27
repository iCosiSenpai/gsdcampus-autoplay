#!/bin/zsh
set -e

# Aggiorna la banca risposte locale scaricando quella pubblica dal repository e
# facendone il merge con le risposte personali dell'utente.
# Questo script viene chiamato automaticamente dall'installer durante l'aggiornamento.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

LOCAL_FILE="$DIR/data/known_answers.json"
PUBLIC_URL="https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/data/known_answers_public.json"
REMOTE_FILE="/tmp/known_answers_public.json.$$"

mkdir -p "$DIR/data"

if ! command -v curl >/dev/null 2>&1; then
  echo "[WARN] curl non disponibile, salto aggiornamento banca risposte pubblica."
  exit 0
fi

echo "[INFO] Controllo banca risposte pubblica..."
if curl -fsSL --max-time 20 "$PUBLIC_URL" -o "$REMOTE_FILE" 2>/dev/null; then
  node -e "
    const fs = require('fs');
    const localPath = '$LOCAL_FILE';
    const remotePath = '$REMOTE_FILE';
    let local = {};
    let remote = {};
    try { local = JSON.parse(fs.readFileSync(localPath, 'utf8')); } catch (_) {}
    try { remote = JSON.parse(fs.readFileSync(remotePath, 'utf8')); } catch (_) {}
    const merged = { ...remote, ...local };
    const added = Object.keys(remote).filter(k => !(k in local)).length;
    fs.writeFileSync(localPath, JSON.stringify(merged, null, 2));
    console.log('[OK] Banca risposte aggiornata: +' + added + ' nuove risposte dalla repo pubblica.');
  "
  rm -f "$REMOTE_FILE"
else
  echo "[WARN] Impossibile scaricare la banca risposte pubblica (offline o non ancora creata)."
  rm -f "$REMOTE_FILE"
  exit 0
fi
