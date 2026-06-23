#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
PID_FILE=".ollama_pid"

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
    echo "Ollama gia attivo"
    return 0
  fi
  mkdir -p logs
  echo "$(date '+%Y-%m-%d %H:%M:%S') | Avvio Ollama in background..." >> "$DIR/logs/ollama.log"
  nohup ollama serve >> "$DIR/logs/ollama.log" 2>&1 &
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

  echo "Attenzione: Ollama non ha risposto entro 15s, ma il processo e attivo"
  return 0
}

stop() {
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE" 2>/dev/null || echo "")
    if [ -n "$pid" ]; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  # Cleanup eventuali ollama serve orfani
  pgrep -f "ollama serve" 2>/dev/null | while read pid; do
    kill "$pid" 2>/dev/null || true
  done
  echo "Ollama fermato"
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
