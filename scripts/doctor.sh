#!/bin/zsh
#
# doctor.sh — checkup del sistema a semaforo, pensato per colleghi non tecnici.
#
# Esegue in ~5 secondi i controlli che spiegano il 90% dei "non funziona":
# rete, GitHub, piattaforma GSD, Ollama+Claude on-demand, spazio disco, requisiti,
# configurazione. Ogni problema ha il suo rimedio scritto sotto.
#
# Uso:
#   ./scripts/doctor.sh          # check veloci
#   ./scripts/doctor.sh --full   # + sonda LIVE del link autologin (~30s, fino a 5 min)
#
# Exit: 0 = nessun problema critico (gli ⚠ non bloccano), 1 = almeno un ✗.
#
# NIENTE `set -e`: è uno script diagnostico, deve eseguire TUTTI i check anche
# quando i primi falliscono (stessa filosofia di check-requirements.sh).

DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

source "$DIR/scripts/lib/ui.sh"

FULL=false
for arg in "$@"; do
  case "$arg" in
    --full) FULL=true ;;
  esac
done

CRIT=0
WARN=0

# chk_ok/chk_warn/chk_err "etichetta" ["rimedio"]
chk_ok()   { ok "$1"; }
chk_warn() {
  warn "$1"
  [ -n "${2:-}" ] && echo -e "   ${DIM}→ $2${NC}"
  WARN=$((WARN + 1))
}
chk_err()  {
  err "$1"
  [ -n "${2:-}" ] && echo -e "   ${DIM}→ $2${NC}"
  CRIT=$((CRIT + 1))
}

ui_header "Checkup sistema" "$([ "$FULL" = true ] && echo 'completo (con sonda link)' || echo 'controlli rapidi')"
echo ""

# 1. Internet (captive.apple.com: endpoint di test ufficiale macOS, sempre su).
if curl -m 5 -fsS -o /dev/null https://captive.apple.com 2>/dev/null; then
  chk_ok "Connessione internet"
else
  chk_err "Connessione internet assente" "controlla Wi-Fi/cavo di rete e riprova"
fi

# 2. GitHub raw (da qui arrivano aggiornamenti e banca risposte).
if curl -m 5 -fsS -o /dev/null "https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh" 2>/dev/null; then
  chk_ok "GitHub raggiungibile (aggiornamenti)"
else
  chk_err "GitHub non raggiungibile" "rete aziendale/firewall? Riprova tra qualche minuto"
fi

