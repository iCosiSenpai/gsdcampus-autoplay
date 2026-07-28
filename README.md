🔴 **Usa questo programma solo se sei autorizzato dal titolare del corso.**

# GSD Campus Autopilot

Segue **da solo** le video-lezioni e i quiz del corso GSD Campus sul Mac del tuo store.
Tu lanci **un comando**, al resto pensa lui: segue i corsi negli orari di lavoro, si ferma da solo la sera e riprende il giorno dopo.

---

## 🚀 Come si avvia

Due modi, scegli quello che preferisci. **Entrambi fanno tutto**: la prima volta installano, le volte dopo aggiornano, e ogni volta avviano i corsi.

### ⭐️ Modo A — Scarica e doppio clic (consigliato: non copi né scrivi niente)

1. Scarica il file: **[⬇︎ Scarica "GSD Avvia"](https://gsd.lookatale95.workers.dev/avvia)**
2. Arriva un archivio **GSD Avvia.zip**: Safari lo apre da solo e dentro trovi **GSD Avvia.command** (se resta zippato, doppio clic sullo zip).
3. Fai **doppio clic** su *GSD Avvia.command* (di solito è in *Download*).
   - *Solo la primissima volta* il Mac può bloccarlo ("sviluppatore non identificato"): allora **tasto destro sul file → Apri → Apri**. Dopo, basta il doppio clic.

Le volte successive: doppio clic sullo stesso file. Fine — **e aggiorna ogni volta**: il file non contiene il programma, va a prendere l'ultima versione al momento del clic. Puoi tenerlo nel Dock o sulla Scrivania.

### ⌨️ Modo B — Comando nel Terminale

1. Apri il **Terminale** (in alto a destra clicca la lente 🔍 → scrivi `Terminale` → Invio).
2. **Scrivi** (o copia dal riquadro) questo comando **su una riga sola**, poi premi **Invio**:

```bash
curl -fsSL https://gsd.lookatale95.workers.dev | bash
```

> ⚠️ **Copialo dal riquadro** o **scrivilo a mano**: non copiare un link "azzurro" cliccabile — alcune app aggiungono l'indirizzo tra parentesi e il comando non parte. Se sembra che non parta, premi di nuovo **Invio**.

Se il comando corto non dovesse funzionare, l'equivalente completo è:
`curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash`

---

## 👋 La prima volta

Il Terminale ti farà qualche domanda. Rispondi con calma, è tutto normale:

- **Password del Mac** — quella che usi per accendere il computer. Te la chiede una volta sola e non viene salvata.
- Se chiede di **installare o aggiornare** qualcosa → rispondi **sì**.
- **"Chi sei?"** — scrivi due lettere del tuo cognome e l'elenco si restringe: frecce ↑ ↓ e **Invio** per scegliere il tuo nome. Non devi incollare nessun link, è già collegato al tuo nome. Se il Mac era già configurato, la prima voce è *"Continua come <il tuo nome>"*: basta **Invio**.
- **Giorni di apertura** — una lista da spuntare con la **barra spaziatrice** (lunedì-venerdì sono già spuntati):

```
   In quali giorni è aperto il negozio?
 ▌  [x]  lunedì      [x] martedì   [x] mercoledì
    [x]  giovedì     [x] venerdì   [ ] sabato    [ ] domenica
```

- **Orario del negozio** — scegli l'orario già pronto che ti somiglia:

```
   A che ora apre e chiude il negozio?
 ▌  01  09:00 – 20:00 con pausa 13:00-16:00   il più comune
    02  09:00 – 18:00 senza pausa
    03  Solo mattina — 09:00 – 13:00
    04  Solo pomeriggio — 16:00 – 20:00
    05  Altro orario — lo scelgo con le frecce
```

  Con **"Altro orario"** non devi scrivere niente: l'ora si sposta con le frecce (←→ quindici minuti, ↑↓ un'ora) e poi ti chiede se c'è la pausa pranzo.

```
   A che ora apre?

         ‹   08:30   ›

   ←→ 15 minuti   ↑↓ un'ora   INVIO confermo
```

- **Hai sbagliato?** Premi **ESC** e torni alla domanda precedente (o scegli la voce `◂ Indietro`): non serve ricominciare da capo.
- **Un'ultima occhiata** — prima di salvare vedi la tua settimana disegnata, e se qualcosa non torna cambi solo quel pezzo:

```
  Giorni             lunedì, martedì, mercoledì, giovedì, venerdì e sabato
  Orario             08:30-13:00 e 16:00-19:30

        07  09  11  13  15  17  19
  lun   ···█████████······███████···
  ...
  dom   chiuso

   Va bene così?
 ▌  01  Sì, salva e vai   02  ◂ Cambio l'orario   03  ◂ Cambio i giorni   04  ◂ Cambio collega
```

---

## 🖥️ Cosa vedi quando è avviato

