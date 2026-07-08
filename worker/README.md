# Receiver delle issue (Cloudflare Worker)

Questo Worker riceve le segnalazioni di bug che l'AI supervisore dei colleghi
non riesce a risolvere in loco e le trasforma in **issue GitHub** sulla repo del
maintainer (`iCosiSenpai/gsdcampus-autoplay`).

Perché serve: per rendere la segnalazione **attiva per tutti** gli utenti che
installano via curl — senza che il maintainer distribuisca un token a ciascuno —
il PAT GitHub dovrebbe stare nel pacchetto pubblico. Ma GitHub **blocca il push**
di un PAT in una repo pubblica (push protection) e **lo auto-revoca** in pochi
minuti (secret scanning). Quindi il PAT resta **segreto lato Worker**
(`ISSUE_TOKEN`); il pacchetto pubblico contiene solo l'**endpoint URL** + una
**chiave non-segreta**. L'AI dei colleghi fa HTTP POST del draft già redatto →
il Worker apre l'issue. Nessun token sui Mac dei colleghi, nessun account GitHub.

## Deploy (una volta, ~10 min, gratuito)

Prerequisiti: Node.js + npm. Poi:

```bash
# 1. Wrangler (CLI di Cloudflare). Puoi usare npx invece di installarlo globalmente.
npm install -g wrangler        # oppure:  npx wrangler ...

# 2. Login Cloudflare (una volta, apre il browser). Serve un account Cloudflare
#    gratuito (non serve carta di credito per il Workers free tier).
wrangler login

# 3. Deploya il Worker da questa cartella.
cd worker
wrangler deploy
#    → stampa l'URL del Worker, es:
#      https://gsd-issue-report.<tuo-account>.workers.dev

# 4. Imposta il PAT GitHub come SECRET (mai nel repo).
wrangler secret put ISSUE_TOKEN
#    → incolla il fine-grained PAT (scope Issues: Read and write, solo la repo
#      iCosiSenpai/gsdcampus-autoplay). Viene conservato come secret Cloudflare.
```

## Attiva la segnalazione per tutti i colleghi

Dopo il deploy, l'URL del Worker va **committato** nel pacchetto pubblico così
ogni collega lo ha di default:

1. Copia l'URL stampato da `wrangler deploy` (es. `https://gsd-issue-report.<account>.workers.dev`).
2. Incollalo in `DEFAULT_ISSUE_ENDPOINT` in `scripts/lib/issue-report.js`
   (sostituisci la stringa vuota `''`).
3. Verifica che `DEFAULT_ISSUE_KEY` in `issue-report.js` corrisponda a `KEY` in
   `wrangler.toml` (il default già allineato: `gsd-autoplay-report-key-2026-7f3a9c`).
4. Commit + push su `main`. Da quel momento la segnalazione è attiva per tutti.

## Test

```bash
cd ~/gsdcampus-autoplay
node scripts/lib/issue-report.js draft "test_receiver"
# controlla il draft (nessun CF / autologin URL / token), poi:
node scripts/lib/issue-report.js send
# → "Issue creata: https://github.com/iCosiSenpai/gsdcampus-autoplay/issues/<n>"
```

Chiudi subito l'issue di test. Se il `send` refusa con "github_token" → il PAT
del Worker non è valido o senza scope `issues:write`: ruotalo con
`wrangler secret put ISSUE_TOKEN`. Se refusa con "bad_key" → `KEY` nel Worker e
`DEFAULT_ISSUE_KEY` nel modulo non coincidono.

## (Opzionale) Label `auto-report`

Il Worker cerca di mettere la label `auto-report`; se non esiste (GitHub 422)
ritenta senza label. Per crearla (così le issue sono etichettate e filtrabili):
GitHub → repo → Issues → Labels → New label `auto-report` (colore a piacere).

## (Opzionale) Rate limiting anti-spam

Endpoint e chiave sono pubblici: chiunque legga la repo può POSTare. Il volume è
basso (l'AI chiede conferma umana prima di spedire), ma per blindare lo spam:
Cloudflare dashboard → Security → WAF → Rate limiting rules → una regola sulla
route `gsd-issue-report.*.workers.dev` / `*` con soglia es. 5 req/minuto per IP
→ action "Block".

## Rotazione

- **PAT compromesso/scaduto**: `wrangler secret put ISSUE_TOKEN` (rimpiazza).
- **Chiave**: cambia `KEY` in `wrangler.toml` + `DEFAULT_ISSUE_KEY` in
  `issue-report.js`, poi `wrangler deploy` + commit + push.

## Cos'è pubblico e cos'è segreto

| Item | Dove | Pubblico? |
|---|---|---|
| Codice Worker (`issue-receiver.js`, `wrangler.toml`) | repo `worker/` | sì |
| Endpoint URL del Worker | `issue-report.js` `DEFAULT_ISSUE_ENDPOINT` | sì |
| `KEY` (chiave non-segreta) | `wrangler.toml` + `issue-report.js` | sì |
| `ISSUE_TOKEN` (PAT GitHub) | Cloudflare secret (`wrangler secret`) | **NO** |