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

### Chiudere la scheda: cosa succede davvero

Lo scheduler parte con `nohup`, quindi un semplice `exit` del Terminale non lo tocca. Ma quando si chiude una **scheda con processi attivi**, Terminal.app propone di terminarli e la conferma manda un segnale a tutto il process group: `nohup` protegge da `SIGHUP`, non da `SIGKILL`. Per questo la plancia non promette più "chiudere la finestra non ferma nulla" e dice invece:

- `Q` = **chiude solo questa scheda** (`terminalCloseScript()` in `panel-cli.js`: `selected tab of front window` su Terminal.app, `current session` su iTerm2 — mai `quit` dell'applicazione, perché altre schede/finestre dello stesso Mac possono fare tutt'altro). Terminali non riconosciuti → no-op, esce solo il processo. Nessuna sentinella scritta: se i processi vengono interrotti, il keepalive li riprende entro ~2 minuti.
- `F` = fermata vera: `stop.sh` (sentinella `.user_stopped` + `bootout` del keepalive) e poi chiusura della scheda. Resta giù finché non lo riavvia un `start.sh` esplicito o il comando curl.
- `Ctrl-C` = esce dalla plancia e **lascia la scheda aperta** (via d'uscita non distruttiva).

La plancia mostra in chiaro se il guardiano è installato (plist `com.gsdcampus.autoplay.keepalive`): se manca, avvisa in giallo che chiudere la scheda può fermare l'automazione.

## Auto-update continuo (ogni ~10 min)
Il LaunchAgent `com.gsdcampus.autoplay.autoupdate` (`scripts/lib/install-launchd.sh`) non gira più alle 05:30: usa `StartInterval` (600s) e lancia `scripts/auto-update.sh` **ogni ~10 minuti**. Così un push del maintainer arriva alla flotta in pochi minuti, non la notte dopo.

- **Costo quasi nullo quando non c'è nulla**: `auto-update.sh` fa un `git fetch` e, se `HEAD == origin/main`, esce in <1s. Solo con un commit nuovo procede.
- **Sicurezza update**: stop scheduler → `update_repo` (ff/reset) → **GATE `dev-check`** → se rotto, **rollback** al commit precedente + issue automatica al maintainer + notifica → restart + riabilita keepalive. Un push difettoso viene scartato, non stende la flotta.
- **Mai durante un quiz**: prima di fermare, `phase_is_busy` controlla `status.json` (fresco); se la fase è `quiz_dashboard`/`quiz_needs_answers`/`checking` rimanda al giro dopo. Un **video** invece si interrompe (la piattaforma salva la posizione).
- **Restart**: `auto-update.sh` chiama `stop.sh` + `start.sh` (già collaudato); il keepalive copre il resto. Lock `noclobber` anti-doppio-run; il file si ricopia in `$TMPDIR` prima del `git` per non corrompersi.
- Opt-out: `"autoUpdate": false` in `config.json` → l'agent viene rimosso.

### Come si vede che sta funzionando

`auto-update.sh` scrive `logs/auto-update-state.json` a **ogni** giro, anche quando non c'è niente di nuovo (`src/lib/update-state.js`, CLI `scripts/lib/update-state-cli.js`). Senza questo, il caso normale (`HEAD == origin/main`, uscita in <1s, nessun log) era indistinguibile da un agent morto o mai installato.

- Plancia (`panel-cli.js`): riga `Aggiorn. ▸ controllato 4m fa · già all'ultima versione (964824c)`.
- `./status.sh`: stessa riga in alto, con `warn` quando serve attenzione.
- `node scripts/lib/update-state-cli.js show [--json]` per leggerla a mano.
- Esiti tracciati: `up_to_date`, `updated`, `rollback`, `postponed`, `deps_required`, `update_failed`, `offline`, `disabled`.
- **Avviso giallo** in due casi: nessun controllo da oltre 35 minuti (`STALE_MS`) → l'agent non gira; plist assente in `~/Library/LaunchAgents/` → auto-update non attivo su quel Mac (rimedio: rilanciare il comando curl, che riesegue `install-launchd.sh install`). Con `autoUpdate:false` in `config.json` la riga resta informativa ("disattivato"), non un avviso.
- **Finestra rimasta aperta**: `readHeadSha()` (lettura diretta di `.git/HEAD`, nessun `git` spawnato per frame) confronta il commit di quando la plancia è partita con quello sul disco. Se differiscono la plancia avvisa che sta mostrando la versione precedente e invita a chiudere e rilanciare il curl. È il caso tipico del Mac del collega: l'auto-update aggiorna i file e riavvia lo scheduler, ma il processo della plancia continua col codice vecchio.
- **Notifica macOS** ad aggiornamento riuscito (`auto_update_done`, throttle 6h): l'unico segnale per chi non ha nessun terminale aperto.
- Lato maintainer: `scripts/lib/diag-ping.js` invia a ogni avvio del launcher la versione (short sha) + `storeTag` al Worker (`POST /diag`, visibile con `wrangler tail`) — nessun dato personale. Serve a vedere da remoto quale versione gira su ogni store.

Verifica manuale dell'agent: `launchctl print gui/$(id -u)/com.gsdcampus.autoplay.autoupdate | grep -E "path|last exit|run interval"`. Un `last exit code = 127` significa che il plist punta a un percorso che non esiste più (progetto spostato/rinominato): `./scripts/lib/install-launchd.sh install` lo riallinea.

### Perché un Mac può NON aggiornarsi (e come si vede)

Tre modi silenziosi di restare indietro, tutti ora rilevati da `scripts/doctor.sh` (menu curl → "Diagnostica on-demand"):

1. **Cartella senza cronologia git** — tipico di chi è partito dallo zip di `prepare-package.sh`, che rimuove `.git`. In quello stato `install.sh` cadeva nel ramo `elif [ -d "$TARGET" ]` → `MODE=launch`: nessun menu, nessun aggiornamento, per sempre. Ora l'installer lo dice e offre la riparazione (`git init` + `remote add` + `fetch --depth 1` + `checkout -f -B main origin/main`): i file tracciati vengono riportati alla versione del repo, tutto ciò che è gitignorato (`config.json`, `data/`, `logs/`) resta intatto. Verificato in sandbox: account, stato per-account, banca trusted e log sopravvivono.
2. **Preflight di rete troppo severo** — `net_preflight()` pretendeva risposta da `captive.apple.com` **e** da `raw.githubusercontent.com` (timeout 5s). Su una rete di store che filtra uno dei due, o semplicemente lenta, l'update veniva saltato con un warning facile da non notare. Ora basta **una** risposta fra raw, l'endpoint `git-upload-pack` di GitHub e captive, con timeout 8s. Stessa logica in `auto-update.sh` (`net_ok()`).
3. **Falso "Progetto aggiornato"** — con il `fetch` fallito, `update_repo()` proseguiva mergiando su un `origin/main` vecchio e stampava comunque il messaggio di successo. Ora il fetch fallito interrompe l'aggiornamento con un errore esplicito e `return 1`; l'esito finale è calcolato sullo **sha reale** prima/dopo (`Aggiornato: X → Y` / `Già all'ultima versione (X)`). I call site (`install.sh`, `auto-update.sh`) gestiscono il codice di ritorno.

> `scripts/lib/update-repo.sh` e la copia inline in `install.sh` devono restare allineate: la seconda gira anche prima che il repo esista.

**Versione mostrata sui Mac dei colleghi**: i cloni sono `--depth 1` e quindi **senza tag**, dove `git describe --tags --always` restituisce solo lo sha. `ui_version()` (`scripts/lib/ui.sh`) e `readVersion()` (`panel-cli.js`) ripiegano su `package.json` + sha → `v1.1.0 · 42a07aa` invece di un esadecimale nudo.

**Le due vie di avvio sono lo stesso script**: il Worker `worker-install/install-proxy.js` serve `GET /` = proxy di `raw.githubusercontent.com/.../main/install.sh` (cache 60s) e `GET /avvia` = file `GSD Avvia.command` che esegue lo stesso `curl`. Quindi "Modo A" (doppio clic) e "Modo B" (comando) eseguono **identico** installer: se uno non aggiorna, non aggiorna nemmeno l'altro — il problema non è mai la via scelta, ma `origin/main` (nessun commit nuovo), la rete, o la cartella non aggiornabile.

## Diagnostica flotta (silenziosa)

`scripts/lib/diag-ping.js` manda un ping **privacy-safe** al Worker (`POST /diag`): solo `version` (git short sha), `event`, `errorClass`, `storeTag` — **mai** CF, autologin, token, cookie o URL (slug-only + redazione lato Worker). Il Worker fa un semplice `console.log` (niente issue, niente persistenza): lo leggi con `wrangler tail` o dalla dashboard Cloudflare.

- Inviato dal launcher all'avvio (`event: start` con la versione) → sai quale versione gira su ogni store, così noti i Mac rimasti su codice vecchio.
- Inviato su eventi che contano: `crash_loop`, `autologin_invalid` (scheduler), `ai_batch_failed`/`ai_not_ready` (launcher).
- Best-effort: non blocca mai, esce sempre 0, ignora offline/timeout. Opt-out: `"diagnostics": false` in `config.json`.
- Le **issue** GitHub restano riservate ai casi rari e azionabili (es. rollback auto-update, deduplicato): la diagnostica di routine passa da qui, senza rumore.

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
