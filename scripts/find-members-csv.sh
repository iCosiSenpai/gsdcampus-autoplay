#!/bin/zsh
# find-members-csv.sh — SOLO maintainer/referente che aggiorna members.db.
#
# I colleghi NON usano questo file. Loro: install → "Chi sei?" (cerca il nome).
# members.db (con gli autologin) arriva già dal git clone / curl.
#
# Uso (maintainer, dopo export FNC):
#   ./scripts/find-members-csv.sh
#   node scripts/import-members.js "/path/al.csv"
#   git add data/members.db && git commit && git push
set -eu

DIR_DL="${HOME}/Downloads"
if [ ! -d "$DIR_DL" ]; then
  echo "Nessuna cartella Downloads."
  echo "Colleghi: non vi serve. Al setup usate «Chi sei?» e cercate il vostro nome."
  exit 1
fi

found=$(find "$DIR_DL" -maxdepth 1 -type f \( -iname '*elenco*utenti*.csv' -o -iname '*fnc*.csv' -o -iname '*membri*.csv' -o -iname '*utenti*.csv' \) -mtime -14 2>/dev/null | head -20)
if [ -z "$found" ]; then
  found=$(find "$DIR_DL" -maxdepth 1 -type f -iname '*.csv' -mtime -7 2>/dev/null | head -10)
fi

if [ -z "$found" ]; then
  echo "Nessun CSV elenco in ~/Downloads."
  echo ""
  echo "• Collega: non serve CSV né link. Setup → Chi sei? → cerca il tuo nome."
  echo "• Maintainer: esporta elenco FNC (CSV) per aggiornare members.db, poi commit+push."
  exit 1
fi

echo "CSV candidati (import → members.db → push, solo maintainer):"
echo "$found" | while read -r f; do
  echo "  $f"
done
echo ""
echo "Import: node scripts/import-members.js \"/path/al.csv\""
echo "Poi:    git add data/members.db && git commit -m 'chore: refresh members.db' && git push"
