#!/bin/zsh
set -e

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

IGNORE_HOURS=false
if [ "$1" = "--ignore-hours" ]; then
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

log() {
  local line="$(date '+%Y-%m-%d %H:%M:%S') | $1"
  echo "$line" | tee -a "$LOG_FILE"
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
  node -e "
    const { nextWorkStart, msUntil } = require('./src/lib/schedule');
    const d = nextWorkStart(new Date());
    process.stdout.write(String(d ? msUntil(d) : 0) + '\n');
  " 2>/dev/null
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
  node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -q '^yes$'
}

log "Scheduler avviato. IGNORE_HOURS=$IGNORE_HOURS"

# Contatore crash consecutivi (exit code diverso da 0 e 4). Backoff crescente per
# evitare di martellare autoplay quando crasha di fila (es. bug o piattaforma giù):
# 60 -> 120 -> 300 -> 1800s. Dopo MAX_CRASHES crash consecutivi, esponiamo la fase
# `crash_loop` in logs/status.json (atomico) e usciamo, così l'AI supervisore lo
# nota e avvisa l'utente invece di restare invisibile in retry infiniti.
CRASH_COUNT=0
MAX_CRASHES=5

# Scrive logs/status.json con phase=$1 in modo atomico (tmp+rename), mergendo i
# campi preesistenti per non cancellare il resto dello stato.
mark_crash_loop() {
  local phase="$1"
  node -e '
    const fs=require("fs"); const path=require("path");
    const f=path.join("'"$DIR"'","logs","status.json");
    let s={}; try{s=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){}
    s.phase=process.argv[1]; s.lastUpdate=new Date().toISOString();
    s.crashLoop=true;
    const tmp=f+".tmp";
    fs.writeFileSync(tmp,JSON.stringify(s,null,2));
    fs.renameSync(tmp,f);
  ' "$phase" 2>/dev/null || true
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

  if [[ "$IGNORE_HOURS" = true ]]; then
    log "Avvio autoplay (modalità ignore-hours)..."
    node "$DIR/src/autoplay.js" --ignore-hours 2>&1 | tee -a "$LOG_FILE"
    # zsh: l'exit code dei comandi in pipe è in $pipestatus (1-indexed), NON in
    # $PIPESTATUS (bash-ism, qui sarebbe vuoto → il ramo "successo" scatterebbe
    # sempre, anche dopo un crash). Va letto SUBITO dopo la pipe.
    EXIT_CODE=${pipestatus[1]}
    if [[ "$EXIT_CODE" -eq 0 ]]; then
      # Uscita pulita: fine turno oppure tutti i corsi completati/in attesa di aiuto (need_help).
      # Non riavviare subito a vuoto; attendi 10 minuti così l'AI/utente può intervenire.
      CRASH_COUNT=0
      log "Autoplay terminato con codice 0. Riavvio tra 10 minuti (evito loop a vuoto, need_help o fine turno)..."
      wait_ms 600000
    elif [[ "$EXIT_CODE" -eq 4 ]]; then
      # session_unstable: il token autologin è valido (abbiamo raggiunto la dashboard)
      # ma la sessione è instabile — tipicamente il token è degradato dal sovrauso
      # (troppi hit nello stesso giorno). Re-hitare subito l'autologin peggiorerebbe
      # il degrado (raffica -> rate-limit della piattaforma). Lasciamo un cooldown
      # lungo così il token recupera e il prossimo run ha una sessione stabile.
      CRASH_COUNT=0
      log "Autoplay terminato con codice 4 (session_unstable): token valido ma sessione instabile. Cooldown 30 minuti per far recuperare il token..."
      wait_ms 1800000
    else
      apply_crash_backoff "$EXIT_CODE" || exit 1
    fi
    continue
  fi

  if is_in_hours; then
    log "In orario lavorativo. Avvio autoplay..."
    node "$DIR/src/autoplay.js" 2>&1 | tee -a "$LOG_FILE"
    # zsh pipestatus (1-indexed): va letto SUBITO dopo la pipe.
    EXIT_CODE=${pipestatus[1]}
    if [[ "$EXIT_CODE" -eq 0 ]]; then
      CRASH_COUNT=0
      log "Autoplay terminato con codice 0 (fine turno). Calcolo prossimo turno..."
    elif [[ "$EXIT_CODE" -eq 4 ]]; then
      CRASH_COUNT=0
      log "Autoplay terminato con codice 4 (session_unstable). Cooldown 30 minuti..."
      wait_ms 1800000
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
