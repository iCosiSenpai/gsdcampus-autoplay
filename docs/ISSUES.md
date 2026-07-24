# Segnalazione problemi al maintainer

Quando l'AI **non riesce a risolvere in loco** un problema **codice/infra** — fasi `crash_loop`, `session_unstable`, `post_login_blocked`, `autologin_invalid` confermato dalla sonda live, `fatal`, o `need_help` non risolvibile con la banca + WebSearch — **NON modificare `src/`/`scripts/`** (vietato dal "Limiti"): **apri un'issue** sulla repo pubblica del maintainer (`iCosiSenpai/gsdcampus-autoplay`). L'issue la apri TU (AI supervisore), non l'autoplay.

**NON sono issue** (gestiti in loco come da flusso esistente): quiz risolvibili con WebSearch + banca trusted, `resetCourse`, restart, end-of-shift/off-hours. Solo i bug codice/infra non risolvibili in loco diventano issue.

**Attiva per tutti di default.** Il PAT GitHub **non** sta nel pacchetto pubblico (GitHub push-protection bloccherebbe il push e auto-revoca i PAT leakati): vive in un **receiver server-side** (Cloudflare Worker, vedi `worker/README.md`) come secret (`ISSUE_TOKEN`). Il pacchetto pubblico contiene solo l'endpoint URL + una chiave non-segreta (`DEFAULT_ISSUE_ENDPOINT` / `DEFAULT_ISSUE_KEY` in `scripts/lib/issue-report.js`, committate dal maintainer dopo il deploy del Worker). `send` fa HTTP POST del draft sanitizzato al receiver, che apre l'issue. **Nessun token sui Mac dei colleghi, nessun account GitHub richiesto.** Finché il maintainer non ha deployato il Worker e committato l'URL, `send` refusa graceful (non crasha).

**Flusso (sempre con conferma umana prima di spedire):**
1. `node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"]` → raccoglie contesto (`logs/status.json` + tail `logs/autoplay.log` + commit HEAD), **redae** CF / autologin URL / token / cookie / username, stampa il draft (title + body) e lo salva in `data/accounts/<CF>/.issue_draft.json`. Non spedice.
2. **Mostra il draft all'utente/collega e chiedi conferma esplicita** ("spedisco questa issue?"). Verifica che nel body NON ci siano CF, autologin URL, cookie o token (il modulo redae, ma tu controlla).
3. Su Sì → `node scripts/lib/issue-report.js send` → HTTP POST al receiver (o, fallback maintainer, `GH_TOKEN=<issueReporterToken> gh issue create --label auto-report`) e stampa l'URL.
4. Riporta l'URL all'utente.

**Gate**: `send` refusa (senza side-effect) se `config.json` ha `reportIssues: false` (disattivazione esplicita), o se non c'è nessun receiver (`issueEndpoint` / `DEFAULT_ISSUE_ENDPOINT` vuoto) né `issueReporterToken`. In quel caso avvisa l'utente. Se il receiver risponde `github_token` (PAT del Worker non valido/senza scope `issues:write`), avvisa che il maintainer deve ruotare `ISSUE_TOKEN` nel Worker (`wrangler secret put ISSUE_TOKEN`).

**Fallback maintainer (opzionale)**: sul proprio Mac il maintainer può mettere in `config.json` (gitignored) `issueReporterToken` = fine-grained PAT GitHub (scope **Issues: Read and write**, solo `iCosiSenpai/gsdcampus-autoplay`): se `issueEndpoint` non è configurato, `send` usa `GH_TOKEN=<token> gh issue create` (richiede `gh`, nessun `gh auth login`). Comodo se il receiver non è ancora deployato o è down. Per i colleghi non serve: usano il receiver.

**Strumento**: `node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"] | send`.

## Issue automatiche per problemi BLOCCANTI (senza conferma)

Oltre al flusso sopra (avviato dall'AI, con conferma umana), alcuni problemi **bloccanti** — che fermano il comando, il terminale o il lavoro — aprono un'issue **da soli**, così il maintainer riceve una notifica push senza dover leggere i log dal vivo:

- `crash_loop` (`scheduler.sh`) — l'automazione si è fermata per crash ripetuti.
- `preflight_failed` (`scheduler.sh`) — i selettori DOM non combaciano (serve un fix del codice).
- `scheduler_start_failed` (`launch-ai-supervisor.sh`) — il launcher non è riuscito ad avviare lo scheduler.

Meccanismo: `scripts/lib/report-issue.sh` → `report_blocking_issue <root> <klass> <reason>` riusa lo stesso `issue-report.js` (draft+send, redazione PII, gate `reportIssues:false`) e lo stesso receiver Worker. **Deduplica** per classe+versione (marker `logs/.issued_<klass>_<sha>`, gitignorato): una sola issue per problema finché non cambia la versione (nuovo deploy = nuovo tentativo). Best-effort, non blocca l'automazione.

Perché **senza conferma**: sono problemi che *bloccano*, quindi potrebbe non esserci nessuno a confermare; sono rari e azionabili → la notifica push è appropriata. La diagnostica di routine (versione, errori non bloccanti) resta invece sul canale **silenzioso** `/diag` (log del Worker), senza aprire issue.
