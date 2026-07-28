#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Hash package.json per npm install condizionale (modulo condiviso).
# shellcheck source=scripts/setup/package-hash.sh
. "$DIR/scripts/setup/package-hash.sh"
# shellcheck source=scripts/setup/browser-check.sh
. "$DIR/scripts/setup/browser-check.sh"
# shellcheck source=scripts/setup/versions.sh
. "$DIR/scripts/setup/versions.sh"
# shellcheck source=scripts/setup/ollama.sh
. "$DIR/scripts/setup/ollama.sh"

# Claude Code native installa il binario in ~/.local/bin. Lo rendiamo subito
# disponibile anche negli shell non interattivi che non caricano .zshrc.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
CONFIG_CHECK_CLI="$DIR/scripts/lib/config-check-cli.js"
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
MODEL_FALLBACK="gemma4:31b-cloud"
get_ollama_model() {
  node -e "try { const c=require('./config.json'); console.log(c.ollamaModel || '${MODEL_FALLBACK}'); } catch(e){ console.log('${MODEL_FALLBACK}'); }" 2>/dev/null || echo "${MODEL_FALLBACK}"
}
OLLAMA_MODEL="$(get_ollama_model)"

# Claude Code native usa ~/.local/bin. Negli shell non interattivi .zshrc non
# viene letto, quindi attiviamo e persistiamo quel path senza rimuovere eventuali
# righe di altri tool gia presenti.
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

# ollama ensure: scripts/setup/ollama.sh (sourced)


# True se package.json/package-lock.json sono cambiati rispetto all'ultimo hash salvato.

# versions: scripts/setup/versions.sh (sourced)


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
  ui_header "Setup GSD Campus Autopilot" "versione $(ui_version "$DIR")" "ᗧ"
  echo ""
  echo "Ti guido in pochi passi a configurare l'automazione del corso."
  echo "Ti chiederò solo 2 cose semplici:"
  echo -e "  ${BOLD}1)${NC} Chi sei  — scegli il tuo nominativo (o incolla il link di accesso)"
  echo -e "  ${BOLD}2)${NC} Quando lavorare — giorni e orari in cui il corso deve andare avanti"
  echo ""
  echo "Al resto (programmi necessari, browser, modello AI) penso io in automatico:"
  echo -e "  ${DIM}Homebrew · Node.js · Playwright · Chrome · Ollama CLI · Claude Code · gh${NC}"
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
info "Ora ti chiedo la password del Mac — quella con cui lo accendi."
info "Serve una volta sola per installare i programmi e non viene salvata da nessuna parte."
sudo -v
ok "Grazie: non me la chiederà più."

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

# Migrazione idempotente delle vecchie configurazioni OpenCode/Ollama. Non
# avvia Claude/Ollama e crea backup prima di toccare impostazioni personali.
if [ -f "$DIR/scripts/lib/migrate-claude-settings.js" ]; then
  node "$DIR/scripts/lib/migrate-claude-settings.js" >/dev/null 2>&1 \
    || warn "Migrazione impostazioni Claude non completata; riprovero al prossimo aggiornamento."
fi

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
# Legge l'account attivo da config.json in AUTOLOGIN / ACTIVE_CF / MEMBER_NAME.
load_account_from_config() {
  AUTOLOGIN=$(node -e "try{const c=require('$CONFIG_FILE'); console.log(c.autologinUrl||'');}catch(e){console.log('')}" 2>/dev/null)
  ACTIVE_CF=$(node -e "try{const c=require('$CONFIG_FILE'); console.log(c.codice_fiscale||'');}catch(e){console.log('')}" 2>/dev/null)
  MEMBER_NAME=$(node -e "try{const c=require('$CONFIG_FILE'); console.log(c.memberName||'');}catch(e){console.log('')}" 2>/dev/null)
  if [ -z "$ACTIVE_CF" ] && [ -n "$AUTOLOGIN" ]; then
    ACTIVE_CF=$(cf_from_url "$AUTOLOGIN")
  fi
}

who_are_you() {
  local result_file="$DIR/.whoareyou_result.json"
  rm -f "$result_file"

  if ! AUTO_YES="$AUTO_YES" node "$WHOAREYOU_CLI" "$result_file"; then
    return 1
  fi

  # Se il risultato non c'è (es. keep in --yes senza file), leggi da config.json
  if [ ! -f "$result_file" ]; then
    load_account_from_config
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

  # "Mantieni account attuale": whoareyou-cli restituisce solo {action:"keep"},
  # senza ripetere i dati. Vanno riletti da config.json, altrimenti il
  # salvataggio a valle scriverebbe autologinUrl/codice_fiscale/memberName
  # VUOTI — cioè cancellerebbe l'account di chi voleva solo cambiare gli orari.
  if [ "$action" = "keep" ] || { [ -z "$AUTOLOGIN" ] && [ -z "$ACTIVE_CF" ]; }; then
    load_account_from_config
  fi

  if [ -z "$AUTOLOGIN" ] && [ -z "$ACTIVE_CF" ]; then
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
  # Delega a src/lib/config-check.js (condiviso con launch-ai-supervisor.sh):
  # JSON valido + autologin nel formato atteso + almeno un giorno e un turno.
  node "$CONFIG_CHECK_CLI" >/dev/null 2>&1
}

