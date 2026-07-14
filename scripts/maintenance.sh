#!/bin/zsh
set -eu -o pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

LOG_DIR="$DIR/logs"
DEBUG_DIR="$DIR/debug"
BACKUP_DIR="$DIR/backups"

# Ruota log troppo grandi (> 10 MB). Usa cp + truncate-in-place invece di
# mv + ricrea: con mv c'è un istante in cui il file NON esiste e un logger
# concorrente (appendFileSync) creerebbe un file nuovo che l'`echo` successivo
# troncherebbe, perdendo righe. cp lascia il file originale al suo posto, poi
# `: >` tronca in place (atomico, senza mai scollegare l'inode): nessun gap.
rotate() {
  local file="$1"
  local max_size=$((10 * 1024 * 1024)) # 10 MB
  if [ -f "$file" ] && [ "$(stat -f%z "$file" 2>/dev/null || echo 0)" -gt "$max_size" ]; then
    cp "$file" "$file.old"
    : > "$file"
    echo "$(date '+%Y-%m-%d %H:%M:%S') | Log ruotato" >> "$file"
  fi
}

# Pulizia screenshot e dump più vecchi di 7 giorni
cleanup_debug() {
  find "$DEBUG_DIR/screenshots" -name '*.png' -mtime +7 -type f -delete 2>/dev/null || true
  find "$DEBUG_DIR/dumps" -name '*.html' -mtime +7 -type f -delete 2>/dev/null || true
}

# Pulizia log storici (prima crescevano all'infinito):
# - autoplay.out.*.old: creati da start.sh a ogni avvio (pota anche lì, ultimi 5);
# - autoplay.<timestamp>.log: ruotati da src/lib/logger.js a 5 MB;
# - *.log.old: copie create da rotate() qui sotto, mai cancellate prima.
# I pattern NON matchano i file correnti (autoplay.log, scheduler.log, ecc.).
cleanup_logs() {
  find "$LOG_DIR" -name 'autoplay.out.*.old' -mtime +7 -type f -delete 2>/dev/null || true
  find "$LOG_DIR" -name 'autoplay.*.log' -mtime +14 -type f -delete 2>/dev/null || true
  find "$LOG_DIR" -name '*.log.old' -mtime +14 -type f -delete 2>/dev/null || true
}

mkdir -p "$LOG_DIR" "$DEBUG_DIR/screenshots" "$DEBUG_DIR/dumps" "$BACKUP_DIR"

rotate "$LOG_DIR/autoplay.log"
rotate "$LOG_DIR/supervisor.log"
rotate "$LOG_DIR/ollama.log"
rotate "$LOG_DIR/error.log"
# scheduler.log riceve tee -a dallo scheduler ad ogni run: prima non era mai
# ruotato e cresceva senza limite. rotate() usa cp+truncate, sicuro con appender
# concorrenti (v. commento sopra).
rotate "$LOG_DIR/scheduler.log"

cleanup_debug
cleanup_logs

echo "Manutenzione completata."
