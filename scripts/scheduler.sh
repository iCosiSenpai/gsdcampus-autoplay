#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Neutralizza FORCE_COLOR: alcuni ambienti di supervisione AI possono esportare
# FORCE_COLOR=3, che fa colorizzare a `node` anche su pipe. Uno snippet
# `node -e "console.log(42)"` emetterebbe allora \x1b[33m42\x1b[39m, e l'aritmetica
# shell `$((NEXT_MS / 60000))` crasherebbe sotto set -e uccidendo lo scheduler
# silenziosamente a ogni fine turno (visto: scheduler morto dopo "Attendo prossimo
# turno..."). FORCE_COLOR ha la precedenza su NO_COLOR/NODE_NO_COLOR, quindi va
# proprio UNSETtato. Così tutti i figli node (autoplay incluso) ereditano env pulito.
unset FORCE_COLOR
export NO_COLOR=1

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
AI_BATCH_RUNNER="$DIR/scripts/run-claude-quiz-batch.sh"

# Cooldown post session_unstable (exit 4): leggibile da config.json
# (sessionUnstableCooldownMin minuti, default 30). Pure helper Node.
session_unstable_cooldown_ms() {
  node -e "
    try {
      const c = require('./config.json');
      const { sessionUnstableCooldownMs } = require('./src/lib/session-policy');
      process.stdout.write(String(sessionUnstableCooldownMs(c)));
    } catch (e) {
      process.stdout.write(String(30 * 60 * 1000));
    }
  " 2>/dev/null || echo 1800000
}

# Notifiche macOS (best-effort, mai bloccanti; throttle interno 6h per tipo).
source "$DIR/scripts/lib/notify.sh"

# Mappa gli exit code che richiedono intervento umano su una notifica macOS.
# SOLO side-effect: non tocca EXIT_CODE né i rami decisionali (l'exit-code API
# 0/2/3/4 del contratto scheduler↔autoplay resta intatta).
notify_on_exit() {
  case "${1:-}" in
    2)
      local phase
      phase=$(node -e "try{process.stdout.write(require('./logs/status.json').phase||'')}catch(e){}" 2>/dev/null || echo "")
      if [[ "$phase" != "awaiting_ai" && "$phase" != "complete" ]]; then
        notify_user "GSD Campus" "Il corso ha bisogno di aiuto: apri il Terminale e rilancia il comando di avvio." need_help || true
      fi
      ;;
    3) notify_user "GSD Campus" "Il link di accesso al corso è scaduto: serve quello nuovo dal referente." autologin_invalid || true ;;
  esac
  return 0
}

IGNORE_HOURS=false
LOCK_TOKEN=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ignore-hours) IGNORE_HOURS=true; shift ;;
    --lock-token)
      [ "$#" -ge 2 ] || { echo "scheduler: --lock-token richiede un valore" >&2; exit 2; }
      LOCK_TOKEN="$2"; shift 2 ;;
    *) echo "scheduler: opzione sconosciuta: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$LOCK_TOKEN" ]; then
  echo "scheduler: token single-instance mancante; usa ./start.sh" >&2
  exit 2
fi
# start.sh promuove il lock subito dopo il fork. Aspettiamo brevemente quella
# scrittura atomica; uno scheduler senza ownership verificata non parte.
LOCK_READY=false
for _lock_try in {1..20}; do
  if node "$DIR/scripts/lib/runtime-lock-cli.js" owns "$DIR" "$LOCK_TOKEN" "$$" >/dev/null 2>&1; then
    LOCK_READY=true
    break
  fi
  sleep 0.1
done
if [ "$LOCK_READY" != true ]; then
  echo "scheduler: lock identità non valido; uscita di sicurezza" >&2
  exit 2
fi

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PID_FILE="$DIR/.autoplay_pid"
LOG_FILE="$DIR/logs/scheduler.log"
STOP_FILE="$DIR/.scheduler_stop"
SCHEDULER_STATUS_CLI="$DIR/scripts/lib/scheduler-status-cli.js"

mkdir -p "$DIR/logs"

