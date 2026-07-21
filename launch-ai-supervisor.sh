#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
CHECK_REQ="$DIR/scripts/check-requirements.sh"
KEYCHAIN_HELPER="$DIR/scripts/lib/keychain-secret.sh"
PROXY="$DIR/scripts/lib/ollama-cloud-proxy.js"

source "$DIR/scripts/lib/ui.sh"
source "$DIR/scripts/lib/pid-utils.sh"
export PATH="$HOME/.local/bin:$HOME/.opencode/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" >/dev/null 2>&1 || true

MODEL_FALLBACK="gemma4:31b-cloud"
read_ollama_model() {
  node -e "try{const c=require('$DIR/config.json');process.stdout.write(c.ollamaModel||'$MODEL_FALLBACK')}catch(e){process.stdout.write('$MODEL_FALLBACK')}" 2>/dev/null || printf '%s' "$MODEL_FALLBACK"
}
requirements_satisfied() { [ -x "$CHECK_REQ" ] && "$CHECK_REQ" >/dev/null 2>&1; }

ui_header "GSD Campus — AI Supervisor" "Ollama Cloud + OpenCode" "⚡"
echo ""

info "Controllo e arresto eventuali istanze precedenti..."
if autoplay_instance_alive "$DIR"; then
  OLD_PID=$(autoplay_instance_pid "$DIR" 2>/dev/null || echo "")
  if pid_matches "$OLD_PID" "scheduler|autoplay"; then
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
    pid_matches "$OLD_PID" "scheduler|autoplay" && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$DIR/.autoplay_pid"
fi
autoplay_clean_stale_lock "$DIR" >/dev/null 2>&1 || true
{ pgrep -f "$DIR/src/autoplay\.js" 2>/dev/null || true; } | while read -r orphan; do kill -9 "$orphan" 2>/dev/null || true; done
{ pgrep -f "$DIR/scripts/scheduler\.sh" 2>/dev/null || true; } | while read -r orphan; do [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true; done
ok "Pulizia istanze precedenti completata."

step "1/5" "Verifica configurazione"
if [ -f "$DIR/config.json" ] && node "$SCHEDULE_CLI" is-work-time >/dev/null 2>&1; then
  ok "config.json valido."
  info "Orario configurato: $(node "$SCHEDULE_CLI" describe 2>/dev/null || echo 'non disponibile')"
else
  warn "config.json non trovato o incompleto. Avvio setup guidato."
  "$DIR/scripts/setup.sh"
fi

MODEL="$(read_ollama_model)"
[ -n "$MODEL" ] || MODEL="$MODEL_FALLBACK"
DIRECT_MODEL="$(node "$DIR/scripts/lib/opencode-config.js" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).model.split('/').slice(1).join('/'))}catch(e){process.exit(1)}})" 2>/dev/null || echo "gemma4:31b")"

step "2/5" "Manutenzione pre-avvio"
if [ -x "$DIR/scripts/maintenance.sh" ]; then "$DIR/scripts/maintenance.sh" >/dev/null 2>&1 || true; fi
ok "Manutenzione completata."

step "3/5" "Verifica requisiti"
if requirements_satisfied; then
  ok "OpenCode, Ollama Cloud e budget locale sono pronti."
else
  warn "Requisiti mancanti o da verificare. Avvio setup..."
  sudo -v
  "$DIR/scripts/setup.sh" --yes
fi

step "4/5" "Portachiavi e proxy Ollama Cloud"
source "$KEYCHAIN_HELPER"
if ! ollama_api_key_present; then
  echo ""
  info "Inserisci la chiave API Ollama Cloud nel Portachiavi macOS. Non verrà mostrata né salvata nel progetto."
  ollama_api_key_store_prompt
fi
if ! ollama_api_key_present; then
  err "Chiave Ollama Cloud non disponibile: l'autoplay può comunque funzionare senza AI con ./start.sh."
  exit 1
fi

PROXY_PORT="$(node -e "try{const c=require('./config.json');process.stdout.write(String(c.aiCloudProxyPort||11435))}catch(e){process.stdout.write('11435')}" 2>/dev/null)"
PROXY_PID_FILE="$DIR/.ai_proxy_pid"

# Il proxy può sopravvivere a un terminale chiuso lasciando la porta occupata.
# Prima del nuovo avvio fermiamo il PID noto e, se necessario, il processo che
# ascolta proprio sulla porta configurata. Non tocchiamo mai un processo che non
# contiene il nostro entrypoint: in quel caso falliamo con un messaggio chiaro.
stop_proxy_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  if pid_matches "$pid" "ollama-cloud-proxy\.js"; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      pid_matches "$pid" "ollama-cloud-proxy\.js" || return 0
      sleep 0.2
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
}

OLD_PROXY_PID="$(cat "$PROXY_PID_FILE" 2>/dev/null || true)"
stop_proxy_pid "$OLD_PROXY_PID"
rm -f "$PROXY_PID_FILE"

if command -v lsof >/dev/null 2>&1; then
  LISTENING_PID="$(lsof -tiTCP:"$PROXY_PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  if [ -n "$LISTENING_PID" ]; then
    if pid_matches "$LISTENING_PID" "ollama-cloud-proxy\.js"; then
      stop_proxy_pid "$LISTENING_PID"
    else
      err "La porta del proxy 127.0.0.1:${PROXY_PORT} è occupata da un altro processo."
      info "Chiudi quel servizio e rilancia il comando curl. Non lo termino automaticamente."
      exit 1
    fi
  fi
