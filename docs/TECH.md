# Configurazione tecnica e permessi

## Note tecniche

- Lo script principale è `src/autoplay.js`; usa Playwright in modalità headless.
- `start.sh` controlla requisiti, configurazione e integrità della banca prima di avviare. Il lock single-instance usa directory atomica + token nella command line: un PID riciclato non può essere scambiato per lo scheduler.
- L'elenco membri è in `data/members.db` (SQLite, richiede Node >=22 per `node:sqlite` built-in). Lo stato per-account è in `data/accounts/<CF>/`. La dashboard aggregata è rigenerata in `data/dashboard.json` alla fine di ogni run.
- I log sono in `logs/`.
- `backups/accounts/<CF>/course-state/` contiene snapshot con SHA-256 creati prima di `reopenCourse`/`resetCourse`. Il restore verifica checksum e account e crea un ulteriore backup dello stato sostituito. Non include cookie, URL di login o `members.db`.
- Fuori turno lo scheduler rinnova `status.json`/heartbeat con `phase: off_hours`; prima di ogni browser esegue `selector-probe.js` e usa `phase: preflight_failed` se il gate non passa.
- `scripts/lib/schedule-cli.js` fornisce helper per leggere e validare gli orari dagli script shell. `scripts/lib/members-cli.js` e `scripts/lib/dashboard-cli.js` gestiscono membri e stato cross-utente.

## Permessi del supervisore AI

`./launch-ai-supervisor.sh` avvia OpenCode con `--auto` e il provider custom `ollama-budget`. Il provider punta a un proxy solo-loopback (`127.0.0.1:11435`) che traduce il formato OpenAI-compatible in `/api/chat`, inoltra al daemon Ollama locale (`127.0.0.1:11434`) e applica 400 richieste/7 giorni, 80/24 ore, 8/minuto, una richiesta alla volta e una cache RAM breve per retry identici. Prima di aprire OpenCode viene verificato il ponte locale tramite `/v1/models`; il login Cloud è gestito dalla CLI Ollama. Prompt e risposte non vengono persistiti.

Quando il repository viene aperto direttamente con Codex, `AGENTS.md` espone lo stesso contratto operativo; i permessi sono quelli della sessione Codex e non vengono configurati da `launch-ai-supervisor.sh`.

## Requisito login Ollama

Il modello da usare è **sempre quello indicato in `config.json` (`ollamaModel`)**. Il percorso standard installa Ollama CLI e OpenCode, avvia il daemon su `127.0.0.1:11434` e tenta il `pull` del modello Cloud. Se la sessione non è autenticata, `ollama signin` apre il browser; dopo il login la CLI autentica automaticamente le richieste Cloud ricevute dalla API locale. Non vengono richieste o salvate API key.

OpenCode usa il proxy budget su `127.0.0.1:11435`; il proxy traduce il formato OpenAI-compatible in `/api/chat` e inoltra al daemon Ollama locale, mantenendo il nome Cloud completo (per esempio `gemma4:31b-cloud`). Il conteggio locale è prudenziale: Ollama misura il tier gratuito anche in tempo GPU e può applicare limiti propri.

### Migrazione una-tantum Claude → OpenCode

Al primo `curl` dopo l'aggiornamento, ogni Mac mostra una domanda: Claude serve ancora? Se sì, Claude resta installato e `scripts/lib/migrate-claude-settings.js` rimuove soltanto override persistenti che citano Ollama/11434; login, conversazioni e preferenze personali restano. Se no, viene rimosso solo il client, non la cartella dati. Un marker in `~/Library/Application Support/gsdcampus-autoplay/` impedisce di ripetere la domanda.
