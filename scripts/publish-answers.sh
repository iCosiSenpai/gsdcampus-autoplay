#!/bin/zsh
#
# publish-answers.sh — distribuisce ai colleghi le risposte verificate dall'AI.
#
# Flusso banca condivisa:
#   1. l'AI verifica → `answers-cli resolve` (trusted + public locale)
#   2. questo script:
#        a) answers-cli share → merge locale + POST /answers al Worker (commit su main)
#        b) opzionale: git commit+push se ci sono permessi (maintainer)
#   3. i colleghi ricevono al prossimo "Aggiorna e avvia" (update-known-answers.sh)
#
# Path primario = Cloudflare Worker (nessun git push richiesto).
# Git push = bonus maintainer. Solo domande+risposte quiz, nessun dato personale.
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
source "$DIR/scripts/lib/ui.sh"

PUBLIC="data/known_answers_public.json"
SHARE_OK=0
PUSH_OK=0

# 1) Share: merge trusted→public + POST delta al Worker.
#    Exit 0 se niente di nuovo o remote ok; exit 1 se remote fallisce con delta.
SHARE_OUT=$(node scripts/lib/answers-cli.js share 2>&1) && SHARE_RC=0 || SHARE_RC=$?
printf '%s\n' "$SHARE_OUT"
if [ "$SHARE_RC" -eq 0 ]; then
  SHARE_OK=1
else
  warn "Share via receiver non riuscito."
fi

# 2) Git commit+push opzionale (history / maintainer).
if git diff --quiet -- "$PUBLIC" 2>/dev/null && git diff --cached --quiet -- "$PUBLIC" 2>/dev/null; then
  : # file già allineato a HEAD
else
  N=$(node -e "try{console.log(Object.keys(require('./$PUBLIC')).filter(k=>k!=='README').length)}catch(e){console.log('?')}" 2>/dev/null || echo "?")
  info "Commit locale della banca condivisa (${N} voci)..."
  git add "$PUBLIC"
  if git commit -m "banca risposte: aggiornamento (${N} voci)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" >/dev/null 2>&1; then
    if git push origin HEAD >/dev/null 2>&1; then
      PUSH_OK=1
      ok "Push git ok (maintainer)."
    else
      info "Push git non riuscito (normale sui Mac dei colleghi): il canale primario è il receiver."
    fi
  fi
fi

# 3) Riepilogo
if [ "$SHARE_OK" -eq 1 ] || [ "$PUSH_OK" -eq 1 ]; then
  ok "Distribuzione completata. I colleghi aggiornano al prossimo \"Aggiorna e avvia\"."
  exit 0
fi

warn "Non è stato possibile distribuire le risposte (né receiver né push)."
info "Restano su questo Mac. Riprova: node scripts/lib/answers-cli.js share --all"
info "Oppure verifica Worker + PAT Contents:write (worker/README.md)."
exit 1
