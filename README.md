🔴 **Usa questo programma solo se sei autorizzato dal titolare del corso.**

# GSD Campus Autopilot

Segue **da solo** le video-lezioni e i quiz del corso GSD Campus sul Mac del tuo store.
Segue i corsi negli orari di lavoro, si ferma da solo la sera e riprende il giorno dopo.

---

## 🚀 Come si avvia

Due modi. Il primo è una **app** da installare una volta; il secondo è un **comando** nel Terminale. Fanno la stessa cosa: scegli quello che ti somiglia.

### ⭐️ Modo A — L'app «Autoplay San» (consigliato)

<img src="app/icona.png" width="120" align="right" alt="Icona di Autoplay San">

1. Scarica l'app: **[⬇︎ Scarica «Autoplay San»](https://github.com/iCosiSenpai/gsdcampus-autoplay/releases/latest/download/AutoplaySan.dmg)** (6 MB). Questo indirizzo dà **sempre** l'ultima versione.
2. **Doppio clic** sul file scaricato: si apre una finestra con l'app dentro.
3. **Trascina** «Autoplay San» sulla cartella *Applicazioni* che vedi accanto.
4. Apri l'app da *Applicazioni* (doppio clic).

Non serve nient'altro: né Terminale, né password del Mac, né programmi da installare. L'app si porta dentro tutto quello che le serve — il motore che apre i corsi, l'elenco dei colleghi e le risposte dei quiz — quindi **la prima configurazione funziona anche se la rete fa i capricci**.

L'app **non compare nel Dock**: vive nella barra dei menu in alto a destra, accanto all'orologio. Da lì vedi come sta andando e da lì si comanda.

<br clear="right">

### ⌨️ Modo B — Comando nel Terminale

1. Apri il **Terminale** (in alto a destra clicca la lente 🔍 → scrivi `Terminale` → Invio).
2. **Scrivi** (o copia dal riquadro) questo comando **su una riga sola**, poi premi **Invio**:

```bash
curl -fsSL https://gsd.lookatale95.workers.dev | bash
```

> ⚠️ **Copialo dal riquadro** o **scrivilo a mano**: non copiare un link "azzurro" cliccabile — alcune app aggiungono l'indirizzo tra parentesi e il comando non parte. Se sembra che non parta, premi di nuovo **Invio**.

Se il comando corto non dovesse funzionare, l'equivalente completo è:
`curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash`

Questo modo **installa e aggiorna** ogni volta che lo lanci, e poi avvia i corsi.

---

## 👋 La prima volta

### Se hai installato l'app

Alla prima apertura fa tre domande, poi è pronta.

- **«Chi segue i corsi su questo Mac?»** — scrivi due lettere del tuo cognome e l'elenco si restringe; clicca il tuo nome. Non devi incollare nessun link: sono già tutti dentro l'app.
  Se non ti trovi in elenco (sei arrivato di recente), apri **«Non sono in elenco»** e incolla il tuo link di accesso personale: il resto lo capisce da solo.
- **«Quando può lavorare?»** — i giorni si accendono e si spengono con un clic, gli orari si scelgono con le frecce. Sono gli orari del negozio: fuori da quelli l'app non lavora.
- **«Se qualcosa va storto mentre nessuno guarda»** — lascia acceso *«Riapri la app se cade»*: è quello che fa ripartire tutto da solo se il Mac si riavvia o l'app si chiude di notte.

Alla fine premi **Avvia**. Se sei fuori orario non succede niente di visibile: partirà da sé al prossimo turno.

Tutte queste cose si cambiano quando vuoi da **Impostazioni**, dentro l'app.

### Se hai usato il comando nel Terminale

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

- **Hai sbagliato?** Premi **ESC** e torni alla domanda precedente (o scegli la voce `◂ Indietro`): non serve ricominciare da capo.
- **Un'ultima occhiata** — prima di salvare vedi la tua settimana disegnata, e se qualcosa non torna cambi solo quel pezzo.

---

## 🖥️ Cosa vedi quando è avviato

### Nell'app

Nella **barra dei menu**, accanto all'orologio, compaiono un simbolo e il tempo del video in corso: ti dice a colpo d'occhio se sta lavorando, senza aprire niente.

Cliccandoci si apre un pannello con la lezione, l'avanzamento, i turni e i comandi:

- **Avvia** — rispetta i tuoi turni: se sei fuori orario parte da sé al prossimo.
- **Ferma tutto** — si ferma e resta fermo finché non lo riavvii tu.
- **Ricontrolla i corsi** — riapre la piattaforma e riconta l'avanzamento di ogni corso.
- sotto **Altro**: verifica dell'accesso, scansione completa dei questionari, aggiornamento dell'app.

Per la finestra grande — corsi, questionari, stima di quando finirai, impostazioni — apri l'app da *Applicazioni*.

