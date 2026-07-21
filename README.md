:red_circle: **Questo script automatizza l'accesso a un corso e-learning. Usalo solo se sei autorizzato dal titolare del corso/account.**

# gsdcampus-autoplay

Script Playwright per completare in automatico le video-lezioni e i quiz del corso e-learning GSD Campus (tecsial.gsdcampus.it).

## Comando principale

Apri il Terminale, incolla questo comando su **una sola riga** e premi Invio:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

> Se dopo l'incolla non succede nulla, premi Invio: alcuni copia-incolla non includono l'"a capo" finale che avvia il comando.

È l'unico comando che ti serve e vale per **tutte** le occasioni:
- **prima installazione** su un Mac nuovo: scarica il progetto in `~/gsdcampus-autoplay`, installa tutti i requisiti e apre l'AI;
- **aggiornamenti** successivi: scarica fix e banca risposte aggiornate, **verifica le dipendenze e le aggiorna solo se necessario**, senza toccare autologin e orari (`config.json`), poi apre l'AI;
- **avvio** quotidiano: apre l'AI.

> 🟡 **Regola d'oro.** L'unico comando manuale ammesso è questo `curl` (e `./launch-ai-supervisor.sh` per riaprire l'AI). **Per tutto il resto — avviare, fermare, controllare lo stato, cambiare utente, cambiare orari, risolvere problemi — chiedi all'AI in chat.** Non lanciare a mano `start.sh`, `stop.sh`, `status.sh`, `setup.sh`, `members-cli` e simili: sono strumenti **interni** usati dall'AI, non comandi per l'utente. Se ti viene in mente di lanciarne uno, scrivilo all'AI invece.

> 🔧 **Segnalazione bug al manutentore (attiva per tutti).** Quando l'AI non riesce a risolvere un problema in loco, può aprire in automatico una *issue* sulla repo pubblica del manutentore (GitHub) invece di "rompere" il codice. È **attiva di default** su ogni installazione e non richiede nessun token né account GitHub da parte tua: la segnalazione passa per un receiver server-side (Cloudflare Worker del manutentore) che tiene il token come segreto lato server — il token non sta nel pacchetto pubblico (GitHub lo bloccherebbe e lo revocherebbe automaticamente). I dati sensibili (CF, token di sessione, cookie) sono redatti prima dell'invio, e l'AI ti mostra sempre il draft e chiede conferma prima di spedire.

Rilanciandolo su un'installazione esistente compare un menu:
1. **Aggiorna e avvia** — pull del codice + check/aggiornamento condizionale delle dipendenze, poi apre l'AI (consigliato).
2. **Cambia link autologin/orari** — reinserisci accesso e orari, poi avvia.
3. **Reinstallazione pulita** — riallinea il codice e reinstalla tutte le dipendenze.
4. **Solo avvia** — apre l'AI senza modificare nulla.
5. **Disinstalla** — rimuove dipendenze, browser Playwright, Ollama, OpenCode, log e (opzionale) la cartella del progetto; la chiave Ollama Cloud viene rimossa solo con una conferma separata.
6. **Annulla**.

In tutti i casi (tranne la disinstallazione) il tuo `config.json` con link e orari resta al suo posto.

> Puoi avviare la disinstallazione anche dal menu 5 del comando `curl`, oppure chiedendo all'AI "disinstalla tutto". Da dentro la cartella del progetto (manutentore):  
> `cd ~/gsdcampus-autoplay && ./scripts/setup.sh --uninstall`

> **Nota sull'aggiornamento:** lo script confronta `package.json` e `package-lock.json` con lo stato di `node_modules`. Se sono cambiati (per esempio dopo un aggiornamento di Playwright), esegue automaticamente `npm install` e, se serve, reinstalla il browser Chromium. Se invece sono già allineati, salta tutto e parte subito.

> 🔒 **Modello di fiducia (curl | bash).** Il comando qui sopra scarica ed esegue codice da Internet: è lo stesso livello di fiducia di qualsiasi `curl | bash`. Il sorgente vive su `github.com/iCosiSenpai/gsdcampus-autoplay` (branch `main`, **mobile**: ogni push su `main` cambia ciò che il comando esegue al prossimo lancio). Non c'è firma crittografica né verifica di checksum: ti fidi del proprietario del repository. Lo script scarica Ollama CLI e OpenCode dai rispettivi canali ufficiali (senza checksum pubblicato da quei progetti), quindi la fiducia si estende anche a quegli installer. Per bloccare il codice a una versione verificata e immutabile, il manutentore può taggare una release (`git tag v0.1.0`) e impostare `PINNED_TAG` in `install.sh`.

## Prima installazione

La prima volta il Terminale ti chiede alcune cose: rispondi con calma.
- la **password del Mac (sudo)** — una sola volta, all'inizio; se il setup dura a lungo può richiederla di nuovo (niente keepalive in background: ruberebbe i tasti al menu "Chi sei?");
- conferme di **installazione/aggiornamento/verifica dipendenze** (anche `y/n`) → rispondi **sempre sì**;
- la **chiave Ollama Cloud** → viene inserita una volta nel Portachiavi macOS, senza finire in config o log;
- sui Mac aggiornati da una versione precedente, una domanda **una-tantum** permette di conservare Claude ripulendo solo gli override GSD/Ollama oppure disinstallare il client; poi viene configurato OpenCode;
- il proxy locale limita il supervisore a **400 richieste rolling/7 giorni**, 80/24 ore, 8/minuto e una sola richiesta contemporanea; il limite Ollama reale resta basato anche sul tempo GPU;
- la **selezione del tuo account** con la schermata interattiva **"Chi sei?"**: nel terminale appare un menu navigabile con le frecce ↑/↓ e Invio; puoi cercare per nome, cognome o codice fiscale, vedere la lista completa, importare il CSV dei membri, incollare manualmente l'autologin o mantenere l'account attuale;
- i **giorni lavorativi** (default lun–ven);
- la **modalità oraria** preferita:
  1. **Continuato** — un solo turno (es. 09:00–18:00).
  2. **Solo mattina** — es. 09:00–13:00.
  3. **Solo pomeriggio** — es. 14:00–18:00.
  4. **Classico** — due turni (default 09:00–13:00 e 16:00–20:00).
  5. **Personalizzato** — fino a 3 turni a scelta.

Gli orari si possono scrivere come vuoi: `9`, `16`, `9:30`, `09:30`, `9.30`, `0930`, `1630`.

Non avere paura di confermare: serve tutto per automatizzare il corso.

> **Requisito**: Node.js >= 22 (per il database membri SQLite built-in). Lo script di setup installa/aggiorna Node se necessario.

In alternativa, manualmente con git:

```bash
git clone https://github.com/iCosiSenpai/gsdcampus-autoplay.git && cd gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

## Riaprire l'AI nei giorni successivi

Se hai già installato e vuoi solo riaprire l'AI senza passare dall'installer:

```bash
cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

Salta l'installazione e apre subito l'AI. Una volta aperta, **non ricordare comandi tecnici: parlane in italiano**, per esempio `controlla il corso`, `come sta andando?`, `avvia il corso`, `ferma tutto`. L'AI avvia, ferma e controlla lo script al posto tuo e ti dice come sta andando.

## Gestione membri e stato multi-utente

L'elenco di tutti i membri del corso è in un database SQLite (`data/members.db`), importato dal CSV esportato da Numbers. Ogni Mac tiene lo **stato personale** (corsi completati, cookie di sessione, risposte quiz in attesa) nella propria cartella `data/accounts/<codice fiscale>/`. La banca delle risposte ha due livelli: `data/known_answers.json` è la banca **TRUSTED locale** (per-Mac, cresce con le risposte verificate); `data/known_answers_public.json` è la banca **condivisa** che il manutentore pubblica e i colleghi ricevono automaticamente al prossimo aggiornamento.

Comandi **interni** (l'utente non li lancia: li usa l'AI su richiesta; riportati qui solo come riferimento per manutentori):

```bash
# Importa/aggiorna l'elenco membri da CSV (default ~/Downloads/elenco utenti FNC.csv)
node scripts/import-members.js

# Cerca un membro e vedi il codice fiscale
node scripts/lib/members-cli.js search "Mario"

# Cambia account attivo (poi riavvia con ./start.sh)
node scripts/lib/members-cli.js set-active <CODICE_FISCALE>

# Stato aggregato di tutti i membri (chi ha finito, chi è bloccato, chi non ha iniziato)
node scripts/lib/dashboard-cli.js summary
node scripts/lib/dashboard-cli.js list
```

Per cambiare utente **basta chiederlo all'AI** (es. "cambia utente in Mario Rossi"): l'AI esegue `members-cli set-active` e riavvia. Lo stato del membro precedente resta salvato nella sua cartella.

## Aggiornamento forzato

Se vuoi davvero reinstallare/aggiornare tutto (Homebrew, npm, browser, Ollama, ecc.), di solito basta chiedere all'AI "aggiorna tutto". Per farlo a mano (manutentore):

```bash
cd ~/gsdcampus-autoplay && ./scripts/setup.sh --yes --force-update && ./launch-ai-supervisor.sh
```

## Ricominciare da zero (cancella membro attivo e orari)

Se vuoi reinserire account e orari da capo, **non cancellare `config.json` a mano**: chiedi all'AI "ricomincia da zero" e lei rifà la configurazione guidata. Per farlo manualmente (manutentore):

```bash
cd ~/gsdcampus-autoplay && rm -f config.json && ./scripts/setup.sh && ./launch-ai-supervisor.sh
```

## Strumenti interni (manutentori / diagnostica)

> 🟡 Questi comandi **non sono per l'utente**: li usa l'AI internamente quando glieli chiedi in chat, oppure un manutentore per diagnostica. L'utente standard non ha bisogno di lanciarli.

```bash
./start.sh                              # avvia scheduler autoplay (rispetta orari lavoro)
./start.sh --ignore-hours               # avvia subito ignorando gli orari
./stop.sh                               # ferma autoplay e scheduler
./status.sh                             # stato, heartbeat, log, orario configurato
./scripts/setup.sh                      # installa/aggiorna requisiti e configura config.json
./scripts/setup.sh --yes                # modalità automatica, salta ciò che è già installato
./scripts/setup.sh --yes --force-update # forza aggiornamento di tutto
./scripts/check-requirements.sh         # verifica requisiti
./scripts/maintenance.sh                # ruota log grandi e pulisce vecchi screenshot/dump
./scripts/uninstall.sh                  # rimuove dipendenze, modelli, CLI e progetto (conferma)
./scripts/prepare-package.sh --yes      # crea sul Desktop copia pulita per un collega
./scripts/prepare-package.sh --yes --zip # ...e anche lo zip
./scripts/dev-check.sh                  # controlli pre-push (sintassi + lint anti-SIGPIPE + test unitari)
npm test                                # solo test unitari (node:test, pure functions, no browser)
./scripts/doctor.sh [--full]            # checkup a semaforo (selettori DOM + con --full sonda autologin)
node scripts/lib/metrics-cli.js summary # metriche phase ultime 24h (logs/metrics.jsonl, no dati personali)
node scripts/lib/selector-probe.js      # verifica marker DOM critici sulle fixture
node scripts/lib/answers-cli.js audit [--fix]   # duplicati/conflitti Unicode; fix solo equivalenti
node scripts/lib/answers-cli.js verify [--remote] # integrità trusted/public e confronto con main
node scripts/lib/course-state-backup-cli.js list # snapshot recuperabili dello stato account
node scripts/lib/course-state-backup-cli.js restore <nome> --yes # ripristino verificato stesso account
# CHANGELOG.md: aggiungere una sezione "## data" con bullet semplici a ogni push
# rilevante — il curl mostra le righe nuove nel box "Novità" dopo l'update.

# Helper orari
node scripts/lib/schedule-cli.js describe      # descrizione orario configurato
node scripts/lib/schedule-cli.js is-work-time  # siamo in orario? (yes/no)
node scripts/lib/schedule-cli.js next-start    # prossimo inizio turno (ISO)
node scripts/lib/schedule-cli.js next-end      # prossima fine turno (ISO)
```

## Struttura

- `launch-ai-supervisor.sh` — unico comando per l'utente
- `AGENTS.md` — istruzioni per il supervisore OpenCode (CLAUDE.md resta compatibile per installazioni legacy)
- `AGENTS.md` — istruzioni equivalenti per sessioni Codex aperte sul repository
- `docs/QUIZ.md`, `docs/ISSUES.md`, `docs/SETUP.md`, `docs/TECH.md` — runbook tematici condivisi dai supervisori
- `src/autoplay.js` — main
- `src/lib/` — logger, monitor, quiz, video, schedule
- `scripts/lib/schedule-cli.js` — helper orari per gli script shell
- `scripts/` — setup, check requisiti, proxy Ollama Cloud e budget AI
- `data/` — risposte conosciute, risposte in attesa di verifica, mappa corsi, stato sessione
- `logs/` — log, heartbeat, status.json, supervisor.log e ai-cloud-proxy.log (mai prompt o chiavi)
- `debug/` — screenshot e dump HTML in caso di errore
- `backups/accounts/<CF>/course-state/` — snapshot con checksum dello stato corsi prima di riaperture/reset; mai cookie o database membri
- `README-COLLEGHI.md` — guida semplificata per i colleghi

## Modalità headless

Lo script usa `chromium.launch({ headless: true })`. Non compare nessuna finestra del browser.

## Note su replicabilità

Gli ID dei corsi (`/corso/show/XXXX`) sono **personali** e variano da utente a utente.

Per questo lo script `src/autoplay.js`, dopo il login, naviga automaticamente sulla dashboard e scopre i corsi assegnati all'utente. Non serve più inserire manualmente gli URL dei corsi in `config.json`.

L'URL di autologin è **personale**: la prima volta lo script te lo chiede in terminale durante il setup. In seguito, l'AI mostrerà solo una conferma; se qualcosa non è corretto, basta scriverlo in chat e l'AI modificherà `config.json` al posto tuo.

Gli orari di lavoro sono salvati in `config.json` nella chiave `workSchedule` (`days` + `shifts`). Puoi modificarli **chattando con l'AI** (es. "cambia orari: 9-18 continuato") — l'AI edita `config.json` per te. In alternativa li reinserisci rilanciando il `curl` e scegliendo "Cambia link autologin/orari".

## Orari di lavoro automatici

I Mac in negozio restano accesi 24/7. Lo scheduler gestisce automaticamente i turni configurati in `config.json`:

- Modalità rapide disponibili in `setup.sh`: continuato, solo mattina, solo pomeriggio, classico, personalizzato.
- I formati orari accettati sono flessibili: `9`, `16`, `9:30`, `09:30`, `9.30`, `0930`, `1630`.
- Default: lunedì–venerdì, 09:00–13:00 e 16:00–20:00.
- Se avvii `start.sh` fuori orario, lo scheduler aspetta l'inizio del prossimo turno e poi avvia l'autoplay.
- Fuori orario `status.json` resta fresco con fase `off_hours`, heartbeat e prossimo turno: un vecchio errore viene archiviato come run precedente e non genera allarmi fantasma.
- Prima di ogni sessione browser lo scheduler esegue il probe offline dei selettori: se fallisce, l'autoplay non apre la piattaforma e non tocca quiz.
- A fine turno, `src/autoplay.js` esce gracefulmente; lo scheduler aspetta il turno successivo e lo riavvia. Tutto autonomo: lanciato una volta, si ferma e riprende da solo a ogni cambio turno (il check di fine turno gira anche durante un video, con 15 min di tolleranza per completare il contenuto in corso).
- `start.sh` attiva anche `caffeinate` (built-in macOS) per tenere il Mac sveglio finché gira lo scheduler.
- `./start.sh --ignore-hours` ignora gli orari e non si ferma mai (pausa 10 min tra i run): solo se vuoi girare fuori orario senza fermarti.
- Nessun cron richiesto.

## Monitoring

- `logs/status.json` — stato live
- `logs/heartbeat.txt` — ultima attività
- `logs/autoplay.log` — log principale
- `logs/supervisor.log` — log delle azioni dell'AI
- `logs/ollama.log` — log di Ollama
- `logs/scheduler.log` — log dello scheduler (orari, prossimi avvii)

## Quiz e banca risposte condivisa

- La **banca risposte condivisa** vive su due livelli: `data/known_answers.json` è la banca **TRUSTED locale** (per-Mac, non committata — cresce con le risposte verificate che l'autoplay scopre su quella macchina); `data/known_answers_public.json` è la banca **condivisa committata** nel repo, uguale per tutti i colleghi, da cui i nuovi install si seedano e che l'aggiornamento scarica e mergia nel file locale. Cresce solo con risposte verificate — dalla piattaforma (scrape post-quiz delle risposte corrette) o dall'AI supervisore (ricerca online + ragionamento). I tentativi di Ollama **non** vengono mai promossi automaticamente (restano per-account in `pending_quiz_answers.json`): così un quiz superato al 24/30 = 80% non inserisce più risposte sbagliate nella banca condivisa di tutta la classe. La distribuzione ai colleghi **non richiede git push**: `./scripts/publish-answers.sh` invia le risposte al Cloudflare Worker del manutentore, che le unisce (solo aggiunte, mai sovrascritture) e le committà su `main`.
- Se una domanda non è in banca, lo script può usare Ollama (modello configurabile in `config.json` tramite `ollamaModel`) con **few-shot** + **self-consistency**. Nel flusso predefinito `useOllamaForQuiz:false`, quindi il quiz non consuma richieste AI: l'AI supervisore OpenCode interviene solo sulle domande in handoff.
- Le domande sconosciute o a bassa confidenza finiscono in `data/accounts/<CF>/ai_quiz_request.json` (con i tentativi di Ollama e la confidenza): l'AI supervisore le risolve e scrive la risposta verificata nella banca TRUSTED. L'esito (superato/non superato + punteggio) finisce in `logs/status.json` (`lastQuizResult`) ed è mostrato da `./status.sh`.
- Se Ollama non sa rispondere, il quiz si ferma e salva la domanda in `data/accounts/<CF>/need_answer.json` + `ai_quiz_request.json`.
- Manutenzione banca: `answers-cli audit --fix` rimuove solo duplicati Unicode con risposta equivalente; risposte discordanti vengono bloccate. `answers-cli verify --remote` confronta hash e contenuto canonico con `main`.

## Robustezza autologin

Il link autologin è personale e può scadere. Se il link non autentica più, lo script lo rileva
(la piattaforma mostra la pagina di login) ed esce subito con stato `autologin_invalid` e un
messaggio chiaro, invece di ritentare a vuoto. `./status.sh` segnala di aggiornare il link in `config.json`.

## Strumento di esplorazione (manutentore)

`node scripts/explore.js <autologin1> [autologin2] ...` esplora uno o più account e salva in
`debug/exploration/<codice>/` la struttura reale di dashboard, lezioni e quiz. Utile per validare
i selettori e raccogliere domande dei quiz. I dump contengono dati personali: `debug/` è in `.gitignore`.
