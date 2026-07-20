#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Neutralizza FORCE_COLOR: alcuni ambienti (es. il supervisore AI / Claude Code)
# esportano FORCE_COLOR=3, che fa colorizzare a `node` anche su pipe. Uno snippet
# `node -e "console.log(42)"` emetterebbe allora \x1b[33m42\x1b[39m, e l'aritmetica
# shell `$((NEXT_MS / 60000))` crasherebbe sotto set -e uccidendo lo scheduler
# silenziosamente a ogni fine turno (visto: scheduler morto dopo "Attendo prossimo
# turno..."). FORCE_COLOR ha la precedenza su NO_COLOR/NODE_NO_COLOR, quindi va
# proprio UNSETtato. Così tutti i figli node (autoplay incluso) ereditano env pulito.
unset FORCE_COLOR
export NO_COLOR=1

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"

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
    2) notify_user "GSD Campus" "Il corso ha bisogno di aiuto: apri il Terminale e rilancia il comando di avvio." need_help || true ;;
    3) notify_user "GSD Campus" "Il link di accesso al corso è scaduto: serve quello nuovo dal referente." autologin_invalid || true ;;
  esac
  return 0
}

IGNORE_HOURS=false
if [ "${1:-}" = "--ignore-hours" ]; then
  IGNORE_HOURS=true
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
}
trap cleanup EXIT INT TERM

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
  local step_ms=60000 # 1 minuto
  local elapsed=0

  # Evita attese nulle o negative
  if [[ -z "$total_ms" || "$total_ms" -le 1000 ]]; then
    sleep 1
    return 0
  fi

  while [[ "$elapsed" -lt "$total_ms" ]]; do
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

# Contatore crash consecutivi (exit code diverso da 0 e 4). Backoff crescente per
# evitare di martellare autoplay quando crasha di fila (es. bug o piattaforma giù):
# 60 -> 120 -> 300 -> 1800s. Dopo MAX_CRASHES crash consecutivi, esponiamo la fase
# `crash_loop` in logs/status.json (atomico) e usciamo, così l'AI supervisore lo
# nota e avvisa l'utente invece di restare invisibile in retry infiniti.
CRASH_COUNT=0
MAX_CRASHES=5

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

# Backoff per crash consecutivi (exit code diverso da 0 e 4). Ladder 60 -> 120 ->
# 300 -> 1800s. A MAX_CRASHES consecutivi scrive crash_loop in status.json e
# retorna 1 (il caller esce, così l'AI supervisore interviene invece di restare in
# retry invisibile). Resetta CRASH_COUNT a 0 per exit 0/4. Va chiamato per OGNI
# run di autoplay (entrambi i branch). Ritorna 1 se crash_loop, 0 dopo aver dormito.
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
    log "Raggiunti $MAX_CRASHES crash consecutivi: crash_loop. Scrivo status.json ed esco (l'AI supervisore deve intervenire)."
    mark_crash_loop "crash_loop"
    notify_user "GSD Campus" "L'automazione si è fermata per errori ripetuti: apri il Terminale e rilancia il comando di avvio." crash_loop || true
    return 1
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
      else
        log "Autoplay terminato con codice 0. Riavvio tra 10 minuti (evito loop a vuoto, need_help o fine turno)..."
        wait_ms 600000
      fi
    elif [[ "$EXIT_CODE" -eq 4 ]]; then
      # session_unstable: token valido ma sessione instabile. Cooldown configurabile
      # (config.sessionUnstableCooldownMin, default 30) — non martellare l'autologin.
      CRASH_COUNT=0
      COOLDOWN_MS=$(session_unstable_cooldown_ms)
      COOLDOWN_MIN=$((COOLDOWN_MS / 60000))
      log "Autoplay terminato con codice 4 (session_unstable): token valido ma sessione instabile. Cooldown ${COOLDOWN_MIN} minuti..."
      wait_ms "$COOLDOWN_MS"
    else
      apply_crash_backoff "$EXIT_CODE" || exit 1
    fi
    continue
  fi

  if is_in_hours; then
    log "In orario lavorativo. Avvio autoplay..."
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
      log "Autoplay terminato con codice 0 (fine turno). Calcolo prossimo turno..."
    elif [[ "$EXIT_CODE" -eq 4 ]]; then
      CRASH_COUNT=0
      COOLDOWN_MS=$(session_unstable_cooldown_ms)
      COOLDOWN_MIN=$((COOLDOWN_MS / 60000))
      log "Autoplay terminato con codice 4 (session_unstable). Cooldown ${COOLDOWN_MIN} minuti..."
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
  wait_ms "$NEXT_MS"
done
