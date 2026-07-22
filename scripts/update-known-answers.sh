#!/bin/zsh
set -eu -o pipefail

# Mergia la banca pubblica nel trusted locale.
# Prima usa SEMPRE data/known_answers_public.json gia ricevuto con git pull;
# il fetch remoto e solo un aggiornamento best-effort, throttled di default,
# e non annulla il merge locale quando la rete non e disponibile.

FORCE_SYNC=false
case "${1:-}" in
  "") ;;
  --force) FORCE_SYNC=true ;;
  *) echo "Uso: $0 [--force]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "Uso: $0 [--force]" >&2
  exit 2
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
mkdir -p "$DIR/data" "$DIR/logs"

echo "[INFO] Aggiorno la banca risposte pubblica..."
GSD_BANK_SYNC_FORCE="$FORCE_SYNC" node -e "
  const { syncPublicBank } = require('./src/lib/bank-sync');
  syncPublicBank('.', {
    force: process.env.GSD_BANK_SYNC_FORCE === 'true',
    log: (message) => console.log('[INFO] ' + message),
  }).then((result) => {
    if (result.ok) {
      if (result.skipped) {
        console.log('[OK] File pubblico locale allineato; fetch remoto non necessario (throttle attivo).');
      } else {
        console.log('[OK] Banca risposte allineata: +' + Number(result.added || 0) + ' risposta/e.');
      }
      process.exit(0);
    }
    if (result.localMerged) {
      console.log('[WARN] File pubblico locale mergiato; fetch remoto saltato: ' + (result.error || 'offline'));
      process.exit(0);
    }
    console.log('[WARN] Aggiornamento banca incompleto: ' + (result.error || 'errore sconosciuto'));
    process.exit(0);
  }).catch((error) => {
    console.log('[WARN] Aggiornamento banca non disponibile: ' + error.message);
    process.exit(0);
  });
"
