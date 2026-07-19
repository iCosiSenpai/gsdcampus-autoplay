# ollama.sh — ensure server/cli + install ufficiale (sourced da setup.sh).
# Richiede: DIR, info/ok/warn, AUTO_YES, e (per install) spinner/sudo se usati.

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
