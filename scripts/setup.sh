#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"

# Colori per output interattivo
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

AUTO_YES=false
FORCE_UPDATE=false

# === Gestione argomenti (ordine libero) ===
for arg in "$@"; do
  case "$arg" in
    --yes) AUTO_YES=true ;;
    --force-update) FORCE_UPDATE=true ;;
  esac
done

info() {
  echo -e "${BLUE}${BOLD}[INFO]${NC} $1"
}
ok() {
  echo -e "${GREEN}${BOLD}[OK]${NC} $1"
}
warn() {
  echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"
}
err() {
  echo -e "${RED}${BOLD}[ERRORE]${NC} $1"
}
step() {
  echo ""
  echo -e "${BOLD}▶ $1${NC}"
}

print_header() {
  echo ""
  echo "============================================"
  echo -e "${BOLD}  Setup gsdcampus-autoplay${NC}"
  echo "============================================"
  echo ""
  echo "Questo script aggiorna/verifica i requisiti."
  echo "Se sono già installati e aggiornati, li salta."
  echo ""
  echo "Verifica:"
  echo "  • Homebrew e formule installate"
  echo "  • Node.js e npm"
  echo "  • Dipendenze npm (Playwright)"
  echo "  • Browser per Playwright / Google Chrome"
  echo "  • Ollama"
  echo "  • Modello Ollama gemma4:31b-cloud"
  echo "  • Claude Code CLI"
  echo ""
  warn "Se il Terminale chiede di installare/aggiornare qualcosa (anche 'y/n'), conferma SEMPRE."
  warn "Non avere paura: serve tutto per automatizzare il corso."
  echo ""
}

print_footer() {
  echo ""
  echo "============================================"
  ok "Setup completato con successo."
  echo "============================================"
  echo ""
  info "Puoi ora avviare l'AI supervisore con:"
  echo "  cd $DIR && ./launch-ai-supervisor.sh"
  echo ""
}

print_header

# Richiedi sudo all'inizio e avvia un keepalive in background
info "Richiesta privilegi sudo all'inizio per tutta la sessione..."
sudo -v
(while true; do sudo -v 2>/dev/null; sleep 60; done) &
SUDO_KEEPALIVE_PID=$!
trap 'kill $SUDO_KEEPALIVE_PID 2>/dev/null || true' EXIT INT TERM
ok "Privilegi sudo acquisiti e mantenuti attivi."

if [ "$AUTO_YES" = false ]; then
  read -q "REPLY?Procedere? [y/N] "
  echo ""
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    info "Uscita."
    exit 1
  fi
fi

# === CONFIGURAZIONE INIZIALE ===
step "0/7 - Configurazione personale"

CONFIG_FILE="$DIR/config.json"
EXAMPLE_FILE="$DIR/config.json.example"

