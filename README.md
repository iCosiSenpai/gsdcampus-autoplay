:red_circle: **Questo script automatizza l'accesso a un corso e-learning. Usalo solo se sei autorizzato dal titolare del corso/account.**

# gsdcampus-autoplay

Script Playwright per completare in automatico le video-lezioni e i quiz del corso e-learning GSD Campus (tecsial.gsdcampus.it).

## Comando principale

Apri il Terminale, incolla questo comando su **una sola riga** e premi Invio:

```bash
cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

> Se il terminale incolla più righe ma non esegue l'ultima, premi Invio una seconda volta.

Lo script:
1. Installa/verifica tutti i requisiti (Homebrew, Node, Playwright, Chrome, Ollama, modello, Claude CLI).
2. **La prima volta ti chiede:**
   - il tuo **link di autologin personale** GSD Campus;
   - i **giorni lavorativi** (default lun–ven);
   - gli **orari di lavoro** (default 09:30–13:00 e 16:30–20:00).
3. Avvia Ollama se necessario.
4. Apre una sessione Claude Code con istruzioni pre-caricate e permessi automatici.
5. Tu scrivi nella chat cose come:
   - `controlla il corso`
   - `come sta andando?`
   - `avvia il corso`
   - `ferma tutto`

All’inizio lo script chiede la **password di sudo una sola volta** e la mantiene valida per tutta la sessione tramite un keepalive in background. Poi, durante il setup, potrebbe chiedere:
- di **installare/aggiornare/verificare dipendenze** (anche con richieste `y/n`) → conferma sempre;
- il **login Ollama** → inserisci le credenziali e lo script continua.

Non avere paura di confermare: serve tutto per automatizzare il corso.

## Prima installazione

Basta eseguire il comando principale. La prima volta installerà tutto in automatico:

```bash
cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

## Aggiornamento (dopo un `git pull`)

Se hai già installato tutto e vuoi solo aggiornare gli script, usa il comando rapido:

```bash
cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

Lo script verificherà i requisiti e, se sono già presenti, li salterà senza reinstallare.

Se invece vuoi forzare l'aggiornamento di tutto (Homebrew, npm, browser, Ollama, ecc.):

```bash
cd ~/gsdcampus-autoplay && ./scripts/setup.sh --yes --force-update
```

## Altri comandi (opzionali)

```bash
./start.sh                              # avvia scheduler autoplay (rispetta orari lavoro)
./start.sh --ignore-hours               # avvia subito ignorando gli orari
./stop.sh                               # ferma autoplay e scheduler
./status.sh                             # stato, heartbeat, log
./scripts/setup.sh                      # installa/aggiorna requisiti e configura config.json
./scripts/setup.sh --yes                # modalità automatica, salta ciò che è già installato
./scripts/setup.sh --yes --force-update # forza aggiornamento di tutto
./scripts/check-requirements.sh         # verifica requisiti
./scripts/maintenance.sh                # ruota log grandi e pulisce vecchi screenshot/dump
./scripts/uninstall.sh                  # rimuove dipendenze, modelli, CLI e progetto (conferma)
./scripts/prepare-package.sh --yes     # crea sul Desktop copia pulita per un collega
./scripts/prepare-package.sh --yes --zip # ...e anche lo zip
```

## Struttura

- `launch-ai-supervisor.sh` — unico comando per l'utente
- `CLAUDE.md` — istruzioni per l'AI supervisore
- `src/autoplay.js` — main
- `src/lib/` — logger, monitor, quiz, video, schedule
- `scripts/` — setup, check requisiti, daemon Ollama
- `data/` — risposte conosciute, risposte in attesa di verifica, mappa corsi, stato sessione
- `logs/` — log, heartbeat, status.json, supervisor.log, ollama.log
- `debug/` — screenshot e dump HTML in caso di errore
- `backups/` — copie di sicurezza dello script
- `README-COLLEGHI.md` — guida estesa per i colleghi

## Modalità headless

Lo script usa `chromium.launch({ headless: true })`. Non compare nessuna finestra del browser.

## Note su replicabilità

Gli ID dei corsi (`/corso/show/XXXX`) sono **personali** e variano da utente a utente.

Per questo lo script `src/autoplay.js`, dopo il login, naviga automaticamente sulla dashboard e scopre i corsi assegnati all'utente. Non serve più inserire manualmente gli URL dei corsi in `config.json`.

L'URL di autologin è **personale**: la prima volta lo script te lo chiede in terminale durante il setup. In seguito, l'AI mostrerà solo una conferma; se qualcosa non è corretto, basta scriverlo in chat e l'AI modificherà `config.json` al posto tuo.

Gli orari di lavoro sono salvati in `config.json` nella chiave `workSchedule` (`days` + `shifts`). Puoi modificarli chattando con l'AI o eseguendo `./scripts/setup.sh`.

## Orari di lavoro automatici

I Mac in negozio restano accesi 24/7. Lo scheduler gestisce automaticamente i turni configurati in `config.json`:

- Default: lunedì–venerdì, 09:30–13:00 e 16:30–20:00.
- Se avvii `start.sh` fuori orario, lo scheduler aspetta l'inizio del prossimo turno e poi avvia l'autoplay.
- A fine turno, `src/autoplay.js` esce gracefulmente; lo scheduler aspetta il turno successivo e lo riavvia.
- Nessun cron richiesto.

## Monitoring

- `logs/status.json` — stato live
- `logs/heartbeat.txt` — ultima attività
- `logs/autoplay.log` — log principale
- `logs/supervisor.log` — log delle azioni dell'AI
- `logs/ollama.log` — log di Ollama
- `logs/scheduler.log` — log dello scheduler (orari, prossimi avvii)

## Quiz

- Le risposte corrette sono in `data/known_answers.json`.
- Se una domanda non è nota, lo script chiede a Ollama (`gemma4:31b-cloud`) la risposta usando la conoscenza del modello.
- Le risposte date da Ollama vengono salvate in `data/pending_quiz_answers.json` per verifica.
- Se Ollama non sa rispondere, il quiz si ferma e salva la domanda in `data/need_answer.json`; a quel punto puoi cercare la risposta e aggiungerla a `data/known_answers.json`.