fi

mkdir -p "$DIR/logs"
OLLAMA_API_KEY="$(ollama_api_key_read)"
export OLLAMA_API_KEY
GSD_AI_PROXY_TOKEN="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
export GSD_AI_PROXY_TOKEN
node "$PROXY" --root "$DIR" --port "$PROXY_PORT" >"$DIR/logs/ai-cloud-proxy.log" 2>&1 &
AI_PROXY_PID=$!
printf '%s\n' "$AI_PROXY_PID" > "$PROXY_PID_FILE"
unset OLLAMA_API_KEY

cleanup_proxy() {
  stop_proxy_pid "${AI_PROXY_PID:-}"
  rm -f "$PROXY_PID_FILE"
}
trap cleanup_proxy EXIT INT TERM

READY=false
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PROXY_PORT}/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.2
done
if [ "$READY" = false ]; then
  err "Proxy Ollama Cloud non avviato. Controlla logs/ai-cloud-proxy.log."
  exit 1
fi
ok "Proxy locale attivo su 127.0.0.1:${PROXY_PORT}."

# Verifica solo il catalogo modelli: nessuna generazione e nessun consumo del
# budget. Distingue una chiave Ollama Cloud rifiutata da un errore OpenCode e
# impedisce di aprire una TUI che mostrerebbe soltanto "Unauthorized".
UPSTREAM_AUTH_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer ${GSD_AI_PROXY_TOKEN}" \
  "http://127.0.0.1:${PROXY_PORT}/v1/models" 2>/dev/null || echo 000)"
case "$UPSTREAM_AUTH_STATUS" in
  200) ok "Autenticazione Ollama Cloud verificata (catalogo modelli)." ;;
  401|403)
    err "Ollama Cloud ha rifiutato la chiave nel Portachiavi (HTTP ${UPSTREAM_AUTH_STATUS})."
    info "Rilancia il comando curl e reinserisci la chiave API quando viene richiesta."
    exit 1
    ;;
  *)
    err "Verifica Ollama Cloud non riuscita (HTTP ${UPSTREAM_AUTH_STATUS})."
    info "Controlla la connessione e rilancia il comando curl."
    exit 1
    ;;
esac
node "$DIR/scripts/lib/ai-budget-cli.js" 2>/dev/null || true

step "5/5" "OpenCode"
if ! command -v opencode >/dev/null 2>&1 && [ -x "$HOME/.opencode/bin/opencode" ]; then
  export PATH="$HOME/.opencode/bin:$PATH"
fi
if ! command -v opencode >/dev/null 2>&1; then
  err "OpenCode non trovato. Rilancia il comando curl per completare il setup."
  exit 1
fi
ok "OpenCode pronto: $(opencode --version 2>/dev/null | head -1)"

MEMBER_LINE=$(node "$DIR/scripts/lib/members-cli.js" active 2>/dev/null | head -1 | sed 's/^Membro attivo: //' || echo "")
[ -n "$MEMBER_LINE" ] || MEMBER_LINE="non configurato"
SCHEDULE_LINE=$(node "$SCHEDULE_CLI" describe 2>/dev/null || echo "non disponibili")
echo ""
ui_hr
echo -e " ${GREEN}${BOLD}${UI_OK} AI Supervisor pronto${NC}"
ui_hr
ui_kv "Account" "${BOLD}${MEMBER_LINE}${NC}"
ui_kv "Orari" "${SCHEDULE_LINE}"
ui_kv "Client" "OpenCode → Ollama Cloud (${DIRECT_MODEL})"
ui_kv "Budget" "400 richieste/7g · 80/24h · 8/min · 1 alla volta"
ui_hr
echo ""

info "Avvio OpenCode con il supervisore autonomo..."
INITIAL_PROMPT="Sei il supervisore AUTONOMO di gsdcampus-autoplay. Leggi AGENTS.md e config.json, mostra membro attivo e orari in una riga, poi lavora senza aspettare istruzioni: leggi logs/ai_todo.json (oppure node scripts/harvest-answers.js --all se vecchio), risolvi le domande aperte con ricerca e ragionamento, usa node scripts/lib/answers-cli.js resolve per le risposte verificate, pubblica con ./scripts/publish-answers.sh, recupera i corsi need_help quando possibile, avvia ./start.sh in modalità normale e monitora gli eventi. Non usare Claude, non avviare un daemon Ollama locale, non leggere o stampare segreti, non modificare src/ o scripts/ salvo esplicita richiesta del proprietario. Il database utenti e gli stati per-account sono intoccabili. Interrompi il proprietario solo per autologin morto confermato dalla sonda o bug infrastrutturale."
export OPENCODE_CONFIG_CONTENT="$(node "$DIR/scripts/lib/opencode-config.js")"
# Lasciamo il token locale nell'ambiente del processo OpenCode oltre che nella
# configurazione inline: alcuni backend OpenAI-compatible preferiscono leggere
# l'autorizzazione dall'ambiente. È un token casuale per questa sessione, non la
# chiave Ollama Cloud, e viene terminato insieme al proxy.
export OPENCODE_DISABLE_AUTOUPDATE=1
export OPENCODE_DISABLE_CLAUDE_CODE=1
opencode --auto --prompt "$INITIAL_PROMPT" --model "ollama-cloud/${DIRECT_MODEL}"
