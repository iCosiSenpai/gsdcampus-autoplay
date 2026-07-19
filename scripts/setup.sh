#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Hash package.json per npm install condizionale (modulo condiviso).
# shellcheck source=scripts/setup/package-hash.sh
. "$DIR/scripts/setup/package-hash.sh"
# shellcheck source=scripts/setup/browser-check.sh
. "$DIR/scripts/setup/browser-check.sh"

# Claude Code CLI installa il binario in ~/.local/bin; assicuriamo che sia
# subito disponibile nel PATH di questo script, anche negli shell non interattivi
# che non caricano .zshrc.
export PATH="$HOME/.local/bin:$PATH"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
MEMBERS_CLI="$DIR/scripts/lib/members-cli.js"
WHOAREYOU_CLI="$DIR/scripts/lib/whoareyou-cli.js"
IMPORT_MEMBERS="$DIR/scripts/import-members.js"

# Palette + spinner_run/ui_version condivisi. Le funzioni info/ok/warn/err/step
# di setup.sh (definite sotto, con stile "▶" proprio) VINCONO su quelle della lib:
# il source va tenuto PRIMA delle definizioni locali.
source "$DIR/scripts/lib/ui.sh"

AUTO_YES=false
FORCE_UPDATE=false
UNINSTALL=false
CONFIG_CHANGED=false   # true se l'utente ha appena (ri)configurato account/orari

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

# info/ok/warn/err/step arrivano da scripts/lib/ui.sh (glifi ✓ ✗ ⚠, progress
# ●●○): le vecchie copie locali sono state rimosse.

# Helper countdown "Timer + Invio per saltare" per i messaggi che l'utente deve leggere.
source "$DIR/scripts/lib/read-timer.sh"

# Legge il modello Ollama da config.json (campo `ollamaModel`).
# Fallback a costante letterale (NON a ${OLLAMA_MODEL}: circolare — vedi check-requirements.sh).
MODEL_FALLBACK="gemma4:cloud"
get_ollama_model() {
  node -e "try { const c=require('./config.json'); console.log(c.ollamaModel || '${MODEL_FALLBACK}'); } catch(e){ console.log('${MODEL_FALLBACK}'); }" 2>/dev/null || echo "${MODEL_FALLBACK}"
}
OLLAMA_MODEL="$(get_ollama_model)"

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

# package-hash: scripts/setup/package-hash.sh (sourced sotto)

# Attende che il server Ollama risponda su http://127.0.0.1:11434.
# Se non risponde, tenta di avviarlo tramite il daemon interno. NON bloccante: se
# il server non parte, setta OLLAMA_AVAILABLE=false e retorna 1 — il setup prosegue
# (l'autoplay può ancora eseguire i quiz a risposta nota) e l'AI supervisore
# gestirà Ollama più tardi. Il daemon ora retorna non-zero se non binda 11434.
OLLAMA_AVAILABLE=true
ensure_ollama_server() {
  if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
    OLLAMA_AVAILABLE=true
    return 0
  fi

  info "Server Ollama non attivo. Avvio in corso..."
  if [ -f "$DIR/scripts/ollama-daemon.sh" ]; then
    # `|| true`: sotto set -e, un daemon che retorna 1 (server non bindato) non
    # deve abortire tutto il setup. La verifica finale decide cosa fare.
    "$DIR/scripts/ollama-daemon.sh" start || true
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

  if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
    OLLAMA_AVAILABLE=true
    ok "Server Ollama attivo."
    return 0
  fi

  warn "Impossibile avviare il server Ollama."
  if [ -f "$DIR/logs/ollama.log" ]; then
    info "Ultimi log Ollama (logs/ollama.log):"
    tail -n 25 "$DIR/logs/ollama.log" 2>/dev/null | sed 's/^/    /'
  fi
  if [ "$AUTO_YES" = false ]; then
    read -q "RETRY?Riprovo ad avviare Ollama? [y/N] "
    echo ""
    if [[ "$RETRY" =~ ^[Yy]$ ]]; then
      "$DIR/scripts/ollama-daemon.sh" start || true
      if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
        OLLAMA_AVAILABLE=true
        ok "Server Ollama attivo."
        return 0
      fi
    fi
  fi
  warn "Continuo senza server Ollama: l'autoplay esegue comunque i quiz a risposta nota."
  warn "L'AI supervisore tenterà di avviare Ollama più tardi (launch-ai-supervisor.sh)."
  OLLAMA_AVAILABLE=false
  return 1
}

