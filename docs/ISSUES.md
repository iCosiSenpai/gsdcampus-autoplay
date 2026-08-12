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
- `need_help` (`scheduler.sh`, exit 2) — corsi bloccati che né la banca né l'AI hanno sbloccato. Escluse le fasi `awaiting_ai` e `complete`, che non sono problemi.
- `post_login_blocked` (`scheduler.sh`, exit 4) — dashboard vuota dopo il login: interstitial non gestito che blocca tutti i Mac. **Non** viene segnalato `session_unstable`, che condivide l'exit 4 ma è solo rate-limiting con token valido e si risolve da solo col cooldown.
- `autologin_invalid` (`scheduler.sh`, exit 3) — segnalato **solo se la sonda live conferma** che il link non autentica più. Senza questo gate la repo si riempirebbe di segnalazioni per link validi, perché la fase viene scritta anche da un calo di sessione transitorio.

Gli errori che avvengono **dentro** `src/autoplay.js` non si segnalano da soli: l'aggancio è nello scheduler, che osserva già l'exit code di ogni run e la fase scritta in `logs/status.json`. Un punto solo invece di sei sparsi nei catch dell'autoplay.

### Da quale Mac arriva la segnalazione

Il titolo porta un'etichetta store: `[auto-report] [mac-db8759] post_login_blocked: ...`.

È `config.storeTag` se configurato (etichetta leggibile, es. `StoreRoma1`), altrimenti un **ID opaco** `mac-<6 hex>` derivato da `sha256(CF)`. Non usiamo hostname o username del Mac perché la repo è **pubblica** e quelli sono dati personali (`RE_HOME` li redae apposta). L'hash è a senso unico: pubblicamente non identifica nessuno, il maintainer lo risolve in locale perché ha `members.db`:

```bash
node scripts/lib/members-cli.js whois mac-db8759
# → mac-db8759 → COSI ALESSIO (CF: CSOLSS95L23D862R)
```

### Qualità del contesto

La coda del log nel body **comprime le righe di avanzamento video** (`Video: 5:30 / 18:57`, una ogni 30s) in un riepilogo `… N righe omesse`. Senza questo, le 40 righe di coda erano tutte contatori e l'errore che ha causato la segnalazione restava fuori dalla finestra — obbligando comunque ad andare a leggere il log sul Mac del collega.

### Auto-fix con Kiro

`.github/workflows/kiro-triage.yml` aggiunge la label `kiro` alle auto-report la cui fase è un difetto **del repo** (`post_login_blocked`, `preflight_failed`, `crash_loop`, `auto_update_rollback`). Le fasi di credenziali/dati (`autologin_invalid`, `need_help`, `scheduler_start_failed`) restano al maintainer: nessuna patch le risolve, e girarle a Kiro produrrebbe solo PR inutili.

Kiro **non** richiede una GitHub Action: è una GitHub App da installare una volta su app.kiro.dev (Settings → Agent → Connect GitHub). Il workflow serve solo a decidere quali issue etichettare.

Meccanismo: `scripts/lib/report-issue.sh` → `report_blocking_issue <root> <klass> <reason>` usa il comando atomico `issue-report.js auto` (redazione PII, gate `reportIssues:false`) e lo stesso receiver Worker. Ogni osservazione viene salvata prima dell'invio in un'entry immutabile dell'outbox per-account; un lock serializza merge e consegna senza perdere eventi concorrenti. La **deduplica** usa una fingerprint opaca e account-scoped, conservata nel ledger locale e nel marker dell'issue GitHub. Gli invii falliti restano in coda e `flush` drena in modo bounded tutte le outbox della fleet al prossimo avvio. Best-effort: un problema del canale issue non blocca l'automazione.

Perché **senza conferma**: sono problemi che *bloccano*, quindi potrebbe non esserci nessuno a confermare; sono rari e azionabili → la notifica push è appropriata. La diagnostica di routine (versione, errori non bloccanti) resta invece sul canale **silenzioso** `/diag` (log del Worker), senza aprire issue.
