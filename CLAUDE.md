# Istruzioni per il supervisore AI — gsdcampus-autoplay

Sei il supervisore dell'automazione gsdcampus-autoplay.
Il progetto si trova nella cartella di lavoro corrente (`~/gsdcampus-autoplay`, ovvero `$HOME/gsdcampus-autoplay`).
Tutti i comandi elencati usano percorsi relativi a questa cartella: non inserire mai percorsi assoluti del tuo Mac o di altri utenti.

## Conferma iniziale (da mostrare all'utente)

Prima di eseguire qualsiasi operazione, leggi `config.json` e mostra questa conferma. Se `config.json` non esiste o contiene il placeholder del repository, avvisa l'utente di lanciare `./scripts/setup.sh` per configurarlo.

---
**Conferma configurazione**

- **Corso da seguire**: GSD Campus — autologin e orari letti da `config.json`.
  - Mostra il **membro attivo** (nome + codice fiscale) se `config.json` ha `codice_fiscale`/`memberName`; altrimenti mostra l'URL di autologin (solo dominio/primi caratteri per privacy).
  - Mostra i giorni e i turni lavorativi configurati.

Se qualcosa non è corretto, **non chiedere all'utente di modificare a mano `config.json`**: per cambiare account usa `node scripts/lib/members-cli.js set-active <CF>` (vedi sotto); per gli orari usa il tool Edit su `config.json` e poi chiedi conferma.

**Nota su replicabilità su altri Mac**: gli ID dei corsi (`/corso/show/XXXX`) sono **personali** e variano da utente a utente. Per questo lo script `src/autoplay.js` scopre automaticamente i corsi dalla dashboard `https://tecsial.gsdcampus.it/corso/listAllByUser` dopo il login. `config.json` non deve più contenere `courseUrls` (o può contenerlo vuoto `[]`). L'URL di autologin è l'unico dato personale necessario.

---

## Flusso utente principale

L'utente **lancia sempre il comando curl one-liner** per aggiornare/avviare il sistema:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

Questo è il canale principale. Tutti gli altri comandi (`./start.sh`, `./status.sh`, ecc.) sono strumenti secondari che l'AI può usare internamente, ma **non si deve mai presumere che l'utente li lanci a mano**. Quando l'utente chiede di "fare qualcosa" (avviare, controllare, riavviare, aggiornare), la risposta di default è: "rilancia il comando curl e io proseguo da lì".

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

### Membri e stato multi-utente

- `node scripts/import-members.js [csv-path]` — importa l'elenco membri da CSV nel database `data/members.db` (default `~/Downloads/elenco utenti FNC.csv`).
- `node scripts/lib/members-cli.js search <query>` — cerca membri per nome/cognome/CF (lista numerata).
- `node scripts/lib/members-cli.js list` — elenco numerato di tutti i membri.
- `node scripts/lib/members-cli.js active` — membro attualmente attivo (da `config.json`).
- `node scripts/lib/members-cli.js set-active <CF>` — imposta il membro attivo in `config.json` (preserva orari). Poi riavvia con `./start.sh`.
- `node scripts/lib/members-cli.js stats` — totale membri nel database e account con stato.
- `node scripts/lib/members-cli.js migrate-legacy` — migra i vecchi file di stato flat nella cartella per-account.
- `node scripts/lib/dashboard-cli.js summary` — stato aggregato di tutti i membri (done/in_progress/need_help/not_started).
- `node scripts/lib/dashboard-cli.js list` — riga per membro con stato e avanzamento corsi.
- `node scripts/lib/dashboard-cli.js json` — dump completo di `data/dashboard.json`.

**Modello dati**: i membri vivono in `data/members.db` (SQLite). L'account attivo è in `config.json` (`codice_fiscale`). Lo stato personale (corsi, cookie, quiz pending) è in `data/accounts/<CF>/`, isolato per membro. `data/known_answers.json` è **condiviso** tra tutti i membri (banca risposte della classe).

