#!/bin/bash
#
# install.sh — installer "una riga" per i colleghi.
#
# Uso (incolla nel Terminale del Mac, una sola riga):
#   curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
#
# Cosa fa:
#   1. Verifica che git sia disponibile (lo installa via Command Line Tools se manca).
#   2. PRIMA installazione: clona il progetto in ~/gsdcampus-autoplay e apre l'AI (con setup).
#      Se l'installazione ESISTE GIÀ, chiede COSA vuoi fare con un menu:
#        - Aggiorna e avvia
#        - Cambia account e/o orari
#        - Reinstallazione pulita (riallinea codice + reinstalla dipendenze)
#        - Solo avvia
#        - Migrazione AI (aggiorna il codice + configura Ollama Cloud/OpenCode)
#        - Disinstalla
#        - Annulla
#   3. Avvia ./launch-ai-supervisor.sh, che installa il resto (Node, Playwright, Ollama, OpenCode)
#      e apre l'AI.
#
# L'aggiornamento NON tocca config.json (è in .gitignore): autologin e orari restano.

set -euo pipefail

REPO_URL="https://github.com/iCosiSenpai/gsdcampus-autoplay.git"
BRANCH="main"
TARGET="$HOME/gsdcampus-autoplay"

# Pin di versione (supply-chain): quando impostato a un tag esistente (es.
# "v0.1.0"), la prima installazione clona ESATTAMENTE quel tag invece del main
# mobile. Main è un branch mobile: un commit malevolo/errato pushato su main
# verrebbe eseguito da ogni collega tramite "curl | bash". Pinning a un tag
# immutabile blocca il codice a una versione verificata.
# Lascia vuoto per usare main (comportamento attuale). Tag va creato con:
#   git tag -a v0.1.0 -m "..." && git push origin v0.1.0
PINNED_TAG=""

clone_repo() {
  # $1 = path destinazione
  local dest="$1"
  if [ -n "$PINNED_TAG" ]; then
    info "Clono la versione pin-nata $PINNED_TAG (immutabile)..."
    if git clone --branch "$PINNED_TAG" --depth 1 "$REPO_URL" "$dest" 2>/dev/null; then
      ok "Progetto scaricato (tag $PINNED_TAG)."
      return 0
    fi
    warn "Tag $PINNED_TAG non trovato (forse non ancora pubblicato). Fallback su $BRANCH."
  fi
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$dest"
}

# Estetica inline (install.sh gira PRIMA del clone: non può sourcare
# scripts/lib/ui.sh — queste copie devono restare allineate a quella lib).
# Colori solo su TTY; accent 256-color con fallback ciano.
if [ -t 1 ]; then
  BOLD='\033[1m'; DIM='\033[2m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  RED='\033[0;31m'; NC='\033[0m'
  if [ "$(tput colors 2>/dev/null || echo 8)" -ge 256 ]; then ACCENT='\033[38;5;45m'; else ACCENT='\033[0;36m'; fi
else
  BOLD=''; DIM=''; GREEN=''; YELLOW=''; RED=''; NC=''; ACCENT=''
fi
case "${LC_ALL:-${LANG:-}}" in
  *UTF-8*|*utf-8*|*utf8*) UI_OK='✓'; UI_ERR='✗'; UI_WARN='⚠'; UI_INFO='·' ;;
  *) UI_OK='+'; UI_ERR='x'; UI_WARN='!'; UI_INFO='-' ;;
esac
info() { printf ' %b%s%b %s\n' "$ACCENT" "$UI_INFO" "$NC" "$1"; }
ok()   { printf ' %b%s%b %s\n' "$GREEN$BOLD" "$UI_OK" "$NC" "$1"; }
warn() { printf ' %b%s%b %s\n' "$YELLOW$BOLD" "$UI_WARN" "$NC" "$1"; }
err()  { printf ' %b%s%b %s\n' "$RED$BOLD" "$UI_ERR" "$NC" "$1"; }

