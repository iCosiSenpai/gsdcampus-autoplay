#!/bin/zsh
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

# Colori
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}${BOLD}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}${BOLD}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}${BOLD}[ATTENZIONE]${NC} $1"; }
err() { echo -e "${RED}${BOLD}[ERRORE]${NC} $1"; }
step() { echo -e "${BOLD}[PASSO $1]${NC} $2"; }

OUTPUT_DIR="$HOME/Desktop/gsdcampus-autoplay-pkg"
ZIP_FILE="$HOME/Desktop/gsdcampus-autoplay.zip"

AUTO_YES=false
AUTO_ZIP=false
if [ "$1" = "--yes" ]; then
  AUTO_YES=true
fi
if [ "$2" = "--zip" ]; then
  AUTO_ZIP=true
fi

echo ""
echo "============================================"
echo -e "${BOLD}  Preparazione pacchetto per nuovo utente${NC}"
echo "============================================"
echo ""
info "Destinazione: $OUTPUT_DIR"
if [ "$AUTO_ZIP" = true ]; then
  info "Verrà creato anche: $ZIP_FILE"
fi
info "Verranno rimossi: dati personali, log, debug, pid, node_modules, .git"
info "Verrà creato un config.json pulito con autologin fittizio."
echo ""

if [ "$AUTO_YES" = false ]; then
  read -q "REPLY?Procedere? [y/N] "
  echo ""
  if [[ ! "$REPLY" =~ ^[Yy]$ ]]; then
    info "Uscita su richiesta dell'utente."
    exit 1
  fi
fi

step "1/6" "Pulizia pacchetto precedente"
rm -rf "$OUTPUT_DIR"
rm -f "$ZIP_FILE"
ok "Pulizia completata."

step "2/6" "Copia file sorgente"
mkdir -p "$OUTPUT_DIR"
cp -R "$DIR/src" "$OUTPUT_DIR/"
cp -R "$DIR/scripts" "$OUTPUT_DIR/"
cp -R "$DIR/data" "$OUTPUT_DIR/"
cp -R "$DIR/debug" "$OUTPUT_DIR/" 2>/dev/null || true
cp -R "$DIR/logs" "$OUTPUT_DIR/" 2>/dev/null || true

cp "$DIR/launch-ai-supervisor.sh" "$OUTPUT_DIR/"
cp "$DIR/start.sh" "$OUTPUT_DIR/"
cp "$DIR/stop.sh" "$OUTPUT_DIR/"
cp "$DIR/status.sh" "$OUTPUT_DIR/"
cp "$DIR/CLAUDE.md" "$OUTPUT_DIR/"
cp "$DIR/README.md" "$OUTPUT_DIR/"
cp "$DIR/README-COLLEGHI.md" "$OUTPUT_DIR/"
cp "$DIR/package.json" "$OUTPUT_DIR/"
cp "$DIR/package-lock.json" "$OUTPUT_DIR/"
cp "$DIR/config.json.example" "$OUTPUT_DIR/"
cp "$DIR/.gitignore" "$OUTPUT_DIR/"
ok "Copia completata."

step "3/6" "Rimozione dati personali"
rm -f "$OUTPUT_DIR/data/session_state.json"
rm -f "$OUTPUT_DIR/data/storage_state.json"
rm -f "$OUTPUT_DIR/data/need_answer.json"
rm -f "$OUTPUT_DIR/data/pending_quiz_answers.json"
rm -f "$OUTPUT_DIR/data/summary_dump.json" 2>/dev/null || true
rm -f "$OUTPUT_DIR/data/extracted_full.json" 2>/dev/null || true
rm -f "$OUTPUT_DIR/data/quiz-domande.txt" 2>/dev/null || true
ok "Dati personali rimossi."

step "4/6" "Pulizia log, debug e temporanei"
find "$OUTPUT_DIR/logs" -type f -delete 2>/dev/null || true
find "$OUTPUT_DIR/debug/screenshots" -type f -delete 2>/dev/null || true
find "$OUTPUT_DIR/debug/dumps" -type f -delete 2>/dev/null || true
rm -rf "$OUTPUT_DIR/scripts/logs"
rm -f "$OUTPUT_DIR/.autoplay_pid"
rm -f "$OUTPUT_DIR/.ollama_pid"
rm -f "$OUTPUT_DIR/.scheduler_stop"
rm -f "$OUTPUT_DIR/.supervisor_prompt.txt"
rm -rf "$OUTPUT_DIR/.claude" 2>/dev/null || true
rm -rf "$OUTPUT_DIR/.git" 2>/dev/null || true
ok "Pulizia completata."

step "5/6" "Creazione config.json pulito e directory vuote"
cp "$OUTPUT_DIR/config.json.example" "$OUTPUT_DIR/config.json"
mkdir -p "$OUTPUT_DIR/logs"
mkdir -p "$OUTPUT_DIR/debug/screenshots"
mkdir -p "$OUTPUT_DIR/debug/dumps"
ok "Config pulito pronto."

SHOULD_ZIP=false
if [ "$AUTO_ZIP" = true ]; then
  SHOULD_ZIP=true
elif [ "$AUTO_YES" = false ]; then
  echo ""
  read -q "REPLY?Creare anche lo zip? [y/N] "
  echo ""
  if [[ "$REPLY" =~ ^[Yy]$ ]]; then
    SHOULD_ZIP=true
  fi
fi

if [ "$SHOULD_ZIP" = true ]; then
  step "6/6" "Creazione archivio zip"
  cd "$(dirname "$OUTPUT_DIR")"
  zip -r "$(basename "$ZIP_FILE")" "$(basename "$OUTPUT_DIR")" -x "*.DS_Store"
  ok "Zip creato in: $ZIP_FILE"
else
  step "6/6" "Archivio zip saltato"
fi

echo ""
echo "============================================"
echo -e "${GREEN}${BOLD}  Pacchetto pronto${NC}"
echo "============================================"
echo ""
info "Percorso: $OUTPUT_DIR"
if [ "$SHOULD_ZIP" = true ]; then
  info "Zip:      $ZIP_FILE"
fi
echo ""
info "Al primo avvio l'AI chiederà conferma del link autologin e degli orari."
