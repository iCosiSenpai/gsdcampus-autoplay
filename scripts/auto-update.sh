#!/bin/zsh
#
# auto-update.sh — aggiornamento periodico UNATTENDED (lanciato da launchd, ~10 min).
#
# Flusso: fetch → (novità?) → se lo scheduler è in un quiz/setup lo rimando →
# stop scheduler se attivo → update codice + banca risposte → GATE dev-check → se
# il nuovo codice è rotto: rollback al commit precedente + issue automatica al
# maintainer + notifica → riavvio scheduler se era attivo. Niente sudo, niente
# interazione: ogni problema degrada con log + notifica, mai un prompt.
#
# Log: logs/auto-update.log (senza ANSI). Opt-out: "autoUpdate": false in config.json.
#
# NIENTE `set -e` globale: job unattended, la gestione errori è esplicita
# (un fallimento parziale non deve lasciare lo scheduler spento).
set -u -o pipefail

# ── 1. Anti-corruzione: ri-eseguiti da una COPIA fuori dal repo ─────────────
# git sta per sostituire QUESTO file mentre zsh lo sta ancora leggendo
# (zsh legge gli script in modo incrementale: il processo si corromperebbe).
# Alla prima invocazione ci copiamo in $TMPDIR e ci rilanciamo da lì.
if [ "${1:-}" != "--resumed" ]; then
  SELF_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  SELF_COPY="${TMPDIR:-/tmp}/gsd-auto-update.$$.zsh"
  cp "$0" "$SELF_COPY" || exit 1
  exec /bin/zsh "$SELF_COPY" --resumed "$SELF_DIR"
fi

DIR="${2:?dir progetto mancante}"
cd "$DIR" || exit 1
# La copia di se stesso si ripulisce in uscita (insieme al lock, v. sotto).
SELF_COPY="$0"

source "$DIR/scripts/lib/ui.sh"
source "$DIR/scripts/lib/pid-utils.sh"
source "$DIR/scripts/lib/notify.sh"
source "$DIR/scripts/lib/update-repo.sh"

# phase_is_busy: exit 0 se status.json (fresco, <5 min) segnala una fase da NON
# interrompere — un quiz o il setup di un corso. Fasi interrompibili (exit 1):
# video (la piattaforma salva la posizione), attese, off_hours, ecc. Stato vecchio
# = non ci fidiamo (scheduler forse morto) → non blocca (exit 1).
phase_is_busy() {
  node -e '
    const fs = require("fs");
    try {
      const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const fresh = s.lastUpdate && (Date.now() - Date.parse(s.lastUpdate) < 5 * 60 * 1000);
      const busy = ["quiz_dashboard", "quiz_needs_answers", "checking"].includes(s.phase);
      process.exit(fresh && busy ? 0 : 1);
    } catch (_) { process.exit(1); }
  ' "$DIR/logs/status.json" 2>/dev/null
}

LOG="$DIR/logs/auto-update.log"
mkdir -p "$DIR/logs"
alog() { log_plain "$LOG" "$1"; }

# Rotazione log (>512KB → tieni l'ultima metà).
if [ -f "$LOG" ] && [ "$(stat -f%z "$LOG" 2>/dev/null || echo 0)" -gt 524288 ]; then
  tail -c 262144 "$LOG" > "$LOG.tmp" 2>/dev/null && mv -f "$LOG.tmp" "$LOG"
fi

# ── 2. Opt-out ───────────────────────────────────────────────────────────────
AU_ENABLED=$(node -e "try{const c=require('$DIR/config.json');process.stdout.write(c.autoUpdate===false?'no':'yes')}catch(e){process.stdout.write('yes')}" 2>/dev/null || echo "yes")
if [ "$AU_ENABLED" = "no" ]; then
  exit 0
fi

# ── 3. Lock anti-doppia-esecuzione (noclobber, con recovery lock stale) ─────
LOCK="$DIR/logs/.autoupdate_lock"
if [ -f "$LOCK" ]; then
  OLD_LOCK_PID=$(cat "$LOCK" 2>/dev/null || echo "")
  if pid_matches "$OLD_LOCK_PID" "auto-update"; then
    alog "Altro auto-update in corso (PID $OLD_LOCK_PID): esco."
    exit 0
  fi
  rm -f "$LOCK"
fi
if ! (set -o noclobber; echo "$$" > "$LOCK") 2>/dev/null; then
  alog "Lock non acquisito: esco."
  exit 0
fi
trap 'rm -f "$LOCK" "$SELF_COPY" 2>/dev/null' EXIT

# ── 4. Rete + c'è qualcosa di nuovo? ────────────────────────────────────────
if ! curl -m 5 -fsS -o /dev/null https://raw.githubusercontent.com 2>/dev/null; then
  # Niente rete: esci in silenzio (niente log-spam a ogni giro offline).
  exit 0
