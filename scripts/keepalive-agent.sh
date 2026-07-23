#!/bin/zsh
#
# keepalive-agent.sh — watchdog lanciato dal LaunchAgent
# com.gsdcampus.autoplay.keepalive (RunAtLoad + KeepAlive). Gira h24 nella
# sessione di launchd (NON legato al Terminale), quindi:
#   - sopravvive alla chiusura della finestra del Terminale e a Cmd+Q;
#   - dopo un riavvio del Mac riparte da solo (RunAtLoad);
#   - se lo scheduler muore (crash, orfano), lo fa ripartire.
#
# NON riscrive il percorso di avvio: si limita a chiamare ./start.sh (lo stesso
# comando di sempre) quando lo scheduler non risulta vivo. Lo scheduler continua
# a rispettare gli orari internamente: il watchdog garantisce solo la presenza
# del processo, non decide gli orari. Se il watchdog fallisce, il comportamento
# degrada a quello attuale (serve il comando curl), MAI peggio.
#
# Sospensione: stop.sh crea .keepalive_disabled per non far resuscitare lo
# scheduler durante/dopo uno stop esplicito; il launcher lo rimuove al riavvio.
set -u

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
unset FORCE_COLOR
export NO_COLOR=1

source "$DIR/scripts/lib/pid-utils.sh"

INTERVAL="${GSD_KEEPALIVE_INTERVAL:-120}"   # secondi tra un controllo e l'altro
DISABLE_FLAG="$DIR/.keepalive_disabled"
LOG="$DIR/logs/keepalive.log"
mkdir -p "$DIR/logs"

klog() { printf '%s | %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$1" >> "$LOG" 2>/dev/null || true; }

# Rotazione log leggera (>256KB → tieni la seconda metà).
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 262144 ]; then
  tail -c 131072 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
fi

klog "keepalive-agent avviato (intervallo ${INTERVAL}s)."
while true; do
  if [ -f "$DISABLE_FLAG" ]; then
    sleep "$INTERVAL"
    continue
  fi
  if ! autoplay_instance_alive "$DIR"; then
    # Ricontrolla il flag subito prima di agire: evita di resuscitare lo
    # scheduler mentre uno stop è in corso (race tra questo giro e stop.sh).
    if [ ! -f "$DISABLE_FLAG" ]; then
      klog "Scheduler non attivo: eseguo ./start.sh per riavviarlo."
      "$DIR/start.sh" >> "$LOG" 2>&1 || klog "start.sh ha restituito errore; riprovo al prossimo giro."
    fi
  fi
  sleep "$INTERVAL"
done