# Motivo dell'incompletezza: 'missing_file' | 'bad_json' | 'missing_autologin'
# | 'missing_schedule' (prima configurazione interrotta dopo «Chi sei?»).
config_state_reason() {
  node "$CONFIG_CHECK_CLI" 2>/dev/null || true
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
  # Distinguo "non c'è ancora niente" da "prima configurazione interrotta a metà":
  # se l'utente ha scelto il membro in «Chi sei?» e poi ha annullato o chiuso il
  # Terminale, config.json esiste con l'account ma senza orari.
  CONFIG_REASON="$(config_state_reason)"
  if [ "$AUTO_YES" = true ]; then
    if [ -t 0 ]; then
      # C'è un terminale: RIPRENDIAMO la configurazione da dove si era interrotta
      # invece di uscire con errore. Prima questo ramo faceva `exit 1` e bloccava
      # "Aggiorna e avvia" a OGNI rilancio del comando curl: l'utente restava
      # fermo finché non scopriva di dover lanciare ./scripts/setup.sh a mano.
      echo ""
      if [ "$CONFIG_REASON" = "missing_schedule" ]; then
        warn "La configurazione precedente è rimasta a metà: account scelto, orari mai salvati."
      else
        warn "Configurazione assente o non valida: la prima configurazione non è stata completata."
      fi
      info "La riprendo adesso: ti richiedo account e orari (un minuto), poi proseguo da solo."
      echo ""
      read_with_timer 4 "${DIM}Tra 4s riprendo da «Chi sei?» (Invio per saltare).${NC}"
      # Solo la parte di configurazione torna interattiva: installazioni e
      # aggiornamenti a valle restano automatici.
      AUTO_YES=false
    else
      echo ""
      err "Configurazione mancante o non valida e nessun terminale interattivo disponibile."
      info "Esegui una volta: cd $DIR && ./scripts/setup.sh (senza --yes) per configurare autologin e orari."
      exit 1
    fi
  fi
  if [ "$CONFIG_REASON" = "missing_schedule" ]; then
    echo ""
    info "Configurazione da completare: account già presente, mancano i giorni e i turni."
    echo ""
  elif [ -f "$CONFIG_FILE" ]; then
    echo ""
    warn "config.json esistente ma non valido o contiene dati fittizi."
    warn "Verrà riconfigurato da zero."
    echo ""
  elif [ -f "$DIR/config.json.bak" ]; then
    echo ""
    info "Riconfigurazione: ti richiedo account e orari (se annulli ripristino i precedenti)."
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
  # precedente invece di lasciare l'utente senza account. Il backup vale anche
  # quando config.json esiste ma è incompleto (setup interrotto a metà): senza
  # questo controllo un annullamento lasciava sul disco la config mutilata.
  if [ -f "$DIR/config.json.bak" ] && ! is_config_valid; then
    mv -f "$DIR/config.json.bak" "$CONFIG_FILE"
    warn "Riconfigurazione annullata: ho ripristinato la configurazione precedente."
    ok "Account e orari ripristinati. Puoi rilanciare il comando curl quando vuoi cambiarli."
    exit 0
  fi
  err "Account non configurato. Impossibile proseguire."
  info "Nessun problema: rilancia il comando curl quando vuoi e riprendo da qui."
  exit 1
fi
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

# Indice 1-based del turno che si sovrappone all'intervallo [start_min, end_min),
# oppure stringa vuota se nessuno. skip_idx (opzionale, 1-based) esclude dal
# controllo il turno che si sta modificando.
overlapping_shift_index() {
  local start_min="$1" end_min="$2" skip_idx="${3:-0}"
  local i=1 spec h1 m1 h2 m2 p_start p_end
  for spec in "$SHIFT_SPECS[@]"; do
    if [ "$i" -ne "$skip_idx" ]; then
      h1=$(echo "$spec" | cut -d, -f1)
      m1=$(echo "$spec" | cut -d, -f2)
      h2=$(echo "$spec" | cut -d, -f3)
      m2=$(echo "$spec" | cut -d, -f4)
      p_start=$((h1 * 60 + m1))
      p_end=$((h2 * 60 + m2))
      if [ "$start_min" -lt "$p_end" ] && [ "$end_min" -gt "$p_start" ]; then
        echo "$i"
        return 0
      fi
    fi
    i=$((i + 1))
  done
  echo ""
  return 1
}

# Chiede inizio/fine e valida (fine > inizio, nessuna sovrapposizione).
# Successo: imposta NEW_SPEC ("sh,sm,eh,em"). skip_idx esclude un turno dal
# controllo di sovrapposizione (serve quando lo si sta modificando).
ask_shift_times() {
  local label="$1"
  local default_start="$2"
  local default_end="$3"
  local skip_idx="${4:-0}"
  echo ""
  echo -e "${BOLD}${label}${NC}"
  prompt_time "  Inizio" "$default_start"
  local s_h=$LAST_H s_m=$LAST_M
  prompt_time "  Fine" "$default_end"
  local e_h=$LAST_H e_m=$LAST_M

  local start_min=$((s_h * 60 + s_m))
  local end_min=$((e_h * 60 + e_m))
  if [ "$start_min" -ge "$end_min" ]; then
    warn "L'orario di fine deve essere successivo a quello di inizio."
    return 1
  fi

  local clash
  clash=$(overlapping_shift_index "$start_min" "$end_min" "$skip_idx" || true)
  if [ -n "$clash" ]; then
    warn "Questo orario si sovrappone al turno $clash ($(spec_to_label "$SHIFT_SPECS[$clash]"))."
    return 1
  fi

  NEW_SPEC="${s_h},${s_m},${e_h},${e_m}"
  return 0
}

# Chiede un range e lo aggiunge all'array SHIFT_SPECS (stringhe "startHour,startMin,endHour,endMin")
ask_shift() {
  ask_shift_times "$1" "$2" "$3" 0 || return 1
  SHIFT_SPECS+=("$NEW_SPEC")
  return 0
}

# Modifica il turno con indice 1-based: ripropone gli orari attuali come default,
# quindi basta Invio per tenerli.
edit_shift() {
  local idx="$1" spec sh sm eh em cur_start cur_end
  spec="$SHIFT_SPECS[$idx]"
  [ -n "$spec" ] || return 1
  sh=$(echo "$spec" | cut -d, -f1)
  sm=$(echo "$spec" | cut -d, -f2)
  eh=$(echo "$spec" | cut -d, -f3)
  em=$(echo "$spec" | cut -d, -f4)
  cur_start=$(node "$SCHEDULE_CLI" format-time "$sh" "$sm")
  cur_end=$(node "$SCHEDULE_CLI" format-time "$eh" "$em")
  echo ""
  info "Invio tiene l'orario attuale; per cambiarlo scrivi il nuovo (es. 9:30, 1630)."
  if ask_shift_times "Modifica turno $idx (ora: ${cur_start}-${cur_end})" "$cur_start" "$cur_end" "$idx"; then
    SHIFT_SPECS[$idx]="$NEW_SPEC"
    ok "Turno $idx aggiornato: $(spec_to_label "$NEW_SPEC")"
    return 0
  fi
  info "Turno $idx lasciato invariato (${cur_start}-${cur_end})."
  return 1
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

# Riga di riepilogo dei turni per il sottotitolo del menu (il menu a frecce
# pulisce lo schermo, quindi la lista va dentro il menu stesso per restare visibile).
shifts_subtitle() {
  if [ ${#SHIFT_SPECS} -eq 0 ]; then
    echo "Nessun turno impostato: aggiungine almeno uno per continuare."
    return 0
  fi
  local out="" spec
  for spec in "${SHIFT_SPECS[@]}"; do
    [ -n "$out" ] && out+="   ·   "
    out+="$(spec_to_label "$spec")"
  done
  echo "Turni attuali:  $out"
}

# Giorni di apertura: lista da spuntare (prima erano numeri da digitare,
# "0=dom 1=lun …": lo schema più da tecnico di tutto il setup).
configure_days() {
  local picked
  picked=$(node "$DIR/scripts/lib/prompt-cli.js" check \
    --title "In quali giorni è aperto il negozio?" \
    --subtitle "Spazio per spuntare · A tutti · N nessuno · Invio conferma · ESC torna indietro" \
    --default "${DAYS_CHECK_DEFAULT:-1,2,3,4,5}" -- \
    "lunedì" "martedì" "mercoledì" "giovedì" "venerdì" "sabato" "domenica" 2>/dev/null || echo "1,2,3,4,5")
  # Riga vuota = ESC: l'utente vuole tornare al passo precedente («Chi sei?»).
  if [ -z "$picked" ]; then
    return 1
  fi
  DAYS_CHECK_DEFAULT="$picked"
  # Le voci sono lun..dom (1..7): i giorni JS sono 0=dom … 6=sab.
  DAYS=$(node -e "
    const map = [1, 2, 3, 4, 5, 6, 0];
    const out = String(process.argv[1] || '').split(',')
      .map((x) => parseInt(x, 10) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < map.length)
      .map((i) => map[i]);
    process.stdout.write([...new Set(out)].sort((a, b) => a - b).join(','));
  " "$picked" 2>/dev/null || echo "1,2,3,4,5")
  [ -n "$DAYS" ] || DAYS="1,2,3,4,5"
  DAYS_JSON="$DAYS"
  ok "Giorni di apertura: $(node -e "
    const { describeDaysHuman } = require('$DIR/src/lib/schedule-ui');
    process.stdout.write(describeDaysHuman(String(process.argv[1]||'').split(',').map(Number)));
  " "$DAYS_JSON" 2>/dev/null || days_human "$DAYS_JSON")"
  return 0
}

# Orario del negozio → turni. Il collega ragiona per "apre / chiude / pausa
# pranzo", non per "turni": traduciamo noi (src/lib/schedule-ui.js).
ask_time() {
  # $1 = titolo, $2 = default HH:MM, $3 = suggerimento.
  # Stampa l'orario scelto, oppure NIENTE se l'utente ha premuto ESC (indietro).
  node "$DIR/scripts/lib/prompt-cli.js" time \
    --title "$1" --default "$2" --hint "${3:-} · ESC torna indietro" 2>/dev/null || echo "$2"
}

# Costruisce SHIFT_SPECS da apertura/chiusura/pausa usando l'helper condiviso.
shifts_from_store_hours() {
  local open="$1" close="$2" pstart="${3:-}" pend="${4:-}"
  local out
  out=$(node -e "
    const { buildShiftsFromStoreHours } = require('$DIR/src/lib/schedule-ui');
    const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return { hour: h, min: m }; };
    const [open, close, ps, pe] = process.argv.slice(1);
    const res = buildShiftsFromStoreHours({
      open: hm(open),
      close: hm(close),
      pause: ps && pe ? { start: hm(ps), end: hm(pe) } : null,
    });
    if (!res.ok) { console.error(res.reason); process.exit(1); }
    process.stdout.write(res.shifts.map((s) => [s.startHour, s.startMin, s.endHour, s.endMin].join(',')).join(' '));
  " "$open" "$close" "$pstart" "$pend" 2>/tmp/gsd_hours_err) || {
    local reason
    reason=$(cat /tmp/gsd_hours_err 2>/dev/null || echo "")
    rm -f /tmp/gsd_hours_err
    case "$reason" in
      chiusura_prima_apertura) warn "La chiusura deve venire dopo l'apertura. Riprova." ;;
      pausa_invertita) warn "La fine della pausa deve venire dopo l'inizio. Riprova." ;;
      pausa_fuori_orario) warn "La pausa deve stare dentro l'orario di apertura. Riprova." ;;
      *) warn "Orario non valido. Riprova." ;;
    esac
    return 1
  }
  rm -f /tmp/gsd_hours_err
  SHIFT_SPECS=(${=out})
  return 0
}

