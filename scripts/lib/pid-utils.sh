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
  ps -o command= -p "$p" 2>/dev/null | grep -qE "$pat" || return 1
  return 0
}
