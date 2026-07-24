#!/bin/zsh
set -eu -o pipefail

# Bootstrap deterministico: aggiorna inbox/banca, esegue Claude solo se esistono
# quiz aperti, poi avvia lo scheduler normale e termina. Nessun processo AI resta vivo.

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
unset FORCE_COLOR
export NO_COLOR=1

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
CHECK_REQ="$DIR/scripts/check-requirements.sh"
BATCH_RUNNER="$DIR/scripts/run-claude-quiz-batch.sh"
TODO_FILE="$DIR/logs/ai_todo.json"

source "$DIR/scripts/lib/ui.sh"
source "$DIR/scripts/lib/pid-utils.sh"

ui_header "GSD Campus — Avvio autonomo" "Claude on-demand: zero chiamate senza quiz" "⚡"
echo ""

# Ping diagnostico della versione (best-effort, in background, non blocca; opt-out
# diagnostics:false): il maintainer vede nei log del Worker quale versione gira su
# ogni store — utile per accorgersi dei Mac rimasti su codice vecchio.
node "$DIR/scripts/lib/diag-ping.js" start >/dev/null 2>&1 &

info "Controllo e arresto eventuali istanze precedenti..."
# Sospendi e scarica il keepalive PRIMA di fermare lo scheduler, così non lo
# resuscita durante la pulizia/riavvio (race-guard: flag + bootout dell'agent).
touch "$DIR/.keepalive_disabled" 2>/dev/null || true
"$DIR/scripts/lib/install-scheduler-agent.sh" remove >/dev/null 2>&1 || true
if autoplay_instance_alive "$DIR"; then
  OLD_PID="$(autoplay_instance_pid "$DIR" 2>/dev/null || echo "")"
  if pid_matches "$OLD_PID" "scheduler|autoplay"; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
    pid_matches "$OLD_PID" "scheduler|autoplay" && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$DIR/.autoplay_pid"
