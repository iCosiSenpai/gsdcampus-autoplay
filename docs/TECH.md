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

### Adozione del codice nuovo senza intervento

Dopo un auto-update convivevano due versioni: i file su disco erano nuovi, ma i processi già avviati (scheduler e **plancia**) continuavano col codice caricato all'apertura. La plancia in particolare restava vecchia per giorni e bisognava chiuderla a mano.

- **Plancia** (`panel-cli.js`): confronta il commit di partenza con `.git/HEAD` a ogni frame. Quando cambiano, annuncia il riavvio con 6 secondi di preavviso e si ri-esegue da sola (`spawnSync` dello stesso file, stdio ereditati) — il riavvio della plancia non tocca i corsi, è solo una finestra di lettura. `planPanelRestart()` (pura, testata) **rimanda** se: si sta leggendo il log dal vivo, è armata la conferma di `F`, oppure c'è un quiz in corso (`claudeWorking` o fase `quiz*`/`checking`) — con tetto di 5 minuti, così una finestra non resta vecchia per sempre. Massimo 3 riaperture per sessione (`GSD_PANEL_RELAUNCH`), per non rischiare cicli.
- **Scheduler** (`scheduler.sh`): all'inizio di ogni giro — quando nessun autoplay è in esecuzione, quindi **mai** durante un video o un quiz — confronta `git rev-parse HEAD` con lo sha di partenza e, se è cambiato, fa `exec` di se stesso. `exec` mantiene lo **stesso PID**: `.autoplay_pid`, il lock single-instance e `caffeinate -w <pid>` restano validi e nessuno vede un riavvio. È la rete di sicurezza per quando il restart di `auto-update.sh` non è andato a buon fine.
- Se lo stato del corso è vecchio (nessun corso in esecuzione adesso), il piè di pagina della plancia lo dice: `stato del corso di 4h 12m fa`. Serve a distinguere "schermata bloccata" da "non c'è niente in corso": prima il contenuto immobile con l'orologio che avanzava sembrava un blocco.

### Chiudere la scheda: cosa succede davvero

Lo scheduler parte con `nohup`, quindi un semplice `exit` del Terminale non lo tocca. Ma quando si chiude una **scheda con processi attivi**, Terminal.app propone di terminarli e la conferma manda un segnale a tutto il process group: `nohup` protegge da `SIGHUP`, non da `SIGKILL`. Per questo la plancia non promette più "chiudere la finestra non ferma nulla" e dice invece:

- `Q` = **chiude solo questa scheda** (`terminalCloseScript()` in `panel-cli.js`: `selected tab of front window` su Terminal.app, `current session` su iTerm2 — mai `quit` dell'applicazione, perché altre schede/finestre dello stesso Mac possono fare tutt'altro). Terminali non riconosciuti → no-op, esce solo il processo. Nessuna sentinella scritta: se i processi vengono interrotti, il keepalive li riprende entro ~2 minuti.
- `F` = fermata vera: `stop.sh` (sentinella `.user_stopped` + `bootout` del keepalive) e poi chiusura della scheda. Resta giù finché non lo riavvia un `start.sh` esplicito o il comando curl.
- `Ctrl-C` = esce dalla plancia e **lascia la scheda aperta** (via d'uscita non distruttiva).

La plancia mostra in chiaro se il guardiano è installato (plist `com.gsdcampus.autoplay.keepalive`): se manca, avvisa in giallo che chiudere la scheda può fermare l'automazione.

## Reinstallazione totale (menu del curl)

Quando la copia locale è in uno stato che non si raddrizza (banca risposte incoerente, file mischiati, cartella senza `.git`), il menu del comando curl ha **"Reinstallazione totale — Riscarica tutto da zero, tenendo il tuo nome e gli orari"**:

1. chiede conferma esplicita (`y/N`) elencando cosa tiene;
2. ferma l'automazione (`stop.sh`);
3. **sposta** la cartella in `~/gsdcampus-vecchia-<timestamp>` — non cancella niente, e non duplica GB di `node_modules`;
4. ri-clona il progetto pulito e rimette `config.json` (nome, accesso al corso, orari): il "chi sei?" non si rifà;
5. prosegue come una prima installazione (`MODE=install`), quindi dipendenze e setup vengono completati dal launcher.

La banca risposte torna quella condivisa; lo stato per-account viene ricostruito dalla piattaforma al primo giro. La cartella vecchia resta a disposizione e la cancella l'utente quando vuole.

## Cosa succede se… (azioni involontarie dell'utente)

Comportamento reale, verificato sul codice. Regola generale: **niente è irreversibile**, il peggio che capita è una pausa fino al prossimo giro dello scheduler o del watchdog.

| Azione | Cosa succede | Recupero |
| --- | --- | --- |
| **Logout da Ollama** (o Ollama chiuso dalla GUI) | Solo la risoluzione quiz si ferma. `run-claude-quiz-batch.sh` prova `ollama pull`, fallisce e esce **24**: handoff intatto, nessun tentativo quiz consumato. Lo scheduler logga "login Ollama richiesto" e manda una notifica macOS (throttle 6h). I **corsi continuano**: i video non usano l'AI. | Al primo giro interattivo (comando curl / doppio clic) il batch esegue `ollama signin`, apre il browser e riprende. Non serve nessuna API key. |
| **Uscita forzata di Chrome** dal Dock / Monitoraggio Attività | Il browser dell'automazione è un processo separato **headless** (nessuna icona nel Dock): l'uscita forzata del Chrome dell'utente non lo tocca. Se muore comunque (aggiornamento di Chrome, crash, kill mirato), `isBrowserGoneError()` lo riconosce: log "BROWSER CHIUSO DALL'ESTERNO", fase `browser_closed`, nessun dump d'errore inutile. | Il retry esterno riapre un browser nuovo (backoff 30s → 60s → …) e riprende dal punto salvato **dalla piattaforma**: al massimo si riguarda l'ultimo pezzo di video. |
| **Chiusura della scheda del Terminale** (o Cmd+Q) | La plancia muore; lo scheduler è `nohup` ma se il Terminale termina i processi della scheda cade anche lui. | Il keepalive (`com.gsdcampus.autoplay.keepalive`) lo rilancia entro ~2 minuti. La plancia lo dice in chiaro e avvisa in giallo se il keepalive non è installato. |
| **Tasto F nella plancia / `./stop.sh`** | Stop **volontario**: scrive `.user_stopped` e fa `bootout` del keepalive, così niente lo resuscita (nemmeno l'auto-update). | Riparte solo con `./start.sh` o col comando curl. |
| **Cartella del progetto spostata o rinominata** | I LaunchAgent puntano al vecchio percorso: launchd li lancia e muoiono con `exit 127`, in silenzio. Niente auto-aggiornamento, niente watchdog. | `doctor.sh` ora lo rileva ("Servizio … punta a un'altra cartella"); il comando curl reinstalla entrambi gli agent. |
| **Cartella copiata da uno zip** (senza `.git`) | Il Mac non può aggiornarsi. | `install.sh` lo rileva e offre la riparazione automatica (conserva account, dati e risposte). |
| **`config.json` cancellato o modificato male** | `config-check-cli.js` lo classifica (`missing_file`/`bad_json`/…) e il launcher apre il setup guidato. Con orari mancanti il setup **riprende** invece di fallire. | Selezione account dall'elenco: nessun link da incollare. |
| **`data/known_answers.json` cancellato** | `ensureKnownBankSeeded()` lo risemina dalla banca pubblica al primo quiz; il sync periodico rimette il resto. | Nessuna azione. Le risposte sono anche sul Worker. |
| **`data/members.db` cancellato** | «Chi sei?» resta senza elenco e offre import CSV o incolla-link. L'account già configurato continua a funzionare (l'autologin sta in `config.json`). | Il file torna col primo aggiornamento (è tracciato nel repo). |
| **Il collega apre il corso nel proprio browser** mentre l'automazione lavora | Due sessioni sullo stesso account: la piattaforma può invalidare la sessione → `SessionError` → fase `session_unstable`, exit 4. **Nessun re-login a raffica** (degraderebbe il token). | Cooldown scheduler (default 30 min) e ripartenza da sola. Il link NON è da cambiare. |
| **Wi-Fi staccato / rete dello store giù** | Autoplay: errore di navigazione → retry con backoff. Auto-update: segna `offline` e riprova al giro dopo. Banca risposte: merge locale, fetch remoto saltato. Nessun crash. | Automatico al ritorno della rete. |
| **Mac addormentato / coperchio chiuso** | Mentre lo scheduler gira, `caffeinate -i -s -m -w <pid>` impedisce lo sleep idle. In clamshell senza alimentazione il Mac dorme comunque. | Al risveglio lo scheduler riprende; i job launchd mancati partono al wake. |
| **Node/Chrome disinstallati o aggiornati** | `check-requirements.sh --runtime` fallisce → il launcher esegue il setup condizionale. Senza Chrome di sistema si usa Chromium di Playwright (fallback automatico). | Comando curl. |
| **Processo `node autoplay` ucciso da Monitoraggio Attività** | Lo scheduler vede l'uscita anomala → backoff crescente (60s → 120s → 300s → 1800s); dopo 5 crash consecutivi fase `crash_loop`, notifica e retry dopo 30 min. | Automatico; il keepalive copre anche la morte dello scheduler. |
| **Quiz aperto a mano dal collega** | L'autoplay è attempt-protective: finalizza solo con **tutte** le risposte note. Un tentativo consumato a mano resta contato dalla piattaforma. | Nessun rimedio automatico: è l'unico caso in cui un tentativo si può perdere davvero. |

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

**Le due vie di avvio sono lo stesso script**: il Worker `worker-install/install-proxy.js` serve `GET /` = proxy di `raw.githubusercontent.com/.../main/install.sh` (cache 60s) e `GET /avvia` = archivio `GSD Avvia.zip` con dentro `GSD Avvia.command`, che a ogni doppio clic riscarica `install.sh` da `main`. Quindi "Modo A" (doppio clic) e "Modo B" (comando) eseguono **identico** installer e aggiornano entrambi: se uno non aggiorna, non aggiorna nemmeno l'altro — il problema non è mai la via scelta, ma `origin/main` (nessun commit nuovo), la rete, o la cartella non aggiornabile.

**Perché uno ZIP e non il `.command` nudo**: HTTP non trasporta i permessi, quindi un `.command` scaricato dal browser arriva `644` e il doppio clic risponde *"could not be executed because you do not have appropriate access privileges"* — il Modo A non partiva affatto (verificato: `execve` su un file 644 → `permission denied`). Lo ZIP porta i permessi Unix negli *external file attributes*: `worker-install/zip-store.js` (scrittore STORED senza dipendenze, con CRC32) marca il file `0o100755`, e sia `ditto` (il motore di Safari) sia `unzip` restituiscono un file eseguibile. La rotta `GET /avvia.command` resta come fallback per chi vuole lo script nudo (richiede `chmod +x`).

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
