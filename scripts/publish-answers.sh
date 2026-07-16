#!/bin/zsh
#
# publish-answers.sh — distribuisce ai colleghi le risposte verificate dall'AI.
#
# Flusso banca condivisa:
#   1. l'AI verifica una risposta → `answers-cli resolve` (trusted + banca pubblica locale)
#   2. questo script fa git add/commit/push di data/known_answers_public.json
#   3. i colleghi la ricevono al prossimo "Aggiorna e avvia" (update-known-answers.sh)
#
# SOLO il maintainer ha i permessi di push: per i colleghi il push fallisce e lo
# script degrada con un messaggio (le loro risposte restano locali e aiutano
# comunque loro). Nessun dato personale: known_answers_public.json contiene solo
# domande+risposte dei quiz.
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
source "$DIR/scripts/lib/ui.sh"

PUBLIC="data/known_answers_public.json"

# Prima allinea la banca pubblica al trusted locale (idempotente).
node scripts/lib/answers-cli.js publish >/dev/null 2>&1 || true

if git diff --quiet -- "$PUBLIC" 2>/dev/null && git diff --cached --quiet -- "$PUBLIC" 2>/dev/null; then
  ok "Banca condivisa già allineata: niente da pubblicare."
  exit 0
fi

# Conteggio risposte per il messaggio di commit.
N=$(node -e "try{console.log(Object.keys(require('./$PUBLIC')).length)}catch(e){console.log('?')}" 2>/dev/null || echo "?")

info "Pubblico le risposte verificate nella banca condivisa (${N} totali)..."
git add "$PUBLIC"
git commit -m "banca risposte: aggiornamento (${N} voci)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" >/dev/null 2>&1 || { warn "Niente da committare."; exit 0; }

if git push origin HEAD >/dev/null 2>&1; then
  ok "Risposte distribuite: i colleghi le riceveranno al prossimo \"Aggiorna e avvia\"."
else
  warn "Push non riuscito (probabilmente non hai i permessi sul repo)."
  info "Le risposte sono salvate localmente e aiutano comunque questo Mac."
  info "Per condividerle a tutti, passa il commit al referente del progetto."
fi