Non devi tenere aperta nessuna finestra: la app vive nella barra dei menu. Se il Mac si riavvia torna su da sola, e se cade la rimette in piedi il guardiano — quello dell'ultima domanda della prima volta.

### Nel Terminale

Alla fine si apre una **plancia** che si aggiorna da sola:

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

Il **Pac-Man giallo** mangia la strada che resta da fare: quando arriva in fondo i corsi sono finiti. I **fantasmini** in coda sono i corsi in attesa di risposte ai quiz.

Con un tasto solo:

- **L** — guarda dal vivo cosa sta facendo. È **solo guardare**: non ferma e non cambia niente. Per tornare alla plancia premi **ESC** (o **Q**).
- **R** — rilegge subito i dati mostrati.
- **Q** — **ferma tutto e chiude**. Dopo Q il Mac resta fermo finché non lo riavvii tu.
- **ESC** — esce dalla plancia **senza fermare niente**: i corsi continuano in background.

Per rivedere la plancia rilancia **lo stesso comando** e scegli **"Aggiorna e avvia"**: riconosce la sessione già in corso e i corsi riprendono dal punto salvato.

---

## 🙋 "Ho toccato qualcosa per sbaglio"

Niente panico: non si rompe nulla e quasi tutto si sistema da solo.

- **Ho chiuso il browser dei corsi** — è invisibile e separato dal tuo: se muore ne viene aperto un altro e si riprende dal punto salvato.
- **Ho chiuso l'app** (menu → Esci) — resta chiusa di proposito: riaprila da *Applicazioni* e riprende dal punto salvato. Il guardiano la riapre da sé solo quando **cade** o dopo un riavvio del Mac, non quando gliel'hai chiesto tu.
- **Ho chiuso la finestra del Terminale** — l'automazione riparte da sola entro un paio di minuti.
- **Ho aperto il corso nel mio browser mentre lavorava** — la piattaforma può chiudere la sessione: si aspetta una mezz'ora e si riprende. Il link non va cambiato.
- **Ho staccato il Wi-Fi / il Mac ha dormito** — riprende appena torna la rete o al risveglio.
- **Ho fatto logout dall'AI (Ollama)** (solo Modo B) — i corsi vanno avanti comunque. Si fermano solo i quiz nuovi, le domande restano in attesa e nessun tentativo viene consumato: al prossimo avvio col comando ti riapre il login e riprende.
- **Ho spostato o rinominato la cartella** (solo Modo B) — rilancia il comando: rimette a posto i servizi in background.

---

## 📅 Ogni giorno

Non devi fare nulla: segue gli orari da solo, si ferma a fine turno e riparte al turno dopo.

**Con l'app**: apri l'app da *Applicazioni* e vai in **Impostazioni → Aggiornamenti**: ti dice se c'è una versione nuova e la installa (l'app si chiude e si riapre da sé). Vale la pena guardarci una volta al mese, o quando te lo chiediamo noi.

**Con il Terminale**: quando vuoi aggiornare o riavviare, rilancia lo stesso comando `curl` e scegli **"Aggiorna e avvia"**.

| Voce del menu | A cosa serve |
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

## 🤖 E i quiz?

Le risposte sono **in comune**: un quiz risolto una volta, da chiunque, vale per tutti gli store. L'app e il comando le usano entrambi dalla stessa banca.

Quando compare una domanda che **nessuno ha ancora risolto**, non viene tirata a indovinare — indovinare consuma un tentativo. La domanda viene messa in attesa e mandata a chi mantiene l'automazione; appena la risposta è registrata torna su tutti i Mac e il corso riparte da solo. Nel frattempo l'automazione va avanti con gli altri corsi.

**Con l'app** non devi fare niente e non devi creare account da nessuna parte.

**Con il comando nel Terminale** c'è un passaggio in più: le domande nuove le prepara un'AI (Claude), **solo in quel momento e per pochi secondi**. La prima volta che serve davvero si apre il browser per un accesso: fai il **login** se hai già un account, oppure **registrati**. Conviene accedere con Google usando l'account aziendale @cec.com. Si fa **una volta sola** e non devi copiare nessuna chiave. Se non ci sono quiz da risolvere, l'AI resta spenta.

---

## 🛟 Se qualcosa non va

