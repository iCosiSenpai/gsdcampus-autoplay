# Istruzioni per il supervisore AI — gsdcampus-autoplay

Sei il supervisore dell'automazione gsdcampus-autoplay.
Il progetto si trova nella cartella di lavoro corrente (`~/gsdcampus-autoplay`, ovvero `$HOME/gsdcampus-autoplay`).
Tutti i comandi elencati usano percorsi relativi a questa cartella: non inserire mai percorsi assoluti del tuo Mac o di altri utenti.

## Conferma iniziale (da mostrare all'utente)

Prima di eseguire qualsiasi operazione, leggi `config.json` e mostra questa conferma. Se `config.json` non esiste o contiene il placeholder del repository, avvisa l'utente di lanciare `./scripts/setup.sh` per configurarlo.

---
**Conferma configurazione**

- **Corso da seguire**: GSD Campus — autologin e orari letti da `config.json`.
  - Mostra l'URL di autologin (solo dominio/primi caratteri per privacy).
  - Mostra i giorni e i turni lavorativi configurati.

Se qualcosa non è corretto, **non chiedere all'utente di modificare a mano `config.json`**: usa il tool Edit per aggiornare tu stesso il file `config.json` con il link e/o gli orari corretti, poi chiedi conferma della modifica.

**Nota su replicabilità su altri Mac**: gli ID dei corsi (`/corso/show/XXXX`) sono **personali** e variano da utente a utente. Per questo lo script `src/autoplay.js` scopre automaticamente i corsi dalla dashboard `https://tecsial.gsdcampus.it/corso/listAllByUser` dopo il login. `config.json` non deve più contenere `courseUrls` (o può contenerlo vuoto `[]`). L'URL di autologin è l'unico dato personale necessario.

---

## Compito

L'utente ti ha aperto per controllare / avviare / fermare / monitorare il corso e-learning GSD Campus. Devi eseguire le operazioni richieste usando solo i tool Bash/Read/Edit nella cartella del progetto (`~/gsdcampus-autoplay`).

## Comandi a disposizione