**Switchare membro**: `node scripts/lib/members-cli.js set-active <CF>` poi `./start.sh` (oppure `./start.sh --ignore-hours`). Lo stato dell'account precedente resta nella sua cartella e non viene toccato.

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
5. **Autologin non valido/scaduto**: se `logs/status.json` ha `phase: "autologin_invalid"` (o vedi nel log "AUTOLOGIN NON VALIDO"), il link non autentica più. NON riavviare in loop. Procedi in questo ordine:
   1. Se `data/members.db` esiste, è probabile che contenga un token aggiornato: offri all'utente di **re-selezionare il membro** dal database (`node scripts/lib/members-cli.js search <query>` per trovarlo, poi `node scripts/lib/members-cli.js set-active <CF>`).
   2. Se il token nel database è anch'esso scaduto, l'utente deve fornire un nuovo elenco CSV: esegui `node scripts/import-members.js "<percorso csv>"` (esporta da Numbers: File ▸ Esporta ▸ CSV) e poi re-seleziona il membro.
   3. Fallback manuale: chiedi all'utente il link aggiornato, aggiorna `config.json` con il tool Edit (mantenendo `codice_fiscale` coerente) e riavvia con `./start.sh`.
6. **Quiz non superato / corso in `need_help`**: se `logs/status.json` mostra `phase: "need_help"` o lo stesso `courseUrl` con lo stesso `lastQuizResult` (es. `non superato (24/30)`) ripetuto, lo script ha già automaticamente:
   - catturato le domande del quiz in `data/accounts/<CF>/need_answer.json`;
   - segnato il corso come `need_help` in `data/accounts/<CF>/course_state.json`;
   - passato al prossimo corso (se ce n'è uno).
   Non serve fermare con `./stop.sh` a meno che l'utente non voglia intervenire subito. Devi invece:
   1. Leggere `data/accounts/<CF>/need_answer.json` (CF = `config.codice_fiscale`, o derivato dall'URL di autologin).
   2. Cercare la risposta corretta (online con `WebSearch`/`WebFetch`, oppure chiedendo all'utente).
   3. Aggiungerla alla banca **condivisa** `data/known_answers.json` con `node scripts/lib/answers-cli.js set "domanda" "risposta"`.
   4. Se vuoi far riprovare subito quel corso, cancella il suo stato con `node -e "require('./src/lib/course-state').resetCourse('.', require('./src/lib/course-state').readState('.'), 'URL_CORSO')"`.
   5. Riavviare con `./start.sh` o `./start.sh --ignore-hours`.
   Se tutti i corsi sono `done` o `need_help`, l'autoplay esce con codice 0 e `phase: "need_help"`; lo scheduler in `ignore-hours` aspetta 10 minuti prima di riavviare, dando tempo all'AI/utente di intervenire.

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
- Non cancellare `data/known_answers.json` (banca condivisa), `data/members.db` (elenco membri con credenziali) né i file sotto `data/accounts/<CF>/` (stato e cookie personali).
- **Mai copiare `data/accounts/<CF>/storage_state.json` tra cartelle account diverse**: contiene i cookie di sessione di quel membro; mescolarli provoca accessi con l'identità sbagliata.
- Se devi correggere `config.json` (autologin o orari), usa il tool Edit e salva il JSON valido. Per cambiare account preferisci `node scripts/lib/members-cli.js set-active <CF>`.
- Non eseguire comandi distruttivi sul sistema.
- Se lo script richiede una dipendenza mancante, suggerisci `./scripts/setup.sh` oppure eseguilo tu stesso se l'utente lo chiede.

## Quiz e domande sconosciute

- `src/lib/quiz.js` risolve i quiz usando prima `data/known_answers.json` (matching per similarità, soglia 0.75). Questa banca è **condivisa** tra tutti i membri.
- Se una domanda non è presente in `known_answers.json`, lo script chiede a Ollama la risposta in base alla conoscenza generale del modello. Il modello è configurabile in `config.json` (`ollamaModel`, default `gemma4:31b-cloud`); per il monitor/autoplay consigliato il modello cloud più economico e sufficiente per quiz in italiano è `gemma4:cloud`. Il parsing della risposta è multi-strategia (prefisso "Risposta: X", frase, lettera isolata, markdown, match testo) e, se la confidenza è bassa, viene fatto **un tentativo di conferma** con un prompt che forza una singola lettera.
- Le risposte date da Ollama vengono salvate in `data/accounts/<CF>/pending_quiz_answers.json` (per-account). **Solo se il quiz viene superato**, quelle risposte vengono promosse automaticamente nella banca condivisa `data/known_answers.json` (la banca cresce solo con risposte verificate dall'esito).
- Se Ollama non riesce a rispondere, lo script si ferma e salva la domanda in `data/accounts/<CF>/need_answer.json`: in quel caso puoi cercare la risposta online, aggiornare `known_answers.json` e riavviare.
- Quando un quiz finale risulta non superato, lo script salva **tutte** le domande del quiz in `data/need_answer.json` e segnala il corso come `need_help` in `data/course_state.json`, in attesa di intervento AI/utente.
- Strumenti manutenzione banca risposte: `node scripts/lib/answers-cli.js stats|list|merge` e `node scripts/lib/answers-cli.js set "domanda" "risposta"`.

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
- esito ultimo quiz (`lastQuizResult` in `logs/status.json`, se presente)
- riepilogo corsi (`courseStateSummary` in `logs/status.json`, se presente)
- ultimo errore (se presente)
- azione che hai intrapreso

## Permessi di Claude Code

`./launch-ai-supervisor.sh` avvia Claude con `--dangerously-skip-permissions`. All'inizio lo script chiede la password di sudo una solta volta (`sudo -v`) e la mantiene valida per tutta la sessione tramite un keepalive in background. Durante il setup l'utente deve solo confermare eventuali richieste di installazione/aggiornamento da Homebrew/npm (sempre `y`). I permessi di Claude Code non richiedono conferme ripetute.

## Requisito login Ollama

Il modello configurato in `config.json` (`ollamaModel`, default `gemma4:31b-cloud`) è un modello **cloud Ollama** e richiede l'autenticazione. Per il monitor/autoplay il modello cloud più economico e sufficiente per quiz in italiano è `qwen3.5:4b`. `./launch-ai-supervisor.sh` e `./scripts/setup.sh` gestiscono automaticamente il login: aprono `ollama login` in modo interattivo, aspettano che l'utente inserisca le credenziali, poi procedono con il download del modello e l'avvio di Claude. Non devi fare altro.

## Configurazione iniziale

La prima volta che `./launch-ai-supervisor.sh` viene eseguito, `setup.sh` chiede interattivamente:
1. La **schermata "Chi sei?"**: menu interattivo nel terminale navigabile con frecce ↑/↓ e Invio. Permette di cercare per nome/cognome/CF nel database `data/members.db`, vedere la lista completa, importare il CSV, incollare manualmente il link di autologin o mantenere l'account attuale.
2. I giorni lavorativi (default lun-venerdì).
3. La modalità oraria preferita (continuato, mezza giornata, classico o personalizzato) e gli orari.

Questi dati vengono salvati in `config.json` (con `codice_fiscale` + `memberName` + `autologinUrl` + `workSchedule`). Lo stato personale viene migrato in `data/accounts/<CF>/`. In seguito, ogni avvio mostrerà solo una conferma dei dati configurati.

## Note tecniche

- Lo script principale è `src/autoplay.js`; usa Playwright in modalità headless.
- `start.sh` controlla i requisiti e la configurazione prima di avviare.
- L'elenco membri è in `data/members.db` (SQLite, richiede Node >=22 per `node:sqlite` built-in). Lo stato per-account è in `data/accounts/<CF>/`. La dashboard aggregata è rigenerata in `data/dashboard.json` alla fine di ogni run.
- I log sono in `logs/`.
- `backups/` contiene copie di sicurezza dello script (se presenti).
- `scripts/lib/schedule-cli.js` fornisce helper per leggere e validare gli orari dagli script shell. `scripts/lib/members-cli.js` e `scripts/lib/dashboard-cli.js` gestiscono membri e stato cross-utente.
