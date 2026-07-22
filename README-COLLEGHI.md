:red_circle: **Usa questo script solo se sei autorizzato dal titolare del corso/account.**

# Guida per colleghi — GSD Campus Autopilot

Questo script completa in automatico le video-lezioni e i quiz del corso GSD Campus.

**Per te serve una cosa sola:** il comando `curl` del capitolo 1 per installare, aggiornare e avviare. Lo scheduler prosegue da solo negli orari configurati; Claude viene chiamato solo quando incontra un quiz nuovo.

Tutto il resto (stato, requisiti e diagnostica) è più in basso e di solito non ti serve.

> 🟡 **Regola d'oro.** Rilancia il `curl` per aggiornare o avviare. Non serve mantenere una finestra AI aperta: se l'inbox quiz è vuota, Claude, Ollama e proxy restano spenti.

---


## Fleet: un Mac, uno o più colleghi

| Scenario | Cosa fare |
|----------|-----------|
| **Un collega su questo Mac** | Install → “Chi sei?” → orari → lo scheduler avvia i corsi. |
| **Più colleghi sullo stesso Mac** | Il maintainer configura `memberQueue`; a fine corsi passa da solo al prossimo. |
| **Aggiornare risposte quiz da altri store** | “Aggiorna e avvia” (curl) oppure auto-update notturno. Non serve git. |
| **Quiz bloccato** | Il batch Claude on-demand risolve e condivide (`resolve` → Worker); gli altri Mac ricevono al prossimo update. |
| **“Link scaduto”** | Verifica con `./status.sh --check`: `session_unstable` non significa token morto. |

**Accesso al corso (come funziona per tutti):**

1. Con l’install/`curl` arriva già **`data/members.db`**: elenco colleghi + link di autologin (è **tracciato in git**, consenso del titolare — non lo crei tu).
2. Al setup **“Chi sei?”**: cerchi **nome/cognome/CF** e scegli te stesso dalla lista. **Non incolli niente.** L’autologin è già nel DB.
3. **CSV**: serve **solo al maintainer/referente** per *aggiornare* l’elenco quando i token ruotano, poi fa commit di `members.db`. **I colleghi non usano e non hanno il CSV.**

| Chi | Cosa fa |
|-----|---------|
| **Collega** | curl → Chi sei? → orari → scheduler. Zero link da incollare, zero CSV. |
| **Coda multi-persona sul Mac** | Stesso DB: `queue set` con i CF già presenti in `members.db`. |
| **Emergenza** | Solo se non sei in elenco o il token è morto: fallback “incolla link” o CSV aggiornato dal referente. |

**Pin versione (store cauti):** un admin può impostare `PINNED_TAG=v1.1.0` in `install.sh`. Dettagli: `docs/SECURITY-MEMBERS.md`, `docs/CHANGELOG.md`.

---

## ⭐ 1. Comando principale (installazione, aggiornamento, avvio)

1. Apri il **Terminale** sul Mac (Spotlight → scrivi "Terminale" → Invio).
2. Incolla questo comando su **una sola riga** e premi `Invio`:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

> Se dopo l'incolla non succede nulla, premi `Invio`: alcuni copia-incolla non includono l'"a capo" finale che avvia il comando.

È l'unico comando che ti serve per prima installazione, aggiornamenti e avvio quotidiano. La prima volta scarica il progetto in `~/gsdcampus-autoplay`, installa il runtime del corso e avvia lo scheduler; Ollama/Claude vengono preparati solo quando compare un quiz aperto.

Se lo rilanci su un'installazione esistente compare un menu:
1. **Aggiorna e avvia** — scarica fix/risposte e avvia (consigliato).
2. **Cambia collega o orari** — seleziona account e turni.
3. **Ripara l'installazione** — riallinea codice e dipendenze.
4. **Solo avvia** — non aggiorna codice, account o orari; riconcilia lo stato runtime e avvia.
5. **Diagnostica on-demand** — controlla i componenti senza avviare processi AI.
6. **Disinstalla** — rimuove i componenti scelti con conferma.
7. **Esci**.

In tutti i casi (tranne la disinstallazione) il tuo `config.json` con link e orari resta al suo posto.

### Prima installazione (la prima volta)

Durante la prima installazione il Terminale ti chiederà alcune cose: rispondi con calma.

