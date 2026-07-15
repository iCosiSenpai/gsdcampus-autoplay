#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PID_FILE=".ollama_pid"

# pid_matches condiviso (protezione PID recycling).
source "$DIR/scripts/lib/pid-utils.sh"

# Preferisci il CLI headless `ollama` (entrypoint documentato per `serve`, non
# instanzia l'icona nella barra di stato). Fall back al binario GUI dell'app solo
# se il CLI non è in PATH. Il binario Contents/MacOS/Ollama è il launcher GUI:
# lanciarlo direttamente è proprio il path che Gatekeeper SIGKilla in quarantina.
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN="$(command -v ollama)"
elif [ -x "/Applications/Ollama.app/Contents/MacOS/Ollama" ]; then
  OLLAMA_BIN="/Applications/Ollama.app/Contents/MacOS/Ollama"
else
  OLLAMA_BIN="ollama"
fi

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') | $1" | tee -a "$DIR/logs/ollama.log"
}

is_running() {
  # 1. Verifica via porta
  if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
    return 0
  fi
  # 2. Verifica via PID file (evita il PID del daemon stesso)
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ] && [ "$pid" -ne "$$" ] && pid_matches "$pid" "ollama|Ollama"; then
      return 0
    fi
  fi
  return 1
}

start() {
  if is_running; then
    echo "Ollama già attivo"
    return 0
  fi

  # Se c'è un'istanza GUI dell'app aperta, chiudila silenziosamente per non mostrare l'icona
  if pgrep -x "Ollama" >/dev/null 2>&1; then
    osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
    sleep 1
  fi

  # Lock atomica anti-doppio-avvio: noclobber crea il PID file solo se non esiste,
  # in modo esclusivo. Previene che due `ollama-daemon.sh start` lanciati in rapida
  # successione passino entrambi l'`is_running` (entrambi vedono "non attivo") e
  # avviino due `ollama serve` concorrenti. Eventuale PID file stale (processo
  # morto senza ripulire) viene rimosso prima della lock.
  if [ -f "$PID_FILE" ]; then
    local stale=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$stale" ] && ! pid_matches "$stale" "ollama|Ollama"; then
      rm -f "$PID_FILE"
    fi
  fi
  if ! (set -o noclobber; : > "$DIR/$PID_FILE") 2>/dev/null; then
    echo "Impossibile acquisire il lock su $PID_FILE (avvio concorrente?)."
    return 1
  fi

  mkdir -p logs
  # Safety net anti-quarantine: se l'app è stata (re)installata e mai `open`-ata,
  # il com.apple.quarantine fa SIGKILL del binario lanciato direttamente (vedi
  # setup.sh install_ollama_official). Strip + VERIFY: se il flag persiste riprovo
  # con sudo; se resta ancora, avviso (il binario potrebbe essere SIGKILLato).
  if [ -d "/Applications/Ollama.app" ]; then
    xattr -dr com.apple.quarantine "/Applications/Ollama.app" 2>/dev/null || true
    # grep -c (non -q): evita SIGPIPE sotto pipefail (v. commento in start.sh).
    if xattr -l "/Applications/Ollama.app" 2>/dev/null | grep -c 'com.apple.quarantine' >/dev/null; then
      sudo xattr -dr com.apple.quarantine "/Applications/Ollama.app" 2>/dev/null || true
      if xattr -l "/Applications/Ollama.app" 2>/dev/null | grep -c 'com.apple.quarantine' >/dev/null; then
        log "Attenzione: com.apple.quarantine ancora presente su Ollama.app; il binario potrebbe essere SIGKILLato."
      fi
    fi
  fi
  log "Avvio Ollama in background (headless: $OLLAMA_BIN serve)..."
  nohup "$OLLAMA_BIN" serve >> "$DIR/logs/ollama.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "Ollama avviato (PID $pid), attendo prontezza su 11434..."

  for i in $(seq 1 60); do            # 30s @ 0.5s
    if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
      echo "Ollama pronto"
      return 0
    fi
    sleep 0.5
  done

  # Fallback: bind diretto non riuscito (quarantine SIGKILL, entitlements mancanti,
  # ...). open -a Ollama avvia l'app GUI che a sua volta fa partire il server su 11434.
  log "Bind diretto non riuscito entro 30s. Fallback: open -a Ollama (GUI)..."
  open -a Ollama 2>/dev/null || true
  for i in $(seq 1 40); do            # 20s
    if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
      local gui_pid=$(pgrep -x Ollama 2>/dev/null | head -1)
      [ -n "$gui_pid" ] && echo "$gui_pid" > "$PID_FILE"
      echo "Ollama pronto (via GUI)"
      return 0
    fi
    sleep 0.5
  done

  log "Ollama non ha bindato 11434 entro ~50s."
  echo "Attenzione: Ollama non ha risposto su 11434." >&2
  return 1
}

stop() {
  local killed=false

  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ]; then
      if pid_matches "$pid" "ollama|Ollama"; then
        echo "Arresto Ollama (PID $pid) con SIGTERM..."
        kill "$pid" 2>/dev/null || true
        for i in {1..10}; do
          if ! kill -0 "$pid" 2>/dev/null; then
            echo "Ollama fermato."
            killed=true
            break
          fi
          sleep 0.5
        done
        if [ "$killed" = false ]; then
          echo "Forzo arresto Ollama con SIGKILL..."
          kill -9 "$pid" 2>/dev/null || true
          killed=true
        fi
      else
        echo "PID $pid nel file non corrisponde a Ollama (probabile PID recycling). Non lo kill."
      fi
    fi
    rm -f "$PID_FILE"
  fi

  # Cleanup eventuali ollama serve orfani
  local orphans=$(pgrep -f "ollama serve" 2>/dev/null || true)
  if [ -n "$orphans" ]; then
    echo "$orphans" | while read pid; do
      [ "$pid" != "$$" ] && kill -9 "$pid" 2>/dev/null || true
    done
    killed=true
  fi

  # Chiudi anche eventuale app GUI rimasta
  if pgrep -x "Ollama" >/dev/null 2>&1; then
    osascript -e 'quit app "Ollama"' >/dev/null 2>&1 || true
    killed=true
  fi

  if [ "$killed" = true ]; then
    echo "Ollama fermato"
  else
    echo "Ollama non era attivo"
  fi
}

status() {
  if is_running; then
    echo "Ollama attivo"
  else
    echo "Ollama non attivo"
  fi
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop && start ;;
  *) echo "Uso: $0 {start|stop|status|restart}" ;;
esac
