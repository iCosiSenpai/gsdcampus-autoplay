#!/bin/zsh
# find-members-csv.sh — SOLO per chi ha già l'export FNC (referente / admin).
#
# I colleghi normali NON usano questo script: al setup basta il link di
# autologin (incolla). Il CSV non è sul Mac di default e non arriva dal curl.
#
# Uso (referente): ./scripts/find-members-csv.sh
# Poi: node scripts/import-members.js "/path/al.csv"
set -eu

DIR_DL="${HOME}/Downloads"
if [ ! -d "$DIR_DL" ]; then
  echo "Nessuna cartella Downloads."
  echo "Se sei un collega: non ti serve il CSV. Al setup incolla il link di autologin."
  exit 1
fi

# Preferisci nomi tipo "elenco*utenti*" / FNC / .csv recenti (14 giorni)
found=$(find "$DIR_DL" -maxdepth 1 -type f \( -iname '*elenco*utenti*.csv' -o -iname '*fnc*.csv' -o -iname '*membri*.csv' -o -iname '*utenti*.csv' \) -mtime -14 2>/dev/null | head -20)
if [ -z "$found" ]; then
  found=$(find "$DIR_DL" -maxdepth 1 -type f -iname '*.csv' -mtime -7 2>/dev/null | head -10)
fi

if [ -z "$found" ]; then
  echo "Nessun CSV elenco-utenti in ~/Downloads."
  echo ""
  echo "• Collega: non serve. Setup → incolla il TUO link di autologin."
  echo "• Referente: esporta l'elenco FNC (Numbers ▸ CSV) e rilancia questo script."
  exit 1
fi

echo "CSV candidati (solo se stai importando l'elenco completo):"
echo "$found" | while read -r f; do
  echo "  $f"
done
echo ""
echo "Import: node scripts/import-members.js \"/path/al.csv\""
