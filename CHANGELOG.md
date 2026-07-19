# Novità

Questo file racconta le novità in linguaggio semplice: dopo "Aggiorna e avvia"
il comando curl mostra automaticamente le righe nuove di questo file.
(Per il maintainer: aggiungere una sezione `## data` con bullet brevi a ogni
push rilevante; il box "Novità" mostra al massimo 10 righe.)

## 2026-07-19

- Se l'autoplay non gira più, lo stato non resta finto "in esecuzione": si allinea da solo (niente più corse fantasma).
- L'autoplay e i controlli partono anche **senza Google Chrome** installato: usano in automatico Chromium di Playwright.
- Lo stato mostra da quanto tempo non si aggiorna (evita di confondere un run vecchio con la situazione attuale); il checkup verifica anche i selettori della piattaforma.
- Le risposte dei quiz verificate si distribuiscono a **tutti i colleghi anche senza permessi git**: l'AI le invia a un servizio del manutentore che le pubblica per tutti.
- Codice riorganizzato senza cambiare il comportamento: matching quiz e pagine di login/informativa in moduli separati (più facile da mantenere e testare).
- Aggiunti test automatici sulle funzioni critiche (quiz, orari, log, stato corsi) e un controllo CI su GitHub: i fix vengono verificati prima di arrivare ai colleghi.

## 2026-07-17

- Aggiunto un avviso automatico: il sistema ora ti informa se c'è una nuova versione disponibile e ti consiglia di aggiornare.
- Risolto un ritardo della piattaforma che a volte causava un secondo tentativo inutile a fine video: ora aspetta qualche secondo in più che il 100% venga salvato.

## 2026-07-16

- "Cambia account Ollama" ora aggiorna anche il codice e chiede il login una volta sola (prima lo chiedeva due volte).
- Nuovo strumento che raccoglie in anticipo le domande dei questionari finali (senza compilarli né consumare tentativi) così l'AI può preparare le risposte prima del quiz.
- I corsi con video al 100% ma questionario finale ancora da fare vengono ora riconosciuti e rimessi in coda automaticamente (prima potevano risultare "completati" per errore).
- Il quiz finale viene inviato solo quando tutte le risposte sono certe: se ne manca qualcuna, il sistema si ferma e la prepara con l'AI invece di sprecare un tentativo.
- All'avvio l'AI controlla quanti corsi ci sono e la loro percentuale di completamento (`./status.sh` lo mostra in cache); nuove risposte verificate aggiunte al glossario condiviso.
- L'AI ora si orienta da un unico "elenco cose da fare" e viene avvisata anche quando il link di accesso scade; un solo comando fa il giro completo di controllo dei corsi; le risposte verificate si distribuiscono ai colleghi con un comando.
- Il supervisore ora lavora in autonomia: all'apertura controlla i corsi, prepara le risposte dei quiz e avvia il corso da solo (rispettando gli orari), senza farti rispondere a domande a ogni passo. Interviene solo se è davvero bloccato.

## 2026-07-15

- Nuovo checkup automatico a semaforo dopo ogni aggiornamento: vedi subito se rete, piattaforma, Ollama e configurazione sono a posto, con il rimedio scritto accanto.
- Notifiche macOS quando il corso ha bisogno di aiuto o il link di accesso è scaduto: non serve più tenere d'occhio il Terminale.
- Il sistema si aggiorna da solo ogni notte (e se un aggiornamento è difettoso torna indietro da solo).
- Nuova voce nel menu del comando curl per cambiare account Ollama (esci ed entra con un altro login).
- Grafica del setup completamente rinnovata: box, colori e avanzamento a pallini.
- Risolto il problema per cui il download del modello AI risultava "non disponibile" anche quando era andato a buon fine.
