# Configurazione tecnica e permessi

## Note tecniche

- Lo script principale è `src/autoplay.js`; usa Playwright in modalità headless.
- `start.sh` verifica solo i requisiti **runtime**: Node, dipendenze, browser e configurazione. Ollama e Claude Code non sono necessari per riprodurre video o attendere il prossimo turno.
- Il lock single-instance usa directory atomica + token nella command line: un PID riciclato non può essere scambiato per lo scheduler.
- L'elenco membri è in `data/members.db` (SQLite, Node >=22). Lo stato per-account è in `data/accounts/<CF>/`; la dashboard aggregata è rigenerata in `data/dashboard.json`.
- `backups/accounts/<CF>/course-state/` contiene snapshot SHA-256 creati prima di `reopenCourse`/`resetCourse`. Non include cookie, autologin o `members.db`.
- Fuori turno lo scheduler mantiene `phase: off_hours`; prima di ogni browser esegue `selector-probe.js` e usa `phase: preflight_failed` se il gate non passa.

## Resilienza: keepalive LaunchAgent

Lo scheduler non è più solo un processo `nohup` legato al Terminale: un LaunchAgent utente `com.gsdcampus.autoplay.keepalive` (RunAtLoad + KeepAlive, `scripts/keepalive-agent.sh`) gira h24 nella sessione di launchd e garantisce che lo scheduler sia vivo. Effetti:

- **Chiusura finestra / Cmd+Q / crash**: il watchdog rilancia lo scheduler via `./start.sh` entro ~2 minuti.
- **Riavvio del Mac**: `RunAtLoad` riporta su il watchdog, che riavvia lo scheduler.
- Lo scheduler continua a **rispettare gli orari** internamente (il watchdog garantisce solo la presenza del processo, non decide i turni).
- **Stop esplicito** (`./stop.sh`, tasto F): crea `.keepalive_disabled` e fa `bootout` dell'agent, così il watchdog NON resuscita. Il launcher (comando curl) lo riabilita al successivo "Aggiorna e avvia".
- **crash_loop**: dopo 5 crash consecutivi lo scheduler NON esce più (uscire sotto KeepAlive = restart immediato = martellamento): segnala `crash_loop`, attende 30 min e riprova da solo.
- Opt-out: `"keepAlive": false` in `config.json`. No-op sui sistemi senza `launchctl`.
- Installazione idempotente dal launcher dopo `start.sh` (`scripts/lib/install-scheduler-agent.sh install|remove`); rimosso da `uninstall.sh`.

> Il percorso di avvio (`start.sh`, lock/token, `caffeinate`) è **invariato**: il keepalive lo usa così com'è. Se il watchdog fallisce, il comportamento degrada a quello attuale (serve il comando curl), mai peggio.

## Claude Code on-demand

`launch-ai-supervisor.sh` è un bootstrap deterministico, non una TUI: sincronizza la banca, aggiorna `logs/ai_todo.json` se è più vecchio di 15 minuti, esegue l'eventuale batch quiz e avvia `start.sh`. Poi termina.

Il solo gate che può aprire l'AI è `buildAiTodo(root).openQuizRequests > 0`. Campi come `actions`, `need_help`, `bankLag` e `falseDones` descrivono lavoro deterministico e non avviano Claude. Prima del gate, le risposte già presenti in `data/known_answers_public.json`/`known_answers.json` vengono riconciliate localmente: se coprono l'intero handoff, le chiamate AI restano zero.

Quando serve un batch, `scripts/run-claude-quiz-batch.sh`:

1. acquisisce un lock e deduplica per `workFingerprint`;
2. avvia Ollama e il proxy solo-loopback soltanto in quel momento;
3. esegue `ollama pull` e, se la sessione non è autenticata, `ollama signin` nel browser;
4. avvia una sola sessione `claude -p --bare --safe-mode --no-session-persistence`;
5. chiude runner, proxy e l'eventuale daemon Ollama avviato dal batch.

Claude ha soltanto `WebSearch` e `WebFetch`: niente `Read`, `Bash`, `Edit`, `Write`, subagent, MCP o persistenza sessione. Riceve esclusivamente ID effimeri, domanda, opzioni e guess legacy; non riceve CF, URL, cookie, token o contesti account. L'output è vincolato da JSON Schema. Una risposta viene applicata solo con confidenza almeno 0,7 e, quando esistono opzioni, se coincide esattamente con una delle opzioni di ogni occorrenza della domanda.

In `phase: awaiting_ai` lo scheduler richiama lo stesso batch su un fingerprint nuovo e resta senza browser finché l'inbox non è vuota. Un errore Claude viene ritentato al `retryAfter` registrato (30 minuti), non al ricontrollo generico di 6 ore. Tra un tentativo e l'altro non rimane alcun processo AI persistente. Le risposte applicate usano un marker metadata-only per ritentare lo share fleet: il batch segnala separatamente un errore di distribuzione senza perdere la banca locale.

## Proxy e budget

`scripts/lib/ollama-cloud-proxy.js` accetta su loopback le API OpenAI legacy e le route Anthropic usate da Claude Code:

- `POST /v1/messages` — generativa, conteggiata;
- `POST /v1/messages/count_tokens` — non generativa, non conteggiata;
- `GET /v1/models` — verifica del ponte.

Il proxy accetta il token casuale del batch via `x-api-key` o Bearer, inoltra gli header `anthropic-version`/`anthropic-beta` e non persiste prompt o risposte. I limiti predefiniti sono 400 richieste rolling/7 giorni, 80/24 ore, 8/minuto, una generazione alla volta e massimo 8 generazioni per batch. La cache RAM breve evita di ricontare retry byte-identici.

## Requisito login Ollama

Il modello è sempre `config.json.ollamaModel`, incluso il suffisso `-cloud`. Con inbox vuota setup e diagnostica controllano soltanto il runtime/presenza dei binari senza eseguire le CLI AI. Installazione/verifica di Ollama e Claude Code, daemon, pull e login partono soltanto dopo `openQuizRequests > 0`. Il login standard resta `ollama signin`: si apre il browser e non vengono richieste API key manuali.

Le vecchie installazioni OpenCode non vengono disinstallate o modificate automaticamente; semplicemente non sono più invocate. Quando il repository viene aperto direttamente con Codex/Kiro, `AGENTS.md` espone il contratto operativo della sessione esterna, separato dal runner distribuito.
