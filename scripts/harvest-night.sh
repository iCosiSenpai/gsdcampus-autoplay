#!/bin/zsh
# harvest-night.sh — solo harvest/reconcile/census (niente video autoplay).
# Utile di notte o per riempire la banca domande prima del run diurno.
#
# Uso:
#   ./scripts/harvest-night.sh
#   ./scripts/harvest-night.sh --no-ai-request   # senza scrivere ai_quiz_request
#
# NON lanciare in parallelo all'autoplay (stesso browser/account → conflitti).

set -eu -o pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

TO_AI=true
for a in "$@"; do
  case "$a" in
    --no-ai-request) TO_AI=false ;;
    -h|--help)
      echo "Uso: $0 [--no-ai-request]"
      exit 0
      ;;
  esac
done

mkdir -p "$DIR/logs"
LOG="$DIR/logs/harvest-night.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

echo "$(ts) | harvest-night: avvio (to-ai-request=$TO_AI)" | tee -a "$LOG"

ARGS=(--all)
if [ "$TO_AI" = true ]; then
  ARGS+=(--to-ai-request)
fi

# --all fa census + reconcile(+reset) + harvest domande pendenti in un login.
if node "$DIR/scripts/harvest-answers.js" "${ARGS[@]}" 2>&1 | tee -a "$LOG"; then
  echo "$(ts) | harvest-night: ok" | tee -a "$LOG"
  echo "Prossimo passo AI: leggi ai_quiz_request / answers-cli resolve / publish-answers."
  exit 0
else
  ec=$?
  echo "$(ts) | harvest-night: fallito (exit $ec)" | tee -a "$LOG"
  exit "$ec"
fi
