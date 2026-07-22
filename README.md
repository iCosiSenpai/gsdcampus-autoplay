:red_circle: **Questo script automatizza l'accesso a un corso e-learning. Usalo solo se sei autorizzato dal titolare del corso/account.**

# gsdcampus-autoplay

Script Playwright per completare in automatico le video-lezioni e i quiz del corso e-learning GSD Campus (tecsial.gsdcampus.it).

## Comando principale

Apri il Terminale, incolla questo comando su **una sola riga** e premi Invio:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

> Se dopo l'incolla non succede nulla, premi Invio: alcuni copia-incolla non includono l'"a capo" finale che avvia il comando.

Il comando apre con una mascotte compatta e un menu centrato, con descrizioni leggibili per ogni azione. Su Terminal.app o iTerm2 allarga automaticamente una finestra troppo piccola per mostrare bene menu e messaggi. Le finestre già abbastanza grandi o a schermo intero non vengono ridotte. Se macOS chiede di consentire a Terminale di controllare la propria finestra, autorizzalo: serve solo a impostarne le dimensioni; se rifiuti, il menu resta comunque utilizzabile.

È l'unico comando che ti serve e vale per **tutte** le occasioni:
- **prima installazione**: scarica il progetto, installa i requisiti e avvia lo scheduler;
- **aggiornamenti**: scarica fix e banca risposte, aggiorna solo ciò che serve e riavvia senza toccare account/orari;
- **avvio quotidiano**: prepara l'inbox, usa Claude solo per eventuali quiz nuovi e poi termina lasciando attivo soltanto lo scheduler.

> 🟡 **Regola d'oro.** Rilancia questo `curl` per aggiornare o avviare. Non serve tenere aperta una finestra AI: video, orari, sync e monitoraggio sono deterministici. Claude Code viene eseguito in modalità one-shot esclusivamente quando esistono domande quiz aperte; con inbox vuota le chiamate AI sono zero.

> 🔧 **Segnalazione bug al manutentore (attiva per tutti).** Quando l'AI non riesce a risolvere un problema in loco, può aprire in automatico una *issue* sulla repo pubblica del manutentore (GitHub) invece di "rompere" il codice. È **attiva di default** su ogni installazione e non richiede nessun token né account GitHub da parte tua: la segnalazione passa per un receiver server-side (Cloudflare Worker del manutentore) che tiene il token come segreto lato server — il token non sta nel pacchetto pubblico (GitHub lo bloccherebbe e lo revocherebbe automaticamente). I dati sensibili (CF, token di sessione, cookie) sono redatti prima dell'invio, e l'AI ti mostra sempre il draft e chiede conferma prima di spedire.

Rilanciandolo su un'installazione esistente compare un menu:
1. **Aggiorna e avvia** — pull del codice, check dipendenze e avvio autonomo (consigliato).
2. **Cambia collega o orari** — seleziona l'account e modifica i turni.
3. **Ripara l'installazione** — riallinea il codice e reinstalla le dipendenze.
4. **Solo avvia** — non aggiorna codice, account o orari; riconcilia gli artefatti runtime e avvia.
5. **Diagnostica on-demand** — controlla rete, runtime e presenza delle CLI senza avviare processi AI.
6. **Disinstalla** — rimuove i componenti scelti, con conferma separata.
7. **Esci**.

In tutti i casi (tranne la disinstallazione) il tuo `config.json` con link e orari resta al suo posto.

> Puoi avviare la disinstallazione dalla voce 6 del comando `curl`. Da dentro la cartella del progetto (manutentore): `cd ~/gsdcampus-autoplay && ./scripts/setup.sh --uninstall`

> **Nota sull'aggiornamento:** lo script confronta `package.json` e `package-lock.json` con lo stato di `node_modules`. Se sono cambiati (per esempio dopo un aggiornamento di Playwright), esegue automaticamente `npm install` e, se serve, reinstalla il browser Chromium. Se invece sono già allineati, salta tutto e parte subito.

> 🔒 **Modello di fiducia (`curl | bash`).** Il comando scarica ed esegue codice da Internet: ti fidi del proprietario del repository e del branch `main`. Quando esiste un quiz aperto, lo script installa/verifica Ollama CLI e Claude Code dai canali ufficiali; Claude viene fissato almeno alla versione verificata in `scripts/setup/versions.sh`. Per bloccare anche il repository a una release immutabile, il manutentore può impostare `PINNED_TAG` in `install.sh`.

## Prima installazione

La prima volta il Terminale ti chiede alcune cose: rispondi con calma.
- la **password del Mac (sudo)** — una sola volta, all'inizio; se il setup dura a lungo può richiederla di nuovo (niente keepalive in background: ruberebbe i tasti al menu "Chi sei?");
- conferme di **installazione/aggiornamento/verifica dipendenze** (anche `y/n`) → rispondi **sempre sì**;
- il **login Ollama** → non compare durante un avvio senza quiz; solo al primo batch necessario si apre il browser, accedi e torna al Terminale senza creare o incollare API key;
- Ollama e Claude Code vengono installati/verificati automaticamente soltanto dopo che compare un quiz aperto; con inbox vuota anche le CLI restano non eseguite;
- daemon Ollama e proxy budget vengono avviati soltanto per il batch e poi chiusi;
- le vecchie installazioni OpenCode vengono lasciate intatte ma non sono più invocate;
- il proxy limita a **400 richieste rolling/7 giorni**, 80/24 ore, 8/minuto, una generazione alla volta e massimo 8 richieste per batch;
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

## Avviare nei giorni successivi

