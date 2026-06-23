:red_circle: **Usa questo script solo se sei autorizzato dal titolare del corso/account.**

# Guida per colleghi — GSD Campus Autopilot

Questo script completa in automatico le video-lezioni e i quiz del corso GSD Campus.

**Per te servono solo due cose:**
1. **Installarlo una volta** (capitolo 1).
2. **Parlarci dall'AI** per avviarlo e controllarlo (capitolo 2).

Tutto il resto (requisiti, orari, manutenzione) è più in basso e di solito non ti serve.

---

## ⭐ 1. Installazione (una volta sola)

1. Apri il **Terminale** sul Mac (Spotlight → scrivi "Terminale" → Invio).
2. Incolla questo comando su **una sola riga** e premi `Invio`:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

> Se incolli e l'ultima riga non parte, premi `Invio` una seconda volta.

Questo scarica il progetto in `~/gsdcampus-autoplay`, installa tutto da solo e apre l'AI.

**Se lanci di nuovo lo stesso comando** quando il progetto è già installato, ti compare un menu
che chiede cosa vuoi fare:
1. **Aggiorna e avvia** — scarica fix e risposte quiz aggiornate, poi apre l'AI (consigliato).
2. **Cambia link autologin/orari** — reinserisci accesso e orari, poi avvia.
3. **Reinstallazione pulita** — riallinea il codice e reinstalla tutte le dipendenze.
4. **Solo avvia** — apre l'AI senza modificare nulla.
5. **Disinstalla** — rimuove tutto (con conferma).
6. **Annulla**.

In tutti i casi (tranne la disinstallazione) il tuo `config.json` con link e orari resta al suo posto.

Durante la prima installazione il Terminale ti chiederà alcune cose: rispondi con calma.

