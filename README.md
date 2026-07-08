:red_circle: **Questo script automatizza l'accesso a un corso e-learning. Usalo solo se sei autorizzato dal titolare del corso/account.**

# gsdcampus-autoplay

Script Playwright per completare in automatico le video-lezioni e i quiz del corso e-learning GSD Campus (tecsial.gsdcampus.it).

## Comando principale

Apri il Terminale, incolla questo comando su **una sola riga** e premi Invio:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

> Se incolli e l'ultima riga non parte, premi Invio una seconda volta.

È l'unico comando che ti serve e vale per **tutte** le occasioni:
- **prima installazione** su un Mac nuovo: scarica il progetto in `~/gsdcampus-autoplay`, installa tutti i requisiti e apre l'AI;
- **aggiornamenti** successivi: scarica fix e banca risposte aggiornate, **verifica le dipendenze e le aggiorna solo se necessario**, senza toccare autologin e orari (`config.json`), poi apre l'AI;
- **avvio** quotidiano: apre l'AI.

> 🟡 **Regola d'oro.** L'unico comando manuale ammesso è questo `curl` (e `./launch-ai-supervisor.sh` per riaprire l'AI). **Per tutto il resto — avviare, fermare, controllare lo stato, cambiare utente, cambiare orari, risolvere problemi — chiedi all'AI in chat.** Non lanciare a mano `start.sh`, `stop.sh`, `status.sh`, `setup.sh`, `members-cli` e simili: sono strumenti **interni** usati dall'AI, non comandi per l'utente. Se ti viene in mente di lanciarne uno, scrivilo all'AI invece.

Rilanciandolo su un'installazione esistente compare un menu:
1. **Aggiorna e avvia** — pull del codice + check/aggiornamento condizionale delle dipendenze, poi apre l'AI (consigliato).
2. **Cambia link autologin/orari** — reinserisci accesso e orari, poi avvia.
3. **Reinstallazione pulita** — riallinea il codice e reinstalla tutte le dipendenze.
4. **Solo avvia** — apre l'AI senza modificare nulla.
5. **Disinstalla** — rimuove dipendenze, browser Playwright, Ollama, Claude Code, log e (opzionale) la cartella del progetto; ripulisce anche la riga `PATH` che lo script aveva aggiunto a `.zshrc`/`.bash_profile`.
6. **Annulla**.

In tutti i casi (tranne la disinstallazione) il tuo `config.json` con link e orari resta al suo posto.

> Puoi avviare la disinstallazione anche dal menu 5 del comando `curl`, oppure chiedendo all'AI "disinstalla tutto". Da dentro la cartella del progetto (manutentore):  
> `cd ~/gsdcampus-autoplay && ./scripts/setup.sh --uninstall`

> **Nota sull'aggiornamento:** lo script confronta `package.json` e `package-lock.json` con lo stato di `node_modules`. Se sono cambiati (per esempio dopo un aggiornamento di Playwright), esegue automaticamente `npm install` e, se serve, reinstalla il browser Chromium. Se invece sono già allineati, salta tutto e parte subito.

> 🔒 **Modello di fiducia (curl | bash).** Il comando qui sopra scarica ed esegue codice da Internet: è lo stesso livello di fiducia di qualsiasi `curl | bash`. Il sorgente vive su `github.com/iCosiSenpai/gsdcampus-autoplay` (branch `main`, **mobile**: ogni push su `main` cambia ciò che il comando esegue al prossimo lancio). Non c'è firma crittografica né verifica di checksum: ti fidi del proprietario del repository. Lo script scarica anche Ollama e Claude Code dai rispettivi canali ufficiali (senza checksum pubblicato da quei progetti), quindi la fiducia si estende anche a quegli installer. Per bloccare il codice a una versione verificata e immutabile, il manutentore può taggare una release (`git tag v0.1.0`) e impostare `PINNED_TAG` in `install.sh`: in quel caso la prima installazione clona esattamente quel tag invece del `main` mobile. Il vero signing/verifica dei binari resta un follow-up.

## Prima installazione

La prima volta il Terminale ti chiede alcune cose: rispondi con calma.
- la **password del Mac (sudo)** — una sola volta, all'inizio; lo script la mantiene valida per tutta la sessione con un keepalive in background;
- conferme di **installazione/aggiornamento/verifica dipendenze** (anche `y/n`) → rispondi **sempre sì**;
- il **login Ollama** (modello AI configurabile, default `gemma4:31b-cloud`; consigliato per monitor/autoplay il modello cloud economico `gemma4:cloud`) → inserisci le credenziali;
- la **selezione del tuo account** con la schermata interattiva **"Chi sei?"**: nel terminale appare un menu navigabile con le frecce ↑/↓ e Invio; puoi cercare per nome, cognome o codice fiscale, vedere la lista completa, importare il CSV dei membri, incollare manualmente l'autologin o mantenere l'account attuale;
- i **giorni lavorativi** (default lun–ven);
- la **modalità oraria** preferita:
  1. **Continuato** — un solo turno (es. 09:00–18:00).
  2. **Solo mattina** — es. 09:00–13:00.
  3. **Solo pomeriggio** — es. 14:00–18:00.
  4. **Classico** — due turni (default 09:30–13:00 e 16:30–20:00).
  5. **Personalizzato** — fino a 3 turni a scelta.

Gli orari si possono scrivere come vuoi: `9:30`, `09:30`, `9.30`, `0930`, `930`.

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

L'elenco di tutti i membri del corso è in un database SQLite (`data/members.db`), importato dal CSV esportato da Numbers. Ogni Mac tiene lo **stato personale** (corsi completati, cookie di sessione, risposte quiz in attesa) nella propria cartella `data/accounts/<codice fiscale>/`. La banca delle risposte `data/known_answers.json` è **condivisa** tra tutti i membri della classe.

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

# Helper orari
node scripts/lib/schedule-cli.js describe      # descrizione orario configurato
node scripts/lib/schedule-cli.js is-work-time  # siamo in orario? (yes/no)
node scripts/lib/schedule-cli.js next-start    # prossimo inizio turno (ISO)
node scripts/lib/schedule-cli.js next-end      # prossima fine turno (ISO)
```

## Struttura

- `launch-ai-supervisor.sh` — unico comando per l'utente
- `CLAUDE.md` — istruzioni per l'AI supervisore
- `src/autoplay.js` — main
- `src/lib/` — logger, monitor, quiz, video, schedule
- `scripts/lib/schedule-cli.js` — helper orari per gli script shell
- `scripts/` — setup, check requisiti, daemon Ollama
- `data/` — risposte conosciute, risposte in attesa di verifica, mappa corsi, stato sessione
- `logs/` — log, heartbeat, status.json, supervisor.log, ollama.log
- `debug/` — screenshot e dump HTML in caso di errore
- `backups/` — copie di sicurezza dello script
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
- I formati orari accettati sono flessibili: `9:30`, `09:30`, `9.30`, `0930`, `930`.
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

## Quiz e banca risposte condivisa

- La **banca risposte condivisa** è in `data/known_answers.json` (committata nel repo: uguale per tutti i colleghi).
- Se una domanda non è nota, lo script chiede a Ollama (modello configurabile in `config.json` tramite `ollamaModel`) la risposta usando la conoscenza del modello; la salva in `data/pending_quiz_answers.json`. Per monitor/autoplay il modello cloud più economico e sufficiente per quiz in italiano è `gemma4:cloud`.
- **Verifica dall'esito**: solo quando un quiz viene **superato**, le risposte nuove di Ollama vengono promosse automaticamente nella banca condivisa. Così la banca cresce solo con risposte verificate. L'esito (superato/non superato + punteggio) finisce in `logs/status.json` (`lastQuizResult`) ed è mostrato da `./status.sh`.
- Se Ollama non sa rispondere, il quiz si ferma e salva la domanda in `data/need_answer.json`.
- Manutenzione banca (per chi prepara i rilasci): `node scripts/lib/answers-cli.js stats|list|merge` e `... set "domanda" "risposta"`.

## Robustezza autologin

Il link autologin è personale e può scadere. Se il link non autentica più, lo script lo rileva
(la piattaforma mostra la pagina di login) ed esce subito con stato `autologin_invalid` e un
messaggio chiaro, invece di ritentare a vuoto. `./status.sh` segnala di aggiornare il link in `config.json`.

## Strumento di esplorazione (manutentore)

`node scripts/explore.js <autologin1> [autologin2] ...` esplora uno o più account e salva in
`debug/exploration/<codice>/` la struttura reale di dashboard, lezioni e quiz. Utile per validare
i selettori e raccogliere domande dei quiz. I dump contengono dati personali: `debug/` è in `.gitignore`.
