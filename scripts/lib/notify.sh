# notify.sh — notifiche macOS native (sourcato, non eseguito; bash + zsh).
#
# notify_user "titolo" "messaggio" [tipo]
#   - Mostra una notifica macOS via osascript (display notification).
#   - Opt-out: `"notifications": false` in config.json → nessuna notifica.
#   - Throttle: max 1 notifica ogni 6 ore per `tipo` (marker logs/.notify_<tipo>):
#     lo scheduler può riprovare ogni pochi minuti, ma il collega non va
#     bombardato con la stessa notifica a raffica.
#   - MAI fallisce e non scrive nulla su stdout: è sempre sicuro chiamarla
#     sotto `set -e` (gli errori osascript/permessi notifiche sono ignorati).
#
# Richiede $DIR (root del progetto) già definito dal chiamante.

notify_user() {
  local title="${1:-GSD Campus}" msg="${2:-}" type="${3:-general}"
  [ -n "$msg" ] || return 0

  # Opt-out esplicito in config.json (pattern read_ollama_model: node + fallback).
  local enabled
  enabled=$(node -e "try{const c=require('$DIR/config.json');process.stdout.write(c.notifications===false?'no':'yes')}catch(e){process.stdout.write('yes')}" 2>/dev/null || echo "yes")
  [ "$enabled" = "no" ] && return 0

  # Throttle per tipo: se il marker esiste ed è più giovane di 6 ore, salta.
  # `tr -cd`: il tipo diventa un nome file sicuro qualunque cosa arrivi.
  local safe_type marker
  safe_type=$(printf '%s' "$type" | tr -cd 'a-zA-Z0-9_-')
  [ -n "$safe_type" ] || safe_type="general"
  marker="$DIR/logs/.notify_${safe_type}"
  if [ -f "$marker" ] && [ -n "$(find "$marker" -mmin -360 2>/dev/null)" ]; then
    return 0
  fi
  mkdir -p "$DIR/logs" 2>/dev/null || true
  touch "$marker" 2>/dev/null || true

  # `on run argv`: titolo/messaggio passano come ARGOMENTI, mai interpolati
  # nel sorgente AppleScript (niente injection da virgolette nei messaggi).
  osascript \
    -e 'on run argv' \
    -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
    -e 'end run' \
    "$title" "$msg" >/dev/null 2>&1 || true
  return 0
}
