#!/bin/zsh
#
# monitor-course.sh — monitor LIVE del corso.
#
# Mostra in tempo reale, aggiornandosi ogni N secondi:
#   • stato del processo (attivo/fermo) e PID
#   • orario lavorativo (in orario / fuori orario, prossimo turno)
#   • corso/lezione attuale, progresso video, esito ultimo quiz
#   • riepilogo corsi (done / in_progress / need_help)
#   • freschezza dell'heartbeat (quanti secondi fa l'ultimo segnale di vita)
#   • avvisi se lo stato è vecchio o se c'è un problema di autologin
#
# Uso:
#   ./scripts/monitor-course.sh            # aggiorna ogni 30s
#   ./scripts/monitor-course.sh 10          # aggiorna ogni 10s
#   ./scripts/monitor-course.sh --once      # stampa una volta sola ed esci
#
# Premi Ctrl-C per uscire.

set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
PID_FILE="$DIR/.autoplay_pid"

# pid_matches condiviso (protezione PID recycling).
source "$DIR/scripts/lib/pid-utils.sh"

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; DIM='\033[2m'; NC='\033[0m'

INTERVAL=30
ONCE=false
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=true ;;
    *[0-9]) if [[ "$arg" =~ ^[0-9]+$ ]]; then INTERVAL="$arg"; fi ;;
  esac
done

render() {
  clear 2>/dev/null || true
  echo "============================================"
  echo -e "${BOLD}  Monitor corso GSD Campus${NC}   ${DIM}$(date '+%H:%M:%S')${NC}"
  echo "============================================"

  # ── Processo ── (pid_matches: un PID recyclato non risulta "ATTIVO")
  if [ -f "$PID_FILE" ] && pid_matches "$(cat "$PID_FILE" 2>/dev/null || echo "")" "scheduler|autoplay"; then
    echo -e "Processo:   ${GREEN}${BOLD}ATTIVO${NC} (PID $(cat "$PID_FILE"))"
  else
    echo -e "Processo:   ${YELLOW}${BOLD}FERMO${NC}"
  fi

  # ── Orario ──
  if node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -q '^yes$'; then
    echo -e "Orario:     ${GREEN}in orario${NC}  $(node "$SCHEDULE_CLI" describe 2>/dev/null)"
  else
    NEXT=$(node "$SCHEDULE_CLI" next-start 2>/dev/null || echo "")
    echo -e "Orario:     ${YELLOW}fuori orario${NC}  (prossimo turno: ${NEXT:-N/A})"
  fi

  # ── Stato runtime + freschezza ──
  if [ -f logs/status.json ] && node -e "JSON.parse(require('fs').readFileSync('logs/status.json','utf8'))" 2>/dev/null; then
    # `|| true`: sotto set -e un fallimento del render non deve uccidere il monitor.
    node 2>/dev/null <<'NODE' || true
      const s = require('./logs/status.json');
      const ageMin = s.lastUpdate ? Math.floor((Date.now() - new Date(s.lastUpdate).getTime()) / 60000) : null;
      const C = { dim: '\x1b[2m', y: '\x1b[0;33m', g: '\x1b[0;32m', r: '\x1b[0;31m', n: '\x1b[0m', b: '\x1b[1m' };
      const stale = ageMin !== null && ageMin > 3;
      const out = [];
      out.push(`Fase:       ${s.phase || '-'}${stale ? `  ${C.y}(stato vecchio: ${ageMin} min fa — non è la situazione attuale)${C.n}` : ''}`);
      if (s.courseUrl) out.push(`Corso:      ${s.courseUrl}`);
      if (s.lessonTitle) out.push(`Lezione:    ${s.lessonTitle}`);
      if (s.videoProgress) out.push(`Video:      ${s.videoProgress}`);
      if (s.lastQuizResult) out.push(`Ult. quiz:  ${s.lastQuizResult}`);
      if (s.courseStateSummary) {
        const cs = s.courseStateSummary;
        out.push(`Corsi:      done ${cs.done || 0} / in_progress ${cs.inProgress || 0} / need_help ${cs.needHelp || 0} (tot ${cs.total || 0})`);
      }
      if (s.phase === 'autologin_invalid') out.push(`${C.y}${C.b}⚠ Stato segnala autologin scaduto. Verifica reale: ./status.sh --check${C.n}`);
      if (s.lastError) out.push(`${C.dim}Ultimo errore: ${s.lastError}${C.n}`);
      console.log(out.join('\n'));
NODE
  else
    echo -e "Stato:      ${DIM}nessuno status.json${NC}"
  fi

  # ── Heartbeat ──
  if [ -f logs/heartbeat.txt ]; then
    echo -e "${DIM}Heartbeat:  $(cat logs/heartbeat.txt)${NC}"
  fi

  echo "--------------------------------------------"
  echo -e "${DIM}Ultimi log:${NC}"
  # `|| true`: sotto set -e un `[ ] && cmd` con condizione falsa sarebbe fatale.
  [ -f logs/autoplay.log ] && tail -n 6 logs/autoplay.log || true
  echo ""
  [ "$ONCE" = false ] && echo -e "${DIM}Aggiorno ogni ${INTERVAL}s — Ctrl-C per uscire.${NC}" || true
}

if [ "$ONCE" = true ]; then
  render
  exit 0
fi

trap 'echo ""; echo "Monitor interrotto."; exit 0' INT TERM
while true; do
  render
  sleep "$INTERVAL"
done
