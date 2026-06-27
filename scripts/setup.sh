#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Claude Code CLI installa il binario in ~/.local/bin; assicuriamo che sia
# subito disponibile nel PATH di questo script, anche negli shell non interattivi
# che non caricano .zshrc.
export PATH="$HOME/.local/bin:$PATH"

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
UNINSTALL=false

# === Gestione argomenti (ordine libero) ===
for arg in "$@"; do
  case "$arg" in
    --yes) AUTO_YES=true ;;
    --force-update) FORCE_UPDATE=true ;;
    --uninstall) UNINSTALL=true ;;
  esac
done

# Modalità disinstallazione: esci subito dallo script di setup e passa a uninstall.sh
if [ "$UNINSTALL" = true ]; then
  exec "$DIR/scripts/uninstall.sh"
fi

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

# Claude Code CLI installa in ~/.local/bin. Negli shell non interattivi .zshrc
# non viene letto, quindi assicuriamo il PATH sia attivo qui e persistito nei
# principali file di configurazione dello shell (zsh e bash).
ensure_local_bin_in_path() {
  export PATH="$HOME/.local/bin:$PATH"
  local line='export PATH="$HOME/.local/bin:$PATH"'
  local f human
  for f in "$HOME/.zshrc" "$HOME/.bash_profile" "$HOME/.bashrc"; do
    if [ -f "$f" ] && ! grep -qF "$line" "$f" 2>/dev/null; then
      human="${f/#$HOME/~}"
      info "Aggiunta ~/.local/bin al PATH in $human"
      echo "$line" >> "$f"
    fi
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# Helpers per aggiornamento condizionale delle dipendenze
# ─────────────────────────────────────────────────────────────────────────────

# Calcola un hash stabile di package.json + package-lock.json.
# Usato per capire se è necessario rieseguire npm install.
calc_package_hash() {
  if command -v sha256sum &>/dev/null; then
    (sha256sum "$DIR/package.json" "$DIR/package-lock.json" 2>/dev/null || true) | sha256sum | awk '{print $1}'
  elif command -v shasum &>/dev/null; then
    (shasum -a 256 "$DIR/package.json" "$DIR/package-lock.json" 2>/dev/null || true) | shasum -a 256 | awk '{print $1}'
  else
    # Fallback per macOS senza shasum (improbabile): nome, dimensione e mtime.
    stat -f "%N%z%m" "$DIR/package.json" "$DIR/package-lock.json" 2>/dev/null | md5
  fi
}

# Salva l'hash attuale in .package_hash
save_package_hash() {
  calc_package_hash > "$DIR/.package_hash"
}

# Attende che il server Ollama risponda su http://127.0.0.1:11434.
# Se non risponde, tenta di avviarlo tramite il daemon interno o, in fallback,
# con 'ollama serve' direttamente. Fallisce se il server non si avvia.
ensure_ollama_server() {
  if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
    return 0
  fi

  info "Server Ollama non attivo. Avvio in corso..."
  if [ -f "$DIR/scripts/ollama-daemon.sh" ]; then
    "$DIR/scripts/ollama-daemon.sh" start
  else
    warn "Daemon Ollama non trovato. Avvio 'ollama serve' manualmente..."
    nohup ollama serve >> "$DIR/logs/ollama.log" 2>&1 &
    for i in $(seq 1 30); do
      if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
        break
      fi
      sleep 0.5
    done
  fi

  if ! curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
    err "Impossibile avviare il server Ollama."
    info "Prova a eseguire manualmente in un altro terminale:  ollama serve"
    info "Poi riesegui questo script."
    exit 1
  fi
  ok "Server Ollama attivo."
}

# True se package.json/package-lock.json sono cambiati rispetto all'ultimo hash salvato.
package_hash_changed() {
  [ ! -f "$DIR/.package_hash" ] && return 0
  local current saved
  current=$(calc_package_hash)
  saved=$(cat "$DIR/.package_hash" 2>/dev/null || echo "")
  [ "$current" != "$saved" ]
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

# ─────────────────────────────────────────────────────────────────────────────
# Helper interattivi per giorni e turni
# ─────────────────────────────────────────────────────────────────────────────

day_label() {
  case "$1" in
    0) echo "dom";; 1) echo "lun";; 2) echo "mar";; 3) echo "mer";;
    4) echo "gio";; 5) echo "ven";; 6) echo "sab";; *) echo "$1";;
  esac
}

# Da "1,2,3" a "lun, mar, mer"
days_human() {
  local csv="$1" out="" d
  for d in ${(s:,:)csv}; do
    [ -n "$out" ] && out+=", "
    out+="$(day_label "$d")"
  done
  echo "$out"
}

# Da spec "sh,sm,eh,em" a "HH:MM-HH:MM"
spec_to_label() {
  local spec="$1" sh sm eh em
  sh=$(echo "$spec" | cut -d, -f1); sm=$(echo "$spec" | cut -d, -f2)
  eh=$(echo "$spec" | cut -d, -f3); em=$(echo "$spec" | cut -d, -f4)
  echo "$(node "$SCHEDULE_CLI" format-time "$sh" "$sm")-$(node "$SCHEDULE_CLI" format-time "$eh" "$em")"
}