- La **password del Mac (sudo)**: una sola volta, all'inizio.
- Eventuali conferme di **installazione/aggiornamento** (anche `y/n`) → rispondi **sempre sì**.
- Il **login Ollama** compare solo quando esiste davvero un quiz aperto: si apre il browser, accedi e torna al Terminale. Non devi creare o incollare API key.
- **Chi sei?** — cerchi il tuo **nome** (o cognome/CF) nell’elenco già presente sul Mac (`members.db` arriva con l’install) e premi Invio. **Non incolli link e non serve un CSV.** L’autologin è già associato al tuo nome.
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

## ⭐ 2. Usare l'automazione

**Dopo l'installazione il sistema parte da solo.** Il launcher aggiorna la banca risposte e l'inbox, avvia lo scheduler negli orari configurati e poi termina. Non resta aperta una chat AI.

Claude Code viene usato **solo on-demand**: se compare una domanda quiz nuova, parte un singolo batch protetto dal budget; se non ci sono quiz aperti, le chiamate AI sono zero e Ollama/proxy restano spenti. Se serve autenticazione, `ollama signin` apre il browser: accedi e torna al Terminale, senza creare API key.

### Avviare o aggiornare nei giorni successivi

Rilancia sempre il comando `curl` del capitolo 1 e scegli **Aggiorna e avvia**. È sufficiente farlo una volta: lo scheduler rispetta i turni, si ferma a fine turno e riparte automaticamente.

---

## 3. Vedere cosa sta facendo

Per un controllo rapido, apri un altro Terminale:

```bash
cd ~/gsdcampus-autoplay && ./status.sh
```

Vedrai se lo scheduler è attivo, il prossimo turno, corso/lezione corrente, progresso video, ultimo quiz ed eventuali errori. Per i log live: `tail -f logs/autoplay.log`.

---

## 4. Se qualcosa non va

Rilancia il comando `curl` del capitolo 1 e scegli **Aggiorna e avvia**: aggiorna il codice, riconcilia la banca e riavvia senza perdere progressi. Se viene richiesto il login Ollama, completa l'accesso nel browser.

Se `./status.sh --check` conferma che l'autologin non è valido, scegli **Cambia collega o orari** dal menu `curl` per riselezionare l'account dal database.

### Comando di emergenza per manutentori

```bash
cd ~/gsdcampus-autoplay && ./scripts/setup.sh --yes --force-update && ./launch-ai-supervisor.sh
```

Per reinserire account e orari usa il menu del `curl`; non modificare `config.json` a mano.

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
- **Quiz**: usa una banca risposte condivisa. Se una domanda è nuova, il quiz viene sospeso prima della conferma (nessun tentativo consumato) e il batch Claude on-demand prepara una risposta verificata. Solo risposte validate entrano nella banca condivisa.
- **Stato personale**: ogni Mac tiene i progressi in `data/accounts/<codice fiscale>/`. Per cambiare utente rilancia il `curl` e scegli **Cambia collega o orari**; lo stato precedente resta salvato.

---

## 7. Orari di lavoro automatici

L'automazione segue i turni configurati in fase di installazione:

- Default: lunedì–venerdì, 09:30–13:00 e 16:30–20:00 (puoi cambiarli).
- A fine turno si ferma da sola e riprende al turno successivo.
- Fuori orario lo scheduler aspetta automaticamente il prossimo turno.
- `--ignore-hours` è una modalità tecnica riservata al maintainer.

---

## 8. Solo per chi prepara/distribuisce (manutentore)

Normalmente i colleghi usano l'installer del capitolo 1. In alternativa, dal Mac "master":

```bash
./scripts/prepare-package.sh --yes --zip   # crea sul Desktop una copia pulita + zip
```

Il pacchetto è già ripulito dai dati personali (niente `config.json`, sessioni, log).

---

## 9. Disinstallazione

Il modo più semplice è rilanciare il comando `curl` del capitolo 1 e scegliere **6. Disinstalla**.

Se preferisci un comando diretto (manutentore):

```bash
cd ~/gsdcampus-autoplay && ./scripts/setup.sh --uninstall
```

Rimuove dipendenze, Ollama, Claude Code, log e (se vuoi) la cartella del progetto. Ogni componente viene confermato separatamente; configurazioni e conversazioni personali di Claude non vengono cancellate.
Homebrew e Node.js restano, per non compromettere altri software.

---

## 10. Avvisi

- Non spegnere né mettere in stop il Mac se vuoi che il corso continui.
- Non modificare i file in `data/` se non sai cosa stai facendo.
- Se il sito del corso cambia layout, avvisa chi ha creato l'automazione.