- La **password del Mac (sudo)**: una sola volta, all'inizio.
- Eventuali conferme di **installazione/aggiornamento** (anche `y/n`) → rispondi **sempre sì**.
- Il **login Ollama** (per il modello AI) → inserisci le credenziali.
- Il **tuo link di autologin personale** GSD Campus → incollalo (lo trovi nell'email del corso).
- I **giorni lavorativi** dello store (es. lun–ven).
- La **modalità oraria**:
  1. **Continuato** — un solo turno (es. 09:00–18:00).
  2. **Solo mattina** — es. 09:00–13:00.
  3. **Solo pomeriggio** — es. 14:00–18:00.
  4. **Classico** — due turni (default 09:30–13:00 e 16:30–20:00).
  5. **Personalizzato** — fino a 3 turni a scelta.

Gli orari si possono scrivere come vuoi: `9:30`, `09:30`, `9.30`, `0930`, `930`.

Non avere paura di confermare: serve tutto per far funzionare l'automazione.

---

## ⭐ 2. Usare l'automazione con l'AI

**Cosa succede appena finita l'installazione:** parte da sola una sessione dell'**AI** — è
**Claude che gira in locale tramite Ollama** con il modello cloud `gemma4:31b-cloud`. Non devi
lanciare nessun altro comando: la finestra dell'AI si apre da sé, con le istruzioni già caricate.

Da lì in poi **non devi ricordare comandi tecnici: parli con l'AI in italiano.** È l'AI che avvia,
ferma e controlla lo script al posto tuo.

> Se hai chiuso la finestra dell'AI, riaprila con: `cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh`

Scrivi semplicemente, per esempio:

```
avvia il corso
```
oppure
```
controlla il corso
```

L'AI capisce, avvia/ferma/riavvia lo script al posto tuo e ti dice come sta andando.

### Frasi che puoi usare

- `avvia il corso`
- `controlla il corso`
- `come sta andando?`
- `ferma tutto`
- `status`
- `riavvia`

### Riaprire l'AI nei giorni successivi

Se hai chiuso la finestra, riapri l'AI così (una sola riga):

```bash
cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
```

La seconda volta è molto più veloce: salta l'installazione e apre subito l'AI.

---

## 3. Vedere cosa sta facendo (senza AI)

In qualsiasi momento puoi aprire un altro Terminale e scrivere:

```bash
cd ~/gsdcampus-autoplay && ./status.sh
```

Vedrai: se è attivo e da quanto, se è orario lavorativo e quando parte il prossimo turno,
quale corso/lezione sta facendo, il progresso del video, l'esito dell'ultimo quiz e gli errori.

Per i log in tempo reale: `tail -f logs/autoplay.log`.

---

## 4. Se qualcosa non va

1. Nella finestra dell'AI premi `Ctrl+C` per chiudere.
2. Riapri il supervisore:
   ```bash
   cd ~/gsdcampus-autoplay && ./launch-ai-supervisor.sh
   ```
3. Scrivi: `controlla il corso`.

Se in `./status.sh` vedi **"Autologin non valido/scaduto"**, il tuo link di accesso non funziona
più: procurati un link aggiornato e chiedi all'AI di sostituirlo (lo fa lei in `config.json`).

### Comandi di emergenza (di rado necessari)

```bash
# Reinstalla/aggiorna tutto e riapre l'AI
cd ~/gsdcampus-autoplay && ./scripts/setup.sh --yes --force-update && ./launch-ai-supervisor.sh

# Reinserisci link autologin e orari da zero
cd ~/gsdcampus-autoplay && rm -f config.json && ./scripts/setup.sh && ./launch-ai-supervisor.sh
```

---

## 5. Requisiti

- Mac con macOS e connessione internet.
- Account del Mac con permessi di installare programmi.
- Il Mac deve restare **acceso 24/7** quando il corso deve girare (non metterlo in stop).

---

## 6. Come gestisce corsi e quiz (per curiosità)

- **Corsi**: non devi inserire URL. Dopo il login, lo script scopre da solo i corsi assegnati al
  tuo account e li completa uno alla volta. Se un corso dà `MISSING_PERMISSION`, il link non è
  corretto o quel corso non è assegnato a te.
- **Quiz**: usa una **banca risposte condivisa** (uguale per tutti i colleghi). Se la domanda è
  nota risponde da sola; se è nuova chiede al modello AI. **Solo se il quiz viene superato**, le
  risposte nuove entrano nella banca condivisa, che così cresce solo con risposte verificate.
  L'esito (superato/non superato + punteggio) compare in `./status.sh`.

---

## 7. Orari di lavoro automatici

L'automazione segue i turni configurati in fase di installazione:

- Default: lunedì–venerdì, 09:30–13:00 e 16:30–20:00 (puoi cambiarli).
- A fine turno si ferma da sola e riprende al turno successivo.
- Se chiedi all'AI `avvia il corso` fuori orario, aspetta automaticamente l'inizio del turno.
- Per forzare l'avvio subito (anche di notte/weekend) chiedi all'AI: "avvia ignorando gli orari".

---

## 8. Solo per chi prepara/distribuisce (manutentore)

Normalmente i colleghi usano l'installer del capitolo 1. In alternativa, dal Mac "master":

```bash
./scripts/prepare-package.sh --yes --zip   # crea sul Desktop una copia pulita + zip
```

Il pacchetto è già ripulito dai dati personali (niente `config.json`, sessioni, log).

---

## 9. Disinstallazione

```bash
cd ~/gsdcampus-autoplay && ./scripts/uninstall.sh
```

Rimuove dipendenze, modello Ollama, Claude Code CLI, log e (se vuoi) la cartella del progetto.
Homebrew e Node.js restano, per non compromettere altri software.

---

## 10. Avvisi

- Non spegnere né mettere in stop il Mac se vuoi che il corso continui.
- Non modificare i file in `data/` se non sai cosa stai facendo.
- Se il sito del corso cambia layout, avvisa chi ha creato l'automazione.