# Ordina i turni per orario di inizio
sort_shifts() {
  [ ${#SHIFT_SPECS} -gt 0 ] || return 0
  IFS=$'\n'
  SHIFT_SPECS=($(printf '%s\n' "${SHIFT_SPECS[@]}" | sort -t, -k1,1n -k2,2n))
  unset IFS
}

# Rimuove il turno con indice 1-based
remove_shift() {
  local idx="$1" i=1 newarr=()
  for spec in "${SHIFT_SPECS[@]}"; do
    [ "$i" -ne "$idx" ] && newarr+=("$spec")
    i=$((i + 1))
  done
  SHIFT_SPECS=("${newarr[@]}")
}

# Fine dell'ultimo turno (HH:MM), per proporre un default sensato al turno successivo
last_shift_end() {
  [ ${#SHIFT_SPECS} -gt 0 ] || { echo ""; return 0; }
  sort_shifts
  local spec=${SHIFT_SPECS[-1]} eh em
  eh=$(echo "$spec" | cut -d, -f3); em=$(echo "$spec" | cut -d, -f4)
  printf "%02d:%02d" "$eh" "$em"
}

# Mostra la tabella dei turni correnti
render_shifts() {
  if [ ${#SHIFT_SPECS} -eq 0 ]; then
    echo -e "  ${YELLOW}(nessun turno impostato)${NC}"
  else
    local i=1
    for spec in "${SHIFT_SPECS[@]}"; do
      echo -e "  ${BOLD}$i)${NC} $(spec_to_label "$spec")"
      i=$((i + 1))
    done
  fi
}

# Scelta giorni lavorativi con modelli rapidi
configure_days() {
  echo ""
  echo -e "${BOLD}Giorni lavorativi${NC}"
  echo "  1) Lun–Ven  (5 giorni)"
  echo "  2) Lun–Sab  (6 giorni)"
  echo "  3) Tutti i giorni"
  echo "  4) Personalizzati"
  echo ""
  local choice
  while true; do
    read "choice?Scelta [1]: "
    [ -z "$choice" ] && choice=1
    case "$choice" in
      1) DAYS="1,2,3,4,5"; break ;;
      2) DAYS="1,2,3,4,5,6"; break ;;
      3) DAYS="0,1,2,3,4,5,6"; break ;;
      4)
        while true; do
          echo "Numeri: 0=dom 1=lun 2=mar 3=mer 4=gio 5=ven 6=sab"
          read "DAYS?Giorni separati da virgola (es. 1,2,3,4,5): "
          if valid_days "$DAYS"; then break; fi
          warn "Input non valido. Usa solo numeri da 0 a 6 separati da virgola."
        done
        break ;;
      *) warn "Scelta non valida (1-4)." ;;
    esac
  done
  DAYS_JSON=$(format_days "$DAYS")
  ok "Giorni: $(days_human "$DAYS_JSON")"
}

# Configurazione turni: modello di partenza + editor interattivo (aggiungi/rimuovi/svuota)
configure_shifts() {
  echo ""
  echo -e "${BOLD}Turni di lavoro${NC}"
  echo "Scegli un modello di partenza, poi potrai aggiungere o rimuovere turni a piacere."
  echo "  1) Classico        — 09:30-13:00 e 16:30-20:00"
  echo "  2) Continuato      — 09:00-18:00"
  echo "  3) Solo mattina    — 09:00-13:00"
  echo "  4) Solo pomeriggio — 14:00-18:00"
  echo "  5) Parto da zero   — nessun turno, li aggiungo io"
  echo ""
  local seed
  while true; do
    read "seed?Modello di partenza [1]: "
    [ -z "$seed" ] && seed=1
    case "$seed" in
      1) SHIFT_SPECS=("9,30,13,0" "16,30,20,0"); break ;;
      2) SHIFT_SPECS=("9,0,18,0"); break ;;
      3) SHIFT_SPECS=("9,0,13,0"); break ;;
      4) SHIFT_SPECS=("14,0,18,0"); break ;;
      5) SHIFT_SPECS=(); break ;;
      *) warn "Scelta non valida (1-5)." ;;
    esac
  done

  # Editor interattivo dei turni
  local act ridx le def_start
  while true; do
    sort_shifts
    echo ""
    echo -e "${BOLD}── I tuoi turni ──${NC}"
    render_shifts
    echo ""
    echo -e "${BOLD}Cosa vuoi fare?${NC}"
    echo "  [a] aggiungi un turno"
    [ ${#SHIFT_SPECS} -gt 0 ] && echo "  [r] rimuovi un turno"
    [ ${#SHIFT_SPECS} -gt 0 ] && echo "  [s] svuota tutti i turni"
    echo "  [c] conferma e continua"
    echo ""
    read "act?Scelta [c]: "
    [ -z "$act" ] && act="c"
    case "$act" in
      a|A)
        if [ ${#SHIFT_SPECS} -ge 4 ]; then
          warn "Hai raggiunto il massimo di 4 turni."
        else
          def_start="09:00"
          le=$(last_shift_end)
          [ -n "$le" ] && def_start="$le"
          if ask_shift "Nuovo turno" "$def_start" "13:00"; then
            ok "Turno aggiunto."
          fi
        fi
        ;;
      r|R)
        if [ ${#SHIFT_SPECS} -eq 0 ]; then
          warn "Non c'è nessun turno da rimuovere."
        else
          read "ridx?Numero del turno da rimuovere: "
          if [[ "$ridx" =~ ^[0-9]+$ ]] && [ "$ridx" -ge 1 ] && [ "$ridx" -le ${#SHIFT_SPECS} ]; then
            remove_shift "$ridx"
            ok "Turno $ridx rimosso."
          else
            warn "Numero non valido."
          fi
        fi
        ;;
      s|S)
        SHIFT_SPECS=()
        ok "Tutti i turni rimossi."
        ;;
      c|C)
        if [ ${#SHIFT_SPECS} -eq 0 ]; then
          warn "Devi avere almeno un turno per continuare. Aggiungine uno con [a]."
        else
          break
        fi
        ;;
      *) warn "Azione non valida. Usa a, r, s oppure c." ;;
    esac
  done
  sort_shifts
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

    configure_days
    configure_shifts

    # Costruisci JSON shifts su una sola riga (JSON non richiede a capo; evita problemi di
    # escaping di \n in zsh, che lascerebbe backslash-n letterali rendendo il file non valido).
    SHIFTS_JSON=""
    for spec in "$SHIFT_SPECS[@]"; do
      sh=$(echo "$spec" | cut -d, -f1)
      sm=$(echo "$spec" | cut -d, -f2)
      eh=$(echo "$spec" | cut -d, -f3)
      em=$(echo "$spec" | cut -d, -f4)
      [ -n "$SHIFTS_JSON" ] && SHIFTS_JSON+=", "
      SHIFTS_JSON+="{ \"startHour\": $sh, \"startMin\": $sm, \"endHour\": $eh, \"endMin\": $em }"
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
    echo "  Giorni:    $(days_human "$DAYS_JSON")"
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
    "shifts": [$SHIFTS_JSON]
  }
}
EOF
      ok "Configurazione salvata in config.json"
      ok "Autologin: $(mask_url "$AUTOLOGIN")"
      ok "Giorni: $(days_human "$DAYS_JSON")"
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

# 2. Node.js (richiesto >= 18)
step "2/7 - Node.js"
NODE_MIN_MAJOR=18
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -v | sed 's/^v\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null; then
    ok "Node.js già installato: $(node -v). Salto."
  else
    info "Node.js trovato ma versione $NODE_MAJOR < $NODE_MIN_MAJOR. Aggiornamento in corso..."
    brew install node 2>/dev/null || true
    ok "Node.js pronto: $(node -v)"
  fi
else
  info "Node.js non trovato. Installazione in corso..."
  brew install node 2>/dev/null || true
  ok "Node.js pronto: $(node -v)"
fi

# 3. npm dependencies — solo se package.json/package-lock.json sono cambiati,
# node_modules manca, oppure --force-update
step "3/7 - Dipendenze npm"
NEEDS_NPM=false
if [ "$FORCE_UPDATE" = true ] || [ ! -d "$DIR/node_modules" ] || package_hash_changed; then
  NEEDS_NPM=true
fi

if [ "$NEEDS_NPM" = true ]; then
  info "Installazione/aggiornamento dipendenze..."
  npm install
  ok "Dipendenze npm aggiornate."
else
  ok "Dipendenze npm già aggiornate. Salto."
fi

# 4. Playwright browsers / Chrome — solo se necessario
step "4/7 - Browser per Playwright"
if [ "$FORCE_UPDATE" = true ] || [ "$NEEDS_NPM" = true ] || [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  info "Installazione/aggiornamento Chromium..."
  npx playwright install chromium
  ok "Browser Playwright pronto."
else
  ok "Browser Playwright già presente. Salto."
fi

# Salva l'hash aggiornato solo se abbiamo toccato le dipendenze o se mancava
if [ "$FORCE_UPDATE" = true ] || [ "$NEEDS_NPM" = true ] || [ ! -f "$DIR/.package_hash" ]; then
  save_package_hash
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

# Prima di interrogare i modelli, assicurati che il server Ollama sia attivo.
ensure_ollama_server

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
ensure_local_bin_in_path
if ! command -v claude &>/dev/null; then
  info "Claude Code CLI non trovato. Installazione in corso..."
  curl -fsSL https://claude.ai/install.sh | bash
  ensure_local_bin_in_path
fi

if command -v claude &>/dev/null; then
  ok "Claude Code CLI pronto: $(claude --version 2>/dev/null | head -1)."
else
  err "Claude Code CLI non trovato neanche dopo l'installazione. Prova a chiudere e riaprire il Terminale, poi riesegui ./launch-ai-supervisor.sh."
  exit 1
fi

print_footer
