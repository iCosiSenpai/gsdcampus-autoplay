# Changelog

## Unreleased (2026-07-21)

- Supervisore migrato da Claude Code a OpenCode mantenendo il login browser Ollama: `ollama signin`, daemon locale e modelli Cloud.
- Proxy loopback autenticato e con allowlist: applica il budget, inoltra al daemon Ollama locale e non salva contenuti nei log/contatori. Nessuna API key manuale richiesta.
- Budget conservativo: 400 richieste rolling/7 giorni, 80/24 ore, 8/minuto, una richiesta alla volta e cache RAM per retry identici.
- Il curl propone una sola volta per Mac se conservare Claude (pulendo solo override GSD/Ollama) o disinstallare il client lasciando i dati personali.
- `useOllamaForQuiz:false` resta il default: nessun consumo AI domanda-per-domanda durante l'autoplay.

## v1.1.0 (2026-07-20)

### Per i colleghi (fleet)
- **Account:** `data/members.db` nel repo → setup **«Chi sei?»** (cerca il nome). Niente incolla link, niente CSV sul Mac del collega.
- **Banca risposte**: `resolve` fa **auto-share** al Worker. Opt-out: `autoShareAnswers: false`.
- **Sync banca** all’avvio di `./start.sh` (merge public→trusted, max 1 volta / 6 ore).
- **Coda multi-CF** su un Mac: `members-cli queue set CF1 CF2` (CF già in members.db).
- **Notifiche macOS**: corso completato / quiz da risolvere.
- Browser: Chrome consigliato, **Chromium ok**.
- Report locale: `weekly-report-cli.js`; harvest senza video: `harvest-night.sh`.

### Interni
- Split `course-runner`, quiz-bank/handoff/outcome, setup ollama/versions modules.
- Metrics `POST /metrics`, session cooldown configurabile, tag `v1.1.0`.

## v1.0.x
- Baseline multi-utente, trust-by-location quiz, Worker answers/issues, AI supervisor.