fi
autoplay_clean_stale_lock "$DIR" >/dev/null 2>&1 || true
{ pgrep -f "$DIR/src/autoplay\\.js" 2>/dev/null || true; } | while read -r orphan; do kill -9 "$orphan" 2>/dev/null || true; done
{ pgrep -f "$DIR/scripts/scheduler\\.sh" 2>/dev/null || true; } | while read -r orphan; do [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true; done

# Rimuovi soltanto processi AI registrati da questo progetto. Runner e batch
# vengono fermati prima del proxy/daemon, cosi non restano processi orfani ne
# un batch vivo con le dipendenze appena rimosse.
stop_tracked_pid_file "$DIR/.claude_runner_pid" "claude-quiz-runner\\.js" || true
stop_tracked_pid_file "$DIR/.claude_batch_pid" "run-claude-quiz-batch\\.sh" || true
stop_tracked_pid_file "$DIR/.ai_proxy_pid" "ollama-cloud-proxy\\.js" || true
stop_tracked_pid_file "$DIR/.ollama_pid" "ollama|Ollama" || true
# Rimuovi il lock del batch SOLO se orfano: un batch ancora vivo (non tracciato
# dai pid file sopra) deve mantenere la mutua esclusione, cosi il prossimo batch
# lo riconosce e attende (exit 26) invece di scavalcarlo con una seconda istanza.
_batch_lock="$DIR/logs/.claude-quiz-batch.lock"
if [ -d "$_batch_lock" ]; then
  _batch_lock_owner="$(cat "$_batch_lock/pid" 2>/dev/null || true)"
  if [ -z "$_batch_lock_owner" ] || ! kill -0 "$_batch_lock_owner" 2>/dev/null; then
    rm -rf "$_batch_lock" 2>/dev/null || true
  fi
fi
unset _batch_lock _batch_lock_owner
ok "Pulizia istanze precedenti completata."

step "1/5" "Verifica configurazione"
if [ -f "$DIR/config.json" ] && node "$SCHEDULE_CLI" is-work-time >/dev/null 2>&1; then
  ok "config.json valido."
  info "Orario configurato: $(node "$SCHEDULE_CLI" describe 2>/dev/null || echo 'non disponibile')"
else
  warn "Configurazione mancante o incompleta. Avvio setup guidato."
  "$DIR/scripts/setup.sh"
fi

step "2/5" "Manutenzione e requisiti runtime"
if [ -x "$DIR/scripts/maintenance.sh" ]; then "$DIR/scripts/maintenance.sh" >/dev/null 2>&1 || true; fi
if [ ! -x "$CHECK_REQ" ] || ! "$CHECK_REQ" --runtime >/dev/null 2>&1; then
  warn "Requisiti runtime mancanti. Avvio setup condizionale..."
  sudo -v
  "$DIR/scripts/setup.sh" --yes
fi
ok "Runtime autoplay pronto."

step "3/5" "Banca risposte e inbox"
mkdir -p "$DIR/logs"
if [ -x "$DIR/scripts/update-known-answers.sh" ]; then
  "$DIR/scripts/update-known-answers.sh" || true
fi
TODO_FRESH="$(node -e "
  const fs=require('fs');
  try {
    const st=fs.statSync(process.argv[1]);
    process.stdout.write(Date.now()-st.mtimeMs <= 15*60*1000 ? 'yes' : 'no');
  } catch (_) { process.stdout.write('no'); }
" "$TODO_FILE" 2>/dev/null || echo no)"
if [ "$TODO_FRESH" != yes ]; then
  info "Inbox assente o piu vecchia di 15 minuti: eseguo un unico scan deterministico."
  if node "$DIR/scripts/harvest-answers.js" --all; then
    ok "Censimento, riconciliazione e raccolta domande aggiornati."
  else
    warn "Scan live non completato; uso gli artefatti locali disponibili e lascio riprovare allo scheduler."
  fi
else
  ok "Inbox recente: nessun login browser aggiuntivo."
fi

OPEN_QUIZ_REQUESTS=$(node -e "try{const t=require('./src/lib/ai-todo').buildAiTodo(process.cwd());process.stdout.write(String(t.openQuizRequests||0))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0)
if [ "$OPEN_QUIZ_REQUESTS" -gt 0 ] 2>/dev/null; then
  if [ ! -x "$CHECK_REQ" ] || ! "$CHECK_REQ" --ai >/dev/null 2>&1; then
    warn "$OPEN_QUIZ_REQUESTS domanda/e aperte: preparo ora Ollama e Claude Code."
    if sudo -v && "$DIR/scripts/setup.sh" --yes; then
      ok "Componenti AI on-demand pronti."
    else
      warn "Setup AI non completato; il batch conservera l'handoff e chiedera un nuovo tentativo."
    fi
  fi
fi

step "4/5" "Quiz AI on-demand"
BATCH_RC=0
"$BATCH_RUNNER" || BATCH_RC=$?
case "$BATCH_RC" in
  0) ok "Batch quiz completato e risposte distribuite." ;;
  20) ok "Nessun quiz aperto: Claude, Ollama e proxy non sono stati avviati." ;;
  21) ok "Inbox invariata gia elaborata: nessuna nuova chiamata AI." ;;
  22) warn "Alcune risposte non hanno superato la validazione; restano nell'inbox senza consumare tentativi quiz." ;;
  23)
    warn "Claude non ha completato il batch; handoff intatto e retry protetto da cooldown."
    node "$DIR/scripts/lib/diag-ping.js" error ai_batch_failed >/dev/null 2>&1 &
    ;;
  24)
    warn "Componenti AI/login non pronti; autoplay parte comunque e conserva l'handoff."
    node "$DIR/scripts/lib/diag-ping.js" error ai_not_ready >/dev/null 2>&1 &
    ;;
  25) warn "Risposte salvate localmente, ma distribuzione fleet non riuscita; il retry resta persistente." ;;
  *) warn "Batch AI terminato con codice $BATCH_RC; autoplay parte comunque." ;;
esac

step "5/5" "Avvio scheduler"
MEMBER_LINE="$(node "$DIR/scripts/lib/members-cli.js" active 2>/dev/null | head -1 | sed 's/^Membro attivo: //' || echo '')"
[ -n "$MEMBER_LINE" ] || MEMBER_LINE="non configurato"
SCHEDULE_LINE="$(node "$SCHEDULE_CLI" describe 2>/dev/null || echo 'non disponibile')"
ui_kv "Account" "${BOLD}${MEMBER_LINE}${NC}"
ui_kv "Orari" "$SCHEDULE_LINE"
ui_kv "AI" "Claude Code on-demand · gate openQuizRequests · proxy budget temporaneo"

if GSD_LAUNCHER=1 "$DIR/start.sh"; then
  # Riabilita e (re)installa il keepalive: mantiene vivo lo scheduler h24 anche
  # a finestra chiusa, dopo Cmd+Q o un riavvio del Mac. Idempotente; no-op su
  # non-macOS (senza launchctl).
  rm -f "$DIR/.keepalive_disabled" 2>/dev/null || true
  "$DIR/scripts/lib/install-scheduler-agent.sh" install >/dev/null 2>&1 || true
  # Plancia interattiva del collega: si aggiorna da sola, azioni a tasto singolo
  # (L guarda dal vivo · F ferma · R aggiorna · Q chiudi). In ambiente non
  # interattivo stampa un solo riquadro ed esce. Non tiene in vita nulla: lo
  # scheduler prosegue in background anche dopo la chiusura della plancia.
  node "$DIR/scripts/lib/panel-cli.js" || true
else
  err "Scheduler non avviato. Controlla logs/autoplay.out e rilancia il comando curl."
  exit 1
fi