fi
git fetch --quiet origin main 2>/dev/null || exit 0
OLD=$(git rev-parse HEAD 2>/dev/null || echo "")
NEW=$(git rev-parse origin/main 2>/dev/null || echo "")
if [ -z "$OLD" ] || [ -z "$NEW" ] || [ "$OLD" = "$NEW" ]; then
  rm -f "$DIR/logs/.update_available" 2>/dev/null || true
  exit 0   # già aggiornati: zero rumore.
fi
alog "Aggiornamento disponibile: ${OLD:0:7} → ${NEW:0:7}"

# ── 4b. Non interrompere un quiz / operazione critica ───────────────────────
# Un update non è urgente: se lo scheduler è vivo ed è in una fase delicata
# (quiz o setup corso), rimando al prossimo giro (~10 min). Un video invece si
# può interrompere: la piattaforma salva la posizione e si riprende dal punto.
if autoplay_instance_alive "$DIR" && phase_is_busy; then
  alog "Update rimandato: scheduler in fase delicata (quiz/setup corso). Riprovo al prossimo giro."
  exit 0
fi

# ── 5. Ferma lo scheduler se attivo (i suoi .sh stanno per cambiare) ────────
WAS_RUNNING=false
if autoplay_instance_alive "$DIR"; then
  WAS_RUNNING=true
  alog "Scheduler attivo: lo fermo per l'aggiornamento."
  "$DIR/stop.sh" >> "$LOG" 2>&1 || true
fi

restart_if_needed() {
  if [ "$WAS_RUNNING" = true ]; then
    # Modalità NORMALE (un eventuale --ignore-hours precedente NON viene
    # ripristinato: scelta deliberata, la modalità autonoma è quella giusta
    # per un riavvio non presidiato).
    alog "Riavvio lo scheduler (modalità normale)."
    "$DIR/start.sh" >> "$LOG" 2>&1 || alog "ATTENZIONE: riavvio scheduler fallito (serve il comando curl)."
    # stop.sh (chiamato sopra) ha sospeso/rimosso il keepalive: lo riattivo, così
    # lo scheduler resta protetto h24 anche dopo un aggiornamento periodico.
    rm -f "$DIR/.keepalive_disabled" 2>/dev/null || true
    "$DIR/scripts/lib/install-scheduler-agent.sh" install >> "$LOG" 2>&1 || true
  fi
}

# ── 6. Aggiorna codice + banca risposte ─────────────────────────────────────
update_repo main >> "$LOG" 2>&1 || { alog "Update non riuscito: resto su ${OLD:0:7}."; restart_if_needed; exit 0; }
"$DIR/scripts/update-known-answers.sh" >> "$LOG" 2>&1 || true

# ── 7. GATE: il nuovo codice deve passare dev-check, altrimenti ROLLBACK ────
if ! "$DIR/scripts/dev-check.sh" >> "$LOG" 2>&1; then
  alog "dev-check FALLITO su ${NEW:0:7}: ROLLBACK a ${OLD:0:7}."
  git reset --hard "$OLD" >> "$LOG" 2>&1 || alog "ATTENZIONE: rollback fallito!"
  # Issue automatica al maintainer (una sola per versione rotta: marker anti-
  # duplicato — a ogni giro l'update ritenta finché il maintainer non pusha il fix).
  RB_MARKER="$DIR/logs/.rollback_${NEW:0:12}"
  if [ ! -f "$RB_MARKER" ]; then
    touch "$RB_MARKER" 2>/dev/null || true
    node "$DIR/scripts/lib/issue-report.js" draft "auto_update_rollback" "dev-check KO su ${NEW:0:7}, rollback automatico a ${OLD:0:7}" >> "$LOG" 2>&1 \
      && node "$DIR/scripts/lib/issue-report.js" send >> "$LOG" 2>&1 \
      || alog "Invio issue di rollback non riuscito (receiver non configurato?)."
  fi
  notify_user "GSD Campus" "Aggiornamento annullato: la nuova versione era difettosa. Segnalato al responsabile, tutto continua a funzionare." auto_update_rollback || true
  restart_if_needed
  exit 0
fi

# ── 8. Dipendenze: MAI sudo unattended — se servono, delega al collega ──────
if [ -x "$DIR/scripts/check-requirements.sh" ] && ! "$DIR/scripts/check-requirements.sh" --runtime >> "$LOG" 2>&1; then
  alog "Aggiornamento codice OK ma servono dipendenze nuove: serve il comando curl (interattivo)."
  notify_user "GSD Campus" "Aggiornamento quasi completo: apri il Terminale e rilancia il comando di installazione per finire." auto_update_deps || true
  # Non riavviare: senza dipendenze start.sh fallirebbe comunque.
  exit 0
fi

rm -f "$DIR/logs/.update_available" 2>/dev/null || true
alog "Aggiornato con successo a ${NEW:0:7}."
restart_if_needed
exit 0