configure_hours() {
  local choice
  # Il menu resta aperto: tornando indietro da "Altro orario" si ricade QUI
  # (stessa pagina), non ai giorni. Indietro dai modelli = pagina precedente.
  while true; do
    choice=$(node "$DIR/scripts/lib/prompt-cli.js" select \
      --title "A che ora apre e chiude il negozio?" \
      --subtitle "Nelle ore scelte l'automazione segue i corsi; fuori si mette in pausa da sola." \
      --default "${LAST_HOURS_PICK:-1}" -- \
      "09:00 – 20:00 con pausa 13:00-16:00 — il più comune" \
      "09:00 – 18:00 senza pausa" \
      "Solo mattina — 09:00 – 13:00" \
      "Solo pomeriggio — 16:00 – 20:00" \
      "Altro orario — lo scelgo con le frecce" \
      "◂ Indietro — torno ai giorni" 2>/dev/null || echo 1)
    LAST_HOURS_PICK="$choice"
    case "$choice" in
      2) SHIFT_SPECS=("9,0,18,0"); break ;;
      3) SHIFT_SPECS=("9,0,13,0"); break ;;
      4) SHIFT_SPECS=("16,0,20,0"); break ;;
      5)
        if configure_hours_custom; then
          break
        fi
        continue ;;      # ESC sul primo orologio: ritorno a questo menu
      6|0) return 1 ;;   # Indietro (voce o ESC): pagina precedente = i giorni
      *) SHIFT_SPECS=("9,0,13,0" "16,0,20,0"); break ;;
    esac
  done
  sort_shifts
  if [ ${#SHIFT_SPECS} -eq 0 ]; then
    warn "Nessun orario impostato: uso il più comune (09:00-13:00 e 16:00-20:00)."
    SHIFT_SPECS=("9,0,13,0" "16,0,20,0")
  fi
  ok "Orario: $(shifts_human_summary)"
  return 0
}

# Catena di domande navigabile: ogni ESC torna alla domanda precedente, e
# dall'apertura si esce ai modelli pronti. Niente vicoli ciechi.
configure_hours_custom() {
  local open="${LAST_OPEN:-09:00}" close="${LAST_CLOSE:-20:00}"
  local pstart="${LAST_PSTART:-13:00}" pend="${LAST_PEND:-16:00}"
  local pause=1 stage=1 val
  while true; do
    case "$stage" in
      1)
        val=$(ask_time "A che ora apre?" "$open" "Frecce ←→ per i minuti, ↑↓ per le ore")
        [ -n "$val" ] || return 1        # indietro: torno ai modelli pronti
        open="$val"; stage=2 ;;
      2)
        val=$(ask_time "A che ora chiude?" "$close" "Deve essere dopo l'apertura")
        if [ -z "$val" ]; then stage=1; continue; fi
        close="$val"; stage=3 ;;
      3)
        pause=$(node "$DIR/scripts/lib/prompt-cli.js" select \
          --title "C'è la pausa pranzo?" --default "$pause" -- \
          "Sì, il negozio chiude a pranzo" \
          "No, orario continuato" \
          "◂ Indietro — cambio l'orario di chiusura" 2>/dev/null || echo 1)
        case "$pause" in
          3|0) stage=2; continue ;;
          2) stage=6 ;;                  # senza pausa: vai alla verifica
          *) pause=1; stage=4 ;;
        esac ;;
      4)
        val=$(ask_time "A che ora inizia la pausa?" "$pstart" "Dentro l'orario di apertura")
        if [ -z "$val" ]; then stage=3; continue; fi
        pstart="$val"; stage=5 ;;
      5)
        val=$(ask_time "A che ora riapre?" "$pend" "Dentro l'orario di apertura")
        if [ -z "$val" ]; then stage=4; continue; fi
        pend="$val"; stage=6 ;;
      6)
        if [ "$pause" = "2" ]; then
          if shifts_from_store_hours "$open" "$close" "" ""; then
            LAST_OPEN="$open"; LAST_CLOSE="$close"
            break
          fi
          stage=1; continue
        fi
        if shifts_from_store_hours "$open" "$close" "$pstart" "$pend"; then
          LAST_OPEN="$open"; LAST_CLOSE="$close"; LAST_PSTART="$pstart"; LAST_PEND="$pend"
          break
        fi
        stage=4; continue ;;             # orari incompatibili: rifai la pausa
    esac
  done
  # Chi ha bisogno di più di due fasce (raro) passa dall'editor avanzato.
  local more
  more=$(node "$DIR/scripts/lib/prompt-cli.js" select \
    --title "Orario impostato: $(shifts_human_summary)" --default 1 -- \
    "Va bene così" \
    "Ho più di due fasce nella giornata — apri l'editor avanzato" 2>/dev/null || echo 1)
  # if (non `[ … ] && cmd`): come ULTIMA istruzione di una funzione, un test
  # falso ritorna non-zero e sotto `set -e` fa morire il setup in silenzio.
  if [ "$more" = "2" ]; then
    edit_shifts_advanced
  fi
  return 0
}