# Assicura che il CLI `ollama` sia raggiungibile nel PATH dopo l'installazione.
# L'installer ufficiale crea il symlink /usr/local/bin/ollama, ma il path del CLI
# dentro il bundle varia tra versioni (a volte Contents/Resources/ollama, a volte
# non presente) e la shell corrente potrebbe non avere /usr/local/bin nel PATH.
# Qui: se `ollama` non è in PATH, cerco il CLI nel bundle, creo/aggiorno il symlink
# in /usr/local/bin e aggiungo /usr/local/bin al PATH. Ritorna 0 se alla fine
# `command -v ollama` ha successo.
ensure_ollama_cli() {
  if command -v ollama &>/dev/null; then
    return 0
  fi

  # Symlink già creato dall'installer ma /usr/local/bin non in PATH: aggiungilo.
  if [ -x "/usr/local/bin/ollama" ]; then
    export PATH="/usr/local/bin:$PATH"
    command -v ollama &>/dev/null && return 0
  fi

  # Fallback: individua il CLI dentro il bundle dell'app (path variabile).
  local cli=""
  for cand in \
    "/Applications/Ollama.app/Contents/Resources/ollama" \
    "/Applications/Ollama.app/Contents/MacOS/ollama"; do
    if [ -x "$cand" ]; then
      cli="$cand"
      break
    fi
  done

  if [ -n "$cli" ]; then
    info "CLI ollama non in PATH: creo/aggiorno il symlink /usr/local/bin/ollama..."
    if ! ln -sf "$cli" "/usr/local/bin/ollama" 2>/dev/null; then
      sudo -v 2>/dev/null
      sudo ln -sf "$cli" "/usr/local/bin/ollama"
    fi
    export PATH="/usr/local/bin:$PATH"
  fi

  command -v ollama &>/dev/null
}

# True se package.json/package-lock.json sono cambiati rispetto all'ultimo hash salvato.

# Versioni minime consigliate delle dipendenze esterne. Se un collega ha già una
# versione >= di questa, lo script NON reinstalla e NON si blocca: va avanti.
# Se la versione è più vecchia, tenta un aggiornamento NON bloccante (se fallisce,
# prosegue con la versione presente piuttosto che abortire). Così chi ha già
# Ollama o Claude installati non viene fermato.
MIN_OLLAMA="0.3.0"   # serve `ollama launch` + modelli cloud
MIN_CLAUDE="1.0.0"   # Claude Code CLI moderno