Rilancia il comando `curl` principale. Per manutenzione locale, l'equivalente è:

```bash
cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

Il launcher sincronizza banca e inbox, esegue al massimo un batch Claude se necessario, avvia lo scheduler e termina. Non resta aperta alcuna chat AI.

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

Se vuoi davvero reinstallare/aggiornare tutto (Homebrew, npm, browser, Ollama, Claude Code, ecc.), usa il comando principale e scegli **Ripara l'installazione**. Per farlo a mano (manutentore):

```bash
cd ~/gsdcampus-autoplay && ./scripts/setup.sh --yes --force-update && ./launch-ai-supervisor.sh
```

## Ricominciare da zero (cancella membro attivo e orari)

Se vuoi reinserire account e orari, rilancia il `curl` e scegli **Cambia collega o orari**. Per farlo manualmente (manutentore):

```bash
cd ~/gsdcampus-autoplay && rm -f config.json && ./scripts/setup.sh && ./launch-ai-supervisor.sh
```

## Strumenti interni (manutentori / diagnostica)

> 🟡 Questi comandi sono per manutentori o per una sessione Codex/Kiro aperta sul repository. L'utente standard usa il `curl` principale.

```bash
./start.sh                              # avvia scheduler autoplay (rispetta orari lavoro)
./start.sh --ignore-hours               # avvia subito ignorando gli orari
./stop.sh                               # ferma autoplay e scheduler
./status.sh                             # stato, heartbeat, log, orario configurato
./scripts/setup.sh                      # installa/aggiorna requisiti e configura config.json
./scripts/setup.sh --yes                # modalità automatica, salta ciò che è già installato
./scripts/setup.sh --yes --force-update # forza aggiornamento di tutto
./scripts/check-requirements.sh --runtime # verifica solo ciò che serve ad autoplay/scheduler
./scripts/check-requirements.sh --ai      # presenza CLI; versioni solo con quiz aperti
./scripts/run-claude-quiz-batch.sh        # batch one-shot; exit 20 = zero quiz/zero AI
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

- `launch-ai-supervisor.sh` — bootstrap: sync/inbox, batch Claude eventuale, avvio scheduler
- `scripts/run-claude-quiz-batch.sh` — lifecycle lazy di Ollama/proxy/Claude
- `scripts/lib/claude-quiz-runner.js` — payload sanitizzato, JSON schema, validazione e applicazione
- `AGENTS.md` / `CLAUDE.md` — contratto per sessioni esterne aperte sul repository
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
- `logs/ollama.log` — log del daemon Ollama locale
- `logs/scheduler.log` — log dello scheduler (orari, prossimi avvii)

## Quiz e banca risposte condivisa

- La **banca risposte condivisa** vive su due livelli: `data/known_answers.json` è la banca **TRUSTED locale** (per-Mac, non committata — cresce con le risposte verificate che l'autoplay scopre su quella macchina); `data/known_answers_public.json` è la banca **condivisa committata** nel repo, uguale per tutti i colleghi, da cui i nuovi install si seedano e che l'aggiornamento scarica e mergia nel file locale. Cresce solo con risposte verificate — dalla piattaforma (scrape post-quiz delle risposte corrette) o dall'AI supervisore (ricerca online + ragionamento). I tentativi di Ollama **non** vengono mai promossi automaticamente (restano per-account in `pending_quiz_answers.json`): così un quiz superato al 24/30 = 80% non inserisce più risposte sbagliate nella banca condivisa di tutta la classe. La distribuzione ai colleghi **non richiede git push**: `./scripts/publish-answers.sh` invia le risposte al Cloudflare Worker del manutentore, che le unisce (solo aggiunte, mai sovrascritture) e le committà su `main`.
- Se una domanda non è in banca, l'autoplay non interroga modelli direttamente: salva l'handoff protetto e il batch Claude Code on-demand interviene soltanto dopo `openQuizRequests > 0`. `src/lib/ollama-quiz.js` resta solo come parser/compatibilità storica e non è chiamato dal flusso autoplay.
- Le domande sconosciute finiscono nell'inbox unificata `need_answer.json` + `ai_quiz_request.json` (con eventuali guess legacy): il batch invia a Claude soltanto domanda, opzioni e guess, valida il JSON restituito e scrive le risposte accettate nella banca TRUSTED. L'esito del quiz (superato/non superato + punteggio) finisce in `logs/status.json` (`lastQuizResult`) ed è mostrato da `./status.sh`.
- Quando l'autoplay incontra una domanda senza risposta trusted, sospende quel quiz e salva l'handoff in `data/accounts/<CF>/need_answer.json` + `ai_quiz_request.json`; con inbox vuota Claude, Ollama e proxy non vengono avviati.
- Manutenzione banca: `answers-cli audit --fix` rimuove solo duplicati Unicode con risposta equivalente; risposte discordanti vengono bloccate. `answers-cli verify --remote` confronta hash e contenuto canonico con `main`.

## Robustezza autologin

Il link autologin è personale e può scadere. Se il link non autentica più, lo script lo rileva
(la piattaforma mostra la pagina di login) ed esce subito con stato `autologin_invalid` e un
messaggio chiaro, invece di ritentare a vuoto. `./status.sh` segnala di aggiornare il link in `config.json`.

## Strumento di esplorazione (manutentore)

`node scripts/explore.js <autologin1> [autologin2] ...` esplora uno o più account e salva in
`debug/exploration/<codice>/` la struttura reale di dashboard, lezioni e quiz. Utile per validare
i selettori e raccogliere domande dei quiz. I dump contengono dati personali: `debug/` è in `.gitignore`.
