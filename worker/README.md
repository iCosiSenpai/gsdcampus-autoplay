# Receiver Cloudflare Worker (issue + banca risposte)

Questo Worker serve **due** canali, attivi per tutti i colleghi senza token GitHub
sul Mac:

| Route | Uso |
|-------|-----|
| `POST /` o `POST /report` | L'AI apre una **issue** GitHub (bug codice/infra) |
| `POST /answers` | L'AI **pubblica risposte quiz** verificate → commit su `data/known_answers_public.json` |

Perché serve: GitHub **blocca** i PAT in repo pubbliche (push protection + secret
scanning). Il PAT resta **segreto lato Worker** (`ISSUE_TOKEN`); il pacchetto
contiene solo endpoint URL + chiave non-segreta (`KEY`).

## Deploy (una volta, ~10 min, gratuito)

```bash
npm install -g wrangler   # oppure npx wrangler ...
wrangler login
cd worker
wrangler deploy
# → es. https://gsd-issue-report.<account>.workers.dev

wrangler secret put ISSUE_TOKEN
# → fine-grained PAT GitHub con SOLO sulla repo iCosiSenpai/gsdcampus-autoplay:
#      • Issues: Read and write
#      • Contents: Read and write   ← necessario per POST /answers
```

### Attiva per tutti

1. URL del deploy → `DEFAULT_ENDPOINT` in `scripts/lib/receiver-config.js`
2. `KEY` in `wrangler.toml` = `DEFAULT_KEY` in `receiver-config.js`
3. Commit + push su `main` + `wrangler deploy` dopo ogni cambio Worker

## Test issue

```bash
node scripts/lib/issue-report.js draft "test_receiver"
node scripts/lib/issue-report.js send
```

## Test answers (share senza git push)

```bash
# Dopo aver aggiunto risposte trusted (resolve) e allineato la public locale:
node scripts/lib/answers-cli.js share
# oppure l'AI lancia:
./scripts/publish-answers.sh

# Curl manuale:
curl -sS -X POST "$ENDPOINT/answers" \
  -H 'Content-Type: application/json' \
  -d '{"key":"gsd-autoplay-report-key-2026-7f3a9c","answers":{"Domanda di test share?":"Risposta di test"}}'
```

Esiti utili:
- `github_token` → PAT senza Contents:write (o Issues:write): ruota `ISSUE_TOKEN`
- `bad_key` → KEY non allineata
- `ok: true, added: 0` → voci già in banca (noop, corretto)
- `ok: true, added: N` → commit su `main`; i colleghi le prendono con "Aggiorna e avvia"

## Comportamento merge risposte

- **Solo additivo**: non sovrascrive mai una domanda già presente
- Max 50 entry/request, limiti lunghezza, scarta PII (CF/autologin/PAT)
- Retry su conflitto SHA (409) fino a 3 volte

## Rate limiting (consigliato)

Cloudflare → Security → WAF → Rate limiting su `gsd-issue-report.*.workers.dev`:
es. 10 req/min per IP su `/answers`, 5/min su `/report`.

## Rotazione

- **PAT**: `wrangler secret put ISSUE_TOKEN`
- **KEY**: cambia in `wrangler.toml` + `scripts/lib/receiver-config.js`, deploy + commit

## Cos'è pubblico / segreto

| Item | Dove | Pubblico? |
|------|------|-----------|
| Codice Worker | `worker/` | sì |
| Endpoint + KEY | `receiver-config.js` + `wrangler.toml` | sì |
| `ISSUE_TOKEN` | Cloudflare secret | **NO** |