# Confronto versione: restituisce 0 se $1 >= $2 (componenti numeriche separate da punto).
version_ge() {
  local a="$1" b="$2"
  local -a A B
  IFS='.' read -A A <<< "$a"
  IFS='.' read -A B <<< "$b"
  local n=${#A} m=${#B} i mx
  mx=$(( n > m ? n : m ))
  for ((i=1; i<=mx; i++)); do
    local ai=${A[i]:-0} bi=${B[i]:-0}
    ai=${ai//[^0-9]/}; bi=${bi//[^0-9]/}
    ai=${ai:-0}; bi=${bi:-0}
    (( ai > bi )) && return 0
    (( ai < bi )) && return 1
  done
  return 0
}

# Estrae la prima versione numerica x.y.z dallo stdout/stderr che le viene passato.
extract_version() {
  grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1
}

# Verifica LIVE che il link autologin scelto funzioni davvero: apre un browser
# headless e raggiunge la dashboard. Dà all'utente la conferma immediata che è
# tutto a posto (o lo avvisa subito se il link va aggiornato), invece di scoprirlo
# solo più tardi. Non blocca il setup: in caso di problemi il supervisore AI può
# comunque intervenire dopo.
HEALTHCHECK_CLI="$DIR/scripts/lib/healthcheck-cli.js"
verify_autologin_live() {
  [ -f "$HEALTHCHECK_CLI" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  step "Verifica accesso al corso"
  info "Provo ad accedere al corso con il link configurato (apro un browser, ~30s)..."
  local out
  if out=$(node "$HEALTHCHECK_CLI" 2>&1); then
    echo ""
    ok "Accesso al corso RIUSCITO. $out"
    ok "Il tuo link funziona: il supervisore potrà seguire il corso senza problemi."
  else
    echo ""
    warn "Non sono riuscito ad accedere al corso con questo link."
    warn "Dettaglio: $out"
    warn "Il link autologin potrebbe essere scaduto. Quando avvii il supervisore AI,"
    warn "chiedigli di aggiornare l'account (re-selezione dal database o nuovo CSV)."
  fi
}

print_header() {
  ui_header "Setup GSD Campus Autopilot" "versione $(ui_version "$DIR")" "⚡"
  echo ""
  echo "Ti guido in pochi passi a configurare l'automazione del corso."
  echo "Ti chiederò solo 2 cose semplici:"
  echo -e "  ${BOLD}1)${NC} Chi sei  — scegli il tuo nominativo (o incolla il link di accesso)"
  echo -e "  ${BOLD}2)${NC} Quando lavorare — giorni e orari in cui il corso deve andare avanti"
  echo ""
  echo "Al resto (programmi necessari, browser, modello AI) penso io in automatico:"
  echo -e "  ${DIM}Homebrew · Node.js · Playwright · Chrome · Ollama (${OLLAMA_MODEL}) · Claude Code · gh${NC}"
  echo "Quello che è già installato e aggiornato viene saltato."
  echo ""
  warn "Se il Terminale chiede di installare/aggiornare qualcosa (anche 'y/n'), rispondi SEMPRE sì."
  warn "Tranquillo: serve tutto per far funzionare il corso, e non tocca i tuoi dati personali."
  echo ""
  read_with_timer 6 "${BOLD}Leggi bene qui sopra: tra 6s proseguo (Invio per saltare).${NC}"
}

print_footer() {
  echo ""
  ui_hr
  ok "${GREEN}${BOLD}Setup completato con successo.${NC}"
  ui_hr
  echo ""
  info "Da ora ti basta SEMPRE questo comando (installa, aggiorna e avvia):"
  echo -e "  ${BOLD}curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash${NC}"
  echo ""
  info "Strumenti utili (opzionali):"
  echo "  • ./status.sh            — stato attuale e log"
  echo "  • ./status.sh --check     — stato + verifica LIVE che il link funzioni"
  echo "  • ./scripts/monitor-course.sh  — monitor live del corso (si aggiorna da solo)"
  echo ""
}

print_header

# Richiedi sudo UNA volta, in foreground, PRIMA dei prompt interattivi.
# Niente keepalive in background: un `sudo -v` lanciato in background legge la
# password da /dev/tty e, quando il timestamp scade durante il menu "Chi sei?"
# (raw-mode, eco in user-space) o i `read` degli orari, ruba i tasti digitati
# dall'utente — caratteri non visibili + "Sorry, try again. Password:". Il sudo
# lo rinfreschiamo in foreground al passo 5 (Ollama), dopo i prompt interattivi.
info "Richiesta privilegi sudo (una volta, prima del setup)..."
sudo -v
ok "Privilegi sudo acquisiti."

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

valid_autologin() {
  local url="$1"
  if [[ ! "$url" =~ ^https://tecsial\.gsdcampus\.it/autologin/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/[A-Za-z0-9]+$ ]]; then
    return 1
  fi
  return 0
}
cf_from_url() {
  local url="$1"
  [[ "$url" =~ autologin/([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])/ ]]
  echo "${match[1]:-}"
}
who_are_you() {
  local result_file="$DIR/.whoareyou_result.json"
  rm -f "$result_file"

  if ! AUTO_YES="$AUTO_YES" node "$WHOAREYOU_CLI" "$result_file"; then
    return 1
  fi

  # Se il risultato non c'è (es. keep in --yes senza file), leggi da config.json
  if [ ! -f "$result_file" ]; then
    AUTOLOGIN=$(node -e "try{const c=require('$CONFIG_FILE'); console.log(c.autologinUrl||'');}catch(e){console.log('')}" 2>/dev/null)
    ACTIVE_CF=$(node -e "try{const c=require('$CONFIG_FILE'); console.log(c.codice_fiscale||'');}catch(e){console.log('')}" 2>/dev/null)
    MEMBER_NAME=$(node -e "try{const c=require('$CONFIG_FILE'); console.log(c.memberName||'');}catch(e){console.log('')}" 2>/dev/null)
    if [ -z "$ACTIVE_CF" ] && [ -n "$AUTOLOGIN" ]; then
      ACTIVE_CF=$(cf_from_url "$AUTOLOGIN")
    fi
    return 0
  fi

  # Legge i dati dal JSON prodotto da whoareyou-cli.js
  local action
  action=$(node -e "
    const fs=require('fs');
    const r=JSON.parse(fs.readFileSync('$result_file','utf8'));
    console.log(r.action||'');
  " 2>/dev/null)

  if [ "$action" = "cancel" ]; then
    rm -f "$result_file"
    return 1
  fi

  AUTOLOGIN=$(node -e "
    const fs=require('fs');
    const r=JSON.parse(fs.readFileSync('$result_file','utf8'));
    console.log(r.autologinUrl||'');
  " 2>/dev/null)
  ACTIVE_CF=$(node -e "
    const fs=require('fs');
    const r=JSON.parse(fs.readFileSync('$result_file','utf8'));
    console.log(r.codice_fiscale||'');
  " 2>/dev/null)
  MEMBER_NAME=$(node -e "
    const fs=require('fs');
    const r=JSON.parse(fs.readFileSync('$result_file','utf8'));
    console.log(r.memberName||'');
  " 2>/dev/null)

  rm -f "$result_file"

  if [ "$action" != "keep" ] && [ -z "$AUTOLOGIN" ] && [ -z "$ACTIVE_CF" ]; then
    warn "whoareyou-cli non ha restituito un account valido."
    return 1
  fi

  return 0
}
apply_selected_account() {
  if [ -n "$MEMBER_NAME" ] && [ -n "$ACTIVE_CF" ] && [ "$MEMBER_NAME" != "(configurazione manuale)" ]; then
    ok "Account selezionato: $MEMBER_NAME (CF: $ACTIVE_CF)"
  elif [ -n "$ACTIVE_CF" ] && [ -n "$AUTOLOGIN" ]; then
    ok "Account configurato: CF $ACTIVE_CF — $(mask_url "$AUTOLOGIN")"
  elif [ -n "$AUTOLOGIN" ]; then
    ok "Account configurato: $(mask_url "$AUTOLOGIN")"
  fi
}

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
  # 3b. (non più attivo) Il campo codice_fiscale non deve bloccare la validità se
  # il database membri è vuoto/assente: in modalità manuale l'utente potrebbe non
  # aver importato il CSV. Il CF viene sempre derivato/verificato a runtime.
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

# Se config esiste ed è valido, mostra riepilogo e chiede se modificare orari
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
    read -q "REPLY?Vuoi modificare anche orari/altre impostazioni? [y/N] "
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

# GitHub CLI (gh) — opzionale. La segnalazione issue ora passa per un receiver
# server-side (Cloudflare Worker, vedi worker/README.md): HTTP POST, nessun token
# sui Mac dei colleghi, nessun account GitHub. gh serve solo come FALLBACK per il
# maintainer che voglia usare il path locale (issueReporterToken in config.json).
# Non blocca il setup se manca.
if ! command -v gh &>/dev/null; then
  info "GitHub CLI (gh) non trovato. Installazione in corso (opzionale, fallback maintainer)..."
  brew install gh 2>/dev/null || true
  if command -v gh &>/dev/null; then
    ok "gh installato: $(gh --version | head -1)."
  else
    warn "gh non installato (non bloccante): la segnalazione issue usa il receiver server-side."
  fi
else
  ok "gh già installato: $(gh --version | head -1). Salto."
fi

# 2. Node.js (richiesto >= 22 per node:sqlite built-in)
step "2/7 - Node.js"
NODE_MIN_MAJOR=22
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

# Schermata iniziale "Chi sei?" — prima di ogni altra scelta del setup.
# L'utente seleziona l'account dal database membri o incolla l'autologin.
step "Chi sei?"
if ! who_are_you; then
  # Se la riconfigurazione è stata annullata ma esiste un backup (creato da
  # install.sh in modalità "Cambia account/orari"), ripristiniamo la config
  # precedente invece di lasciare l'utente senza account.
  if [ -f "$DIR/config.json.bak" ] && [ ! -f "$CONFIG_FILE" ]; then
    mv "$DIR/config.json.bak" "$CONFIG_FILE"
    warn "Riconfigurazione annullata: ho ripristinato la configurazione precedente."
    ok "Account e orari ripristinati. Puoi rilanciare il comando curl quando vuoi cambiarli."
    exit 0
  fi
  err "Account non configurato. Impossibile proseguire."
  exit 1
fi
# Riconfigurazione completata con successo: il backup non serve più.
rm -f "$DIR/config.json.bak" 2>/dev/null || true
apply_selected_account

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


# Estrae il codice fiscale da un URL autologin valido.

# Schermata interattiva "CHI SEI?" — mostrata all'avvio del setup, prima di ogni
# altra scelta. Usa scripts/lib/whoareyou-cli.js che offre:
#   • su TTY: menu navigabile con frecce ↑/↓ e Invio, come una app nel terminale
#   • su non-TTY: menu numerico classico (per pipe/redirezioni)

# Logga l'account attivo/aggiornato. Il file config.json viene già scritto
# direttamente da whoareyou-cli.js per le azioni select/manual.

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
    warn "Orario non valido. Formati accettati: H, HH, HH:MM, H:MM, HH.MM, HHMM (es. 9, 16, 9:30, 1630)."
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

# Scelta giorni lavorativi con modelli rapidi (menu a frecce)
configure_days() {
  echo ""
  echo -e "${BOLD}Giorni lavorativi${NC}"
  echo "  Usa le frecce ↑/↓ e Invio per scegliere."
  local choice
  choice=$(node "$DIR/scripts/lib/prompt-cli.js" select \
    --title "Giorni lavorativi" --default 1 -- \
    "Lun–Ven  (5 giorni)" \
    "Lun–Sab  (6 giorni)" \
    "Tutti i giorni" \
    "Personalizzati (inserisci i numeri a mano)" 2>/dev/null || echo 1)
  case "$choice" in
    1) DAYS="1,2,3,4,5" ;;
    2) DAYS="1,2,3,4,5,6" ;;
    3) DAYS="0,1,2,3,4,5,6" ;;
    4)
      while true; do
        echo "Numeri: 0=dom 1=lun 2=mar 3=mer 4=gio 5=ven 6=sab"
        read "DAYS?Giorni separati da virgola (es. 1,2,3,4,5): "
        if valid_days "$DAYS"; then break; fi
        warn "Input non valido. Usa solo numeri da 0 a 6 separati da virgola."
      done ;;
    *) DAYS="1,2,3,4,5" ;;   # cancel/EOF → default
  esac
  DAYS_JSON=$(format_days "$DAYS")
  ok "Giorni: $(days_human "$DAYS_JSON")"
}

# Configurazione turni: modello di partenza (menu a frecce) + editor interattivo
configure_shifts() {
  echo ""
  echo -e "${BOLD}Turni di lavoro${NC}"
  echo "Scegli un modello di partenza (frecce ↑/↓ + Invio), poi potrai aggiungere/rimuovere turni."
  local seed
  seed=$(node "$DIR/scripts/lib/prompt-cli.js" select \
    --title "Turni di lavoro — scegli un modello di partenza" --default 1 -- \
    "Classico — 09:00-13:00 e 16:00-20:00" \
    "Continuato — 09:00-18:00" \
    "Solo mattina — 09:00-13:00" \
    "Solo pomeriggio — 14:00-18:00" \
    "Parto da zero — nessun turno, li aggiungo io" 2>/dev/null || echo 1)
  case "$seed" in
    1) SHIFT_SPECS=("9,0,13,0" "16,0,20,0") ;;   # nuovo default
    2) SHIFT_SPECS=("9,0,18,0") ;;
    3) SHIFT_SPECS=("9,0,13,0") ;;
    4) SHIFT_SPECS=("14,0,18,0") ;;
    5) SHIFT_SPECS=() ;;
    *) SHIFT_SPECS=("9,0,13,0" "16,0,20,0") ;;   # cancel/EOF → default
  esac

  # Editor interattivo dei turni (menu a frecce dinamico sullo stato corrente)
  local act ridx le def_start pick acts labels rlabels rpick
  while true; do
    sort_shifts
    echo ""
    echo -e "${BOLD}── I tuoi turni ──${NC}"
    render_shifts
    echo ""
    # Costruisco le azioni disponibili in base allo stato (turni presenti o no).
    acts=(); labels=()
    acts+=("add");    labels+=("Aggiungi un turno")
    if [ ${#SHIFT_SPECS} -gt 0 ]; then
      acts+=("rm");   labels+=("Rimuovi un turno")
      acts+=("clr");  labels+=("Svuota tutti i turni")
    fi
    acts+=("conf");   labels+=("Conferma e continua")
    # Default sull'ultima voce (Conferma): Invio-only = conferma, come il vecchio [c].
    pick=$(node "$DIR/scripts/lib/prompt-cli.js" select \
      --title "I tuoi turni — cosa vuoi fare?" --default ${#labels[@]} -- "${labels[@]}" 2>/dev/null || echo ${#labels[@]})
    act="${acts[$pick]}"
    [ -z "$act" ] && act="conf"   # cancel/EOF → conferma
    case "$act" in
      add)
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
      rm)
        rlabels=()
        for spec in "${SHIFT_SPECS[@]}"; do rlabels+=("$(spec_to_label "$spec")"); done
        rpick=$(node "$DIR/scripts/lib/prompt-cli.js" select \
          --title "Quale turno rimuovere?" -- "${rlabels[@]}" 2>/dev/null || echo 0)
        if [[ "$rpick" -ge 1 && "$rpick" -le ${#SHIFT_SPECS} ]]; then
          remove_shift "$rpick"
          ok "Turno $rpick rimosso."
        fi
        ;;
      clr)
        SHIFT_SPECS=()
        ok "Tutti i turni rimossi."
        ;;
      conf)
        if [ ${#SHIFT_SPECS} -eq 0 ]; then
          warn "Devi avere almeno un turno per continuare. Aggiungine uno con 'Aggiungi un turno'."
        else
          break
        fi
        ;;
    esac
  done
  sort_shifts
}

# Loop di configurazione con validazione e conferma finale
while true; do
  if [ "$MODIFY" = true ]; then
    echo ""
    echo -e "${BOLD}Configurazione orari di lavoro${NC}"
    echo ""
    ui_kv "Account" "${BOLD}$MEMBER_NAME${NC} ${DIM}(CF: $ACTIVE_CF)${NC}"
    ui_kv "Autologin" "$(mask_url "$AUTOLOGIN")"

    step "Orari di lavoro"
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
    ui_hr
    echo -e " ${BOLD}Riepilogo configurazione${NC}"
    ui_hr
    ui_kv "Membro" "${BOLD}$MEMBER_NAME${NC} ${DIM}(CF: $ACTIVE_CF)${NC}"
    ui_kv "Autologin" "$(mask_url "$AUTOLOGIN")"
    ui_kv "Giorni" "$(days_human "$DAYS_JSON")"
    ui_kv "Turni" "$shifts_summary"
    ui_kv "Modello" "${OLLAMA_MODEL:-gemma4:cloud}"
    ui_kv "Issue" "${DIM}segnalazione bug al maintainer attiva${NC}"
    ui_hr
    echo ""

    if [ "$AUTO_YES" = true ]; then
      REPLY="y"
    else
      read -q "REPLY?Confermi? [y/N] "
      echo ""
    fi

    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      # Scrive config.json via JSON.stringify per evitare problemi di escaping
      # con nomi contenenti virgolette o backslash. Preserva campi esistenti
      # come baseUrl, courseUrls, ollamaModel e le chiavi issue-* (reportIssues,
      # issueReporterToken, issueEndpoint, issueReportKey) — non le sovrascrive.
      ACTIVE_CF="$ACTIVE_CF" MEMBER_NAME="$MEMBER_NAME" AUTOLOGIN="$AUTOLOGIN" DAYS_JSON="$DAYS_JSON" SHIFTS_JSON="$SHIFTS_JSON" node -e "
        const fs = require('fs');
        const path = require('path');
        const cfgPath = '$CONFIG_FILE';
        let cfg = {};
        try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch(e) {}
        cfg.codice_fiscale = process.env.ACTIVE_CF;
        cfg.memberName = process.env.MEMBER_NAME;
        cfg.autologinUrl = process.env.AUTOLOGIN;
        if (!cfg.baseUrl) cfg.baseUrl = 'https://tecsial.gsdcampus.it/';
        if (!Array.isArray(cfg.courseUrls)) cfg.courseUrls = [];
        if (!cfg.ollamaModel) cfg.ollamaModel = '${OLLAMA_MODEL}';
        cfg.workSchedule = {
          days: process.env.DAYS_JSON.split(',').map(Number).filter(Boolean),
          shifts: JSON.parse('[' + process.env.SHIFTS_JSON + ']')
        };
        // Segnalazione issue: attiva di default per tutti via receiver server-side.
        // Non scriviamo issueReporterToken/issueEndpoint qui (gitignored / default
        // nel modulo). Preserva chiavi preesistenti; forziamo solo reportIssues a
        // true se assente (l'utente può disattivarla mettendola a false in config).
        if (cfg.reportIssues === undefined) cfg.reportIssues = true;
        // Scrittura atomica (tmp+rename): se il processo viene interrotto a metà
        // (SIGTERM/SIGINT/Ctrl-C durante il setup), config.json non resta troncato.
        const tmp = cfgPath + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
        fs.renameSync(tmp, cfgPath);
      " 2>/dev/null || {
        err "Impossibile salvare config.json con JSON.stringify, uso fallback heredoc."
        # Fallback heredoc anch'esso atomico: scrivo su .tmp poi rinomino.
        cat > "$CONFIG_FILE.tmp" <<EOF
{
  "codice_fiscale": "$ACTIVE_CF",
  "memberName": "$MEMBER_NAME",
  "autologinUrl": "$AUTOLOGIN",
  "baseUrl": "https://tecsial.gsdcampus.it/",
  "ollamaModel": "${OLLAMA_MODEL}",
  "courseUrls": [],
  "reportIssues": true,
  "workSchedule": {
    "days": [$DAYS_JSON],
    "shifts": [$SHIFTS_JSON]
  }
}
EOF
        mv "$CONFIG_FILE.tmp" "$CONFIG_FILE"
      }
      ok "Configurazione salvata in config.json"
      CONFIG_CHANGED=true
      # Migra i file di stato legacy (data/*.json personali) nella cartella
      # per-account data/accounts/<CF>/. Idempotente.
      if [ -n "$ACTIVE_CF" ]; then
        node "$MEMBERS_CLI" migrate-legacy 2>/dev/null && ok "Stato migrato in data/accounts/$ACTIVE_CF/"
      fi
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

# 3. npm dependencies — solo se package.json/package-lock.json sono cambiati,
# node_modules manca, oppure --force-update
step "3/7 - Dipendenze npm"
NEEDS_NPM=false
if [ "$FORCE_UPDATE" = true ] || [ ! -d "$DIR/node_modules" ] || package_hash_changed; then
  NEEDS_NPM=true
fi

if [ "$NEEDS_NPM" = true ]; then
  # spinner_run: npm install è muto per decine di secondi e il collega pensava
  # che il setup fosse bloccato. Output completo in logs/setup-npm.log.
  mkdir -p "$DIR/logs"
  spinner_run "Installazione dipendenze npm (può richiedere qualche minuto)" "$DIR/logs/setup-npm.log" npm install
else
  ok "Dipendenze npm già aggiornate. Salto."
fi

# 4. Browser: Chromium Playwright (sempre) + Google Chrome (consigliato).
# src/lib/browser.js: prova channel chrome, poi fallback Chromium bundled.
# Chrome assente NON blocca se Chromium è installato.
step "4/7 - Browser (Chrome consigliato, Chromium ok)"
info "Chrome di sistema è consigliato; se manca, Playwright Chromium basta per autoplay/healthcheck."
if [ "$FORCE_UPDATE" = true ] || [ "$NEEDS_NPM" = true ] || [ ! -d "$HOME/Library/Caches/ms-playwright" ]; then
  mkdir -p "$DIR/logs"
  spinner_run "Installazione Chromium Playwright (fallback browser)" "$DIR/logs/setup-playwright.log" npx playwright install chromium \
    || warn "playwright install chromium non riuscito (non bloccante se Chrome di sistema è presente)."
else
  ok "Componenti Playwright già presenti. Salto."
fi

# Google Chrome: preferito (fingerprint più “normale”). Opzionale se c’è Chromium.
CHROME_APP=""
[ -d "/Applications/Google Chrome.app" ] && CHROME_APP="/Applications/Google Chrome.app"
[ -z "$CHROME_APP" ] && [ -d "$HOME/Applications/Google Chrome.app" ] && CHROME_APP="$HOME/Applications/Google Chrome.app"
if [ -n "$CHROME_APP" ]; then
  ok "Google Chrome presente ($CHROME_APP) — backend preferito."
else
  if command -v brew &>/dev/null; then
    info "Google Chrome assente: installazione consigliata via Homebrew cask (opzionale)..."
    if brew install --cask google-chrome; then
      ok "Google Chrome installato."
    else
      warn "Chrome non installato via brew. Chromium Playwright resta ok: l'autoplay usa il fallback automatico. Oppure installa da google.com/chrome."
    fi
  else
    warn "Chrome assente e Homebrew non disponibile. Chromium Playwright (se installato) è sufficiente."
  fi
fi

# Salva l'hash aggiornato solo se abbiamo toccato le dipendenze o se mancava
if [ "$FORCE_UPDATE" = true ] || [ "$NEEDS_NPM" = true ] || [ ! -f "$DIR/.package_hash" ]; then
  save_package_hash
fi

# 5. Ollama
step "5/7 - Ollama"
install_ollama_official() {
  # Rinfresco sudo in foreground: l'installer crea symlink in /usr/local/bin che
  # può richiedere sudo. Avviene dopo i prompt interattivi, quindi nessun TUI attivo:
  # un eventuale prompt password è sicuro (l'utente sta guardando i log di install).
  sudo -v
  # OLLAMA_NO_START=1 fa saltare all'installer ufficiale il `open -a Ollama` finale,
  # che fallisce ("Unable to find application named 'Ollama'") perché LaunchServices
  # non ha ancora registrato l'app appena spostata in /Applications. Con set -eu
  # nell'installer, quel fallimento abortirebbe tutto il setup. Il server lo avviamo
  # noi headless (ollama-daemon.sh). L'installer esce 0 pulito.
  if ! curl -fsSL https://ollama.com/install.sh | OLLAMA_NO_START=1 sh; then
    warn "Installer Ollama ha segnalato un errore (es. avvio GUI non riuscito). Verifico comunque il CLI..."
  fi
  # Rimuovo il com.apple.quarantine dall'app appena installata. Con OLLAMA_NO_START=1
  # l'installer NON fa `open -a Ollama`, quindi l'app non viene mai "aperta" via
  # LaunchServices e il Gatekeeper non sgombra il quarantine. Il nostro daemon poi
  # lancia il binario Contents/MacOS/Ollama DIRETTAMENTE (non via `open`): macOS
  # SIGKILLa un binario lanciato direttamente da un bundle ancora in quarantine →
  # il server non silega mai su 11434 ("Ollama non ha risposto entro 15s" e poi il
  # processo muore). Su un Mac dove Ollama è stato `open`-ato una volta il quarantine
  # è già pulito e l'xattr è un no-op, quindi è sicuro ribadirlo qui.
  if [ -d "/Applications/Ollama.app" ]; then
    xattr -dr com.apple.quarantine "/Applications/Ollama.app" 2>/dev/null \
      || sudo xattr -dr com.apple.quarantine "/Applications/Ollama.app" 2>/dev/null || true
  fi
  # Consenso Gatekeeper preventivo: `open -a Ollama` subito dopo l'install fallisce
  # ("application named 'Ollama' not found") perché LaunchServices non ha ancora
  # registrato il bundle appena spostato. Riprovo con delay. Quando l'utente clicca
  # "Apri" nel dialogo di consenso, macOS sgombra com.apple.quarantine per i lanci
  # diretti futuri (altrimenti il daemon's `ollama serve` viene SIGKILLato). Gated
  # sul flag quarantine: no-op su un Mac dove Ollama è già stato aperto una volta.
  # Questo triggera preventivamente i permessi che su un Mac nuovo non sono ancora
  # stati concessi (il terminale "non aveva ancora tutti i permessi").
  if [ -d "/Applications/Ollama.app" ]; then
    # grep -c (non -q): niente SIGPIPE in pipeline (v. commento in start.sh).
    if xattr -l "/Applications/Ollama.app" 2>/dev/null | grep -c 'com.apple.quarantine' >/dev/null; then
      info "Primo avvio Ollama: si aprirà il dialogo di consenso Gatekeeper. Clicca 'Apri'."
      local consented=false
      for attempt in 1 2 3; do
        if open -a Ollama 2>/dev/null; then
          for s in $(seq 1 15); do
            if pgrep -x Ollama >/dev/null 2>&1; then consented=true; break; fi
            sleep 1
          done
          break
        fi
        sleep 3   # delay di registrazione LaunchServices prima di ritentare
      done
      if [ "$consented" = true ]; then
        ok "Consenso Gatekeeper concesso. Chiudo l'app GUI e proseguo headless."
        osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
        sleep 1
      else
        warn "Non sono riuscito ad aprire Ollama in automatico (LaunchServices non registrato o hai annullato)."
        warn "Se l'avvio headless fallisce, apri Ollama una volta dal Finder, poi rilancia."
      fi
    fi
  fi
  # Best-effort: se non riesco a mettere ollama in PATH, non abortire qui;
  # ci pensa il controllo successivo (CLI o app binary mancanti) con un messaggio utile.
  ensure_ollama_cli || true
}

if ! command -v ollama &>/dev/null; then
  info "Ollama non trovato. Installazione in corso..."
  install_ollama_official
  if ! command -v ollama &>/dev/null && [ ! -x "/Applications/Ollama.app/Contents/MacOS/Ollama" ]; then
    err "Installazione Ollama non riuscita (CLI non disponibile)."
    info "Prova a eseguire manualmente: curl -fsSL https://ollama.com/install.sh | sh"
    exit 1
  fi
  ok "Ollama installato."
elif [ "$FORCE_UPDATE" = true ]; then
  info "Reinstallazione/aggiornamento Ollama (richiesto --force-update)..."
  install_ollama_official
  ok "Ollama aggiornato."
else
  OLLAMA_VER=$(ollama --version 2>/dev/null | extract_version)
  if [ -z "$OLLAMA_VER" ]; then
    ok "Ollama già installato: $(ollama --version 2>/dev/null | head -1). Salto."
  elif version_ge "$OLLAMA_VER" "$MIN_OLLAMA"; then
    ok "Ollama già installato (v$OLLAMA_VER ≥ min $MIN_OLLAMA). Salto."
  else
    warn "Ollama presente ma versione vecchia (v$OLLAMA_VER < $MIN_OLLAMA). Provo ad aggiornare..."
    install_ollama_official
    if command -v ollama &>/dev/null; then
      ok "Ollama aggiornato: $(ollama --version 2>/dev/null | head -1)."
    else
      warn "Aggiornamento Ollama non riuscito: continuo con la versione presente (v$OLLAMA_VER)."
    fi
  fi
fi

# Prima di interrogare i modelli, assicurati che il server Ollama sia attivo.
# Non bloccante: se non parte, OLLAMA_AVAILABLE=false e saltiamo il pull del modello.
ensure_ollama_server || true

# 6. Modello ${OLLAMA_MODEL} (cloud, richiede login Ollama)
step "6/7 - Modello Ollama ${OLLAMA_MODEL}"
if [ "$OLLAMA_AVAILABLE" = false ]; then
  warn "Salto il download del modello ${OLLAMA_MODEL}: server Ollama non disponibile."
  warn "L'AI supervisore (launch-ai-supervisor.sh) riproverà ad avviare Ollama e scaricare il modello."
else
  # model_present_setup: grep -c >/dev/null (non -q) per evitare SIGPIPE se in
  # futuro questo script passasse a pipefail (bug già visto nel launcher).
  model_present_setup() {
    ollama list 2>/dev/null | grep -c "${OLLAMA_MODEL}" >/dev/null
  }
  if model_present_setup; then
    ok "Modello ${OLLAMA_MODEL} già presente. Salto."
  else
    # PULL-FIRST: se l'utente è già loggato su ollama.com il pull riesce subito,
    # senza mai mostrare istruzioni browser/login. Il login (ollama signin, che
    # stampa da solo l'URL reale) parte SOLO se il pull fallisce davvero.
    info "Download modello ${OLLAMA_MODEL} (la prima volta può richiedere qualche minuto)..."
    if ! ollama pull "${OLLAMA_MODEL}"; then
      echo ""
      warn "Per usare ${OLLAMA_MODEL} serve il login GRATUITO su ollama.com (basta registrarsi, niente da pagare)."
      info "Ora si apre il browser; se non si apre da solo, copia nel browser l'URL che Ollama stampa qui sotto."
      echo ""
      read_with_timer 5 "${BOLD}Tra 5s parte il login (Invio per saltare l'attesa).${NC}"
      ollama signin || true
      info "Riprovo il download di ${OLLAMA_MODEL}..."
      ollama pull "${OLLAMA_MODEL}" || true
    fi
    if model_present_setup; then
      ok "Modello ${OLLAMA_MODEL} pronto."
    else
      err "Download del modello ${OLLAMA_MODEL} non riuscito."
      warn "Completa il login su ollama.com e rilancia:  cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh"
      warn "Nel frattempo l'autoplay può girare senza AI con:  ./start.sh"
      exit 1
    fi
  fi
fi

# 7. Claude Code CLI
step "7/7 - Claude Code CLI"
ensure_local_bin_in_path
if ! command -v claude &>/dev/null; then
  info "Claude Code CLI non trovato. Installazione in corso..."
  # Non bloccante: se l'install fallisce (rete), warn e prosegui — il check finale
  # sotto rileverà claude mancante e darà un messaggio chiaro invece di abortire opaco.
  curl -fsSL https://claude.ai/install.sh | bash || warn "Installazione Claude Code non riuscita (rete?). Il check finale segnalerà se manca."
  ensure_local_bin_in_path
else
  CLAUDE_VER=$(claude --version 2>/dev/null | extract_version)
  if [ -z "$CLAUDE_VER" ]; then
    ok "Claude Code CLI già installato: $(claude --version 2>/dev/null | head -1). Salto."
  elif version_ge "$CLAUDE_VER" "$MIN_CLAUDE"; then
    ok "Claude Code CLI già installato (v$CLAUDE_VER ≥ min $MIN_CLAUDE). Salto."
  else
    warn "Claude presente ma versione vecchia (v$CLAUDE_VER < $MIN_CLAUDE). Provo ad aggiornare..."
    if curl -fsSL https://claude.ai/install.sh | bash; then
      ensure_local_bin_in_path
      ok "Claude aggiornato: $(claude --version 2>/dev/null | head -1)."
    else
      warn "Aggiornamento Claude non riuscito: continuo con la versione presente (v$CLAUDE_VER)."
    fi
  fi
fi

if command -v claude &>/dev/null; then
  ok "Claude Code CLI pronto: $(claude --version 2>/dev/null | head -1)."
else
  err "Claude Code CLI non trovato neanche dopo l'installazione. Prova a chiudere e riaprire il Terminale, poi riesegui ./launch-ai-supervisor.sh."
  exit 1
fi

# Verifica LIVE dell'accesso solo quando l'utente ha appena (ri)configurato un
# account: è il momento in cui la conferma "il link funziona" è più utile. Nel
# path di solo aggiornamento (--yes, config già valida) non rallentiamo con i ~30s.
if [ "$CONFIG_CHANGED" = true ]; then
  verify_autologin_live
fi

# Auto-update notturno (launchd, 05:30): installazione idempotente, opt-out
# con "autoUpdate": false in config.json. Non bloccante.
if [ -x "$DIR/scripts/lib/install-launchd.sh" ]; then
  "$DIR/scripts/lib/install-launchd.sh" install 2>/dev/null || warn "Auto-update notturno non attivato (riproverò al prossimo aggiornamento)."
fi

print_footer
