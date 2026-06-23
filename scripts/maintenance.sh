#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

LOG_DIR="$DIR/logs"
DEBUG_DIR="$DIR/debug"
BACKUP_DIR="$DIR/backups"

# Ruota log troppo grandi (> 10 MB)
rotate() {
  local file="$1"
  local max_size=$((10 * 1024 * 1024)) # 10 MB
  if [ -f "$file" ] && [ "$(stat -f%z "$file" 2>/dev/null || echo 0)" -gt "$max_size" ]; then
    mv "$file" "$file.old"
    echo "$(date '+%Y-%m-%d %H:%M:%S') | Log ruotato" > "$file"
  fi
}

# Pulizia screenshot e dump più vecchi di 7 giorni
cleanup_debug() {
  find "$DEBUG_DIR/screenshots" -name '*.png' -mtime +7 -type f -delete 2>/dev/null || true
  find "$DEBUG_DIR/dumps" -name '*.html' -mtime +7 -type f -delete 2>/dev/null || true
}

mkdir -p "$LOG_DIR" "$DEBUG_DIR/screenshots" "$DEBUG_DIR/dumps" "$BACKUP_DIR"

rotate "$LOG_DIR/autoplay.log"
rotate "$LOG_DIR/supervisor.log"
rotate "$LOG_DIR/ollama.log"
rotate "$LOG_DIR/error.log"

cleanup_debug

echo "Manutenzione completata."
