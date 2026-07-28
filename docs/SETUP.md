# Configurazione iniziale

La prima volta che `./launch-ai-supervisor.sh` viene eseguito, `setup.sh` chiede interattivamente:

1. La **schermata "Chi sei?"**: menu interattivo nel terminale navigabile con frecce ↑/↓ e Invio. Permette di cercare per nome/cognome/CF nel database `data/members.db`, vedere la lista completa, importare il CSV, incollare manualmente il link di autologin o mantenere l'account attuale.
2. I giorni lavorativi (default lun-venerdì).
3. Un **modello di turni** di partenza (classico, continuato, solo mattina, solo pomeriggio, o "parto da zero") e poi l'**editor dei turni**.

Questi dati vengono salvati in `config.json` (con `codice_fiscale` + `memberName` + `autologinUrl` + `workSchedule`). Lo stato personale viene migrato in `data/accounts/<CF>/`. In seguito, ogni avvio mostrerà solo una conferma dei dati configurati.

## Editor dei turni

Dopo il modello di partenza, i turni impostati compaiono come **voci selezionabili** del menu:

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

- Selezionare un turno ne riapre inizio e fine, **già precompilati** con gli orari attuali: Invio li tiene, altrimenti si scrive il nuovo orario (`9:30`, `09.30`, `930`, `1630`…).
- Fine deve essere successiva all'inizio e i turni non possono sovrapporsi (il turno che si sta modificando è escluso dal controllo).
- Massimo 4 turni. Serve almeno un turno per confermare.
- "Conferma e continua" (voce di default: basta Invio) porta al **riepilogo** finale con membro, autologin, giorni, turni e modello AI, dove si salva con `y`.

## Se la prima configurazione viene interrotta

Se si annulla o si chiude il Terminale **dopo** aver scelto l'account ma **prima** di salvare gli orari, `config.json` resta con l'account e senza `workSchedule`. Al rilancio del comando curl il setup **riprende da «Chi sei?»** e completa la configurazione: non serve lanciare niente a mano.

Il controllo di completezza è `scripts/lib/config-check-cli.js` (logica in `src/lib/config-check.js`), usato sia da `setup.sh` sia da `launch-ai-supervisor.sh`. Esce 0 se `config.json` ha account e orari validi, altrimenti 1 con il motivo (`missing_file`, `bad_json`, `missing_autologin`, `missing_schedule`). Serve perché `src/lib/schedule.js` ripiega sui default (lun-ven 09:00-13:00 / 16:00-20:00) quando `workSchedule` manca: senza questo check un setup interrotto sembrerebbe valido e i turni scelti dall'utente non verrebbero mai chiesti.

In modalità "Cambia collega o orari" la configurazione precedente viene salvata in `config.json.bak` e ripristinata se si annulla, fino a quando la nuova non è completa.