# log: su FILE sempre in chiaro (strip degli escape ANSI: prima scheduler.log si
# riempiva di \x1b[0;34m… che sporcano grep/tail/AI), su stdout colorato solo se
# è un TTY (di norma stdout è logs/autoplay.out: anche lì niente escape).
log() {
  local ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local plain="$ts | $(printf '%s' "$1" | sed $'s/\x1b\\[[0-9;]*m//g; s/\\\\033\\[[0-9;]*m//g')"
  printf '%s\n' "$plain" >> "$LOG_FILE"
  if [ -t 1 ]; then
    echo -e "$ts | $1"
  else
    printf '%s\n' "$plain"
  fi
}

info() { log "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { log "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { log "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }

# Pulizia file di controllo in uscita
cleanup() {
  rm -f "$STOP_FILE"
  if [ -f "$PID_FILE" ] && [ "$(cat "$PID_FILE" 2>/dev/null || echo '')" = "$$" ]; then
    rm -f "$PID_FILE"
  fi
  if [ -n "$LOCK_TOKEN" ] && [ -f "$DIR/scripts/lib/runtime-lock-cli.js" ]; then
    node "$DIR/scripts/lib/runtime-lock-cli.js" release "$DIR" "$LOCK_TOKEN" >/dev/null 2>&1 || true
  fi
  if [ -f "$SCHEDULER_STATUS_CLI" ]; then
    node "$SCHEDULER_STATUS_CLI" stop "$DIR" >/dev/null 2>&1 || true
  fi
}
shutdown_scheduler() { exit 0; }
trap cleanup EXIT
trap shutdown_scheduler INT TERM

# Calcola i millisecondi fino al prossimo inizio turno lavorativo.
# Usa process.stdout.write (NON console.log): quest'ultimo colorizzerebbe il
# numero sotto FORCE_COLOR, inquadrando l'aritmetica shell $((NEXT_MS/60000)).
ms_until_next_start() {
  # `|| echo 0`: sotto set -e un node fallito non deve uccidere lo scheduler
  # (il caller tratta 0/vuoto come "riprova tra 1 minuto").
  node -e "
    const { nextWorkStart, msUntil } = require('./src/lib/schedule');
    const d = nextWorkStart(new Date());
    process.stdout.write(String(d ? msUntil(d) : 0) + '\n');
  " 2>/dev/null || echo 0
}

# Restituisce l'ora del prossimo avvio in formato leggibile
next_start_readable() {
  node "$SCHEDULE_CLI" next-start 2>/dev/null || echo "sconosciuto"
}

# Aspetta un certo numero di millisecondi, controllando periodicamente se lo scheduler deve fermarsi
wait_ms() {
  local total_ms="$1"
  local heartbeat_phase="${2:-}"
  local heartbeat_next="${3:-}"
  local step_ms=60000 # 1 minuto
  local elapsed=0

  # Evita attese nulle o negative
  if [[ -z "$total_ms" || "$total_ms" -le 1000 ]]; then
    sleep 1
    return 0
  fi

  while [[ "$elapsed" -lt "$total_ms" ]]; do
    if [ -n "$heartbeat_phase" ] && [ -f "$SCHEDULER_STATUS_CLI" ]; then
      node "$SCHEDULER_STATUS_CLI" mark "$DIR" "$heartbeat_phase" "$heartbeat_next" "Scheduler in attesa; nessun browser attivo." >/dev/null 2>&1 || true
    fi
    if [[ -f "$STOP_FILE" ]]; then
      log "Ricevuto segnale di stop. Fermo lo scheduler."
      rm -f "$STOP_FILE"
      exit 0
    fi

    local wait=$((step_ms))
    if [[ "$((elapsed + step_ms))" -gt "$total_ms" ]]; then
      wait=$((total_ms - elapsed))
    fi

    sleep $((wait / 1000))
    elapsed=$((elapsed + wait))
  done
}

# In attesa di AI non riaprire Chromium in loop: l'AI/utente modifica gli
# handoff per-account e il fingerprint cambia senza bisogno di un nuovo login.
work_fingerprint() {
  node -e "try{const t=require('./src/lib/ai-todo').buildAiTodo(process.cwd());process.stdout.write(t.workFingerprint||'')}catch(e){}" 2>/dev/null || echo ""
}

claude_retry_wait_ms() {
  node -e "
    const fs=require('fs');
    try {
      const s=JSON.parse(fs.readFileSync('./logs/claude-quiz-state.json','utf8'));
      const ms=Date.parse(s.retryAfter||'')-Date.now();
      process.stdout.write(String(Number.isFinite(ms) ? Math.max(60000, ms) : 1800000));
    } catch (_) { process.stdout.write('1800000'); }
  " 2>/dev/null || echo 1800000
}

wait_for_work_change() {
  local initial="$1"
  local max_ms="${2:-21600000}" # 6h default; errori Claude usano retryAfter
  local elapsed=0 slice_ms current wait_min
  while [[ "$elapsed" -lt "$max_ms" ]]; do
    slice_ms=60000
    [[ "$((elapsed + slice_ms))" -gt "$max_ms" ]] && slice_ms=$((max_ms - elapsed))
    wait_ms "$slice_ms" awaiting_ai
    elapsed=$((elapsed + slice_ms))
    current=$(work_fingerprint)
    if [[ -n "$current" && "$current" != "$initial" ]]; then
      log "Rilevato cambiamento nell'inbox/stato locale: riprendo autoplay."
      return 0
    fi
  done
  wait_min=$(( (max_ms + 59999) / 60000 ))
  log "Nessun cambiamento inbox dopo ${wait_min} min: eseguo il retry/ricontrollo previsto."
  return 0
}

# In awaiting_ai resta in un watcher deterministico: esegue al massimo un batch
# per fingerprint e non riapre Chromium finche tutte le domande non sono state
# rimosse dall'handoff. Tra i batch non resta attivo alcun processo AI.
handle_awaiting_ai() {
  local before after code remaining wait_limit_ms
  while true; do
    before=$(work_fingerprint)
    code=0
    wait_limit_ms=21600000
    if [ -x "$AI_BATCH_RUNNER" ]; then
      "$AI_BATCH_RUNNER" --non-interactive >> "$LOG_FILE" 2>&1 || code=$?
    else
      code=24
    fi
    after=$(work_fingerprint)
    remaining=$(node -e "try{const t=require('./src/lib/ai-todo').buildAiTodo(process.cwd());process.stdout.write(String(t.openQuizRequests||0))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0)
    if [[ "$remaining" -eq 0 ]]; then
      if [[ "$code" -eq 25 ]]; then
        log "Inbox quiz vuota; risposte locali applicate ma share fleet ancora pending. Riprendo autoplay senza perdere il marker di retry."
      else
        log "Inbox quiz vuota: riprendo autoplay."
      fi
      return 0
    fi
    case "$code" in
      20) log "awaiting_ai senza domande leggibili: attendo un cambiamento locale." ;;
      21) log "Fingerprint quiz gia elaborato: nessuna nuova chiamata AI." ;;
      22)
        wait_limit_ms=$(claude_retry_wait_ms)
        log "Output AI non valido: handoff preservato; ritento al retryAfter tra circa $(( (wait_limit_ms + 59999) / 60000 )) min."
        ;;
      23)
        wait_limit_ms=$(claude_retry_wait_ms)
        log "Batch AI fallito: retry automatico al retryAfter tra circa $(( (wait_limit_ms + 59999) / 60000 )) min."
        ;;
      24)
        log "Batch AI non disponibile o login Ollama richiesto: rilanciare il comando curl."
        notify_user "GSD Campus" "Serve il login Ollama per risolvere un quiz: rilancia il comando curl." ai_login_required || true
        ;;
      25)
        wait_limit_ms=1800000
        log "Risposte locali salve ma share fleet pending; ritento il batch tra 30 min senza perdere dati."
        ;;
      26)
        wait_limit_ms=60000
        log "Un altro batch AI e gia in esecuzione (contesa lock): ritento tra circa 1 min."
        ;;
      *) log "Restano $remaining domande; batch terminato con codice $code." ;;
    esac
    wait_for_work_change "${after:-$before}" "$wait_limit_ms"
  done
}

