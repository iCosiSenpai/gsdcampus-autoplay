# ui.sh — palette e helper UI condivisi (sourcato, non eseguito).
# Compatibile bash + zsh. Prima palette e funzioni info/ok/warn/err/step erano
# duplicate in 5 script (start, stop, status, launch, setup): questa lib è
# l'unica fonte di verità. install.sh gira PRIMA del clone e mantiene le sue
# copie inline (non può sourcare ciò che non ha ancora scaricato).

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok()   { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err()  { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }
step() { echo -e "${BOLD}[PASSO $1]${NC} $2"; }

# ui_version <dir>: versione leggibile del progetto per i banner
# (tag git se esiste, altrimenti commit corto) + data ultimo aggiornamento.
# Stampa es. "abc1234 del 14/07/2026"; stringa vuota se git non disponibile.
ui_version() {
  local dir="${1:-.}"
  local ver date
  ver=$(git -C "$dir" describe --tags --always 2>/dev/null || echo "")
  [ -n "$ver" ] || return 0
  date=$(git -C "$dir" log -1 --format=%cd --date=format:'%d/%m/%Y' 2>/dev/null || echo "")
  if [ -n "$date" ]; then printf '%s del %s' "$ver" "$date"; else printf '%s' "$ver"; fi
}

# log_plain <file> <messaggio>: appende su file SENZA escape ANSI (sia byte ESC
# reali sia sequenze letterali \033) e stampa su stdout (colorato solo se TTY).
log_plain() {
  local file="$1"; shift
  local ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local plain="$ts | $(printf '%s' "$1" | sed $'s/\x1b\\[[0-9;]*m//g; s/\\\\033\\[[0-9;]*m//g')"
  printf '%s\n' "$plain" >> "$file"
  if [ -t 1 ]; then echo -e "$ts | $1"; else printf '%s\n' "$plain"; fi
}

# spinner_run <label> <logfile> <cmd...>: esegue il comando con output rediretto
# sul logfile mostrando "label" con uno spinner (solo se stdout è un TTY;
# altrimenti stampa la label statica). Ritorna l'exit code del comando: i
# chiamanti sotto set -e devono gestirlo (if/||). NON usarlo per comandi
# interattivi (sudo, login) né per quelli con progress proprio (ollama pull).
spinner_run() {
  local label="$1"; shift
  local logfile="$1"; shift
  if [ ! -t 1 ]; then
    echo "$label..."
    "$@" >> "$logfile" 2>&1
    return $?
  fi
  "$@" >> "$logfile" 2>&1 &
  local cmd_pid=$!
  # Frame ASCII (niente glifi multibyte: cut/substring su UTF-8 non è portabile
  # tra bash e zsh su macOS).
  local i=0
  local f='|'
  while kill -0 "$cmd_pid" 2>/dev/null; do
    case $(( i % 4 )) in
      0) f='|' ;; 1) f='/' ;; 2) f='-' ;; 3) f='\' ;;
    esac
    printf '\r%s %s ' "$f" "$label"
    i=$(( i + 1 ))
    sleep 0.15
  done
  local rc=0
  wait "$cmd_pid" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '\r\033[K'
    ok "$label"
  else
    printf '\r\033[K'
    err "$label — fallito (dettagli: $logfile)"
  fi
  return $rc
}
