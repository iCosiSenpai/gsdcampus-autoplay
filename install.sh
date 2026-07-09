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
#        - Disinstalla
#        - Annulla
#   3. Avvia ./launch-ai-supervisor.sh, che installa il resto (Node, Playwright, Ollama, Claude)
#      e apre l'AI. La parte Ollama/Claude non viene modificata da questo script.
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

BOLD='\033[1m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; BLUE='\033[0;34m'; RED='\033[0;31m'; NC='\033[0m'
info() { printf "${BLUE}${BOLD}[INFO]${NC} %s\n" "$1"; }
ok()   { printf "${GREEN}${BOLD}[OK]${NC} %s\n" "$1"; }
warn() { printf "${YELLOW}${BOLD}[ATTENZIONE]${NC} %s\n" "$1"; }
err()  { printf "${RED}${BOLD}[ERRORE]${NC} %s\n" "$1"; }

# Quando lo script arriva da "curl | bash", lo stdin è la pipe, non il Terminale: i comandi
# interattivi (read dell'autologin/orari, sudo, ollama login) leggerebbero il testo dello script
# invece dell'input dell'utente. Riconnettiamo l'input alla tastiera tramite /dev/tty.
# Verifichiamo che /dev/tty sia davvero APRIBILE in lettura (non basta che esista).
TTY_REDIR=""
if { : < /dev/tty; } 2>/dev/null; then
  TTY_REDIR="/dev/tty"
fi

echo ""
echo "============================================"
printf "${BOLD}  GSD Campus Autopilot — Installer${NC}\n"
echo "============================================"
echo ""
echo -e "${BOLD}Comando principale:${NC}"
echo "  curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash"
echo ""
echo "Questo comando vale sempre: installa, aggiorna il codice e, solo se necessario, le dipendenze."
echo ""

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

if [ -d "$TARGET/.git" ]; then
  if [ -n "$TTY_REDIR" ]; then
    echo ""
    info "Trovata un'installazione esistente in $TARGET."
    # Mostra l'account/orari attualmente configurati, così sai su cosa stai operando.
    if command -v node >/dev/null 2>&1 && [ -f "$TARGET/config.json" ]; then
      ACCT_DESC=$(node -e "try{const c=require('$TARGET/config.json');const s=c.workSchedule&&c.workSchedule.days?(c.workSchedule.days.length+' giorni'):'orari default';process.stdout.write((c.memberName||c.codice_fiscale||'account sconosciuto')+'  ·  '+s)}catch(e){process.stdout.write('')}" 2>/dev/null)
      [ -n "$ACCT_DESC" ] && info "Account attuale: $ACCT_DESC"
    fi
    echo ""
    printf "${BOLD}Perché stai rilanciando l'installer?${NC}\n"
    echo "  1) Aggiorna e avvia          — scarica fix e risposte quiz aggiornate, poi apre l'AI (consigliato)"
    echo "  2) Cambia account/orari        — riconfigura account (elenco membri) e orari, poi avvia"
    echo "  3) Reinstallazione pulita     — riallinea il codice e reinstalla tutte le dipendenze"
    echo "  4) Solo avvia                 — apre l'AI senza modificare nulla"
    echo "  5) Disinstalla                — rimuove dipendenze, modello, CLI (con conferma)"
    echo "  6) Annulla"
    echo ""
    while true; do
      printf "Scelta [1]: "
      IFS= read -r CHOICE < "$TTY_REDIR" || CHOICE=""
      [ -z "$CHOICE" ] && CHOICE=1
      case "$CHOICE" in
        1) MODE="update";    break ;;
        2) MODE="reconfig";  break ;;
        3) MODE="clean";     break ;;
        4) MODE="launch";    break ;;
        5) MODE="uninstall"; break ;;
        6) MODE="cancel";    break ;;
        *) warn "Scelta non valida (1-6)." ;;
      esac
    done
  else
    # Nessun terminale interattivo: posso solo aggiornare il codice.
    MODE="update"
  fi
elif [ -d "$TARGET" ]; then
  warn "Esiste già $TARGET ma non è una copia git. Non la sovrascrivo: uso il contenuto attuale."
  MODE="launch"
else
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

# 3. Esegui l'azione scelta
case "$MODE" in
  update)
    update_repo
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
      "$TARGET/scripts/setup.sh" --yes
    else
      ok "Codice e dipendenze già allineati."
    fi
    ;;
  reconfig)
    update_repo
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
    : # nessuna azione preliminare
    ;;
esac

echo ""
ok "Pronto. Avvio il supervisore AI..."
echo ""

# 4. Avvia il launcher in modo interattivo (legge da terminale anche se siamo in pipe).
#    Nel path "curl | bash", fd0 è la pipe (lo script) ma fd1/fd2 sono ancora il pty reale
#    ereditato dal terminale (es. /dev/ttys002, device major 16). Duplichiamo fd0 e fd2 su
#    fd1 (<&1 2>&1) così stdin/stdout/stderr condividono tutti lo stesso pty reale: è esattamente
#    ciò che fa la shell interattiva nel lancio manuale.
#
#    NON usare /dev/tty (device major 2) per i fd del TUI: il claude CLI è compilato con Bun,
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
