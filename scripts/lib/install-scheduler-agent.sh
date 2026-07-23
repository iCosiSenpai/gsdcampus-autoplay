#!/bin/zsh
#
# install-scheduler-agent.sh — installa/rimuove il LaunchAgent "keepalive" che
# tiene vivo lo scheduler autoplay h24 (RunAtLoad + KeepAlive) nella sessione di
# launchd. Sopravvive a chiusura finestra del Terminale, Cmd+Q e riavvio del
# Mac; se lo scheduler muore lo fa ripartire (via ./start.sh). Lo scheduler
# continua a rispettare gli orari configurati internamente.
#
# Uso:
#   ./scripts/lib/install-scheduler-agent.sh install   # idempotente (no-op se già ok)
#   ./scripts/lib/install-scheduler-agent.sh remove
#
# Opt-out: `"keepAlive": false` in config.json → `install` rimuove l'agent.
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/../.." && pwd)"
LABEL="com.gsdcampus.autoplay.keepalive"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

remove_agent() {
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
}

install_agent() {
  # Solo macOS: senza launchctl (es. CI Linux o altri OS) è un no-op sicuro.
  if ! command -v launchctl >/dev/null 2>&1; then
    echo "launchctl non disponibile: keepalive non installato (ok su non-macOS)."
    return 0
  fi

  # Opt-out esplicito: config.json { "keepAlive": false } → agent rimosso.
  local enabled
  enabled=$(node -e "try{const c=require('$DIR/config.json');process.stdout.write(c.keepAlive===false?'no':'yes')}catch(e){process.stdout.write('yes')}" 2>/dev/null || echo "yes")
  if [ "$enabled" = "no" ]; then
    remove_agent
    echo "keepalive disattivato da config.json (keepAlive: false): agent rimosso."
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
    <string>$DIR/scripts/keepalive-agent.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$DIR/logs/keepalive-launchd.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/keepalive-launchd.log</string>
</dict>
</plist>
PLIST_EOF

  # Idempotenza: plist identico E agent già caricato → no-op.
  if [ -f "$PLIST" ] && cmp -s "$tmp" "$PLIST" \
     && launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
    rm -f "$tmp"
    echo "keepalive scheduler già attivo."
    return 0
  fi

  mv -f "$tmp" "$PLIST"
  # bootout prima di ri-bootstrap: evita "service already loaded".
  launchctl bootout "gui/$UID_NUM" "$PLIST" 2>/dev/null || true
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    echo "keepalive scheduler attivato (h24, rispetta gli orari configurati)."
  elif launchctl load -w "$PLIST" 2>/dev/null; then
    # Fallback per macOS vecchi senza bootstrap.
    echo "keepalive scheduler attivato (load legacy)."
  else
    echo "impossibile attivare il keepalive scheduler (launchctl fallito)." >&2
    return 1
  fi
}

case "${1:-}" in
  install) install_agent ;;
  remove)  remove_agent; echo "agent keepalive rimosso." ;;
  *) echo "Uso: $0 {install|remove}"; exit 2 ;;
esac
