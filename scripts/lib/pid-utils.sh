# pid-utils.sh — helper condiviso per la gestione PID (sourcato, non eseguito).
# Compatibile bash + zsh. Unica fonte di verità per pid_matches: prima era
# duplicata in start.sh / stop.sh / status.sh / ollama-daemon.sh (e mancava
# del tutto in launch-ai-supervisor.sh e monitor-course.sh, che restavano
# esposti al PID recycling).

# pid_matches <PID> <pattern>: verifica che il PID esista E che la sua command
# line contenga il pattern. Protegge dal PID recycling (un PID recyclato a un
# processo non nostro verrebbe scambiato per un'istanza attiva).
pid_matches() {
  local p="$1"; local pat="$2"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  ps -o command= -p "$p" 2>/dev/null | grep -cE "$pat" >/dev/null || return 1
  return 0
}

# stop_pid_tree <PID> <command-pattern>: termina un processo verificato e i
# suoi figli diretti. I PID figli vengono catturati prima del TERM, cosi possono
# essere forzati anche se il parent esce e vengono adottati da launchd.
stop_pid_tree() {
  local pid="$1" pattern="$2" children="" child="" attempt=0
  pid_matches "$pid" "$pattern" || return 1
  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  if [ -n "$children" ]; then
    printf '%s\n' "$children" | while IFS= read -r child; do
      [ -n "$child" ] && kill -TERM "$child" 2>/dev/null || true
    done
  fi
  kill -TERM "$pid" 2>/dev/null || true
  while [ "$attempt" -lt 10 ] && pid_matches "$pid" "$pattern"; do
    sleep 0.2
    attempt=$((attempt + 1))
  done
  if [ -n "$children" ]; then
    printf '%s\n' "$children" | while IFS= read -r child; do
      [ -n "$child" ] && kill -0 "$child" 2>/dev/null && kill -9 "$child" 2>/dev/null || true
    done
  fi
  pid_matches "$pid" "$pattern" && kill -9 "$pid" 2>/dev/null || true
  return 0
}

# stop_tracked_pid_file <pid-file> <command-pattern>: usa soltanto il PID
# registrato e rimuove sempre il file stale.
stop_tracked_pid_file() {
  local file="$1" pattern="$2" pid=""
  pid="$(cat "$file" 2>/dev/null || true)"
  if [ -n "$pid" ] && stop_pid_tree "$pid" "$pattern"; then
    rm -f "$file"
    return 0
  fi
  rm -f "$file"
  return 1
}

# PID dello scheduler verificato con lock+token. Fallback al PID file numerico
# solo per compatibilità durante l'aggiornamento da versioni precedenti.
autoplay_instance_pid() {
  local root="$1"; local p=""
  if [ -f "$root/scripts/lib/runtime-lock-cli.js" ]; then
    p=$(node "$root/scripts/lib/runtime-lock-cli.js" pid "$root" 2>/dev/null || true)
    if [ -n "$p" ]; then printf '%s' "$p"; return 0; fi
  fi
  if [ -f "$root/.autoplay_pid" ]; then
    p=$(cat "$root/.autoplay_pid" 2>/dev/null || echo "")
    if pid_matches "$p" "scheduler|autoplay"; then printf '%s' "$p"; return 0; fi
  fi
  return 1
}

autoplay_instance_alive() {
  [ -n "$(autoplay_instance_pid "$1" 2>/dev/null || true)" ]
}

autoplay_clean_stale_lock() {
  local root="$1"
  if [ -f "$root/scripts/lib/runtime-lock-cli.js" ]; then
    node "$root/scripts/lib/runtime-lock-cli.js" clean "$root" >/dev/null 2>&1 || return 1
  fi
  return 0
}
