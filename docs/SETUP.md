# Configurazione iniziale

La prima volta che `./launch-ai-supervisor.sh` viene eseguito, `setup.sh` chiede interattivamente:

1. La **schermata "Chi sei?"**: menu interattivo nel terminale navigabile con frecce ↑/↓ e Invio. Permette di cercare per nome/cognome/CF nel database `data/members.db`, vedere la lista completa, importare il CSV, incollare manualmente il link di autologin o mantenere l'account attuale.
2. I giorni lavorativi (default lun-venerdì).
3. La modalità oraria preferita (continuato, mezza giornata, classico o personalizzato) e gli orari.

Questi dati vengono salvati in `config.json` (con `codice_fiscale` + `memberName` + `autologinUrl` + `workSchedule`). Lo stato personale viene migrato in `data/accounts/<CF>/`. In seguito, ogni avvio mostrerà solo una conferma dei dati configurati.