# Quando lo script arriva da "curl | bash", lo stdin è la pipe, non il Terminale: i comandi
# interattivi (read dell'autologin/orari, sudo, Portachiavi) leggerebbero il testo dello script
# invece dell'input dell'utente. Riconnettiamo l'input alla tastiera tramite /dev/tty.
# Verifichiamo che /dev/tty sia davvero APRIBILE in lettura (non basta che esista).
TTY_REDIR=""
if { : < /dev/tty; } 2>/dev/null; then
  TTY_REDIR="/dev/tty"
fi

# Diamo respiro all'interfaccia solo quando il Terminale è davvero troppo
# piccolo. Prima proviamo il resize nativo macOS, poi il comando ANSI per i
# terminali compatibili. Le dimensioni nuove sono un minimo: una finestra già
# grande (tipicamente anche quella a schermo intero) non viene mai ridotta.
UI_WINDOW_RESIZED=false
ui_prepare_terminal() {
  [ -t 1 ] || return 0

  # Imposta anche un titolo riconoscibile alla finestra/scheda corrente.
  printf '\033]0;GSD Campus Autopilot\007'

  case "${TERM_PROGRAM:-}" in
    Apple_Terminal)
      if command -v osascript >/dev/null 2>&1; then
        local app_resize
        app_resize=$(osascript <<'APPLESCRIPT' 2>/dev/null || true
set resultText to "unchanged"
set hasWindow to false
tell application "Terminal"
  if (count of windows) > 0 then
    set hasWindow to true
    set oldBounds to bounds of front window
  end if
end tell
if hasWindow then
  tell application "Finder" to set screenBounds to bounds of window of desktop
  set {screenLeft, screenTop, screenRight, screenBottom} to screenBounds
  set {oldLeft, oldTop, oldRight, oldBottom} to oldBounds
  set oldWidth to oldRight - oldLeft
  set oldHeight to oldBottom - oldTop
  if oldWidth < 1180 or oldHeight < 780 then
    set targetWidth to 1180
    set targetHeight to 780
    if targetWidth > (screenRight - screenLeft - 40) then set targetWidth to screenRight - screenLeft - 40
    if targetHeight > (screenBottom - screenTop - 60) then set targetHeight to screenBottom - screenTop - 60
    set newLeft to screenLeft + ((screenRight - screenLeft - targetWidth) div 2)
    set newTop to screenTop + 36
    if newTop + targetHeight > screenBottom - 12 then set newTop to screenBottom - targetHeight - 12
    tell application "Terminal" to set bounds of front window to {newLeft, newTop, newLeft + targetWidth, newTop + targetHeight}
    set resultText to "resized"
  end if
end if
return resultText
APPLESCRIPT
        )
        case "$app_resize" in
          resized*) UI_WINDOW_RESIZED=true; return 0 ;;
          unchanged*) return 0 ;;
        esac
      fi
      ;;
    iTerm.app)
      if command -v osascript >/dev/null 2>&1; then
        local app_resize
        app_resize=$(osascript <<'APPLESCRIPT' 2>/dev/null || true
set resultText to "unchanged"
set hasWindow to false
tell application "iTerm2"
  if (count of windows) > 0 then
    set hasWindow to true
    set oldBounds to bounds of front window
  end if
end tell
if hasWindow then
  set {oldLeft, oldTop, oldRight, oldBottom} to oldBounds
  set oldWidth to oldRight - oldLeft
  set oldHeight to oldBottom - oldTop
  if oldWidth < 1180 or oldHeight < 780 then
    tell application "iTerm2" to set bounds of front window to {40, 36, 1220, 816}
    set resultText to "resized"
  end if
end if
return resultText
APPLESCRIPT
        )
        case "$app_resize" in
          resized*) UI_WINDOW_RESIZED=true; return 0 ;;
          unchanged*) return 0 ;;
        esac
      fi
      ;;
    *) return 0 ;;
  esac

  command -v tput >/dev/null 2>&1 || return 0

  local cols lines new_cols new_lines
  cols=$(tput cols 2>/dev/null || printf '0')
  lines=$(tput lines 2>/dev/null || printf '0')
  case "$cols:$lines" in
    *[!0-9:]*|0:*|*:0) return 0 ;;
  esac

  new_cols=$cols
  new_lines=$lines
  [ "$new_cols" -lt 108 ] && new_cols=108
  [ "$new_lines" -lt 40 ] && new_lines=40
  if [ "$new_cols" -ne "$cols" ] || [ "$new_lines" -ne "$lines" ]; then
    printf '\033[8;%s;%st' "$new_lines" "$new_cols"
    sleep 0.15
    UI_WINDOW_RESIZED=true
  fi
}

