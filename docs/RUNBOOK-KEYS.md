# Runbook — rotazione KEY / PAT / receiver

## Componenti

| Nome | Dove | Segreto? |
|------|------|----------|
| `KEY` / `DEFAULT_KEY` | `worker/wrangler.toml` `[vars]`, `scripts/lib/receiver-config.js` | No (filtra bot) |
| `ISSUE_TOKEN` | Cloudflare Worker secret | **Sì** — PAT GitHub |
| `ANSWERS_TOKEN` | Worker secret (opz., default = ISSUE_TOKEN) | **Sì** |
| `issueReporterToken` | `config.json` locale (solo maintainer) | **Sì** — gitignored |

Scope PAT (fine-grained, solo `iCosiSenpai/gsdcampus-autoplay`):

- Issues: Read and write  
- Contents: Read and write  

## Rotare KEY (non-segreta)

1. Genera nuova stringa (es. `gsd-autoplay-report-key-YYYY-xxxx`).
2. Aggiorna `worker/wrangler.toml` → `[vars].KEY`.
3. Aggiorna `scripts/lib/receiver-config.js` → `DEFAULT_KEY`.
4. `cd worker && wrangler deploy`
5. Commit + push (i Mac dei colleghi prendono la KEY al prossimo aggiorna).

## Rotare ISSUE_TOKEN (se leak o scadenza)

1. GitHub → Settings → Developer settings → Fine-grained tokens → revoca il vecchio.
2. Crea nuovo PAT con scope Issues + Contents sulla sola repo.
3. `cd worker && wrangler secret put ISSUE_TOKEN` (incolla il nuovo).
4. Se usavi `ANSWERS_TOKEN` separato: `wrangler secret put ANSWERS_TOKEN`.
5. Smoke: `node scripts/lib/answers-cli.js share --all` (o draft issue di test).
6. **Non** committare il PAT. Se è finito in chat: revoca subito.

## Se `send` risponde `github_token`

Il Worker ha ricevuto 401/403 da GitHub: PAT scaduto/revocato o scope mancante.  
→ Ruota `ISSUE_TOKEN` come sopra.

## Rate limit Worker (8.5)

In-code (best-effort per isolate):

- `/answers` ≤ 10/min  
- `/report` ≤ 5/min  
- `/metrics` ≤ 20/min  

In Cloudflare dashboard (consigliato): Rate limiting rules sugli stessi path.

## Dopo rotazione: Mac dei colleghi

- KEY: aggiornano con curl / pull.  
- Token: **non** serve sui Mac (solo sul Worker).
