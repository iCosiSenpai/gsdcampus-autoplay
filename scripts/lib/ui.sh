# ui.sh — palette e helper UI condivisi (sourcato, non eseguito).
# Compatibile bash + zsh. Unica fonte di verità per l'estetica degli script:
# stile "premium" a box arrotondati + colore accent, glifi ✓ ✗ ⚠, progress
# ●●●○○, testo secondario DIM. install.sh gira PRIMA del clone e mantiene le
# sue copie inline (non può sourcare ciò che non ha ancora scaricato).
#
# Regole:
# - Colori SOLO se stdout è un TTY. NON guardare NO_COLOR: start/status/
#   scheduler lo esportano per i figli node, ma la loro UI shell deve restare
#   colorata sul terminale.
# - Glifi unicode solo con locale UTF-8; altrimenti fallback ASCII.

if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  BLUE='\033[0;34m'
  RED='\033[0;31m'
  NC='\033[0m'
  # Accent: ciano brillante 256-color; fallback ciano base su terminali poveri.
  if [ "$(tput colors 2>/dev/null || echo 8)" -ge 256 ]; then
    ACCENT='\033[38;5;45m'
  else
    ACCENT='\033[0;36m'
  fi
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; BLUE=''; RED=''; NC=''; ACCENT=''
fi

# Glifi: unicode se il locale è UTF-8, ASCII altrimenti.
case "${LC_ALL:-${LANG:-}}" in
  *UTF-8*|*utf-8*|*utf8*)
    UI_OK='✓'; UI_ERR='✗'; UI_WARN='⚠'; UI_INFO='·'
    UI_DOT='●'; UI_DOT_OFF='○'; UI_ARROW='▸'
    UI_TL='╭'; UI_TR='╮'; UI_BL='╰'; UI_BR='╯'; UI_H='─'; UI_V='│'
    ;;
  *)
    UI_OK='+'; UI_ERR='x'; UI_WARN='!'; UI_INFO='-'
    UI_DOT='*'; UI_DOT_OFF='.'; UI_ARROW='>'
    UI_TL='+'; UI_TR='+'; UI_BL='+'; UI_BR='+'; UI_H='-'; UI_V='|'
    ;;
esac

ok()   { echo -e " ${GREEN}${BOLD}${UI_OK}${NC} $1"; }
err()  { echo -e " ${RED}${BOLD}${UI_ERR}${NC} $1"; }
warn() { echo -e " ${YELLOW}${BOLD}${UI_WARN}${NC} $1"; }
info() { echo -e " ${ACCENT}${UI_INFO}${NC} $1"; }

# ui_repeat <n> <char>: stampa il carattere n volte (senza newline).
ui_repeat() {
  local n="$1" ch="$2" out="" i=0
  while [ "$i" -lt "$n" ]; do out="$out$ch"; i=$((i + 1)); done
  printf '%s' "$out"
}

# ui_charlen <stringa>: lunghezza in CARATTERI (non byte): regge à è ì ò ù.
ui_charlen() {
  printf '%s' "$1" | wc -m | tr -d ' '
}

# ui_header "titolo" ["sottotitolo"]: box arrotondato accent, larghezza 44.
#   ╭──────────────────────────────────────────╮
#   │  Titolo                                  │
#   │  sottotitolo (DIM)                       │
#   ╰──────────────────────────────────────────╯
ui_header() {
  local title="$1" sub="${2:-}" width=44 inner pad len
  inner=$((width - 2))
  echo ""
  echo -e "${ACCENT}${UI_TL}$(ui_repeat "$inner" "$UI_H")${UI_TR}${NC}"
  len=$(ui_charlen "$title")
  pad=$((inner - 2 - len)); [ "$pad" -lt 0 ] && pad=0
  echo -e "${ACCENT}${UI_V}${NC}  ${BOLD}${title}${NC}$(ui_repeat "$pad" " ")${ACCENT}${UI_V}${NC}"
  if [ -n "$sub" ]; then
    len=$(ui_charlen "$sub")
    pad=$((inner - 2 - len)); [ "$pad" -lt 0 ] && pad=0
    echo -e "${ACCENT}${UI_V}${NC}  ${DIM}${sub}${NC}$(ui_repeat "$pad" " ")${ACCENT}${UI_V}${NC}"
  fi
  echo -e "${ACCENT}${UI_BL}$(ui_repeat "$inner" "$UI_H")${UI_BR}${NC}"
}

# ui_hr: separatore orizzontale sottile (DIM), stessa larghezza dell'header.
ui_hr() {
  echo -e "${DIM}$(ui_repeat 44 "$UI_H")${NC}"
}

# ui_kv "Etichetta" "valore": riga di riepilogo con etichetta allineata (10 char).
ui_kv() {
  local label="$1" value="$2" pad len
  len=$(ui_charlen "$label")
  pad=$((10 - len)); [ "$pad" -lt 0 ] && pad=1
  echo -e " ${DIM}${label}${NC}$(ui_repeat "$pad" " ")${value}"
}

# step: indicatore di avanzamento a pallini.
#   step "3/5" "Verifica requisiti"   →   ●●●○○  Passo 3/5 · Verifica requisiti
#   step "3/7 - Dipendenze npm"       →   ●●●○○○○  Passo 3/7 · Dipendenze npm
# Retro-compatibile con entrambe le firme usate negli script (2 arg, o 1 arg
# "N/TOT - label" come in setup.sh).
step() {
  local a="$1" b="${2:-}" cur tot label dots="" i=1
  case "$a" in
    [0-9]*/[0-9]*)
      cur="${a%%/*}"
      tot="${a#*/}"; tot="${tot%%[!0-9]*}"
      if [ -n "$b" ]; then
        label="$b"
      else
        # Firma a 1 argomento "N/TOT - label" (setup.sh)
        label="${a#${cur}/${tot}}"
        label="${label# }"; label="${label#-}"; label="${label#—}"; label="${label# }"
      fi
      ;;
    *)
      # Primo argomento non numerico: riga step semplice con freccia.
      echo ""
      echo -e " ${BOLD}${UI_ARROW} ${a}${b:+ $b}${NC}"
      return 0
      ;;
  esac
  while [ "$i" -le "$tot" ]; do
    if [ "$i" -le "$cur" ]; then dots="$dots${ACCENT}${UI_DOT}${NC}"; else dots="$dots${DIM}${UI_DOT_OFF}${NC}"; fi
    i=$((i + 1))
  done
  echo ""
  echo -e " ${dots}  ${BOLD}Passo ${cur}/${tot}${NC} ${DIM}·${NC} ${label}"
}

# ui_version <dir>: versione leggibile del progetto per i banner
# (tag git se esiste, altrimenti commit corto) + data ultimo aggiornamento.
# Stampa es. "abc1234 del 14/07/2026"; stringa vuota se git non disponibile.
ui_version() {
  local dir="${1:-.}"
  local ver date
  ver=$(git -C "$dir" describe --tags --always 2>/dev/null || echo "")
  [ -n "$ver" ] || return 0
  date=$(git -C "$dir" log -1 --format=%cd --date=format:'%d/%m/%Y' 2>/dev/null || echo "")
  if [ -n "$date" ]; then printf '%s · %s' "$ver" "$date"; else printf '%s' "$ver"; fi
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
    printf '\r%b%s%b %s ' "$ACCENT" "$f" "$NC" "$label"
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