# Hero e pannelli a box arrotondato. Sono inline perché install.sh gira prima
# del clone; la larghezza lascia spazio anche alle voci più lunghe del menu.
UI_BOX_INNER=60
ui_repeat() {
  local char="$1" count="$2" out=""
  while [ "$count" -gt 0 ]; do
    out="${out}${char}"
    count=$((count - 1))
  done
  printf '%s' "$out"
}
ui_box_top() {
  printf ' %b╭%s╮%b\n' "$ACCENT" "$(ui_repeat '─' "$UI_BOX_INNER")" "$NC"
}
ui_box_bottom() {
  printf ' %b╰%s╯%b\n' "$ACCENT" "$(ui_repeat '─' "$UI_BOX_INNER")" "$NC"
}
ui_box_line() {
  # $1 = testo, $2 = codice stile (es. $BOLD o $DIM)
  local text="$1" style="$2" len pad spaces max_text
  max_text=$((UI_BOX_INNER - 2))
  len=$(printf '%s' "$text" | wc -m | tr -d ' ')
  if [ "$len" -gt "$max_text" ]; then
    text="$(printf '%s' "$text" | cut -c "1-$((max_text - 1))")…"
    len=$max_text
  fi
  pad=$((max_text - len)); [ "$pad" -lt 0 ] && pad=0
  spaces=$(printf '%*s' "$pad" "")
  printf ' %b│%b  %b%s%b%s%b│%b\n' "$ACCENT" "$NC" "$style" "$text" "$NC" "$spaces" "$ACCENT" "$NC"
}
ui_prepare_terminal
echo ""
# Versione dell'installazione locale (se esiste già): aiuta a capire da quale
# versione si sta aggiornando. Alla prima installazione non c'è ancora nulla.
INST_VER=""
if [ -d "$HOME/gsdcampus-autoplay/.git" ]; then
  INST_VER=$(git -C "$HOME/gsdcampus-autoplay" describe --tags --always 2>/dev/null || echo "")
  INST_DATE=$(git -C "$HOME/gsdcampus-autoplay" log -1 --format=%cd --date=format:'%d/%m/%Y' 2>/dev/null || echo "")
fi
if [ "${UI_OK}" = '✓' ]; then
  ui_box_top
  ui_box_line "GSD Campus Autopilot · preparazione" "$BOLD"
  ui_box_line "Il menu guidato apparirà tra poco" "$DIM"
  [ -n "$INST_VER" ] && ui_box_line "versione $INST_VER${INST_DATE:+ · $INST_DATE}" "$DIM" || true
  ui_box_bottom
else
  printf '%b  GSD Campus Autopilot%b\n' "$BOLD" "$NC"
  printf '  Preparo il menu guidato...\n'
  [ -n "$INST_VER" ] && printf "  versione installata: %s%s\n" "$INST_VER" "${INST_DATE:+ del $INST_DATE}" || true
fi
[ "$UI_WINDOW_RESIZED" = true ] && info "Finestra adattata per mostrare comodamente tutti i passaggi." || true
echo ""

# Preflight di rete (INLINE: pre-clone scripts/doctor.sh non esiste ancora;
# post-clone il doctor completo rifà questi check e molto altro).
# Ritorna 0 se internet + GitHub raw sono raggiungibili.
net_preflight() {
  curl -m 5 -fsS -o /dev/null https://captive.apple.com 2>/dev/null || return 1
  curl -m 5 -fsS -o /dev/null "https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh" 2>/dev/null || return 1
  return 0
}

