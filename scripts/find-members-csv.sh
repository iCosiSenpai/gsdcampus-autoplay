#!/bin/zsh
# Trova CSV elenco utenti recenti in ~/Downloads (per import-members).
# Uso: ./scripts/find-members-csv.sh
set -eu
DIR_DL="${HOME}/Downloads"
if [ ! -d "$DIR_DL" ]; then
  echo "Nessuna cartella Downloads."
  exit 1
fi
# Preferisci nomi tipo "elenco*utenti*" / FNC / .csv recenti (7 giorni)
found=$(find "$DIR_DL" -maxdepth 1 -type f \( -iname '*elenco*utenti*.csv' -o -iname '*fnc*.csv' -o -iname '*membri*.csv' -o -iname '*utenti*.csv' \) -mtime -14 2>/dev/null | head -20)
if [ -z "$found" ]; then
  found=$(find "$DIR_DL" -maxdepth 1 -type f -iname '*.csv' -mtime -7 2>/dev/null | head -10)
fi
if [ -z "$found" ]; then
  echo "Nessun CSV recente in ~/Downloads. Esporta da Numbers: File ▸ Esporta ▸ CSV."
  exit 1
fi
echo "CSV candidati (più recenti in alto):"
echo "$found" | while read -r f; do
  echo "  $f"
done
echo ""
echo "Import: node scripts/import-members.js \"\$PATH_CSV\""
