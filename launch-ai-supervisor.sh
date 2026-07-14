#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

SCHEDULE_CLI="$DIR/scripts/lib/schedule-cli.js"
CHECK_REQ="$DIR/scripts/check-requirements.sh"

# Palette + info/ok/warn/err/step condivisi.
source "$DIR/scripts/lib/ui.sh"
# Helper countdown "Timer + Invio per saltare" per i messaggi che l'utente deve leggere.
source "$DIR/scripts/lib/read-timer.sh"
# pid_matches condiviso (protezione PID recycling).
source "$DIR/scripts/lib/pid-utils.sh"

# Assicurati che ~/.local/bin sia nel PATH, anche se .zshrc non è ancora stato sourceato
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  export PATH="$HOME/.local/bin:$PATH"
fi

# Tenta di sourceare .zshrc per ereditare eventuali PATH aggiuntivi, silenziosamente
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc" >/dev/null 2>&1 || true
fi

# Modello Ollama: UNICA fonte di verità è config.json (campo ollamaModel), così
# launcher, setup.sh e check-requirements.sh usano sempre lo STESSO modello. Il
# valore viene riletto dopo lo step di configurazione (config.json potrebbe non
# esistere ancora al primo avvio). Fallback coerente con config.json.example.
MODEL_FALLBACK="gemma4:cloud"
read_ollama_model() {
  node -e "try{const c=require('$DIR/config.json');process.stdout.write(c.ollamaModel||'$MODEL_FALLBACK')}catch(e){process.stdout.write('$MODEL_FALLBACK')}" 2>/dev/null || printf '%s' "$MODEL_FALLBACK"
}
MODEL="$MODEL_FALLBACK"

# Controlla se tutti i requisiti sono già soddisfatti (senza output)
requirements_satisfied() {
  [ -f "$CHECK_REQ" ] || return 1
  "$CHECK_REQ" >/dev/null 2>&1
}

echo ""
echo "============================================"
echo -e "${BOLD}  gsdcampus-autoplay — AI Supervisor${NC}"
VERSION_LINE="$(ui_version "$DIR")"
[ -n "$VERSION_LINE" ] && echo -e "${DIM}  versione $VERSION_LINE${NC}" || true
echo "============================================"
echo ""

# 0. Ferma eventuali istanze precedenti per evitare conflitti tra codice vecchio e nuovo
info "Controllo e arresto eventuali istanze precedenti..."
if [ -f "$DIR/.autoplay_pid" ]; then
  OLD_PID=$(cat "$DIR/.autoplay_pid" 2>/dev/null || echo "")
  # pid_matches (non kill -0 puro): un PID recyclato a un processo estraneo NON
  # va killato — qui prima si mandava SIGKILL a qualunque processo vivo con quel PID.
  if pid_matches "$OLD_PID" "scheduler|autoplay"; then
    warn "Trovato scheduler precedente (PID $OLD_PID). Arresto in corso..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
    # SIGKILL solo se è ANCORA il nostro processo (dopo i 2s potrebbe essere
    # morto e il PID riassegnato).
    pid_matches "$OLD_PID" "scheduler|autoplay" && kill -9 "$OLD_PID" 2>/dev/null || true
  fi
  rm -f "$DIR/.autoplay_pid"
fi
# Pattern path-indipendente: lo scheduler lancia `node /abs/path/src/autoplay.js`,
# quindi "node src/autoplay.js" non matchava mai (lasciava orfani vivi). Usiamo il
# nome file. Esclude autoplay.log (grep su "autoplay\.js").
# `|| true` sul pgrep: sotto set -e + pipefail un pgrep senza match (exit 1)
# farebbe fallire la pipeline e ucciderebbe il launcher.
{ pgrep -f "autoplay\.js" 2>/dev/null || true; } | while read orphan; do
  kill -9 "$orphan" 2>/dev/null || true
done
{ pgrep -f "scheduler.sh" 2>/dev/null || true; } | while read orphan; do
  [ "$orphan" != "$$" ] && kill -9 "$orphan" 2>/dev/null || true
done
ok "Pulizia istanze precedenti completata."