# Riepilogo parlato dei turni ("09:00-13:00 e 16:00-20:00").
shifts_human_summary() {
  local json="" spec
  for spec in "$SHIFT_SPECS[@]"; do
    [ -n "$json" ] && json+=","
    json+="{\"startHour\":$(echo "$spec" | cut -d, -f1),\"startMin\":$(echo "$spec" | cut -d, -f2),\"endHour\":$(echo "$spec" | cut -d, -f3),\"endMin\":$(echo "$spec" | cut -d, -f4)}"
  done
  node -e "
    const { describeShiftsHuman } = require('$DIR/src/lib/schedule-ui');
    process.stdout.write(describeShiftsHuman(JSON.parse('[' + (process.argv[1] || '') + ']')));
  " "$json" 2>/dev/null || echo "orario non disponibile"
}

# Anteprima settimanale: si VEDE quando lavora, prima di salvare.
print_week_preview() {
  local shifts_json="" spec
  for spec in "$SHIFT_SPECS[@]"; do
    [ -n "$shifts_json" ] && shifts_json+=","
    shifts_json+="{\"startHour\":$(echo "$spec" | cut -d, -f1),\"startMin\":$(echo "$spec" | cut -d, -f2),\"endHour\":$(echo "$spec" | cut -d, -f3),\"endMin\":$(echo "$spec" | cut -d, -f4)}"
  done
  node -e "
    const { renderWeekPreview } = require('$DIR/src/lib/schedule-ui');
    const days = String(process.argv[1] || '').split(',').map(Number).filter((n) => !Number.isNaN(n));
    const shifts = JSON.parse('[' + (process.argv[2] || '') + ']');
    process.stdout.write(renderWeekPreview({ days, shifts }).join('\n'));
  " "$DAYS_JSON" "$shifts_json" 2>/dev/null || true
  echo ""
}