# Controlla se siamo in orario lavorativo
is_in_hours() {
  # grep -c (non -q): evita SIGPIPE sotto pipefail (v. commento in start.sh).
  node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -c '^yes$' >/dev/null
}

# ── Check aggiornamento versione (throttled: max 1 volta/ora) ───────────────
# Fa un git fetch leggero e, se origin/main è più avanti di HEAD, scrive un
# marker file in logs/.update_available con versione corrente e nuova.
# L'AI supervisore lo legge e consiglia all'utente di chiudere, riaprire il
# comando curl e aggiornare. Non tocca il codice: è solo un avviso.
UPDATE_MARKER="$DIR/logs/.update_available"
UPDATE_CHECK_INTERVAL=3600  # secondi tra un check e l'altro

check_for_updates() {
  # Throttle: se il marker (o un check fallito) è stato scritto meno di 1h fa, skip.
  if [ -f "$UPDATE_MARKER" ]; then
    local marker_age
    marker_age=$(( $(date +%s) - $(stat -f%m "$UPDATE_MARKER" 2>/dev/null || echo 0) ))
    if [ "$marker_age" -lt "$UPDATE_CHECK_INTERVAL" ]; then
      return 0
    fi
  fi

  # Rete? (best-effort, non bloccare lo scheduler se non c'è)
  if ! curl -m 5 -fsS -o /dev/null https://raw.githubusercontent.com 2>/dev/null; then
    return 0
  fi

  git fetch --quiet origin main 2>/dev/null || return 0

  local LOCAL_HEAD REMOTE_HEAD
  LOCAL_HEAD=$(git -C "$DIR" rev-parse HEAD 2>/dev/null || echo "")
  REMOTE_HEAD=$(git -C "$DIR" rev-parse origin/main 2>/dev/null || echo "")

  if [ -z "$LOCAL_HEAD" ] || [ -z "$REMOTE_HEAD" ]; then
    return 0
  fi

  if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
    # Aggiornati: rimuovi il marker se c'era (l'utente ha aggiornato)
    rm -f "$UPDATE_MARKER" 2>/dev/null || true
    return 0
  fi

  # C'è un aggiornamento: scrivi il marker con dettagli
  local LOCAL_SHORT="${LOCAL_HEAD:0:7}"
  local REMOTE_SHORT="${REMOTE_HEAD:0:7}"
  local REMOTE_DATE
  REMOTE_DATE=$(git -C "$DIR" log -1 --format=%cd --date=format:'%d/%m/%Y %H:%M' origin/main 2>/dev/null || echo "")
  local REMOTE_MSG
  REMOTE_MSG=$(git -C "$DIR" log -1 --format=%s origin/main 2>/dev/null || echo "")

  cat > "$UPDATE_MARKER" <<EOF
{
  "localVersion": "$LOCAL_SHORT",
  "remoteVersion": "$REMOTE_SHORT",
  "remoteDate": "$REMOTE_DATE",
  "remoteMessage": "$REMOTE_MSG",
  "checkedAt": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
  log "⚠️  Aggiornamento disponibile: $LOCAL_SHORT → $REMOTE_SHORT ($REMOTE_DATE). L'utente dovrebbe chiudere e rilanciare il comando curl per aggiornare."
}

log "Scheduler avviato. IGNORE_HOURS=$IGNORE_HOURS"
if [ -f "$SCHEDULER_STATUS_CLI" ]; then
  node "$SCHEDULER_STATUS_CLI" mark "$DIR" scheduler_starting "" "Scheduler avviato; preparo il prossimo ciclo." >/dev/null 2>&1 || true
fi

# Gate offline prima di OGNI sessione browser reale. Se fixture/selettori non
# sono coerenti, non apriamo la piattaforma e soprattutto non tocchiamo quiz.
preflight_selectors() {
  if node "$DIR/scripts/lib/selector-probe.js" >> "$LOG_FILE" 2>&1; then
    return 0
  fi
  log "Preflight selettori FALLITO: autoplay non avviato."
  node "$SCHEDULER_STATUS_CLI" mark "$DIR" preflight_failed "" "Probe selettori fallito; browser non aperto." "selector_probe_failed" >/dev/null 2>&1 || true
  notify_user "GSD Campus" "Controllo pagine fallito: aggiorna con il comando curl prima di riprovare." preflight_failed || true
  return 1
}

# Contatore crash consecutivi (exit code diverso da 0 e 4). Backoff crescente per
# evitare di martellare autoplay quando crasha di fila (es. bug o piattaforma giù):
# 60 -> 120 -> 300 -> 1800s. Dopo MAX_CRASHES crash consecutivi esponiamo la fase
# `crash_loop` in logs/status.json (atomico), avvisiamo l'utente, aspettiamo un
# cooldown lungo e RIPRENDIAMO il loop (niente uscita: sotto il keepalive
# LaunchAgent uscire = restart immediato = martellamento).
CRASH_COUNT=0
MAX_CRASHES=5
# Cooldown dopo crash_loop. Sotto il keepalive LaunchAgent NON usciamo (uscire =
# restart immediato da launchd = martellamento): segnaliamo, aspettiamo a lungo
# e riproviamo. 30 min, come il cooldown session_unstable.
CRASH_LOOP_COOLDOWN=1800

# Scrive logs/status.json con phase=$1 in modo atomico, mergendo i campi
# preesistenti. DIR passa via argv (niente interpolazione shell dentro il JS:
# un path con apici/caratteri speciali rompeva lo snippet) e riusa l'helper
# atomico condiviso scripts/lib/write-json.js.
mark_crash_loop() {
  local phase="$1"
  node -e '
    const dir = process.argv[2];
    const { writeJsonAtomic, readJsonSafe } = require(require("path").join(dir, "scripts", "lib", "write-json.js"));
    const f = require("path").join(dir, "logs", "status.json");
    const s = readJsonSafe(f, {}, { warn: false });
    s.phase = process.argv[1]; s.lastUpdate = new Date().toISOString();
    s.crashLoop = true;
    writeJsonAtomic(f, s);
  ' "$phase" "$DIR" 2>/dev/null || true
}

# Azzera il flag crashLoop in status.json dopo il cooldown: lo scheduler NON è
# più fermo (sta per riprovare), quindi lasciarlo true sarebbe fuorviante per la
# plancia / l'AI supervisore.
clear_crash_loop() {
  node -e '
    const dir = process.argv[1];
    const { writeJsonAtomic, readJsonSafe } = require(require("path").join(dir, "scripts", "lib", "write-json.js"));
    const f = require("path").join(dir, "logs", "status.json");
    const s = readJsonSafe(f, {}, { warn: false });
    if (s && s.crashLoop) { s.crashLoop = false; s.lastUpdate = new Date().toISOString(); writeJsonAtomic(f, s); }
  ' "$DIR" 2>/dev/null || true
}

# Backoff per crash consecutivi (exit code diverso da 0 e 4). Ladder 60 -> 120 ->
# 300 -> 1800s. A MAX_CRASHES consecutivi scrive crash_loop in status.json,
# avvisa, aspetta un cooldown lungo e RIPRENDE il loop (niente uscita: v. sopra).
# Resetta CRASH_COUNT a 0 per exit 0/4. Va chiamato per OGNI run di autoplay
# (entrambi i branch). Ritorna sempre 0 (il `|| exit 1` del caller resta come
# guardia difensiva ma non scatta più).
apply_crash_backoff() {
  local code="$1"
  if [[ "$code" -eq 0 || "$code" -eq 4 ]]; then
    CRASH_COUNT=0
    return 0
  fi
  CRASH_COUNT=$((CRASH_COUNT + 1))
  local BACKOFF
  case "$CRASH_COUNT" in
    1) BACKOFF=60 ;;
    2) BACKOFF=120 ;;
    3) BACKOFF=300 ;;
    *) BACKOFF=1800 ;;
  esac
  log "Autoplay terminato con codice $code. Crash consecutivi: $CRASH_COUNT. Attesa ${BACKOFF}s..."
  if [[ "$CRASH_COUNT" -ge "$MAX_CRASHES" ]]; then
    # NON usciamo: sotto il keepalive LaunchAgent uscire = restart immediato da
    # launchd = martellamento. Segnaliamo crash_loop, aspettiamo a lungo, poi
    # riprendiamo il loop (auto-guarigione se la causa è transitoria, es.
    # piattaforma giù). In modalità nohup (senza keepalive) il risultato è lo
    # stesso: riprova da solo più tardi invece di restare morto.
    log "Raggiunti $MAX_CRASHES crash consecutivi: crash_loop. Segnalo, attendo $((CRASH_LOOP_COOLDOWN / 60)) min e riprovo (nessuna uscita)."
    mark_crash_loop "crash_loop"
    notify_user "GSD Campus" "L'automazione ha avuto errori ripetuti: riproverà da sola più tardi. Se persiste, apri il Terminale e rilancia il comando di avvio." crash_loop || true
    sleep "$CRASH_LOOP_COOLDOWN"
    CRASH_COUNT=0
    clear_crash_loop
    return 0
  fi
  sleep "$BACKOFF"
  return 0
}