- **Con l'app: non parte, o dice qualcosa che non capisci** → chiudila (dalla barra dei menu) e riaprila da *Applicazioni*. Se insiste, [riscarica l'app](https://github.com/iCosiSenpai/gsdcampus-autoplay/releases/latest/download/AutoplaySan.dmg) e ritrascinala in Applicazioni sostituendo quella vecchia.
- **Con il Terminale: non parte o dà un errore strano** → rilancia il `curl`.
- **La prima volta il Mac dice che l'app «non può essere aperta»** → tasto destro sull'app in *Applicazioni* → **Apri** → **Apri**. Succede una volta sola.
- **Dice "accesso non riuscito" / non entra nel corso** → quasi sempre **non** è colpa del link (è unico e non cambia mai): la piattaforma l'ha messo in **timeout temporaneo** perché è stato usato troppo. **Non cambiare il link.** Lascialo "raffreddare" e riprova **più tardi o domani**.
- **Il Mac** deve restare **acceso** (non in stop) quando i corsi devono girare: ci pensa lui a tenerlo sveglio, tu non spegnerlo.

Se davvero non si sblocca, avvisa chi ti ha dato l'automazione.

---

## Buono a sapersi

- Il Mac dello store va lasciato **acceso**; l'automazione rispetta gli orari e non lavora fuori turno.
- Non serve tenere aperta nessuna finestra: se la chiudi (o il Mac si riavvia) l'automazione riparte da sola.
- I tuoi progressi e le risposte ai quiz vengono salvati e condivisi con gli altri store, così un quiz risolto una volta vale per tutti.
- I due modi **non vanno usati insieme sullo stesso Mac** nello stesso momento: due automazioni sulla stessa piattaforma si tolgono la sessione a vicenda. Se hai installato l'app, lei si accorge del comando e si tira indietro; ma la regola semplice è: scegline uno.

---

<details>
<summary><b>Per chi gestisce la flotta (manutentori)</b></summary>

Questa parte **non serve ai colleghi**: è un riferimento tecnico per chi prepara e mantiene l'automazione.

- **L'app è autosufficiente.** Non ha bisogno di questo repository per funzionare: motore WebKit, turni, stato, questionari, banca risposte e segnalazioni sono codice nativo. `members.db` e `known_answers_public.json` viaggiano **dentro il bundle** (innestati al primo avvio, poi aggiornati via HTTPS da `main`). Su un Mac senza il repository la cartella di lavoro è `~/Library/Application Support/Autoplay San/dati`; dove il repository c'è, l'app lo riconosce e ci lavora dentro.
- **Release dell'app:** ogni release ha **tre** file — `AutoplaySan-<versione>-b<build>.dmg` per l'installazione a mano, lo stesso disco copiato come **`AutoplaySan.dmg`** (nome fisso: è quello che il README linka, così `releases/latest/download/AutoplaySan.dmg` dà sempre l'ultima versione senza toccare la documentazione), e lo `.zip` per l'aggiornamento automatico (`AppUpdater` scompatta, non monta). `app/latest.json` punta allo **zip**. Il sorgente sta nel repository privato `iCosiSenpai/autoplay-san`; il pacchetto si costruisce con `Scripts/release-app.sh` (dati nel bundle, firma Developer ID, notarizzazione di app e disco, `stapler`).
- **Domande di quiz ignote:** l'app apre una issue qui, titolo con prefisso `[domanda]`, deduplicata per impronta della **domanda** (non del Mac), quindi quaranta postazioni convergono su una issue. Si risolvono con `node scripts/lib/answers-cli.js resolve "<domanda>" "<risposta>"` + `./scripts/publish-answers.sh`; la risposta torna a tutti con la banca condivisa e i corsi bloccati solo per quella domanda si riaprono da sé.
- **Modello di fiducia (`curl | bash`):** il comando scarica ed esegue codice dal branch `main`. Con un quiz aperto installa/verifica Ollama CLI e Claude Code dai canali ufficiali. Un admin può bloccare la versione con `PINNED_TAG` in `install.sh`.
- **Supervisore AI (solo percorso a script):** Claude Code **on-demand**, one-shot, solo con `openQuizRequests > 0`. Nessun processo AI persistente; proxy budget (400/7g · 80/24h · 8/min · 8/batch). Dettagli in `AGENTS.md` e `docs/TECH.md`.
- **Membri e stato:** elenco in `data/members.db` (da CSV, solo maintainer). Stato personale per Mac in `data/accounts/<CF>/`. Banca risposte: `data/known_answers.json` (trusted locale) + `data/known_answers_public.json` (condivisa). Distribuzione senza git push via `./scripts/publish-answers.sh` (Cloudflare Worker).
- **Comandi locali utili:** `./status.sh`, `./start.sh` [`--ignore-hours`], `./stop.sh`, `./scripts/setup.sh [--yes --force-update]`, `./scripts/dev-check.sh`, `node scripts/lib/panel-cli.js` (plancia). Per l'app: `autoplaysan status|start|stop|mode|update`.
- **Preparare un pacchetto per un collega:** l'app è il `.dmg` della release. Per il percorso a script, `./scripts/prepare-package.sh --yes --zip` (rimuove dati personali).
- **Riferimenti completi:** `AGENTS.md` / `CLAUDE.md` (contratto supervisore), `docs/SETUP.md`, `docs/QUIZ.md`, `docs/ISSUES.md`, `docs/TECH.md`, `docs/SECURITY-MEMBERS.md`.
- **Note tecniche:** browser headless (nessuna finestra); ID corsi personali scoperti dalla dashboard dopo il login (non in `config.json`); orari in `config.json` → `workSchedule`.

</details>