# 1. Verifica configurazione iniziale
step "1/5" "Verifica configurazione"
CONFIG_OK=false
if [ -f "$DIR/config.json" ]; then
  if node "$SCHEDULE_CLI" is-work-time >/dev/null 2>&1; then
    CONFIG_OK=true
    ok "config.json valido."
    info "Orario configurato: $(node "$SCHEDULE_CLI" describe 2>/dev/null || echo 'non disponibile')"
  else
    warn "config.json presente ma non valido o incompleto."
  fi
else
  warn "config.json non trovato."
fi

if [ "$CONFIG_OK" = false ]; then
  warn "Eseguo il setup interattivo per configurare autologin e orari."
  if [ -f "$DIR/scripts/setup.sh" ]; then
    "$DIR/scripts/setup.sh"
  else
    err "Errore: scripts/setup.sh non trovato."
    exit 1
  fi
fi

# Ora che config.json esiste di sicuro, leggi il modello da lì (fonte di verità).
MODEL="$(read_ollama_model)"
[ -z "$MODEL" ] && MODEL="$MODEL_FALLBACK"
info "Modello Ollama (da config.json): $MODEL"

# 2. Manutenzione pre-avvio (rotazione log, pulizia vecchi dump)
step "2/5" "Manutenzione pre-avvio"
if [ -f "$DIR/scripts/maintenance.sh" ]; then
  "$DIR/scripts/maintenance.sh" &>/dev/null || true
fi
ok "Manutenzione completata."

# 3. Verifica/installa requisiti: fast-path se tutto è già a posto
step "3/5" "Verifica requisiti"
if requirements_satisfied; then
  ok "Tutti i requisiti sono già soddisfatti. Salto l'installazione."
else
  warn "Requisiti mancanti o da verificare. Avvio setup..."
  # Richiedi sudo solo se serve davvero installare qualcosa
  info "Richiesta privilegi amministrativi (sudo) per l'installazione..."
  sudo -v
  ok "Privilegi sudo acquisiti."

  if [ -f "$DIR/scripts/setup.sh" ]; then
    "$DIR/scripts/setup.sh" --yes
  else
    err "Errore: scripts/setup.sh non trovato."
    exit 1
  fi
fi

# 4. Avvia Ollama se necessario (report onesto: verifichiamo 11434 davvero, non
# ci fidiamo del solo ritorno del daemon).
step "4/5" "Avvio/controllo Ollama"
OLLAMA_UP=false
if [ -f "$DIR/scripts/ollama-daemon.sh" ]; then
  # `|| true`: il daemon ora retorna 1 se non binda 11434; sotto set -e non deve
  # abortire il launcher. La verifica indipendente sotto decide lo stato reale.
  "$DIR/scripts/ollama-daemon.sh" start || true
fi
if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
  OLLAMA_UP=true
  ok "Server Ollama attivo su 11434."
else
  OLLAMA_UP=false
  warn "Server Ollama NON raggiungibile su 11434."
  warn "L'autoplay può girare comunque senza AI con:  ./start.sh"
fi

# 5. Verifica che Claude Code CLI sia accessibile
step "5/5" "Claude Code CLI"
if command -v claude &>/dev/null; then
  ok "Claude Code CLI trovato: $(claude --version 2>/dev/null | head -1)."
else
  warn "Claude Code CLI non trovato nel PATH. Forzo ~/.local/bin..."
  if [ -x "$HOME/.local/bin/claude" ]; then
    export PATH="$HOME/.local/bin:$PATH"
    ok "Claude Code CLI trovato in ~/.local/bin."
  else
    err "Claude Code CLI non trovato. Esegui ./scripts/setup.sh o riapri il Terminale."
    exit 1
  fi
fi