while true; do
  # STOP_FILE check in cima al loop: copre entrambi i branch mid-run. Oggi solo
  # wait_ms lo controlla, e il branch ignore-hours fa `continue` bypassandolo —
  # così ./stop.sh veniva onorato solo tra un run e l'altro. Ora il segnale di stop
  # viene visto subito dopo il run corrente in entrambi i rami.
  if [[ -f "$STOP_FILE" ]]; then
    log "Ricevuto segnale di stop. Fermo lo scheduler."
    rm -f "$STOP_FILE"
    exit 0
  fi

  # Check aggiornamento (throttled: max 1 volta/ora, best-effort, mai bloccante).
  check_for_updates || true

  if [[ "$IGNORE_HOURS" = true ]]; then
    log "Avvio autoplay (modalità ignore-hours)..."
    preflight_selectors || exit 1
    node "$SCHEDULER_STATUS_CLI" mark "$DIR" scheduler_launching "" "Preflight superato; avvio browser." >/dev/null 2>&1 || true
    # zsh: l'exit code dei comandi in pipe è in $pipestatus (1-indexed), NON in
    # $PIPESTATUS (bash-ism). Il `|| EXIT_CODE=...` va nella STESSA riga: sotto
    # set -e + pipefail una pipe fallita (autoplay crashato) ucciderebbe lo
    # scheduler prima di poter leggere pipestatus.
    EXIT_CODE=0
    node "$DIR/src/autoplay.js" --ignore-hours 2>&1 | tee -a "$LOG_FILE" || EXIT_CODE=${pipestatus[1]}
    notify_on_exit "$EXIT_CODE"
    if [[ "$EXIT_CODE" -eq 0 ]]; then
      # Uscita pulita: fine turno / all done / need_help. Se phase=member_queue_advanced
      # (coda multi-CF) riparti in 60s sul prossimo membro; altrimenti 10 min.
      CRASH_COUNT=0
      PHASE=$(node -e "try{const s=require('./logs/status.json');process.stdout.write(s.phase||'')}catch(e){}" 2>/dev/null || echo "")
      if [[ "$PHASE" = "member_queue_advanced" ]]; then
        log "Autoplay: coda multi-CF avanzata. Riavvio tra 60s sul prossimo membro..."
        wait_ms 60000
      elif [[ "$PHASE" = "awaiting_ai" ]]; then
        log "awaiting_ai: provo il batch Claude on-demand senza riaprire il browser..."
        handle_awaiting_ai
      elif [[ "$PHASE" = "complete" ]]; then
        FP=$(work_fingerprint)
        log "complete: nessun browser o processo AI necessario. Attendo cambiamenti locali..."
        wait_for_work_change "$FP"
      else
        log "Autoplay terminato con codice 0. Riavvio tra 10 minuti (evito loop a vuoto, need_help o fine turno)..."
        wait_ms 600000
      fi
    elif [[ "$EXIT_CODE" -eq 4 || "$EXIT_CODE" -eq 3 ]]; then
      # Accesso in timeout temporaneo. Il link e unico e stabile: un login fallito
      # (autologin_invalid, exit 3) o una sessione instabile dopo la dashboard
      # (session_unstable, exit 4) sono trattati allo stesso modo — cooldown e
      # ritento, senza arrendersi e senza suggerire di cambiare il link. Cooldown
      # configurabile (config.sessionUnstableCooldownMin, default 30).
      CRASH_COUNT=0
      COOLDOWN_MS=$(session_unstable_cooldown_ms)
      COOLDOWN_MIN=$((COOLDOWN_MS / 60000))
      log "Autoplay terminato con codice ${EXIT_CODE} (accesso in timeout temporaneo): cooldown ${COOLDOWN_MIN} minuti e ritento (link stabile, non lo cambio)..."
      wait_ms "$COOLDOWN_MS"
    else
      apply_crash_backoff "$EXIT_CODE" || exit 1
    fi
    continue
  fi

  if is_in_hours; then
    log "In orario lavorativo. Avvio autoplay..."
    preflight_selectors || exit 1
    node "$SCHEDULER_STATUS_CLI" mark "$DIR" scheduler_launching "" "Preflight superato; avvio browser." >/dev/null 2>&1 || true
    # zsh pipestatus (1-indexed): v. commento nel ramo ignore-hours.
    EXIT_CODE=0
    node "$DIR/src/autoplay.js" 2>&1 | tee -a "$LOG_FILE" || EXIT_CODE=${pipestatus[1]}
    notify_on_exit "$EXIT_CODE"
    if [[ "$EXIT_CODE" -eq 0 ]]; then
      CRASH_COUNT=0
      PHASE=$(node -e "try{const s=require('./logs/status.json');process.stdout.write(s.phase||'')}catch(e){}" 2>/dev/null || echo "")
      if [[ "$PHASE" = "member_queue_advanced" ]]; then
        log "Coda multi-CF avanzata. Riavvio tra 60s sul prossimo membro..."
        wait_ms 60000
        continue
      fi
      if [[ "$PHASE" = "awaiting_ai" ]]; then
        log "awaiting_ai: provo il batch Claude on-demand senza riaprire il browser..."
        handle_awaiting_ai
        continue
      fi
      if [[ "$PHASE" = "complete" ]]; then
        FP=$(work_fingerprint)
        log "complete: attendo cambiamenti locali senza browser o processo AI persistente..."
        wait_for_work_change "$FP"
        continue
      fi
      log "Autoplay terminato con codice 0 (fine turno). Calcolo prossimo turno..."
    elif [[ "$EXIT_CODE" -eq 4 || "$EXIT_CODE" -eq 3 ]]; then
      CRASH_COUNT=0
      COOLDOWN_MS=$(session_unstable_cooldown_ms)
      COOLDOWN_MIN=$((COOLDOWN_MS / 60000))
      log "Autoplay terminato con codice ${EXIT_CODE} (accesso in timeout temporaneo): cooldown ${COOLDOWN_MIN} minuti e ritento (link stabile)..."
      wait_ms "$COOLDOWN_MS"
      continue
    else
      # Backoff; poi `continue` ri-valuta is_in_hours (il backoff può averci
      # spostato fuori turno → cadiamo nel branch off-hours e aspettiamo il prossimo).
      apply_crash_backoff "$EXIT_CODE" || exit 1
      continue
    fi
  else
    log "Fuori orario lavorativo. Attendo prossimo turno..."
  fi

  NEXT_MS=$(ms_until_next_start)
  if [[ -z "$NEXT_MS" || "$NEXT_MS" -le 0 ]]; then
    NEXT_MS=60000
  fi
  NEXT_MIN=$((NEXT_MS / 60000))
  NEXT_START=$(next_start_readable)
  log "Prossimo avvio: ${NEXT_START} (fra circa ${NEXT_MIN} minuti)."
  node "$SCHEDULER_STATUS_CLI" mark "$DIR" off_hours "$NEXT_START" "Fuori orario; nessun browser attivo." >/dev/null 2>&1 || true
  wait_ms "$NEXT_MS" off_hours "$NEXT_START"
done