# 1. git
if ! command -v git >/dev/null 2>&1; then
  warn "git non trovato. Avvio l'installazione dei Command Line Tools di macOS..."
  xcode-select --install 2>/dev/null || true
  err "Completa l'installazione di 'Command Line Tools' nella finestra appena aperta, poi rilancia questo comando."
  exit 1
fi
ok "git disponibile."

# Aggiorna il codice all'ultima versione (senza toccare i file ignorati: config.json, log, ...)
update_repo() {
  info "Aggiorno il progetto all'ultima versione..."
  git fetch --quiet origin "$BRANCH" || warn "fetch non riuscito, proseguo con la versione locale."

  # Transizione known_answers.json -> gitignorato. Nei commit vecchi questo file è
  # TRACCIATO e l'autoplay lo riscrive a ogni quiz risolto, quindi ogni collega attivo
  # ce l'ha modificato localmente. L'ff-merge al commit che lo destraccia fallirebbe
  # ("Your local changes would be overwritten by merge"). Qui: se è ancora tracciato e
  # modificato, ne back up le risposte verificate, lo resetto al HEAD (così il ff
  # procede pulito e il nuovo commit lo rimuove dal tree), poi ripristino il backup
  # sul file ormai gitignorato. Zero perdita di risposte del collega.
  local ka_restore=""
  if git ls-files --error-unmatch data/known_answers.json >/dev/null 2>&1 \
     && ! git diff --quiet -- data/known_answers.json 2>/dev/null; then
    cp data/known_answers.json data/known_answers.json.__keep 2>/dev/null && ka_restore="data/known_answers.json.__keep"
    git checkout -- data/known_answers.json 2>/dev/null || true
  fi

  if git merge --ff-only "origin/$BRANCH" >/dev/null 2>&1; then
    ok "Progetto aggiornato."
  else
    # L'ff-only è fallito per altri file tracciati sporchi (non known_answers, già
    # gestito). Riallineo forzato a origin: la repo è la source of truth, i file
    # tracciati non dovrebbero avere modifiche locali (quelle legittime sono tutte
    # gitignorate: config.json, logs/, data/accounts/, known_answers.json). Così il
    # "Aggiorna e avvia" non si ferma mai su uno stato sporco imprevisto. Le risposte
    # del collega sono preservate dal backup .__keep (ripristinato sotto).
    warn "Aggiornamento pulito non riuscito (altri file locali modificati?). Riallineo a origin/$BRANCH..."
    if git reset --hard "origin/$BRANCH" >/dev/null 2>&1; then
      ok "Codice riallineato a origin/$BRANCH."
    else
      warn "Impossibile riallineare il codice; proseguo con la versione attuale."
    fi
  fi

  # Ripristino le risposte verificate del collega sul file ora gitignorato.
  if [ -n "$ka_restore" ] && [ -f "$ka_restore" ]; then
    mv -f "$ka_restore" data/known_answers.json 2>/dev/null || rm -f "$ka_restore" 2>/dev/null
  fi
}

# 2. Prima installazione oppure gestione di un'installazione esistente
MODE="install"   # install | update | reconfig | clean | launch | uninstall | cancel
RELOGIN_OLLAMA=false   # compatibilità con vecchie installazioni: non usato dal flusso Cloud