# Verifica login Ollama e modello cloud (rapida, nessun download se già presente)
if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
  echo ""
  warn "Il modello $MODEL richiede il login su ollama.com: ora si apre il browser."
  info "Se non si apre da solo, copia nel browser l'URL che compare qui sotto (https://ollama.com/...)."
  echo ""
  read_with_timer 5 "${BOLD}Tra 5s parte il login (Invio per saltare l'attesa).${NC}"

  # login + pull in una funzione: sotto `set -e` usiamo `|| return 1` per non abortire,
  # così possiamo fare un secondo tentativo se il popup del browser non si è aperto.
  ollama_login_and_pull() {
    ollama login || true
    info "Download modello $MODEL (la prima volta può richiedere qualche minuto)..."
    ollama pull "$MODEL" || return 1
    return 0
  }

  ollama_login_and_pull || true
  if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
    echo ""
    warn "Primo tentativo non riuscito (il browser a volte tarda). Riprovo: se serve, copia a mano l'URL https://ollama.com/... nel browser."
    echo ""
    ollama_login_and_pull || true
  fi
  if ! ollama list 2>/dev/null | grep -q "$MODEL"; then
    echo ""
    err "Modello $MODEL non disponibile. Completa il login su ollama.com e rilancia: cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh"
    info "Nel frattempo l'autoplay può girare senza AI con: ./start.sh"
    exit 1
  fi
fi
ok "Modello $MODEL pronto."

# ── Riepilogo finale: tutto ciò che serve sapere prima di iniziare, in un box.
# Ogni voce degrada a un valore neutro se config.json/CLI non sono disponibili.
MEMBER_LINE=$(node "$DIR/scripts/lib/members-cli.js" active 2>/dev/null | head -1 | sed 's/^Membro attivo: //' || echo "")
[ -n "$MEMBER_LINE" ] || MEMBER_LINE="non configurato"
SCHEDULE_LINE=$(node "$SCHEDULE_CLI" describe 2>/dev/null || echo "non disponibili")
if node "$SCHEDULE_CLI" is-work-time 2>/dev/null | grep -q '^yes$'; then
  TURNO_LINE="${GREEN}adesso è orario di lavoro${NC}"
else
  NEXT_START_ISO=$(node "$SCHEDULE_CLI" next-start 2>/dev/null || echo "")
  NEXT_START_HUMAN=$(node -e "const d=new Date(process.argv[1]);if(!isNaN(d))process.stdout.write(d.toLocaleString('it-IT',{weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}))" "$NEXT_START_ISO" 2>/dev/null || echo "")
  TURNO_LINE="${YELLOW}fuori orario${NC}${NEXT_START_HUMAN:+ — prossimo turno: $NEXT_START_HUMAN}"
fi
if [ "$OLLAMA_UP" = true ]; then OLLAMA_LINE="${GREEN}attivo${NC} ($MODEL)"; else OLLAMA_LINE="${RED}non attivo${NC}"; fi

echo ""
echo "────────────────────────────────────────────"
echo -e "${GREEN}${BOLD}  AI Supervisor pronto${NC}"
echo "────────────────────────────────────────────"
echo -e "  Account:  ${BOLD}${MEMBER_LINE}${NC}"
echo -e "  Orari:    ${SCHEDULE_LINE}"
echo -e "  Turno:    ${TURNO_LINE}"
echo -e "  Ollama:   ${OLLAMA_LINE}"
echo "────────────────────────────────────────────"
echo ""
echo -e "${BOLD}Scrivi in chat:${NC}  'avvia il corso' • 'controlla il corso' • 'come sta andando?' • 'ferma tutto'"
echo ""

# Avvia Claude con skip permessi e modello Ollama.
# Passiamo un prompt di apertura: Claude saluta da solo, legge config.json e mostra
# account + orari, e dice al collega quali frasi può scrivere in chat. Così niente
# schermata vuota e niente comandi da lanciare a mano: il collega sceglie solo una frase.
info "Avvio Claude Code con modello $MODEL..."
INITIAL_PROMPT="Sei il supervisore dell'automazione gsdcampus-autoplay (cartella di lavoro ~/gsdcampus-autoplay). Saluta brevemente l'utente in italiano. Poi usa i tool a tua disposizione (leggi config.json) per mostrare: il membro attivo (nome) e i giorni/turni lavorativi configurati. Infine digli che in chat può scrivere una di queste frasi: 'avvia il corso', 'controlla il corso', 'come sta andando?' oppure 'ferma tutto'. Non avviare né fermare nulla finché l'utente non lo chiede esplicitamente."
ollama launch claude --model "$MODEL" -- --dangerously-skip-permissions "$INITIAL_PROMPT"