mask_url() {
  local url="$1"
  local len=${#url}
  if [ "$len" -le 20 ]; then
    echo "$url"
  else
    printf '%s\n' "$(echo "$url" | cut -c1-20)…(${len} caratteri)"
  fi
}

# Rileva se config.json è ancora un placeholder / non valido.
is_config_valid() {
  [ -f "$CONFIG_FILE" ] || return 1
  # 1. JSON valido?
  if ! node -e "JSON.parse(require('fs').readFileSync('$CONFIG_FILE','utf8'))" 2>/dev/null; then
    return 1
  fi
  # 2. URL autologin presente e non fittizio?
  local url
  url=$(node -e "const c=require('$CONFIG_FILE'); console.log(c.autologinUrl||'');" 2>/dev/null)
  [ -n "$url" ] || return 1
  # Rifiuta placeholder tipici
  case "$url" in
    *CODICEFISCALE/TOKEN*) return 1 ;;
    *YOUR_AUTOLogin*) return 1 ;;
    *example*) return 1 ;;
  esac
  # 3. Deve rispettare il formato atteso
  if [[ ! "$url" =~ ^https://tecsial\.gsdcampus\.it/autologin/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/[A-Za-z0-9]+$ ]]; then
    return 1
  fi
  # 4. Orario presente e con almeno un turno valido?
  node -e "
    const c = require('$CONFIG_FILE');
    const { normalizeShifts, normalizeDays } = require('./src/lib/schedule');
    const days = normalizeDays(c.workSchedule && c.workSchedule.days);
    const shifts = normalizeShifts(c.workSchedule && c.workSchedule.shifts);
    if (days.length === 0 || shifts.length === 0) process.exit(1);
  " 2>/dev/null || return 1
  return 0
}

read_config_url() {
  node -e "const c=require('$CONFIG_FILE'); console.log(c.autologinUrl||'');" 2>/dev/null || echo ""
}

read_config_schedule_desc() {
  node "$SCHEDULE_CLI" describe 2>/dev/null || echo "Orario non configurato"
}

# Se config esiste ed è valido, mostra riepilogo e chiede se modificarlo
if is_config_valid; then
  CURRENT_URL=$(read_config_url)
  CURRENT_SCHEDULE=$(read_config_schedule_desc)

  echo ""
  echo "Trovata configurazione esistente:"
  echo "  Autologin: $(mask_url "$CURRENT_URL")"
  echo "  Orario:    $CURRENT_SCHEDULE"
  echo ""

  if [ "$AUTO_YES" = true ]; then
    MODIFY=false
  else
    read -q "REPLY?Vuoi modificarla? [y/N] "
    echo ""
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      MODIFY=true
    else
      MODIFY=false
    fi
  fi
else
  MODIFY=true
  if [ "$AUTO_YES" = true ]; then
    echo ""
    err "Configurazione mancante o non valida. Impossibile proseguire in modalità automatica."
    info "Esegui una volta: cd $DIR && ./scripts/setup.sh (senza --yes) per configurare autologin e orari."
    exit 1
  fi
  if [ -f "$CONFIG_FILE" ]; then
    echo ""
    warn "config.json esistente ma non valido o contiene dati fittizi."
    warn "Verrà riconfigurato da zero."
    echo ""
  else
    echo ""
    info "Prima configurazione: servono autologin e orari di lavoro."
    echo ""
  fi
fi

# Helper di validazione giorni
valid_days() {
  local input="$1"
  local normalized
  normalized=$(echo "$input" | tr ',' '\n' | grep -E '^[0-6]$' | sort -u | tr '\n' ',' | sed 's/,$//')
  [ -n "$normalized" ]
}

format_days() {
  echo "$1" | tr ',' '\n' | grep -E '^[0-6]$' | sort -u | tr '\n' ',' | sed 's/,$//'
}

valid_autologin() {
  local url="$1"
  if [[ ! "$url" =~ ^https://tecsial\.gsdcampus\.it/autologin/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/[A-Za-z0-9]+$ ]]; then
    return 1
  fi
  return 0
}

parse_input_time() {
  local t="$1"
  local result
  result=$(node "$SCHEDULE_CLI" parse-time "$t" 2>/dev/null) || return 1
  echo "$result"
}

# Chiede un orario con default. Ritorna stringa "HH:MM" tramite variabili globali LAST_H e LAST_M.
prompt_time() {
  local prompt_text="$1"
  local default_time="$2"
  local h m parsed
  while true; do
    read "INPUT?${prompt_text} [${default_time}]: "
    [ -z "$INPUT" ] && INPUT="$default_time"
    parsed=$(parse_input_time "$INPUT" 2>/dev/null || true)
    if [ -n "$parsed" ]; then
      h=$(echo "$parsed" | awk '{print $1}')
      m=$(echo "$parsed" | awk '{print $2}')
      LAST_H=$h
      LAST_M=$m
      return 0
    fi
    warn "Orario non valido. Formati accettati: HH:MM, H:MM, HH.MM, H.MM, HHMM (es. 9:30)."
  done
}

# Chiede un range e lo aggiunge all'array SHIFT_SPECS (stringhe "startHour,startMin,endHour,endMin")
ask_shift() {
  local label="$1"
  local default_start="$2"
  local default_end="$3"
  echo ""
  echo -e "${BOLD}${label}${NC}"
  prompt_time "  Inizio" "$default_start"
  local s_h=$LAST_H s_m=$LAST_M
  prompt_time "  Fine" "$default_end"
  local e_h=$LAST_H e_m=$LAST_M

  # Validazione inizio < fine
  local start_min=$((s_h * 60 + s_m))
  local end_min=$((e_h * 60 + e_m))
  if [ "$start_min" -ge "$end_min" ]; then
    warn "L'orario di fine deve essere successivo a quello di inizio."
    return 1
  fi

  # Controlla sovrapposizione con turni già inseriti
  local i=1
  for spec in "$SHIFT_SPECS[@]"; do
    local prev_h1 prev_m1 prev_h2 prev_m2
    prev_h1=$(echo "$spec" | cut -d, -f1)
    prev_m1=$(echo "$spec" | cut -d, -f2)
    prev_h2=$(echo "$spec" | cut -d, -f3)
    prev_m2=$(echo "$spec" | cut -d, -f4)
    local p_start=$((prev_h1 * 60 + prev_m1))
    local p_end=$((prev_h2 * 60 + prev_m2))
    if [ "$start_min" -lt "$p_end" ] && [ "$end_min" -gt "$p_start" ]; then
      warn "Questo turno si sovrappone con il turno $i (${prev_h1}:${prev_m1}-${prev_h2}:${prev_m2})."
      return 1
    fi
    i=$((i + 1))
  done

  SHIFT_SPECS+=("${s_h},${s_m},${e_h},${e_m}")
  return 0
}

# Loop di configurazione con validazione e conferma finale
while true; do
  if [ "$MODIFY" = true ]; then
    echo ""
    warn "Incolla il TUO link di autologin personale GSD Campus."
    warn "Lo trovi nell'email di invito al corso o nella piattaforma."
    echo ""

    while true; do
      read "AUTOLOGIN?Link autologin: "
      echo ""
      if [ -z "$AUTOLOGIN" ]; then
        warn "Il link autologin è obbligatorio."
      elif ! valid_autologin "$AUTOLOGIN"; then
        warn "Link non valido."
        echo "Formato atteso: https://tecsial.gsdcampus.it/autologin/CODICEFISCALE/TOKEN"
        echo "Esempio:        https://tecsial.gsdcampus.it/autologin/CSOLSS95L23D862R/EbeavV6UwGUVXyVdsPqmTHWd1bWrGddQ"
        echo "Riprova."
      else
        break
      fi
    done

    echo ""
    echo -e "${BOLD}Configurazione orari di lavoro${NC}"
    echo "Scegli la modalità più adatta a te."
    echo ""

    while true; do
      echo "Giorni lavorativi (0=dom, 1=lun, 2=mar, 3=mer, 4=gio, 5=ven, 6=sab)."
      echo "Esempi: 1,2,3,4,5 oppure 1,2,3,4,5,6"
      read "DAYS?Giorni [1,2,3,4,5]: "
      [ -z "$DAYS" ] && DAYS="1,2,3,4,5"
      if valid_days "$DAYS"; then
        DAYS_JSON=$(format_days "$DAYS")
        break
      fi
      warn "Input non valido. Usa solo numeri da 0 a 6 separati da virgola."
      echo ""
    done

    echo ""
    echo "Modalità orario:"
    echo "  1) Continuato    — un solo turno (default 09:00-18:00)"
    echo "  2) Solo mattina  — un turno (default 09:00-13:00)"
    echo "  3) Solo pomeriggio — un turno (default 14:00-18:00)"
    echo "  4) Classico      — mattina + pomeriggio (default 09:30-13:00, 16:30-20:00)"
    echo "  5) Personalizzato — inserisci i turni uno alla volta"
    echo ""

    while true; do
      read "MODE?Scelta [4]: "
      [ -z "$MODE" ] && MODE="4"
      if [[ "$MODE" =~ ^[1-5]$ ]]; then
        break
      fi
      warn "Scelta non valida. Inserisci un numero da 1 a 5."
    done

    # Svuota array turni
    SHIFT_SPECS=()

    case "$MODE" in
      1)
        ask_shift "Orario continuato" "09:00" "18:00" || continue
        ;;
      2)
        ask_shift "Solo mattina" "09:00" "13:00" || continue
        ;;
      3)
        ask_shift "Solo pomeriggio" "14:00" "18:00" || continue
        ;;
      4)
        ask_shift "Mattina" "09:30" "13:00" || continue
        ask_shift "Pomeriggio" "16:30" "20:00" || continue
        ;;
      5)
        echo ""
        echo -e "${BOLD}Modalità personalizzata${NC}"
        echo "Aggiungi i turni in ordine cronologico. Massimo 3 turni."
        while true; do
          if [ ${#SHIFT_SPECS} -ge 3 ]; then
            info "Hai raggiunto il massimo di 3 turni."
            break
          fi
          current_idx=$(( ${#SHIFT_SPECS} + 1 ))
          echo ""
          read "ADD?Aggiungi turno $current_idx? [s/N]: "
          if [[ ! "$ADD" =~ ^[Ss]$ ]]; then
            if [ ${#SHIFT_SPECS} -eq 0 ]; then
              warn "Devi inserire almeno un turno."
              continue
            fi
            break
          fi
          ask_shift "Turno $current_idx" "09:00" "13:00" || continue
        done
        ;;
    esac

    # Ordina i turni per orario di inizio
    if [ ${#SHIFT_SPECS} -gt 0 ]; then
      IFS=$'\n'
      SHIFT_SPECS=($(printf '%s\n' "${SHIFT_SPECS[@]}" | sort -t, -k1,1n -k2,2n))
      unset IFS
    fi

    # Costruisci JSON shifts
    SHIFTS_JSON=""
    first=true
    for spec in "$SHIFT_SPECS[@]"; do
      sh=$(echo "$spec" | cut -d, -f1)
      sm=$(echo "$spec" | cut -d, -f2)
      eh=$(echo "$spec" | cut -d, -f3)
      em=$(echo "$spec" | cut -d, -f4)
      if [ "$first" = true ]; then
        first=false
      else
        SHIFTS_JSON+=","
      fi
      SHIFTS_JSON+="\n      { \"startHour\": $sh, \"startMin\": $sm, \"endHour\": $eh, \"endMin\": $em }"
    done

    # Formatta orari per il riepilogo
    shifts_summary=""
    for spec in "$SHIFT_SPECS[@]"; do
      sh=$(echo "$spec" | cut -d, -f1)
      sm=$(echo "$spec" | cut -d, -f2)
      eh=$(echo "$spec" | cut -d, -f3)
      em=$(echo "$spec" | cut -d, -f4)
      s_str=$(node "$SCHEDULE_CLI" format-time "$sh" "$sm")
      e_str=$(node "$SCHEDULE_CLI" format-time "$eh" "$em")
      if [ -n "$shifts_summary" ]; then shifts_summary+=", "; fi
      shifts_summary+="${s_str}-${e_str}"
    done

    echo ""
    echo -e "${BOLD}Riepilogo configurazione:${NC}"
    echo "  Autologin: $(mask_url "$AUTOLOGIN")"
    echo "  Giorni:    $DAYS_JSON (0=dom, 6=sab)"
    echo "  Turni:     $shifts_summary"
    echo ""

    if [ "$AUTO_YES" = true ]; then
      REPLY="y"
    else
      read -q "REPLY?Confermi? [y/N] "
      echo ""
    fi

    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      cat > "$CONFIG_FILE" <<EOF
{
  "autologinUrl": "$AUTOLOGIN",
  "baseUrl": "https://tecsial.gsdcampus.it/",
  "courseUrls": [],
  "workSchedule": {
    "days": [$DAYS_JSON],
    "shifts": [$SHIFTS_JSON
    ]
  }
}
EOF
      ok "Configurazione salvata in config.json"
      ok "Autologin: $(mask_url "$AUTOLOGIN")"
      ok "Giorni: $DAYS_JSON"
      ok "Turni: $shifts_summary"
      break
    else
      warn "Ricominciamo l'inserimento."
      echo ""
    fi
  else
    ok "Configurazione esistente confermata."
    ok "Orario: $(read_config_schedule_desc)"
    break
  fi
done

# 1. Homebrew
step "1/7 - Homebrew"
if ! command -v brew &>/dev/null; then
  info "Homebrew non trovato. Installazione in corso..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
  ok "Homebrew installato."
elif [ "$FORCE_UPDATE" = true ]; then
  info "Aggiornamento Homebrew (richiesto --force-update)..."
  brew update
  brew upgrade
  ok "Homebrew aggiornato."
else
  ok "Homebrew già installato: $(brew --version | head -1). Salto."
fi

# 2. Node.js
step "2/7 - Node.js"
if command -v node &>/dev/null; then
  ok "Node.js già installato: $(node -v). Salto."
else
  info "Node.js non trovato. Installazione in corso..."
  brew install node 2>/dev/null || true
  ok "Node.js pronto: $(node -v)"
fi

# 3. npm dependencies
step "3/7 - Dipendenze npm"
if [ "$FORCE_UPDATE" = true ] || [ ! -d "$DIR/node_modules" ]; then
  info "Installazione/aggiornamento dipendenze..."
  npm install
  ok "Dipendenze npm aggiornate."
else
  ok "Dipendenze npm già presenti. Salto."
fi

# 4. Playwright browsers / Chrome
step "4/7 - Browser per Playwright"
if [ "$FORCE_UPDATE" = true ] || [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  info "Installazione/aggiornamento Chromium..."
  npx playwright install chromium
  ok "Browser Playwright pronto."
else
  ok "Browser Playwright già presente. Salto."
fi

# 5. Ollama
step "5/7 - Ollama"
if ! command -v ollama &>/dev/null; then
  info "Ollama non trovato. Installazione in corso..."
  curl -fsSL https://ollama.com/install.sh | sh
  ok "Ollama installato."
elif [ "$FORCE_UPDATE" = true ]; then
  info "Reinstallazione/aggiornamento Ollama (richiesto --force-update)..."
  curl -fsSL https://ollama.com/install.sh | sh
  ok "Ollama aggiornato."
else
  ok "Ollama già installato: $(ollama --version | head -1). Salto."
fi

# 6. Modello gemma4:31b-cloud (cloud, richiede login Ollama)
step "6/7 - Modello Ollama gemma4:31b-cloud"
if ! ollama list 2>/dev/null | grep -q "gemma4:31b-cloud"; then
  warn "Il modello gemma4:31b-cloud è un modello CLOUD e richiede il login Ollama."
  warn "Verrà aperto il login interattivo. Inserisci le tue credenziali."
  echo ""
  # Esegue ollama login in modo interattivo, collegando stdin/stderr correttamente
  ollama login

  info "Download modello gemma4:31b-cloud in corso..."
  ollama pull gemma4:31b-cloud

  if ! ollama list 2>/dev/null | grep -q "gemma4:31b-cloud"; then
    err "Download fallito. Se il login non è andato a buon fine, riesegui ./launch-ai-supervisor.sh."
    exit 1
  fi
else
  ok "Modello gemma4:31b-cloud già presente. Salto."
fi

# 7. Claude Code CLI
step "7/7 - Claude Code CLI"
if ! command -v claude &>/dev/null; then
  info "Claude Code CLI non trovato. Installazione in corso..."
  curl -fsSL https://claude.ai/install.sh | bash
fi

# Assicurarsi che ~/.local/bin sia nel PATH in .zshrc e nel processo corrente
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  info "Aggiunta ~/.local/bin al PATH in .zshrc..."
  if [ -f "$HOME/.zshrc" ] && ! grep -qE 'export PATH=.*\$HOME/\.local/bin' "$HOME/.zshrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
  fi
fi
export PATH="$HOME/.local/bin:$PATH"

if command -v claude &>/dev/null; then
  ok "Claude Code CLI pronto: $(claude --version 2>/dev/null | head -1)."
else
  err "Claude Code CLI non trovato neanche dopo l'installazione. Prova a chiudere e riaprire il Terminale, poi riesegui ./launch-ai-supervisor.sh."
  exit 1
fi

print_footer
