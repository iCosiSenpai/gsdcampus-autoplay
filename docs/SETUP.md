# Configurazione iniziale

La prima volta che `./launch-ai-supervisor.sh` viene eseguito, `setup.sh` chiede interattivamente:

1. La **schermata "Chi sei?"**: in cima *"Continua come <nome>"* quando il Mac è già configurato, poi *"Trova il mio nome nell'elenco"* — una schermata sola con **ricerca incrementale** (si scrivono due lettere del cognome e l'elenco si restringe). Codice fiscale, link incollato a mano e import CSV stanno sotto *"Non mi trovo nell'elenco…"*.
2. I giorni di apertura (default lun-venerdì).
3. I **giorni di apertura** (lista da spuntare) e l'**orario del negozio** (modelli pronti oppure orologio a frecce), con anteprima della settimana prima di salvare.

Questi dati vengono salvati in `config.json` (con `codice_fiscale` + `memberName` + `autologinUrl` + `workSchedule`). Lo stato personale viene migrato in `data/accounts/<CF>/`. In seguito, ogni avvio mostrerà solo una conferma dei dati configurati.

## Giorni e orario: come li chiede

Il setup non parla di "turni": chiede l'orario del **negozio** e traduce lui (`src/lib/schedule-ui.js`).

**1. Giorni — lista da spuntare**, non più numeri da digitare (`0=dom 1=lun …` non esiste più):

```
   In quali giorni è aperto il negozio?
   Spazio per spuntare · A tutti · N nessuno · Invio per confermare

 ▌  [x]  lunedì
    [x]  martedì
    [x]  mercoledì
    [x]  giovedì
    [x]  venerdì
    [ ]  sabato
    [ ]  domenica
```

**2. Orario — modelli pronti**, con il più comune per primo:

```
   A che ora apre e chiude il negozio?
 ▌  01  09:00 – 20:00 con pausa 13:00-16:00   il più comune
    02  09:00 – 18:00 senza pausa
    03  Solo mattina — 09:00 – 13:00
    04  Solo pomeriggio — 16:00 – 20:00
    05  Altro orario — lo scelgo con le frecce
```

**3. "Altro orario" — orologio a frecce**, niente orari da scrivere né messaggi sui formati accettati:

```
   A che ora apre?

         ‹   08:30   ›

   ←→ 15 minuti   ↑↓ un'ora   INVIO confermo
```

Poi *"C'è la pausa pranzo?"*: se sì, altri due orologi (inizio pausa e riapertura) e `buildShiftsFromStoreHours()` genera due fasce; se no, una sola. Le combinazioni impossibili vengono spiegate a parole ("La pausa deve stare dentro l'orario di apertura"), non con l'elenco dei formati del parser.

**4. Anteprima della settimana** prima di salvare — si *vede* quando lavora:

```
 Ecco come lavorerà
 ────────────────────────────────────────────
  Collega            MARIO ROSSI
  Accesso al corso   collegato al tuo nome ✓
  Giorni             lunedì, martedì, mercoledì, giovedì, venerdì e sabato
  Orario             08:30-13:00 e 16:00-19:30
 ────────────────────────────────────────────
        07  09  11  13  15  17  19
  lun   ···█████████······███████···
  ...
  dom   chiuso

 · Fuori da queste ore si mette in pausa da sola e riprende al turno dopo.

   Va bene così?
 ▌  01  Sì, salva e vai
    02  Cambio l'orario
    03  Cambio i giorni
```

Scegliendo "Cambio l'orario" o "Cambio i giorni" si rifà **solo quel passo** (`CONFIG_STEP` in `setup.sh`), senza ricominciare da capo come faceva il vecchio `[y/N]`.

## Chi lo usa senza mouse né lettura di manuali

- Zero orari da digitare: tutto con frecce e Invio. Il parser flessibile (`9`, `9:30`, `1630`) resta solo come rete di sicurezza nel fallback non interattivo.
- Il codice fiscale non compare mai nelle schermate principali; l'URL di autologin nemmeno (il riepilogo dice `collegato al tuo nome ✓`).
- Le strade tecniche — ricerca per codice fiscale, link incollato a mano, import CSV — stanno sotto **"Non mi trovo nell'elenco…"**, dove non ci si finisce per sbaglio.
- Widget in `scripts/lib/prompt-cli.js`: `timeMenu` (orologio), `checkMenu` (lista da spuntare), `filterMenu` (ricerca incrementale). Anche da shell: `node scripts/lib/prompt-cli.js time --default 09:00` e `… check --default 1,2,3 -- lun mar mer`.

## Editor avanzato dei turni (casi particolari)

Serve solo a chi ha **più di due fasce** nella stessa giornata: si raggiunge da "Altro orario" → *"Ho più di due fasce"*. I turni impostati sono voci selezionabili del menu:

```
I tuoi turni — seleziona un turno per modificarlo
Turni attuali:  09:00-13:00   ·   16:00-20:00

▌  01  Turno 1: 09:00-13:00     seleziona per cambiare inizio/fine
   02  Turno 2: 16:00-20:00     seleziona per cambiare inizio/fine
   03  Aggiungi un turno        un altro intervallo nella giornata
   04  Rimuovi un turno         scegli quale eliminare
   05  Svuota tutti i turni     riparti da zero
   06  Conferma e continua      vai al riepilogo finale
```

- Selezionare un turno ne riapre inizio e fine, **già precompilati** con gli orari attuali.
- Fine dopo l'inizio, nessuna sovrapposizione (il turno in modifica è escluso dal controllo), massimo 4 fasce.

## Se la prima configurazione viene interrotta

Se si annulla o si chiude il Terminale **dopo** aver scelto l'account ma **prima** di salvare gli orari, `config.json` resta con l'account e senza `workSchedule`. Al rilancio del comando curl il setup **riprende da «Chi sei?»** e completa la configurazione: non serve lanciare niente a mano.

Il controllo di completezza è `scripts/lib/config-check-cli.js` (logica in `src/lib/config-check.js`), usato sia da `setup.sh` sia da `launch-ai-supervisor.sh`. Esce 0 se `config.json` ha account e orari validi, altrimenti 1 con il motivo (`missing_file`, `bad_json`, `missing_autologin`, `missing_schedule`). Serve perché `src/lib/schedule.js` ripiega sui default (lun-ven 09:00-13:00 / 16:00-20:00) quando `workSchedule` manca: senza questo check un setup interrotto sembrerebbe valido e i turni scelti dall'utente non verrebbero mai chiesti.

In modalità "Cambia collega o orari" la configurazione precedente viene salvata in `config.json.bak` e ripristinata se si annulla, fino a quando la nuova non è completa.
