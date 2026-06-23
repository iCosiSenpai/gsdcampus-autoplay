#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Colori per output interattivo
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

AUTO_YES=false
if [ "$1" = "--yes" ]; then
  AUTO_YES=true
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

print_header() {
  echo ""
  echo "============================================"
  echo -e "${BOLD}  Setup gsdcampus-autoplay${NC}"
  echo "============================================"
  echo ""
  echo "Questo script aggiorna/verifica:"
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

load_example() {
  cat "$EXAMPLE_FILE"
}

mask_url() {
  local url="$1"
  if [ "${#url}" -le 20 ]; then
    echo "$url"
  else
    echo "${url:0:20}…(${#url} caratteri)"
  fi
}

# Se config.json esiste, controlla se è un placeholder da configurare
IS_PLACEHOLDER=false
if [ -f "$CONFIG_FILE" ]; then
  if grep -q "Incolla qui il tuo link autologin personale" "$CONFIG_FILE" 2>/dev/null; then
    IS_PLACEHOLDER=true
  fi
fi

# Se config.json esiste ed è valido, mostra un riepilogo e chiede se modificarlo
if [ -f "$CONFIG_FILE" ] && [ "$IS_PLACEHOLDER" = false ]; then
  CURRENT_URL=$(grep -o '"autologinUrl"[^,]*' "$CONFIG_FILE" | head -1 | sed 's/.*"autologinUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  CURRENT_DAYS=$(node -e "const c=require('./config.json'); console.log((c.workSchedule&&c.workSchedule.days||[]).join(','));" 2>/dev/null || echo "1,2,3,4,5")
  CURRENT_SHIFTS=$(node -e "
const c=require('./config.json');
const s=c.workSchedule&&c.workSchedule.shifts||[];
console.log(s.map(x=\>\`${x.startHour}:${String(x.startMin).padStart(2,'0')}-${x.endHour}:${String(x.endMin).padStart(2,'0')}\`).join(', '));
" 2>/dev/null || echo "9:30-13:00, 16:30-20:00")

  echo ""
  echo "Trovata configurazione esistente:"
  echo "  Autologin: $(mask_url "$CURRENT_URL")"
  echo "  Giorni:    $CURRENT_DAYS (0=dom, 1=lun, … 6=sab)"
  echo "  Turni:     $CURRENT_SHIFTS"
  echo ""

  if [ "$AUTO_YES" = false ]; then
    read -q "REPLY?Vuoi modificarla? [y/N] "
    echo ""
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      MODIFY=true
    else
      MODIFY=false
    fi
  else
    MODIFY=false
  fi
else
  MODIFY=true
fi

if [ "$IS_PLACEHOLDER" = true ]; then
  echo ""
  warn "config.json contiene dati fittizi del repository."
  warn "È necessario inserire i tuoi dati prima di continuare."
  echo ""
fi

if [ "$MODIFY" = true ]; then
  echo ""
  warn "Incolla il TUO link di autologin personale GSD Campus."
  warn "Lo trovi nell'email di invito al corso o nella piattaforma."
  echo ""
  read "AUTOLOGIN?Link autologin: "
  echo ""

  while [ -z "$AUTOLOGIN" ]; do
    warn "Il link autologin è obbligatorio."
    read "AUTOLOGIN?Link autologin: "
    echo ""
  done

  echo ""
  echo -e "${BOLD}Configurazione orari di lavoro${NC}"
  echo "Lascia vuoto e premi Invio per confermare il valore mostrato tra []."
  echo ""

  echo "Giorni lavorativi (0=dom, 1=lun, 2=mar, 3=mer, 4=gio, 5=ven, 6=sab)."
  echo "Esempi: 1,2,3,4,5 oppure 1,2,3,4,5,6"
  read "DAYS?Giorni [1,2,3,4,5]: "
  [ -z "$DAYS" ] && DAYS="1,2,3,4,5"
  echo ""

  echo "Turno 1 (mattina). Formato HH:MM, es. 09:30."
  read "SHIFT1_START?Inizio [09:30]: "
  [ -z "$SHIFT1_START" ] && SHIFT1_START="09:30"
  read "SHIFT1_END?Fine [13:00]: "
  [ -z "$SHIFT1_END" ] && SHIFT1_END="13:00"
  echo ""

  echo "Turno 2 (pomeriggio). Formato HH:MM, es. 16:30."
  read "SHIFT2_START?Inizio [16:30]: "
  [ -z "$SHIFT2_START" ] && SHIFT2_START="16:30"
  read "SHIFT2_END?Fine [20:00]: "
  [ -z "$SHIFT2_END" ] && SHIFT2_END="20:00"
  echo ""

  # Parsing helper
  parse_time() {
    local t="$1"
    local h m
    h=$(echo "$t" | sed 's/[^0-9]//g' | cut -c1-2)
    m=$(echo "$t" | sed 's/[^0-9]//g' | cut -c3-4)
    [ -z "$h" ] && h=0
    [ -z "$m" ] && m=0
    printf '%s %s' "$h" "$m"
  }

  read S1H S1M <<< "$(parse_time "$SHIFT1_START")"
  read E1H E1M <<< "$(parse_time "$SHIFT1_END")"
  read S2H S2M <<< "$(parse_time "$SHIFT2_START")"
  read E2H E2M <<< "$(parse_time "$SHIFT2_END")"

  # Normalizza giorni in array JSON
  DAYS_JSON=$(echo "$DAYS" | tr ',' '\n' | grep -E '^[0-6]$' | sort -u | tr '\n' ',' | sed 's/,$//')
  [ -z "$DAYS_JSON" ] && DAYS_JSON="1,2,3,4,5"

  cat > "$CONFIG_FILE" <<EOF
{
  "autologinUrl": "$AUTOLOGIN",
  "baseUrl": "https://tecsial.gsdcampus.it/",
  "courseUrls": [
    "https://tecsial.gsdcampus.it/corso/show/8122",
    "https://tecsial.gsdcampus.it/corso/show/15580",
    "https://tecsial.gsdcampus.it/corso/show/16146"
  ],
  "workSchedule": {
    "days": [$DAYS_JSON],
    "shifts": [
      { "startHour": $S1H, "startMin": $S1M, "endHour": $E1H, "endMin": $E1M },
      { "startHour": $S2H, "startMin": $S2M, "endHour": $E2H, "endMin": $E2M }
    ]
  }
}
EOF

  ok "Configurazione salvata in config.json"
  ok "Autologin: $(mask_url "$AUTOLOGIN")"
  ok "Giorni: $DAYS_JSON"
  ok "Turni: ${S1H}:${S1M}-${E1H}:${E1M}, ${S2H}:${S2M}-${E2H}:${E2M}"
else
  ok "Configurazione esistente confermata."
fi

# 1. Homebrew
step "1/7 - Homebrew"
if ! command -v brew &>/dev/null; then
  info "Homebrew non trovato. Installazione in corso..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
else
  ok "Homebrew già installato: $(brew --version | head -1)"
fi
info "Aggiornamento Homebrew..."
brew update
brew upgrade
ok "Homebrew aggiornato."

# 2. Node.js
step "2/7 - Node.js"
if command -v node &>/dev/null; then
  info "Node.js presente: $(node -v). Verifica aggiornamento..."
else
  info "Node.js non trovato. Installazione in corso..."
fi
brew install node 2>/dev/null || true
brew upgrade node 2>/dev/null || true
ok "Node.js pronto: $(node -v)"

# 3. npm dependencies
step "3/7 - Dipendenze npm"
info "Installazione/aggiornamento dipendenze..."
npm install
ok "Dipendenze npm aggiornate."

# 4. Playwright browsers / Chrome
step "4/7 - Browser per Playwright"
info "Installazione/aggiornamento Chromium..."
npx playwright install chromium
ok "Browser Playwright pronto."

# 5. Ollama
step "5/7 - Ollama"
if command -v ollama &>/dev/null; then
  info "Ollama presente: $(ollama --version | head -1). Reinstallazione/aggiornamento..."
else
  info "Ollama non trovato. Installazione in corso..."
fi
curl -fsSL https://ollama.com/install.sh | sh
ok "Ollama pronto."

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
  ok "Modello gemma4:31b-cloud presente."
fi

# 7. Claude Code CLI
step "7/7 - Claude Code CLI"
if command -v claude &>/dev/null; then
  ok "Claude Code CLI presente: $(claude --version 2>/dev/null | head -1)."
else
  info "Claude Code CLI non trovato. Installazione in corso..."
  curl -fsSL https://claude.ai/install.sh | bash
  ok "Claude Code CLI installato."
fi

# Assicurarsi che ~/.local/bin sia nel PATH (solo se non già presente)
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  info "Aggiunta ~/.local/bin al PATH in .zshrc..."
  export PATH="$HOME/.local/bin:$PATH"
  if [ -f "$HOME/.zshrc" ] && ! grep -q 'export PATH="\$HOME/.local/bin:\$PATH"' "$HOME/.zshrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
  fi
  ok "PATH aggiornato."
fi

print_footer
