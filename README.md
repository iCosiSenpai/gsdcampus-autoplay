🔴 **Usa questo programma solo se sei autorizzato dal titolare del corso.**

# GSD Campus Autopilot

Segue **da solo** le video-lezioni e i quiz del corso GSD Campus sul Mac del tuo store.
Tu lanci **un comando**, al resto pensa lui: segue i corsi negli orari di lavoro, si ferma da solo la sera e riprende il giorno dopo.

---

## 🚀 Come si avvia

È l'**unica** cosa che devi ricordare.

1. Apri il **Terminale** (in alto a destra clicca la lente 🔍 → scrivi `Terminale` → Invio).
2. Copia e incolla questo comando **su una riga sola**, poi premi **Invio**:

```bash
curl -fsSL https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/install.sh | bash
```

> Se sembra che non parta, premi di nuovo **Invio**: a volte l'incolla non porta con sé l'"a capo" finale.

Questo comando fa **tutto**: la prima volta installa, le volte dopo aggiorna, e ogni volta avvia i corsi. Non ci sono altri comandi da imparare.

---

## 👋 La prima volta

Il Terminale ti farà qualche domanda. Rispondi con calma, è tutto normale:

- **Password del Mac** — quella che usi per accendere il computer. Te la chiede una volta sola.
- Se chiede di **installare o aggiornare** qualcosa → rispondi **sì**.
- **"Chi sei?"** — scegli il tuo nome dall'elenco che compare (frecce ↑ ↓ e **Invio**). Non devi incollare nessun link: è già tutto collegato al tuo nome.
- **Giorni e orari** dello store — scegli una modalità pronta o personalizza:

  | Modalità | Esempio |
  |----------|---------|
  | Continuato | 09:00–18:00 |
  | Solo mattina | 09:00–13:00 |
  | Solo pomeriggio | 14:00–18:00 |
  | Classico | 09:30–13:00 e 16:30–20:00 |
  | Personalizzato | fino a 3 turni a scelta |

Fatto questo, parte da solo. Le volte successive queste domande non ricompaiono.

---

## 🖥️ Cosa vedi quando è avviato

Alla fine si apre una **plancia** che ti dice a colpo d'occhio come sta andando e si aggiorna da sola:

```
 GSD Campus · IL TUO NOME                             ● attivo
 ────────────────────────────────────────────────────────────
   Sto seguendo   Sicurezza sul lavoro · video 68%

   Corsi     ▸ 7 totali · 3 fatti · 4 da fare
   Quiz      ▸ nessuno in attesa
   Claude    ▸ inattivo — entra da solo solo se serve
   Turni     ▸ 09:00–13:00 · 16:00–20:00  · in orario
 ────────────────────────────────────────────────────────────
  L guarda dal vivo   F ferma e chiudi   R aggiorna   Q chiudi
```

Con un tasto solo:

- **Q** — chiudi la plancia. **Il lavoro continua** in background: puoi chiudere la finestra tranquillamente, i corsi vanno avanti lo stesso.
- **L** — guarda dal vivo cosa sta facendo.
- **R** — aggiorna subito i dati mostrati.
- **F** — **ferma tutto e chiude la tab** del Terminale.

Non devi tenere niente aperto: una volta avviato, lavora da solo anche a finestra chiusa.

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

La prima volta che serve davvero, potrebbe aprirsi il browser per un **accesso**: fai il login e torna al Terminale. Non devi creare o copiare nessuna chiave.

---

## 🛟 Se qualcosa non va

Quasi tutto si sistema **rilanciando il comando `curl`** e scegliendo **"Aggiorna e avvia"**.

- **Non parte o dà un errore strano** → rilancia il `curl`.
- **Dice "link scaduto" / non entra nel corso** → rilancia il `curl`; se insiste, scegli **"Cambia collega o orari"** e riseleziona il tuo nome.
- **Ti chiede se rimuovere "OpenCode"** → è la vecchia AI, non serve più: puoi rispondere **Sì**. (Se lo usi per conto tuo, scegli **No**.)
- **Il Mac** deve restare **acceso** (non in stop) quando i corsi devono girare: ci pensa lui a tenerlo sveglio, tu non spegnerlo.

Se davvero non si sblocca, avvisa chi ti ha dato l'automazione.

---

## Buono a sapersi

- Il Mac dello store va lasciato **acceso**; l'automazione rispetta gli orari e non lavora fuori turno.
- Non serve tenere aperta nessuna finestra: dopo l'avvio lavora in background.
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
- **Riferimenti completi:** `AGENTS.md` / `CLAUDE.md` (contratto supervisore), `docs/SETUP.md`, `docs/QUIZ.md`, `docs/ISSUES.md`, `docs/TECH.md`, `docs/SECURITY-MEMBERS.md`. Guida colleghi estesa: `README-COLLEGHI.md`.
- **Note tecniche:** browser headless (nessuna finestra); ID corsi personali scoperti dalla dashboard dopo il login (non in `config.json`); orari in `config.json` → `workSchedule`.

</details>