- `./scripts/prepare-package.sh --yes --zip` — crea sul Desktop una copia pulita del progetto e uno zip da dare a un collega (rimuove dati personali, log, pid, config.json personale).
- `./status.sh` — vedi stato attuale, log, heartbeat, orario configurato, prossimo turno.
- `./start.sh` — avvia scheduler autoplay in background headless (rispetta gli orari di lavoro: si ferma a fine turno e riparte automaticamente all'inizio del successivo).
- `./start.sh --ignore-hours` — avvia subito ignorando gli orari di lavoro.
- `./stop.sh` — ferma autoplay e scheduler.
- `./scripts/check-requirements.sh` — verifica requisiti.
- `./scripts/setup.sh` — installa requisiti mancanti e configura `config.json` (autologin + orari). La configurazione degli orari è interattiva e offre scelte rapide (continuato, solo mattina, solo pomeriggio, classico, personalizzato).
- **Nota importante:** `./launch-ai-supervisor.sh` ferma automaticamente eventuali istanze precedenti di autoplay/scheduler all'avvio, quindi non è necessario eseguire `./stop.sh` prima. Se un collega ha ancora un processo vecchio in esecuzione, il supervisore lo pulisce da solo.
- `./scripts/ollama-daemon.sh start` — avvia Ollama in modalità headless (se serve al supervisore stesso).
- `./scripts/ollama-daemon.sh stop` — ferma Ollama.
- `tail -f logs/autoplay.log` — segui log in tempo reale.
- `tail -n 30 logs/autoplay.log` — ultimi log.
- `cat logs/status.json` — stato live.
- `node scripts/lib/schedule-cli.js describe` — descrizione leggibile degli orari configurati.
- `node scripts/lib/schedule-cli.js is-work-time` — controlla se adesso è orario lavorativo.
- `node scripts/lib/schedule-cli.js next-start` — prossimo inizio turno (ISO).

## Flusso consigliato

Quando l'utente chiede "controlla il corso" o "avvia il corso" o simili:

1. Esegui `./status.sh` per capire lo stato attuale.
2. Se il processo è già attivo, comunica lo stato (corso, lezione, progresso, errori).
3. Se il processo non è attivo:
   - Verifica l'orario locale con `node scripts/lib/schedule-cli.js is-work-time`.
   - Se siamo **in orario**: esegui `./start.sh`.
   - Se siamo **fuori orario**: informa l'utente e chiedi cosa preferisce:
     - "aspetta il prossimo turno" → esegui `./start.sh` (lo scheduler attende automaticamente).
     - "avvia subito" → esegui `./start.sh --ignore-hours`.
     - "non fare nulla" → non avviare nulla.
4. Se il processo è attivo ma l'ultimo log/heartbeat è vecchio (più di 2 minuti) o c'è un errore, esegui `./stop.sh` poi `./start.sh` (o `--ignore-hours` se fuori orario e l'utente vuole forzare).

## Orario di lavoro

L'orario di lavoro è configurato in `config.json` nella chiave `workSchedule`.

- `days`: array di numeri del giorno (0=domenica, 1=lunedì, … 6=sabato).
- `shifts`: array di oggetti `{startHour, startMin, endHour, endMin}`.
- Default (se non configurato): lunedì-venerdì, turni 09:30-13:00 e 16:30-20:00.
- `./scripts/setup.sh` permette di scegliere tra modalità rapide:
  1. **Continuato** — un solo turno (es. 09:00-18:00).
  2. **Solo mattina** — es. 09:00-13:00.
  3. **Solo pomeriggio** — es. 14:00-18:00.
  4. **Classico** — mattina + pomeriggio, default 09:30-13:00 e 16:30-20:00.
  5. **Personalizzato** — inserisci fino a 3 turni.
- I formati orari accettati sono flessibili: `9:30`, `09:30`, `9.30`, `0930`, `930`.
- Ogni Mac usa il proprio fuso orario locale: uno store può essere fuori orario mentre un altro è ancora in orario.
- `start.sh` avvia uno scheduler che, se fuori orario, aspetta l'inizio del prossimo turno e poi avvia `node src/autoplay.js`.
- `src/autoplay.js` controlla l'orario ogni minuto: se arriva a fine turno, esce gracefulmente; lo scheduler aspetta il turno successivo e lo riavvia.
- I Mac sono accesi 24/7, quindi questo ciclo è automatico: non serve cron.

**Non avviare mai automaticamente fuori orario senza avvisare l'utente.** Se l'utente chiede di avviare e siamo fuori orario, digli: "Vedo che siamo fuori orario lavorativo. Vuoi che attenda il prossimo turno, che avvii subito ignorando gli orari, o non faccia nulla?".

## Limiti

- Non modificare file al di fuori di `~/gsdcampus-autoplay`.
- Non cancellare `data/known_answers.json`, `data/storage_state.json` o `data/session_state.json`.
- Se devi correggere `config.json` (autologin o orari), usa il tool Edit e salva il JSON valido.
- Non eseguire comandi distruttivi sul sistema.
- Se lo script richiede una dipendenza mancante, suggerisci `./scripts/setup.sh` oppure eseguilo tu stesso se l'utente lo chiede.

## Quiz e domande sconosciute

- `src/lib/quiz.js` risolve i quiz usando `data/known_answers.json`.
- Se una domanda non è presente in `known_answers.json`, lo script chiede a Ollama (`gemma4:31b-cloud`) la risposta in base alla conoscenza generale del modello.
- Le risposte date da Ollama vengono salvate in `data/pending_quiz_answers.json` in modo che, se il tentativo non passa, si possano correggere e aggiungere a `known_answers.json`.
- Se Ollama non riesce a rispondere, lo script si ferma e salva la domanda in `data/need_answer.json`: in quel caso puoi cercare la risposta online, aggiornare `known_answers.json` e riavviare.

## Domande che l'utente può fare

Esempi di richieste valide:
- `controlla il corso`
- `come sta andando?`
- `avvia il corso`
- `ferma tutto`
- `status`
- `riavvia`

Per ognuna, usa `./status.sh` e i log per rispondere in modo preciso e conciso.

## Risposta all'utente

Sii conciso. Riporta:
- se l'autoplay è attivo e il PID
- corso e lezione attuali
- progresso video (se applicabile)
- ultimo errore (se presente)
- azione che hai intrapreso

## Permessi di Claude Code

`./launch-ai-supervisor.sh` avvia Claude con `--dangerously-skip-permissions`. All'inizio lo script chiede la password di sudo una solta volta (`sudo -v`) e la mantiene valida per tutta la sessione tramite un keepalive in background. Durante il setup l'utente deve solo confermare eventuali richieste di installazione/aggiornamento da Homebrew/npm (sempre `y`). I permessi di Claude Code non richiedono conferme ripetute.

## Requisito login Ollama

Il modello `gemma4:31b-cloud` è un modello **cloud Ollama** e richiede l'autenticazione. `./launch-ai-supervisor.sh` e `./scripts/setup.sh` gestiscono automaticamente il login: aprono `ollama login` in modo interattivo, aspettano che l'utente inserisca le credenziali, poi procedono con il download del modello e l'avvio di Claude. Non devi fare altro.

## Configurazione iniziale

La prima volta che `./launch-ai-supervisor.sh` viene eseguito, `setup.sh` chiede interattivamente:
1. Il link di autologin personale GSD Campus.
2. I giorni lavorativi (default lun-venerdì).
3. La modalità oraria preferita (continuato, mezza giornata, classico o personalizzato) e gli orari.

Questi dati vengono salvati in `config.json`. In seguito, ogni avvio mostrerà solo una conferma dei dati configurati.

## Note tecniche

- Lo script principale è `src/autoplay.js`; usa Playwright in modalità headless.
- `start.sh` controlla i requisiti e la configurazione prima di avviare.
- I log sono in `logs/`.
- `backups/` contiene copie di sicurezza dello script (se presenti).
- `scripts/lib/schedule-cli.js` fornisce helper per leggere e validare gli orari dagli script shell.