# 3. Piattaforma GSD Campus: qualunque codice HTTP ≠ 000 = server raggiungibile
# (anche un 403/redirect va bene: qui testiamo la RETE, non il login).
HTTP_CODE=$(curl -m 5 -s -o /dev/null -w '%{http_code}' https://tecsial.gsdcampus.it 2>/dev/null || echo 000)
if [ "$HTTP_CODE" != "000" ]; then
  chk_ok "Piattaforma GSD Campus raggiungibile"
else
  chk_err "Piattaforma GSD Campus non raggiungibile" "il sito del corso è giù o la rete lo blocca; riprova più tardi"
fi

# 4. AI on-demand: il doctor verifica presenza e stato della porta senza
# eseguire le CLI. Versione, login e modello vengono controllati dal batch solo
# dopo il gate openQuizRequests > 0.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v ollama >/dev/null 2>&1; then
  chk_warn "Ollama CLI assente" "verra installata automaticamente quando compare un quiz aperto"
elif curl -fsS "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
  chk_ok "Ollama installato; daemon gia attivo"
else
  chk_ok "Ollama installato; daemon correttamente spento"
fi
if command -v claude >/dev/null 2>&1; then
  chk_ok "Claude Code installato (non avviato dal checkup)"
else
  chk_warn "Claude Code assente" "verra installato automaticamente quando compare un quiz aperto"
fi
if node "$DIR/scripts/lib/ai-budget-cli.js" --json >/dev/null 2>&1; then
  chk_ok "Budget AI locale leggibile (nessun prompt salvato)"
else
  chk_warn "Budget AI locale non inizializzato" "verra creato alla prima chiamata"
fi

# 5. Spazio disco nella home (GB liberi).
FREE_GB=$(df -g "$HOME" 2>/dev/null | awk 'NR==2{print $4}')
if [ -n "$FREE_GB" ] && [ "$FREE_GB" -lt 5 ] 2>/dev/null; then
  chk_warn "Spazio disco basso: ${FREE_GB} GB liberi (consigliati ≥5)" "svuota il Cestino o libera spazio"
else
  chk_ok "Spazio disco: ${FREE_GB:-?} GB liberi"
fi

# 6. Requisiti runtime installati. Le CLI AI non vengono eseguite dal doctor:
# il batch le verifica soltanto con domande aperte.
if [ -x "$DIR/scripts/check-requirements.sh" ] && "$DIR/scripts/check-requirements.sh" --runtime >/dev/null 2>&1; then
  chk_ok "Programmi necessari installati"
else
  chk_err "Programmi necessari mancanti o da aggiornare" "rilancia il comando curl e scegli 'Aggiorna e avvia'"
fi

# 7. Configurazione (config.json presente e leggibile dagli helper orari).
if [ -f "$DIR/config.json" ] && node "$DIR/scripts/lib/schedule-cli.js" is-work-time >/dev/null 2>&1; then
  chk_ok "Configurazione account e orari valida"
else
  chk_err "Configurazione mancante o non valida" "rilancia il comando curl (fa partire il setup guidato)"
fi

# 8. Probe selettori DOM (fixture offline): avvisa se il layout atteso dalla
# piattaforma non matcha più i marker critici (quiz form, link corsi, …).
if node "$DIR/scripts/lib/selector-probe.js" >/dev/null 2>&1; then
  chk_ok "Selettori pagina corso (fixture) allineati"
else
  chk_err "Selettori pagina corso non allineati alle fixture" \
    "la piattaforma potrebbe aver cambiato layout — rilancia il curl per aggiornare, o chiedi all'AI di aprire un'issue"
fi

# 9. Integrità banca trusted/public (offline, nessuna risposta modificata).
if node "$DIR/scripts/lib/answers-cli.js" verify >/dev/null 2>&1; then
  chk_ok "Banca risposte integra (nessun conflitto)"
else
  chk_err "Banca risposte con conflitti o dati non validi" \
    "esegui: node scripts/lib/answers-cli.js audit"
fi

# 10. (--full) Corrispondenza banca pubblica locale ↔ main.
if [ "$FULL" = true ]; then
  if node "$DIR/scripts/lib/answers-cli.js" verify --remote >/dev/null 2>&1; then
    chk_ok "Banca pubblica locale allineata a main"
  else
    chk_err "Banca pubblica locale non allineata a main" \
      "rilancia il comando curl per aggiornare e riprova"
  fi
fi

# 11. (--full) Sonda LIVE del link autologin: apre un browser headless.
if [ "$FULL" = true ]; then
  info "Sonda LIVE del link autologin in corso ${DIM}(~30s, fino a 5 min se il link è morto)${NC}..."
  if node "$DIR/scripts/lib/healthcheck-cli.js" >/dev/null 2>&1; then
    chk_ok "Link autologin VALIDO (verificato adesso)"
  else
    chk_err "Link autologin NON valido" "serve il link/CSV aggiornato dal referente, poi rilancia il curl"
  fi
fi

# Riga finale a semaforo.
NCHECKS=9
[ "$FULL" = true ] && NCHECKS=11
TOTAL_OK=$((NCHECKS - CRIT - WARN))
[ "$TOTAL_OK" -lt 0 ] && TOTAL_OK=0
echo ""
ui_hr
SUMMARY="${GREEN}${TOTAL_OK} ${UI_OK}${NC} ${DIM}·${NC} ${YELLOW}${WARN} ${UI_WARN}${NC} ${DIM}·${NC} ${RED}${CRIT} ${UI_ERR}${NC}"
if [ "$CRIT" -eq 0 ]; then
  echo -e " ${SUMMARY}   ${GREEN}${BOLD}Tutto in ordine.${NC}"
else
  echo -e " ${SUMMARY}   ${RED}${BOLD}${CRIT} problema/i da risolvere (rimedi qui sopra).${NC}"
fi
ui_hr

[ "$CRIT" -eq 0 ]
