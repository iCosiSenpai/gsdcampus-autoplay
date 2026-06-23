:red_circle: **Usa questo script solo se sei autorizzato dal titolare del corso/account.**

# Guida per colleghi — GSD Campus Autopilot

Questo script automatizza le video-lezioni e i quiz del corso GSD Campus.

## 1. Cosa serve

- Mac con macOS
- Connessione internet
- Account utente del Mac con permessi di installare programmi
- I Mac devono restare **accesi 24/7** quando il corso deve girare

## 2. Comando principale (l'unico che devi ricordare)

1. Apri il **Terminale** sul Mac.
2. Trascina la cartella `gsdcampus-autoplay` dalla scrivania (o da Finder) dentro la finestra del Terminale: si scriverà automaticamente il percorso.
3. **Scrivi `cd ` prima del percorso** (ricorda lo spazio tra `cd` e il percorso), quindi tocca `Invio`.
   - Esempio: `cd /Users/mario/gsdcampus-autoplay`
4. Incolla il comando di avvio e tocca `Invio`:

```bash
./launch-ai-supervisor.sh
```

> In alternativa, puoi anche scrivere a mano: `cd ~/gsdcampus-autoplay` (spazio tra `cd` e `~`), poi `Invio`, poi `./launch-ai-supervisor.sh`.

La prima volta installerà/aggiornerà tutto in automatico.

All'inizio lo script chiederà la **password del Mac (sudo) una sola volta** e la terrà valida per tutta la sessione. Poi, durante l'installazione, potrebbe succedere che:
- Ti chieda di **installare/aggiornare/verificare qualcosa** (anche con richieste `y/n`) → conferma **sempre**.
- Ti chieda il **login Ollama** (per il modello cloud `gemma4:31b-cloud`) → inserisci le credenziali e continuerà da solo.

Non avere paura di confermare: serve tutto per automatizzare il corso.

## 3. Come usare l'automazione

Dopo aver lanciato il comando sopra, si apre una sessione di Claude Code con già caricate le istruzioni. Scrivi semplicemente:

```
controlla il corso
```

Oppure:

```
come sta andando?
```

L'AI ti risponderà e, se necessario, avvierà / fermerà / riavvierà lo script al posto tuo.

## 4. Altre frasi utili

- `controlla il corso`
- `come sta andando?`
- `avvia il corso`
- `ferma tutto`
- `status`
- `riavvia`

## 5. Cosa sta facendo adesso?

In qualsiasi momento puoi aprire un altro terminale e scrivere:

```bash
cd ~/gsdcampus-autoplay
./status.sh
```

Vedrai:
- se il processo è attivo
- quale corso/lezione sta facendo
- progresso del video
- ultimi errori

Per i log in tempo reale:

```bash
tail -f logs/autoplay.log
tail -f logs/supervisor.log
```

## 6. Se qualcosa non va

1. Chiudi la sessione di Claude Code con `Ctrl+C`.
2. Riapri il supervisore: `./launch-ai-supervisor.sh`
3. Scrivi: `controlla il corso`

## 7. Replicare su un altro Mac

### Per chi prepara il pacchetto

Sul Mac "master" (quello con il progetto funzionante), apri il Terminale nella cartella del progetto e lancia:

```bash
./scripts/prepare-package.sh --yes --zip
```

Questo crea sul Desktop:
- una cartella pulita `gsdcampus-autoplay-pkg`
- uno zip `gsdcampus-autoplay.zip`

Il pacchetto è già pulito: non contiene `config.json` personale, sessioni, log, screenshot, né dati del tuo corso.

### Per chi riceve il pacchetto

1. Copia sul nuovo Mac la cartella `gsdcampus-autoplay-pkg` (o estrai lo zip).
2. Rinominala in `gsdcampus-autoplay` e mettila nella home (`~/gsdcampus-autoplay`).
3. Apri il Terminale:
   ```bash
   cd ~/gsdcampus-autoplay
   ./launch-ai-supervisor.sh
   ```
4. All’inizio l’AI ti chiederà di confermare il **tuo link di autologin personale** e gli **orari di lavoro dello store**. Se qualcosa non è corretto, scrivilo in chat e l’AI modificherà `config.json` al posto tuo.
5. Da lì in poi usa sempre `./launch-ai-supervisor.sh`.

## 8. Orari di lavoro automatici

I Mac in negozio sono accesi 24/7. L'automazione segue automaticamente i turni lavorativi:

- **Turni**: lunedì–venerdì, 09:30–13:00 e 16:30–20:00.
- Se dici all'AI `avvia il corso`, lo scheduler parte anche fuori orario e aspetta l'inizio del prossimo turno.
- A fine turno si ferma da sola e riprende al turno successivo.
- Se vuoi forzare l'avvio subito (anche di notte o nel weekend), chiedi all'AI: "avvia ignorando gli orari".

## 9. Domande e quiz

Lo script conosce già alcune risposte del quiz in `data/known_answers.json`.

- Se trova una domanda conosciuta, risponde in automatico.
- Se la domanda è nuova, chiede a Ollama (`gemma4:31b-cloud`) la risposta in base alla conoscenza del modello.
- Se il modello non è sicuro, il quiz si ferma e salva la domanda in `data/need_answer.json`: in quel caso scrivi in chat all’AI e lei cercherà la risposta corretta per te.

## 10. Disinstallazione

Se vuoi rimuovere tutto, apri il Terminale nella cartella del progetto e lancia:

```bash
./scripts/uninstall.sh
```

Lo script chiederà conferma e rimuoverà dipendenze, modelli Ollama, Claude Code CLI, log e (se vuoi) anche la cartella del progetto. Homebrew e Node.js resteranno installati, per non compromettere altri software.

## 11. Avvisi

- Non chiudere il Mac o metterlo in stop se vuoi che il corso continui.
- Non modificare i file in `data/` se non sai cosa stai facendo.
- Se il sito del corso cambia layout, avvisa chi ha creato l'automazione.
