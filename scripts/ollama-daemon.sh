#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PID_FILE=".ollama_pid"

# Usa il binario interno dell'app per evitare l'apertura della GUI nella barra di stato
if [ -x "/Applications/Ollama.app/Contents/MacOS/Ollama" ]; then
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
    if [ -n "$pid" ] && [ "$pid" -ne "$$" ] && kill -0 "$pid" 2>/dev/null; then
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

  mkdir -p logs
  log "Avvio Ollama in background (headless)..."
  nohup "$OLLAMA_BIN" serve >> "$DIR/logs/ollama.log" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "Ollama avviato (PID $pid), attendo prontezza..."

  for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:11434 >/dev/null 2>&1; then
      echo "Ollama pronto"
      return 0
    fi
    sleep 0.5
  done

  echo "Attenzione: Ollama non ha risposto entro 15s, ma il processo è attivo"
  return 0
}

stop() {
  local killed=false

  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ]; then
      if kill -0 "$pid" 2>/dev/null; then
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

case "$1" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop && start ;;
  *) echo "Uso: $0 {start|stop|status|restart}" ;;
esac