if [ -d "$TARGET/.git" ]; then
  # Il menu viene mostrato prima di chiedere l'azione. Se la copia locale ha il
  # renderer precedente, aggiorniamolo prima di disegnarlo: altrimenti il primo
  # rilancio del curl mostrerebbe ancora la vecchia schermata e la nuova UI si
  # vedrebbe soltanto dal rilancio successivo.
  if [ -f "$TARGET/scripts/lib/prompt-cli.js" ] \
     && ! grep -q "drawMenuScreen" "$TARGET/scripts/lib/prompt-cli.js" 2>/dev/null; then
    if net_preflight; then
      info "Preparo il nuovo menu di benvenuto..."
      (cd "$TARGET" && update_repo)
    else
      warn "Niente rete: uso temporaneamente il menu già installato."
    fi
  fi
  if [ -n "$TTY_REDIR" ]; then
    echo ""
    info "Trovata un'installazione esistente in $TARGET."
    # Mostra l'account/orari attualmente configurati, così sai su cosa stai operando.
    if command -v node >/dev/null 2>&1 && [ -f "$TARGET/config.json" ]; then
      ACCT_DESC=$(node -e "try{const c=require('$TARGET/config.json');const s=c.workSchedule&&c.workSchedule.days?(c.workSchedule.days.length+' giorni'):'orari default';process.stdout.write((c.memberName||c.codice_fiscale||'account sconosciuto')+'  ·  '+s)}catch(e){process.stdout.write('')}" 2>/dev/null)
      [ -n "$ACCT_DESC" ] && info "Account attuale: $ACCT_DESC"
    fi
    ACCT_DESC="${ACCT_DESC:-Account non ancora configurato}"
    echo ""
    printf '%bPerché stai rilanciando l'"'"'installer?%b\n' "$BOLD" "$NC"
    echo "  Usa le frecce ↑/↓ e Invio per scegliere."
    echo ""
    CHOICE=$(node "$TARGET/scripts/lib/prompt-cli.js" select \
      --brand --title "Cosa vuoi fare?" --subtitle "$ACCT_DESC" --default 1 -- \
      "Aggiorna e avvia — Scarica fix e risposte quiz, poi apre l'AI (consigliato)" \
      "Cambia collega o orari — Seleziona l'account e modifica i turni di lavoro" \
      "Ripara l'installazione — Riallinea il codice e reinstalla le dipendenze" \
      "Apri soltanto l'AI — Avvia senza cambiare configurazione o file" \
      "Configura la nuova AI — Imposta Ollama Cloud e OpenCode" \
      "Disinstalla — Rimuove programmi e componenti, dopo una conferma" \
      "Esci — Non modifica nulla" < "$TTY_REDIR" 2>/dev/null || echo 1)
    case "$CHOICE" in
      1) MODE="update" ;;
      2) MODE="reconfig" ;;
      3) MODE="clean" ;;
      4) MODE="launch" ;;
      5) MODE="update" ;;   # aggiornamento + migrazione una-tantum
      6) MODE="uninstall" ;;
      0|7) MODE="cancel" ;;
      *) MODE="update" ;;   # node failure / EOF → safest default
    esac
  else
    # Nessun terminale interattivo: posso solo aggiornare il codice.
    MODE="update"
  fi
elif [ -d "$TARGET" ]; then
  warn "Esiste già $TARGET ma non è una copia git. Non la sovrascrivo: uso il contenuto attuale."
  MODE="launch"
else
  # Prima installazione: senza rete non si può clonare → fail-fast chiaro.
  if ! net_preflight; then
    err "Niente connessione a internet (o GitHub non raggiungibile)."
    info "Controlla il Wi-Fi/cavo di rete e rilancia questo stesso comando."
    exit 1
  fi
  info "Scarico il progetto in $TARGET..."
  clone_repo "$TARGET"
  ok "Progetto scaricato."
  MODE="install"   # prima volta: il launcher avvierà il setup interattivo (selezione account + orari)
fi

if [ "$MODE" = "cancel" ]; then
  info "Operazione annullata. Niente è stato modificato."
  exit 0
fi

