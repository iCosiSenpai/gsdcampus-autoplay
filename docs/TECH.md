# Configurazione tecnica e permessi

## Note tecniche

- Lo script principale è `src/autoplay.js`; usa Playwright in modalità headless.
- `start.sh` controlla i requisiti e la configurazione prima di avviare.
- L'elenco membri è in `data/members.db` (SQLite, richiede Node >=22 per `node:sqlite` built-in). Lo stato per-account è in `data/accounts/<CF>/`. La dashboard aggregata è rigenerata in `data/dashboard.json` alla fine di ogni run.
- I log sono in `logs/`.
- `backups/` contiene copie di sicurezza dello script (se presenti).
- `scripts/lib/schedule-cli.js` fornisce helper per leggere e validare gli orari dagli script shell. `scripts/lib/members-cli.js` e `scripts/lib/dashboard-cli.js` gestiscono membri e stato cross-utente.

## Permessi del supervisore AI

`./launch-ai-supervisor.sh` avvia Claude con `--dangerously-skip-permissions`. Lo script chiede la password di sudo una sola volta (`sudo -v`) in foreground, **prima** dei prompt interattivi, e la rinfresca in foreground al passo Ollama. **Non usa un keepalive in background**: un `sudo -v` in background legge la password da `/dev/tty` e ruba i tasti al menu "Chi sei?" (caratteri non visibili + "Sorry, try again. Password:"). Durante il setup l'utente deve solo confermare eventuali richieste di installazione/aggiornamento da Homebrew/npm (sempre `y`). I permessi di Claude Code non richiedono conferme ripetute.

Quando il repository viene aperto direttamente con Codex, `AGENTS.md` espone lo stesso contratto operativo; i permessi sono quelli della sessione Codex e non vengono configurati da `launch-ai-supervisor.sh`.

## Requisito login Ollama

Il modello da usare è **sempre quello indicato in `config.json` (`ollamaModel`)** — `launch-ai-supervisor.sh`, `setup.sh` e `check-requirements.sh` lo leggono tutti da lì, così non c'è rischio di scaricare/cercare modelli diversi tra loro. Se è un modello **cloud Ollama**, richiede l'autenticazione: `./launch-ai-supervisor.sh` e `./scripts/setup.sh` gestiscono automaticamente il login (aprono `ollama login` in modo interattivo, aspettano le credenziali, poi scaricano il modello e avviano il supervisore). Per cambiare modello basta modificare `ollamaModel` in `config.json`. Non devi fare altro.