# Editor avanzato dei turni (fino a 4 fasce): resta per i casi particolari.
edit_shifts_advanced() {
  # Editor interattivo delle fasce: la LISTA è il menu — ogni turno inserito è una
  # voce selezionabile che ne riapre gli orari (prima la lista veniva stampata
  # sopra il menu e il clear-screen del menu a frecce la cancellava subito).
  local act ridx le def_start pick acts labels rlabels rpick idx
  while true; do
    sort_shifts
    echo ""
    echo -e "${BOLD}── I tuoi turni ──${NC}"
    render_shifts
    echo ""
    # Costruisco le azioni disponibili in base allo stato (turni presenti o no).
    acts=(); labels=()
    idx=1
    for spec in "$SHIFT_SPECS[@]"; do
      acts+=("edit:$idx")
      labels+=("Turno $idx: $(spec_to_label "$spec") — seleziona per cambiare inizio/fine")
      idx=$((idx + 1))
    done
    acts+=("add");    labels+=("Aggiungi un turno — un altro intervallo nella giornata")
    if [ ${#SHIFT_SPECS} -gt 0 ]; then
      acts+=("rm");   labels+=("Rimuovi un turno — scegli quale eliminare")
      acts+=("clr");  labels+=("Svuota tutti i turni — riparti da zero")
    fi
    acts+=("conf");   labels+=("Conferma e continua — vai al riepilogo finale")
    # Default sull'ultima voce (Conferma): Invio-only = conferma, come il vecchio [c].
    pick=$(node "$DIR/scripts/lib/prompt-cli.js" select \
      --title "I tuoi turni — seleziona un turno per modificarlo" \
      --subtitle "$(shifts_subtitle)" \
      --default ${#labels[@]} -- "${labels[@]}" 2>/dev/null || echo ${#labels[@]})
    act="${acts[$pick]}"
    [ -z "$act" ] && act="conf"   # cancel/EOF → conferma
    case "$act" in
      edit:*)
        edit_shift "${act#edit:}" || true
        ;;
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

# Configurazione guidata: giorni → orario → anteprima e conferma. Ogni passo si
# può rifare senza ricominciare da capo (CONFIG_STEP fa da segnaposto).
CONFIG_STEP="days"
while true; do
  if [ "$MODIFY" = true ]; then
    # Passo «Chi sei?» raggiungibile tornando indietro dai giorni: se si annulla
    # lì, si tiene il collega di prima invece di uscire dal setup.
    if [ "$CONFIG_STEP" = "who" ]; then
      step "Chi sei?"
      if who_are_you; then
        apply_selected_account
      else
        load_account_from_config
        info "Tengo il collega già configurato: $MEMBER_NAME"
      fi
      CONFIG_STEP="days"
    fi
    if [ "$CONFIG_STEP" = "days" ]; then
      echo ""
      step "Quando lavora"
      ui_kv "Collega" "${BOLD}$MEMBER_NAME${NC}"
      ui_kv "Accesso al corso" "${GREEN}collegato al tuo nome ✓${NC}"
      if configure_days; then
        CONFIG_STEP="hours"
      else
        CONFIG_STEP="who"      # ESC sui giorni: torna a «Chi sei?»
        continue
      fi
    fi
    if [ "$CONFIG_STEP" = "hours" ]; then
      if configure_hours; then
        CONFIG_STEP="confirm"
      else
        CONFIG_STEP="days"     # Indietro sugli orari: torna ai giorni
        continue
      fi
    fi

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
    echo -e " ${BOLD}Ecco come lavorerà${NC}"
    ui_hr
    ui_kv "Collega" "${BOLD}$MEMBER_NAME${NC}"
    ui_kv "Accesso al corso" "${GREEN}collegato al tuo nome ✓${NC}"
    ui_kv "Giorni" "$(node -e "
      const { describeDaysHuman } = require('$DIR/src/lib/schedule-ui');
      process.stdout.write(describeDaysHuman(String(process.argv[1]||'').split(',').map(Number)));
    " "$DAYS_JSON" 2>/dev/null || days_human "$DAYS_JSON")"
    ui_kv "Orario" "$(shifts_human_summary)"
    ui_hr
    echo ""
    # Anteprima: vedere la settimana rassicura più che rileggere una lista di orari.
    print_week_preview
    info "Fuori da queste ore si mette in pausa da sola e riprende al turno dopo."
    echo ""

    if [ "$AUTO_YES" = true ]; then
      CONFIRM_PICK=1
    else
      CONFIRM_PICK=$(node "$DIR/scripts/lib/prompt-cli.js" select \
        --title "Va bene così?" --default 1 -- \
        "Sì, salva e vai" \
        "◂ Cambio l'orario" \
        "◂ Cambio i giorni" \
        "◂ Cambio collega" 2>/dev/null || echo 1)
    fi

    case "$CONFIRM_PICK" in
      2) CONFIG_STEP="hours"; continue ;;
      3) CONFIG_STEP="days"; continue ;;
      4) CONFIG_STEP="who"; continue ;;
      *) : ;;   # 1 / annullato → salva
    esac

    if true; then
      # Guardia: senza autologin NON scriviamo (scrivere stringhe vuote
      # cancellerebbe l'account di chi stava solo cambiando gli orari).
      if [ -z "$AUTOLOGIN" ]; then
        load_account_from_config
      fi
      if [ -z "$AUTOLOGIN" ]; then
        err "Account non disponibile: non salvo per non sovrascrivere config.json."
        info "Rilancia il comando curl e scegli il tuo nominativo in «Chi sei?»."
        exit 1
      fi
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
        // Solo valori non vuoti: un env vuoto NON deve azzerare l'account già
        // presente (vedi guardia in setup.sh prima della scrittura).
        if (process.env.ACTIVE_CF) cfg.codice_fiscale = process.env.ACTIVE_CF;
        if (process.env.MEMBER_NAME) cfg.memberName = process.env.MEMBER_NAME;
        if (process.env.AUTOLOGIN) cfg.autologinUrl = process.env.AUTOLOGIN;
        if (!cfg.baseUrl) cfg.baseUrl = 'https://tecsial.gsdcampus.it/';
        if (!Array.isArray(cfg.courseUrls)) cfg.courseUrls = [];
        if (!cfg.ollamaModel) cfg.ollamaModel = '${OLLAMA_MODEL}';
        cfg.aiSupervisorClient = 'claude-on-demand';
        cfg.useOllamaForQuiz = false;
        if (!cfg.ollamaLocalEndpoint) cfg.ollamaLocalEndpoint = 'http://127.0.0.1:11434';
        if (!cfg.aiCloudProxyPort) cfg.aiCloudProxyPort = 11435;
        if (!cfg.aiWeeklyRequestLimit) cfg.aiWeeklyRequestLimit = 400;
        if (!cfg.aiDailyRequestLimit) cfg.aiDailyRequestLimit = 80;
        if (!cfg.aiPerMinuteRequestLimit) cfg.aiPerMinuteRequestLimit = 8;
        if (!cfg.aiMinRequestIntervalMs) cfg.aiMinRequestIntervalMs = 1500;
        if (!cfg.aiMaxConcurrentRequests) cfg.aiMaxConcurrentRequests = 1;
        const configuredBatchLimit = Number(cfg.aiClaudeMaxRequestsPerBatch);
        cfg.aiClaudeMaxRequestsPerBatch = Number.isFinite(configuredBatchLimit)
          ? Math.max(1, Math.min(8, Math.floor(configuredBatchLimit))) : 8;
        if (!cfg.aiClaudeTimeoutMs) cfg.aiClaudeTimeoutMs = 900000;
        cfg.workSchedule = {
          // filter su 0..6 (NON filter(Boolean): scartava la domenica, giorno 0).
          days: process.env.DAYS_JSON.split(',')
            .map(Number)
            .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
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
  "aiSupervisorClient": "claude-on-demand",
  "useOllamaForQuiz": false,
  "ollamaLocalEndpoint": "http://127.0.0.1:11434",
  "aiCloudProxyPort": 11435,
  "aiWeeklyRequestLimit": 400,
  "aiDailyRequestLimit": 80,
  "aiPerMinuteRequestLimit": 8,
  "aiMinRequestIntervalMs": 1500,
  "aiMaxConcurrentRequests": 1,
  "aiClaudeMaxRequestsPerBatch": 8,
  "aiClaudeTimeoutMs": 900000,
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
      ok "Accesso al corso: collegato al tuo nome"
      ok "Giorni: $(days_human "$DAYS_JSON")"
      ok "Orario: $shifts_summary"
      break
    fi
  else
    ok "Configurazione esistente confermata."
    ok "Orario: $(read_config_schedule_desc)"
    break
  fi
done

# Configurazione completa (appena salvata o confermata): il backup di
# install.sh non serve più. Prima veniva rimosso subito dopo «Chi sei?»,
# quindi un'interruzione durante gli orari lo perdeva insieme alla config.
rm -f "$DIR/config.json.bak" 2>/dev/null || true

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

# 5-7. Componenti AI strettamente on-demand. Senza handoff aperti non
# eseguiamo neppure `ollama --version`/`claude --version`: presenza, install,
# daemon, pull e login vengono verificati dopo che buildAiTodo apre il gate.
AI_OPEN_REQUESTS=$(node -e "try{const t=require('./src/lib/ai-todo').buildAiTodo(process.cwd());process.stdout.write(String(t.openQuizRequests||0))}catch(e){process.stdout.write('0')}" 2>/dev/null || echo 0)
if [ "$AI_OPEN_REQUESTS" -gt 0 ] 2>/dev/null; then
  info "Rilevate $AI_OPEN_REQUESTS domanda/e quiz: preparo i componenti AI on-demand."

# 5. Ollama CLI e daemon locale (gestisce il login Cloud)
step "5/7 - Ollama"
if ! command -v ollama &>/dev/null; then
  info "Ollama non trovato. Installazione in corso..."
  install_ollama_official
  if ! ensure_ollama_cli; then
    err "Installazione Ollama non riuscita (CLI non disponibile)."
    info "Rilancia il comando curl quando la rete è disponibile."
    exit 1
  fi
  ok "Ollama installato."
elif [ "$FORCE_UPDATE" = true ]; then
  info "Reinstallazione/aggiornamento Ollama (richiesto --force-update)..."
  install_ollama_official
  ensure_ollama_cli || true
  ok "Ollama aggiornato."
else
  OLLAMA_VER=$(ollama --version 2>/dev/null | extract_version)
  if [ -z "$OLLAMA_VER" ]; then
    warn "Versione Ollama non rilevabile. Reinstallo dal canale ufficiale..."
    install_ollama_official
    ensure_ollama_cli || true
  elif version_ge "$OLLAMA_VER" "$MIN_OLLAMA"; then
    ok "Ollama già installato (v$OLLAMA_VER ≥ min $MIN_OLLAMA). Salto."
  else
    warn "Ollama presente ma versione vecchia (v$OLLAMA_VER < $MIN_OLLAMA). Provo ad aggiornare..."
    install_ollama_official
    ensure_ollama_cli || true
  fi
fi

OLLAMA_VER=$(ollama --version 2>/dev/null | extract_version)
if [ -z "$OLLAMA_VER" ] || ! version_ge "$OLLAMA_VER" "$MIN_OLLAMA"; then
  err "Ollama deve essere almeno v$MIN_OLLAMA (rilevata: ${OLLAMA_VER:-sconosciuta})."
  exit 1
fi

# Il daemon, il pull del modello e il login browser restano differiti al primo
# batch con domande aperte: un setup senza quiz non genera traffico AI.

# 6. Ollama Cloud: nessun daemon/pull/login finche non esiste lavoro AI.
step "6/7 - Ollama Cloud on-demand"
ok "Ollama CLI pronta; daemon e modello restano spenti senza quiz aperti."
info "Quando servira una risposta, il batch tentera il pull e, solo se necessario, aprira ollama signin nel browser."

# 7. Claude Code CLI (versione minima verificata per il runner one-shot).
step "7/7 - Claude Code CLI"
ensure_local_bin_in_path
NEED_CLAUDE_INSTALL=false
if ! command -v claude &>/dev/null; then
  info "Claude Code non trovato. Installazione dal canale ufficiale..."
  NEED_CLAUDE_INSTALL=true
elif [ "$FORCE_UPDATE" = true ]; then
  info "Aggiornamento Claude Code richiesto da --force-update..."
  NEED_CLAUDE_INSTALL=true
else
  CLAUDE_VER=$(claude --version 2>/dev/null | extract_version)
  if [ -z "$CLAUDE_VER" ] || ! version_ge "$CLAUDE_VER" "$MIN_CLAUDE"; then
    warn "Claude Code ${CLAUDE_VER:-sconosciuto} e precedente alla versione minima $MIN_CLAUDE. Aggiorno..."
    NEED_CLAUDE_INSTALL=true
  fi
fi

if [ "$NEED_CLAUDE_INSTALL" = true ]; then
  if ! command -v claude &>/dev/null; then
    curl -fsSL https://claude.ai/install.sh | bash -s -- "$MIN_CLAUDE" || warn "Bootstrap Claude Code non riuscito (rete?)."
    ensure_local_bin_in_path
  fi
  if command -v claude &>/dev/null; then
    claude install --force "$MIN_CLAUDE" >/dev/null 2>&1 || warn "Installazione della versione Claude $MIN_CLAUDE non completata."
  fi
fi

if command -v claude &>/dev/null; then
  CLAUDE_VER=$(claude --version 2>/dev/null | extract_version)
  if [ -n "$CLAUDE_VER" ] && version_ge "$CLAUDE_VER" "$MIN_CLAUDE"; then
    ok "Claude Code pronto: v$CLAUDE_VER"
  else
    err "Claude Code deve essere almeno v$MIN_CLAUDE (rilevata: ${CLAUDE_VER:-sconosciuta})."
    exit 1
  fi
else
  err "Claude Code CLI non trovato. Rilancia il comando curl quando la rete e disponibile."
  exit 1
fi
else
  step "5/7 - Ollama"
  if command -v ollama >/dev/null 2>&1; then
    ok "Ollama CLI presente; verifica versione differita al primo quiz."
  else
    ok "Ollama non necessario ora; installazione differita al primo quiz."
  fi
  step "6/7 - Ollama Cloud on-demand"
  ok "Inbox quiz vuota: daemon, pull e login non vengono avviati."
  step "7/7 - Claude Code CLI"
  if command -v claude >/dev/null 2>&1; then
    ok "Claude Code presente; nessun processo avviato senza quiz."
  else
    ok "Claude Code non necessario ora; installazione differita al primo quiz."
  fi
fi

# Verifica LIVE dell'accesso solo quando l'utente ha appena (ri)configurato un
# account: è il momento in cui la conferma "il link funziona" è più utile. Nel
# path di solo aggiornamento (--yes, config già valida) non rallentiamo con i ~30s.
if [ "$CONFIG_CHANGED" = true ]; then
  verify_autologin_live
fi

# Auto-update periodico (launchd, ~10 min): installazione idempotente, opt-out
# con "autoUpdate": false in config.json. Non bloccante.
if [ -x "$DIR/scripts/lib/install-launchd.sh" ]; then
  "$DIR/scripts/lib/install-launchd.sh" install 2>/dev/null || warn "Auto-update periodico non attivato (riproverò al prossimo aggiornamento)."
fi

print_footer
