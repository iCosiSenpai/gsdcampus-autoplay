# Changelog

## Unreleased (2026-07-21)

- Supervisore distribuito migrato a Claude Code **on-demand**: `openQuizRequests > 0` è l'unico gate; senza quiz non partono Claude, Ollama o proxy.
- Runner one-shot `-p --bare --safe-mode --no-session-persistence`, soli tool WebSearch/WebFetch, payload senza CF/URL/token e output JSON Schema validato.
- Proxy Anthropic-compatible (`/v1/messages`, `/v1/messages/count_tokens`) con token locale, budget rolling, serializzazione e massimo 8 generazioni per batch.
- Scheduler `awaiting_ai` guidato da `workFingerprint`: niente TUI persistente e niente Chromium finché l'handoff non è risolto.
- Sync banca locale-first: `known_answers_public.json` viene mergiato anche se il fetch remoto fallisce; risposte già note non aprono Claude.
- Setup e diagnostica non eseguono le CLI AI con inbox vuota; installazione/verifica di Claude Code e Ollama, daemon/pull/login sono differiti al primo batch necessario.
- Retry errori Claude al `retryAfter` di 30 minuti e share fleet durevole con marker locale/exit dedicato.
- Le installazioni OpenCode preesistenti non vengono rimosse automaticamente.

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
