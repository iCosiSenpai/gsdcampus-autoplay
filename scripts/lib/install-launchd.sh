#!/bin/zsh
#
# install-launchd.sh — installa/rimuove il LaunchAgent dell'auto-update periodico.
#
# Uso:
#   ./scripts/lib/install-launchd.sh install   # idempotente (no-op se già ok)
#   ./scripts/lib/install-launchd.sh remove
#
# L'agent gira nel dominio gui/ dell'utente (NIENTE sudo) ogni ~10 minuti e lancia
# scripts/auto-update.sh, che aggiorna SOLO se c'è un commit nuovo su origin/main
# (altrimenti esce in <1s) e NON interrompe un quiz in corso. Sostituisce il
# vecchio job notturno delle 05:30 con un controllo continuo.
# Opt-out: `"autoUpdate": false` in config.json → `install` rimuove l'agent.
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.gsdcampus.autoplay.autoupdate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

remove_agent() {
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
}

install_agent() {
  # Opt-out esplicito: config.json { "autoUpdate": false } → agent rimosso.
  local enabled
  enabled=$(node -e "try{const c=require('$DIR/config.json');process.stdout.write(c.autoUpdate===false?'no':'yes')}catch(e){process.stdout.write('yes')}" 2>/dev/null || echo "yes")
  if [ "$enabled" = "no" ]; then
    remove_agent
    echo "auto-update disattivato da config.json (autoUpdate: false): agent rimosso."
    return 0
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$DIR/logs"

  local tmp="$PLIST.tmp.$$"
  cat > "$tmp" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$DIR/scripts/auto-update.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>StartInterval</key><integer>600</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$DIR/logs/auto-update-launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/auto-update-launchd.log</string>
</dict>
</plist>
PLIST_EOF

  # Idempotenza: plist identico E agent già caricato → no-op.
  if [ -f "$PLIST" ] && cmp -s "$tmp" "$PLIST" \
     && launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "auto-update periodico già attivo (ogni 10 min)."
    return 0
  fi

  mv -f "$tmp" "$PLIST"
  # bootout prima di ri-bootstrap: evita "service already loaded".
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    echo "auto-update periodico attivato (ogni 10 min)."
  elif launchctl load -w "$PLIST" 2>/dev/null; then
    # Fallback per macOS vecchi senza bootstrap.
    echo "auto-update periodico attivato (load legacy)."
  else
    echo "impossibile attivare l'auto-update periodico (launchctl fallito)." >&2
    return 1
  fi
}

case "${1:-}" in
  install) install_agent ;;
  remove)  remove_agent; echo "agent auto-update rimosso." ;;
  *) echo "Uso: $0 {install|remove}"; exit 2 ;;
esac
