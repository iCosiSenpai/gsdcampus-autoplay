#!/bin/zsh
# dev-check.sh — controlli statici per il maintainer, da lanciare PRIMA del push.
# main è produzione (i colleghi aggiornano via curl): questo script blocca le
# classi di errore già viste in produzione.
#
# Uso:  ./scripts/dev-check.sh        (exit 0 = tutto verde)
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

source "$DIR/scripts/lib/ui.sh"

FAIL=0

# 1. Sintassi shell (zsh per gli script del progetto, bash per install.sh).
step "1/3" "Sintassi shell"
for f in *.sh scripts/*.sh scripts/lib/*.sh; do
  [ -f "$f" ] || continue
  if [ "$f" = "install.sh" ]; then
    bash -n "$f" || { err "bash -n $f"; FAIL=1; }
  else
    zsh -n "$f" || { err "zsh -n $f"; FAIL=1; }
  fi
done
if command -v shellcheck >/dev/null 2>&1; then
  shellcheck install.sh || { err "shellcheck install.sh"; FAIL=1; }
fi
[ "$FAIL" -eq 0 ] && ok "Sintassi shell ok."

# 2. Sintassi JavaScript.
step "2/3" "Sintassi JavaScript"
JS_FAIL=0
for f in src/*.js src/lib/*.js scripts/*.js scripts/lib/*.js worker/*.js; do
  [ -f "$f" ] || continue
  node --check "$f" >/dev/null 2>&1 || { err "node --check $f"; JS_FAIL=1; FAIL=1; }
done
[ "$JS_FAIL" -eq 0 ] && ok "Sintassi JavaScript ok."

# 3. Lint anti-regressione: '| grep -q' in uno script con pipefail.
# Bug visto in produzione (07/2026): grep -q esce al primo match chiudendo la
# pipe, il comando a sinistra muore di SIGPIPE (141) e sotto pipefail la
# pipeline fallisce ANCHE col match trovato. Usare 'grep -c PAT >/dev/null'.
step "3/3" "Lint: grep -q in pipeline sotto pipefail"
LINT_FAIL=0
for f in *.sh scripts/*.sh scripts/lib/*.sh; do
  [ -f "$f" ] || continue
  # Salta se stesso: i commenti/stringhe del lint contengono il pattern.
  [ "$f" = "scripts/dev-check.sh" ] && continue
  # Solo script che attivano pipefail (direttamente).
  grep -c 'pipefail' "$f" >/dev/null 2>&1 || continue
  HITS=$(grep -n '| *grep -q' "$f" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    err "$f usa '| grep -q' sotto pipefail (SIGPIPE!): usa 'grep -c PAT >/dev/null'"
    printf '%s\n' "$HITS" | while read -r line; do echo "     $line"; done
    LINT_FAIL=1; FAIL=1
  fi
done
[ "$LINT_FAIL" -eq 0 ] && ok "Nessun '| grep -q' sotto pipefail."

echo ""
if [ "$FAIL" -eq 0 ]; then
  ok "${GREEN}${BOLD}dev-check: tutto verde.${NC}"
else
  err "${RED}${BOLD}dev-check: problemi trovati (vedi sopra). NON pushare.${NC}"
  exit 1
fi