Alla fine si apre una **plancia** che ti dice a colpo d'occhio come sta andando, si aggiorna da sola e si muove:

```
 ᗧ GSD CAMPUS · IL TUO NOME · v1.1.0                         ● attivo
 ════════════════════════════════════════════════════════════════════
   ● Sto seguendo: Sicurezza sul lavoro · modulo 3 · video 62%

   Corsi     ▸ 7 totali · 5 fatti · 1 in attesa · 1 in corso

   Avanzamento di tutti i corsi
   ▕──────────────────────────ᗧ···•···•···•···•··ᗣ▏   81%

   Video     ▸ ⣾ ████████████████░░░░░░░░  62%  0:59 / 16:00
   Quiz      ▸ nessuno in attesa
   Claude    ▸ inattivo — entra da solo solo se serve
   Turni     ▸ 09:00–13:00 · 16:00–20:00  · in orario
   Aggiorn.  ▸ controllato 4m fa · già all'ultima versione
 ════════════════════════════════════════════════════════════════════
  L guarda dal vivo   R aggiorna ora   Q ferma tutto e chiudi   ESC esci e lascia lavorare
```

Il **Pac-Man giallo** mangia la strada che resta da fare: quando arriva in fondo i corsi sono finiti. I **fantasmini** in coda sono i corsi in attesa di risposte ai quiz (uno per corso, coi colori dei quattro originali). In alto trovi sempre la **versione** installata, accanto al tuo nome.

Con un tasto solo:

- **L** — guarda dal vivo cosa sta facendo. È **solo guardare**: non ferma e non cambia niente. Per tornare alla plancia premi **ESC** (o **Q**).
- **R** — rilegge subito i dati mostrati.
- **Q** — **ferma tutto e chiude**: corsi, scheduler e guardiano si spengono, poi si chiude questa scheda del Terminale (solo questa: non l'app né le altre finestre). Chiede una conferma, e dopo Q il Mac resta fermo finché non lo riavvii tu.
- **ESC** — esce dalla plancia **senza fermare niente**: chiude la scheda e i corsi continuano in background.

Se vuoi uscire lasciando anche la scheda aperta, premi **Ctrl-C**.

La riga **Aggiorn.** dice quando il Mac ha controllato l'ultima volta se c'è una versione nuova (il controllo è automatico ogni ~10 minuti). Se diventa gialla — "nessun controllo recente" o "non attivo su questo Mac" — rilancia il comando curl: lo riattiva.

Se l'aggiornamento arriva **mentre questa finestra è aperta**, la plancia te lo dice ("Si è aggiornato da solo…"): i dati che vedi restano veri, ma la schermata gira ancora sulla versione precedente — chiudila con **ESC** e rilancia il comando curl. Ad aggiornamento riuscito arriva anche una **notifica** del Mac, così te ne accorgi pure senza terminali aperti.

Non devi tenere niente aperto: se la scheda si chiude — o se il Mac si riavvia — il **guardiano** rimette in piedi l'automazione entro un paio di minuti e continua in background. Se invece premi **Q**, resta ferma di proposito finché non la riavvii tu.

**Per rivederla o controllare come va**, riapri il Terminale e rilancia **lo stesso comando** di sopra, poi scegli **"Aggiorna e avvia"**: riconosce la sessione già in corso, ricompare la schermata di stato e i corsi riprendono dal punto salvato. È sempre lo stesso comando, per tutto.

---

## 🙋 "Ho toccato qualcosa per sbaglio"

Niente panico: non si rompe nulla e quasi tutto si sistema da solo.

- **Ho chiuso Chrome / il Mac ha aggiornato Chrome** — il browser dei corsi è invisibile e separato dal tuo: se muore, l'automazione ne apre un altro e riprende dal punto salvato.
- **Ho fatto logout dall'AI (Ollama)** — i corsi vanno avanti comunque. Si fermano solo i quiz nuovi, le domande restano in attesa e nessun tentativo viene consumato: al prossimo avvio col comando (o doppio clic) ti riapre il login e riprende.
- **Ho chiuso la finestra del Terminale** — l'automazione riparte da sola entro un paio di minuti. Se vuoi fermarla davvero usa **F** nella plancia.
- **Ho spostato o rinominato la cartella** — rilancia il comando: rimette a posto i servizi in background (senza il comando resterebbe ferma in silenzio).
- **Ho aperto il corso nel mio browser mentre lavorava** — la piattaforma può chiudere la sessione: l'automazione aspetta una mezz'ora e riprende. Il link non va cambiato.
- **Ho staccato il Wi-Fi / il Mac ha dormito** — riprende appena torna la rete o al risveglio.

Per un controllo completo: rilancia il comando e scegli **"Diagnostica on-demand"**. Dice in chiaro se il Mac è aggiornabile, se i servizi in background sono a posto e cosa manca.

---

## 📅 Ogni giorno

Non devi fare nulla: segue gli orari da solo, si ferma a fine turno e riparte al turno dopo.

Quando vuoi **aggiornare o riavviare**, rilancia lo stesso comando `curl` e scegli **"Aggiorna e avvia"**. Tutto qui.

Il menu che compare rilanciando il comando:

| Voce | A cosa serve |
|------|--------------|
| **Aggiorna e avvia** | *consigliato*: aggiorna e parte |
| Cambia collega o orari | cambia persona o turni di lavoro |
| Ripara l'installazione | se qualcosa si è rotto |
| Solo avvia | avvia senza aggiornare nulla |
| Diagnostica | controlla che sia tutto a posto |
| Disinstalla | rimuove tutto (con conferma) |
| Esci | non tocca niente |

I tuoi dati (nome e orari) restano sempre al loro posto.

---

## 🤖 E l'intelligenza artificiale?

Quando incontra un **quiz nuovo** che non sa risolvere, un'AI (Claude) prepara la risposta — **solo in quel momento e per pochi secondi**. Se non ci sono quiz da risolvere, l'AI resta spenta e non consuma niente. Nella plancia lo vedi: compare *"Claude sta risolvendo…"* mentre lavora.

La prima volta che serve davvero, si apre il browser per un **accesso all'AI**: fai il **login** se hai già un account, oppure **registrati** (sign up) se è la prima installazione o non l'hai mai configurata su questo Mac. **Consiglio: accedi con Google usando il tuo account aziendale @cec.com.** È rapido e si fa **una volta sola**; poi torni al Terminale. Non devi creare o copiare nessuna chiave.

---

## 🛟 Se qualcosa non va

Quasi tutto si sistema **rilanciando il comando `curl`** e scegliendo **"Aggiorna e avvia"**.

- **Non parte o dà un errore strano** → rilancia il `curl`.
- **Dice "accesso non riuscito" / non entra nel corso** → quasi sempre **non** è colpa del link (è unico e non cambia mai): la piattaforma l'ha messo in **timeout temporaneo** perché è stato usato troppo. **Non cambiare il link.** Lascialo "raffreddare" e riprova **più tardi o domani** — puoi anche lasciare la finestra aperta, riprova da sola.
- **Ti chiede se rimuovere "OpenCode"** → è la vecchia AI, non serve più: puoi rispondere **Sì**. (Se lo usi per conto tuo, scegli **No**.)
- **Il Mac** deve restare **acceso** (non in stop) quando i corsi devono girare: ci pensa lui a tenerlo sveglio, tu non spegnerlo.

Se davvero non si sblocca, avvisa chi ti ha dato l'automazione.

---

## Buono a sapersi

- Il Mac dello store va lasciato **acceso**; l'automazione rispetta gli orari e non lavora fuori turno.
- Non serve tenere aperta nessuna finestra: se la chiudi (o il Mac si riavvia) l'automazione riparte da sola.
- I tuoi progressi e le risposte ai quiz vengono salvati e condivisi con gli altri store, così un quiz risolto una volta vale per tutti.

---

<details>
<summary><b>Per chi gestisce la flotta (manutentori)</b></summary>

Questa parte **non serve ai colleghi**: è un riferimento tecnico per chi prepara e mantiene l'automazione.

- **Modello di fiducia (`curl | bash`):** il comando scarica ed esegue codice dal branch `main` del repo. Con un quiz aperto installa/verifica Ollama CLI e Claude Code dai canali ufficiali. Un admin può bloccare la versione con `PINNED_TAG` in `install.sh`.
- **Supervisore AI:** Claude Code **on-demand**, one-shot, solo con `openQuizRequests > 0`. Nessun processo AI persistente; proxy budget (400/7g · 80/24h · 8/min · 8/batch). Dettagli in `AGENTS.md` e `docs/TECH.md`.
- **Membri e stato:** elenco in `data/members.db` (da CSV, solo maintainer). Stato personale per Mac in `data/accounts/<CF>/`. Banca risposte: `data/known_answers.json` (trusted locale) + `data/known_answers_public.json` (condivisa). Distribuzione senza git push via `./scripts/publish-answers.sh` (Cloudflare Worker).
- **Comandi locali utili:** `./status.sh`, `./start.sh` [`--ignore-hours`], `./stop.sh`, `./scripts/setup.sh [--yes --force-update]`, `./scripts/dev-check.sh`, `node scripts/lib/panel-cli.js` (plancia).
- **Preparare un pacchetto per un collega:** `./scripts/prepare-package.sh --yes --zip` (rimuove dati personali).
- **Riferimenti completi:** `AGENTS.md` / `CLAUDE.md` (contratto supervisore), `docs/SETUP.md`, `docs/QUIZ.md`, `docs/ISSUES.md`, `docs/TECH.md`, `docs/SECURITY-MEMBERS.md`.
- **Note tecniche:** browser headless (nessuna finestra); ID corsi personali scoperti dalla dashboard dopo il login (non in `config.json`); orari in `config.json` → `workSchedule`.

</details>