cd "$TARGET"
chmod +x ./launch-ai-supervisor.sh ./start.sh ./stop.sh ./status.sh 2>/dev/null || true
chmod +x ./scripts/*.sh 2>/dev/null || true

# Migrazione una sola volta per Mac. Il marker vive fuori dal repository, quindi
# non si ripete dopo un pull/reset e non viene distribuito ai colleghi.
migrate_claude_once() {
  local marker_dir="$HOME/Library/Application Support/gsdcampus-autoplay"
  local marker="$marker_dir/client-opencode-v1.done"
  [ -f "$marker" ] && return 0
  [ -n "$TTY_REDIR" ] || return 0
  [ -f "$TARGET/scripts/lib/migrate-claude-settings.js" ] || return 0
  if ! command -v claude >/dev/null 2>&1 && [ ! -x "$HOME/.local/bin/claude" ] && [ ! -d "$HOME/.claude" ]; then
    return 0
  fi

  echo ""
  info "Ho aggiornato il client AI da Claude a OpenCode. Claude ti serve ancora?"
  local choice
  choice=$(node "$TARGET/scripts/lib/prompt-cli.js" select \
    --brand --title "Claude → OpenCode" --subtitle "Scegli come trattare il vecchio client" --default 1 -- \
    "Tieni Claude — Ripristina soltanto le impostazioni GSD/Ollama" \
    "Rimuovi Claude — Conserva dati e conversazioni personali" \
    "Lascia tutto com'è — Decidi in un secondo momento" < "$TTY_REDIR" 2>/dev/null || echo 1)

  case "$choice" in
    1)
      node "$TARGET/scripts/lib/migrate-claude-settings.js" 2>/dev/null || warn "Non ho potuto ripristinare gli override Ollama di Claude."
      ok "Claude conservato; rimossi soltanto eventuali override GSD/Ollama riconoscibili."
      ;;
    2)
      rm -f "$HOME/.local/bin/claude" 2>/dev/null || true
      if command -v brew >/dev/null 2>&1; then
        brew uninstall --cask claude-code 2>/dev/null || true
        brew uninstall --cask claude 2>/dev/null || true
      fi
      if command -v npm >/dev/null 2>&1; then
        npm uninstall -g @anthropic-ai/claude-code 2>/dev/null || true
      fi
      ok "Claude disinstallato; configurazioni e conversazioni personali non sono state cancellate."
      ;;
    *)
      info "Claude lasciato invariato. Potrai disinstallarlo manualmente in seguito."
      ;;
  esac
  mkdir -p "$marker_dir"
  printf 'client=opencode\ncompletedAt=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"
}

# 3. Esegui l'azione scelta
case "$MODE" in
  update)
    # Su installazione esistente la rete assente NON blocca: si salta solo
    # l'aggiornamento e si avvia la versione locale (meglio di un vicolo cieco).
    if ! net_preflight; then
      warn "Niente rete: salto l'aggiornamento e avvio la versione già installata."
    else
      OLD_HEAD=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo "")
      update_repo
      migrate_claude_once
      # Box "Novità": righe aggiunte a CHANGELOG.md tra la versione di prima e
      # quella appena scaricata, in linguaggio semplice. Ogni grep con || true:
      # sotto pipefail un no-match (exit 1) abortirebbe l'installer.
      NEW_HEAD=$(git -C "$TARGET" rev-parse HEAD 2>/dev/null || echo "")
      if [ -n "$OLD_HEAD" ] && [ -n "$NEW_HEAD" ] && [ "$OLD_HEAD" != "$NEW_HEAD" ]; then
        NOVITA=$(git -C "$TARGET" diff "$OLD_HEAD"..HEAD -- CHANGELOG.md 2>/dev/null \
          | { grep '^+' || true; } | { grep -v '^+++' || true; } \
          | sed 's/^+//' | { grep -v '^\s*$' || true; } | { grep -v '^#' || true; } | head -10)
        if [ -n "${NOVITA:-}" ] && [ "${UI_OK}" = '✓' ]; then
          echo ""
          ui_box_top
          ui_box_line "Novità di questo aggiornamento" "$BOLD"
          ui_box_bottom
          printf '%s\n' "$NOVITA" | while IFS= read -r nl; do
            printf '  %b·%b %s\n' "$ACCENT" "$NC" "${nl#- }"
          done
          printf '  %baggiornato: %.7s → %.7s%b\n' "$DIM" "$OLD_HEAD" "$NEW_HEAD" "$NC"
          echo ""
        fi
      fi
      # Aggiorna la banca risposte pubblica (se presente sul repo) con quelle locali.
      if [ -f "$TARGET/scripts/update-known-answers.sh" ]; then
        "$TARGET/scripts/update-known-answers.sh" 2>/dev/null || true
      fi
      # Dopo l'aggiornamento del codice, controlla se anche le dipendenze sono allineate.
      # Se package.json/package-lock.json sono cambiati, setup.sh le aggiornerà in modo
      # automatico e solo se necessario.
      if [ -f "$TARGET/scripts/check-requirements.sh" ] && ! "$TARGET/scripts/check-requirements.sh" >/dev/null 2>&1; then
        info "Dipendenze da aggiornare dopo il pull. Avvio setup condizionale..."
        sudo -v
        if [ -n "$TTY_REDIR" ]; then
          "$TARGET/scripts/setup.sh" --yes < "$TTY_REDIR"
        else
          "$TARGET/scripts/setup.sh" --yes
        fi
      else
        ok "Codice e dipendenze già allineati."
      fi
    fi
    # Auto-update notturno: attivato/aggiornato a ogni "Aggiorna e avvia"
    # (guarded: sui Mac con la versione vecchia lo script appare dopo l'update).
    if [ -x "$TARGET/scripts/lib/install-launchd.sh" ]; then
      "$TARGET/scripts/lib/install-launchd.sh" install 2>/dev/null || true
    fi
    # Checkup a semaforo (post-update): AVVISA, non blocca — il launcher a valle
    # ha già i rimedi per quasi tutto (setup, Ollama, pull modello).
    DOCTOR_STATUS=""
    if [ -x "$TARGET/scripts/doctor.sh" ]; then
      if "$TARGET/scripts/doctor.sh"; then
        DOCTOR_STATUS="ok"
      else
        DOCTOR_STATUS="problemi"
        warn "Il checkup ha trovato problemi (rimedi qui sopra). Proseguo comunque tra 8s..."
        if [ -n "$TTY_REDIR" ]; then
          read -r -t 8 -p "  Invio per continuare subito, Ctrl-C per fermarti. " < "$TTY_REDIR" || true
          echo ""
        fi
      fi
    fi
    ;;
  reconfig)
    if ! net_preflight; then
      warn "Niente rete: salto l'aggiornamento del codice, riconfiguro con la versione locale."
    else
      update_repo
    fi
    migrate_claude_once
    warn "Riconfigurazione: ti verrà richiesto di selezionare l'account dall'elenco membri e di configurare gli orari."
    # NON cancelliamo subito la config: la mettiamo da parte come backup, così se
    # la riconfigurazione viene annullata setup.sh può ripristinarla (niente perdita
    # di account/orari, come capitato annullando a metà).
    if [ -f config.json ]; then
      cp config.json config.json.bak
      ok "Configurazione attuale salvata in config.json.bak (ripristinata se annulli)."
    fi
    rm -f config.json
    ;;
  clean)
    info "Reinstallazione pulita."
    net_preflight || warn "Niente rete: riallineo alla versione origin già scaricata (niente fetch)."
    git fetch --quiet origin "$BRANCH" || true
    # Preservo known_answers.json (banca trusted locale, ora gitignorata): il
    # reset --hard al commit che la destraccia la rimuoverebbe dal disco, perdendo
    # le risposte verificate del collega. Backup prima del reset, restore dopo.
    ka_clean_keep=""
    [ -f data/known_answers.json ] && cp data/known_answers.json data/known_answers.json.__keep 2>/dev/null && ka_clean_keep="data/known_answers.json.__keep"
    if git reset --hard "origin/$BRANCH" >/dev/null 2>&1; then
      ok "Codice riallineato a origin/$BRANCH (config.json e dati personali restano)."
    else
      warn "Impossibile riallineare il codice; proseguo con la versione attuale."
    fi
    if [ -n "$ka_clean_keep" ] && [ -f "$ka_clean_keep" ]; then
      mv -f "$ka_clean_keep" data/known_answers.json 2>/dev/null || rm -f "$ka_clean_keep" 2>/dev/null
    fi
    if [ -n "$TTY_REDIR" ] && [ -f config.json ]; then
      migrate_claude_once
      info "Reinstallo/aggiorno tutte le dipendenze (può richiedere qualche minuto)..."
      ./scripts/setup.sh --yes --force-update < "$TTY_REDIR" || warn "Force-update dipendenze non completato; proseguo."
    fi
    ;;
  uninstall)
    if [ -n "$TTY_REDIR" ]; then
      exec ./scripts/uninstall.sh <> "$TTY_REDIR"
    else
      warn "Serve un terminale per la disinstallazione."
      info "Esegui:  cd ~/gsdcampus-autoplay && ./scripts/uninstall.sh"
      exit 1
    fi
    ;;
  launch|install)
    migrate_claude_once
    ;;
esac

# Il vecchio flusso di logout/pull locale Ollama è intenzionalmente rimosso:
# questa versione usa la chiave nel Portachiavi e Ollama Cloud via proxy.

echo ""
# Schermata finale "Tutto pronto" prima di passare al supervisore.
FINAL_VER=$(git -C "$TARGET" describe --tags --always 2>/dev/null || echo "")
case "$MODE" in
  update)  FINAL_ACTION="aggiornato · Ollama Cloud + OpenCode" ;;
  reconfig) FINAL_ACTION="riconfigurazione in arrivo" ;;
  clean)   FINAL_ACTION="reinstallato da zero" ;;
  install) FINAL_ACTION="prima installazione" ;;
  *)       FINAL_ACTION="pronto" ;;
esac
if [ "${UI_OK}" = '✓' ]; then
  ui_box_top
  ui_box_line "Tutto pronto" "$BOLD"
  [ -n "$FINAL_VER" ] && ui_box_line "versione $FINAL_VER · $FINAL_ACTION" "$DIM" || true
  if [ "${DOCTOR_STATUS:-}" = "ok" ]; then
    ui_box_line "checkup sistema: tutto in ordine" "$DIM"
  elif [ "${DOCTOR_STATUS:-}" = "problemi" ]; then
    ui_box_line "checkup sistema: vedi avvisi sopra" "$DIM"
  fi
  ui_box_bottom
  echo ""
fi
ok "Avvio il supervisore AI..."
echo ""

# 4. Avvia il launcher in modo interattivo (legge da terminale anche se siamo in pipe).
#    Nel path "curl | bash", fd0 è la pipe (lo script) ma fd1/fd2 sono ancora il pty reale
#    ereditato dal terminale (es. /dev/ttys002, device major 16). Duplichiamo fd0 e fd2 su
#    fd1 (<&1 2>&1) così stdin/stdout/stderr condividono tutti lo stesso pty reale: è esattamente
#    ciò che fa la shell interattiva nel lancio manuale.
#
#    NON usare /dev/tty (device major 2) per i fd del TUI: il client TUI può richiedere un pty,
#    che crea il WriteStream del TTY tramite kqueue; kqueue su macOS non supporta /dev/tty e
#    fallisce con EINVAL (crash "invalid argument, kqueue" in internal:util/colors).
#    Inoltre, redirigere solo fd0 su /dev/tty lascia stdout/stderr sul pty reale: il TUI entra
#    in raw mode su fd0 ma scrive su fd1 (device diverso) e l'input da tastiera non arriva
#    (la finestra si apre ma non risponde).
if [ -n "$TTY_REDIR" ]; then
  exec ./launch-ai-supervisor.sh <&1 2>&1
else
  warn "Nessun terminale interattivo rilevato in questo contesto."
  info "Apro automaticamente una nuova finestra del Terminale con l'AI..."
  # osascript apre una finestra di Terminal.app che lancia il supervisore in un pty
  # pulito: il collega non deve lanciare comandi a mano. Se Terminal.app non è
  # disponibile (es. usa iTerm2 senza permessi di automazione), restiamo sul messaggio.
  if osascript -e "tell application \"Terminal\" to do script \"cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh\"" >/dev/null 2>&1; then
    ok "Finestra del Terminale aperta. Continua lì: l'AI si avvierà da sola."
    exit 0
  else
    warn "Impossibile aprire automaticamente una finestra del Terminale."
    info "Apri il Terminale ed esegui:  cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh"
  fi
fi
