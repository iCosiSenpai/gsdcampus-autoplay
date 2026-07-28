# Novità

Questo file racconta le novità in linguaggio semplice: dopo "Aggiorna e avvia"
il comando curl mostra automaticamente le righe nuove di questo file.
(Per il maintainer: aggiungere una sezione `## data` con bullet brevi a ogni
push rilevante; il box "Novità" mostra al massimo 10 righe.)

## 2026-07-28

- **Risolto un blocco che fermava i corsi**: se la banca risposte locale non era d'accordo con quella condivisa, l'avvio si interrompeva ("Conflitto nella banca risposte") e il Mac restava fermo. Ora si riallinea da solo — per quella domanda vale la risposta condivisa da tutti — tiene una copia di sicurezza e riparte. Le risposte nuove arrivano comunque anche in presenza di un disaccordo.
- Nuova voce nel menu del comando: **"Reinstallazione totale"**. Riscarica tutto da zero tenendo il tuo nome, l'accesso al corso e gli orari; la cartella vecchia viene spostata in `~/gsdcampus-vecchia-…`, non cancellata.
- Il **calendario della settimana** non sparisce più un attimo dopo essere apparso: ora sta dentro la schermata di conferma, insieme al riepilogo.
- Gli errori imprevisti nel log non compaiono più come `ERRORE CRITICO: {}` ma col motivo scritto.

- **Si può tornare indietro** durante la configurazione: **ESC** (o la voce `◂ Indietro`) riporta alla domanda precedente — dai giorni si torna a «Chi sei?», dall'orario ai giorni, e dentro "Altro orario" si risale una domanda per volta. Dal riepilogo si cambia solo l'orario, solo i giorni o solo il collega. Niente più "ricominciamo l'inserimento".

- **La schermata si riapre da sola** quando arriva un aggiornamento: prima restava sulla versione vecchia (l'orologio avanzava ma il contenuto sembrava fermo) e bisognava chiuderla a mano. Ora avvisa e si riapre dopo 6 secondi — e **aspetta** se stai leggendo il log dal vivo o se c'è un quiz in corso. I corsi non si fermano.
- Anche l'automazione **adotta il codice nuovo da sola**, tra un corso e l'altro: mai durante un video o un quiz.
- Se non c'è nessun corso in esecuzione, la schermata lo dice ("stato del corso di 4h 12m fa"), così un contenuto immobile non sembra un blocco.

- **Prima configurazione senza tastiera**: niente più orari da scrivere né numeri dei giorni. I giorni si spuntano con la barra spaziatrice, l'orario si sceglie tra modelli pronti ("09:00–20:00 con pausa 13:00-16:00", il più comune) e con "Altro orario" si sposta l'ora con le frecce (←→ 15 minuti, ↑↓ un'ora).
- Il setup chiede l'**orario del negozio** — apre, chiude, pausa pranzo — invece di parlare di "turni": le fasce le calcola lui.
- **Anteprima della settimana** prima di salvare: si vede disegnato quando lavora e quando è chiuso. Se qualcosa non torna, "Cambio l'orario" o "Cambio i giorni" rifà solo quel passo invece di ricominciare.
- **"Chi sei?" in una schermata**: si scrivono due lettere del cognome e l'elenco si restringe; se il Mac è già configurato la prima voce è "Continua come <nome>". Codice fiscale, link da incollare e import CSV sono finiti sotto "Non mi trovo nell'elenco…".
- Via il gergo dalle schermate: niente codice fiscale nei riepiloghi, niente indirizzo di accesso (ora dice "collegato al tuo nome ✓"), e la richiesta della password del Mac è spiegata a parole.

- **Plancia in stile Pac-Man**: la barra dell'avanzamento ora prende tutta la larghezza della finestra e ha un vero Pac-Man giallo che mastica (bocca spalancata → media → chiusa, come nel gioco) mentre mangia le pastiglie. I corsi in attesa di risposte diventano **fantasmini** in coda, coi colori dei quattro originali. Muri del labirinto blu, pastiglie bianche, tasti in giallo, e la mascotte nell'intestazione di tutti i comandi.

- **Corsi bloccati sbloccati**: la stessa lezione vive su due indirizzi (elenco e riproduttore) e le lezioni "asincrone" erano invisibili all'automazione. Aprendo una lezione la piattaforma dice "Completa l'attività corrente" e porta su quella asincrona: il programma guardava quel video (20+ minuti) ma poi controllava la lezione sbagliata, che restava a 0% — tre tentativi a vuoto e corso fermo. Ora segue la lezione giusta, la porta a termine e riprende quella che voleva aprire.
- **Se chiudi Chrome per sbaglio** l'automazione lo dice in chiaro, riapre un browser e riprende dal punto salvato, invece di registrare un errore critico.
- Il **checkup** avvisa se la cartella del progetto è stata spostata o rinominata: in quel caso i servizi in background morivano in silenzio (niente aggiornamenti, niente riavvio automatico).
- Nel README c'è una sezione **"Ho toccato qualcosa per sbaglio"** con cosa succede e cosa fare per i casi più comuni (logout AI, Chrome chiuso, finestra chiusa, cartella spostata, Wi-Fi staccato).

- **Modo A riparato**: il file "GSD Avvia" arriva ora come archivio e dentro c'è il file **già eseguibile**. Prima, scaricato dal browser, il doppio clic rispondeva "non hai i permessi necessari" e non partiva niente. Ogni doppio clic scarica l'ultima versione: aggiorna sempre.
- **"Aggiorna e avvia" ora dice la verità**: se l'aggiornamento non parte (rete o proxy che bloccano GitHub) lo scrive a chiare lettere invece di stampare "Progetto aggiornato". A fine giro compare sempre l'esito reale: `Aggiornato: 964824c → 42a07aa` oppure `Già all'ultima versione (964824c)`.
- Il **controllo rete prima dell'aggiornamento** non pretende più che rispondano *tutti* gli indirizzi di prova: su reti aziendali filtrate bastava un blocco per saltare l'aggiornamento in silenzio. Ora basta una risposta e il timeout è più tollerante (8s).
- Le installazioni **partite dallo zip** (senza cronologia git) non potevano aggiornarsi *mai*, senza dirlo: adesso il comando lo rileva, lo spiega e propone la riparazione automatica — account, orari, risposte e log restano al loro posto.
- Il **checkup** (menu → "Diagnostica on-demand") dice se il Mac è aggiornabile: cartella valida, GitHub raggiungibile, di quanti aggiornamenti è indietro e stato dell'auto-aggiornamento.
- Sui Mac dei colleghi la **versione** compare leggibile (`v1.1.0 · 42a07aa`) anche se il clone non ha le etichette di versione: prima si vedeva solo un codice esadecimale.
- La plancia ora è **viva**: mascotte Pac-Man che mangia la strada da fare (con fantasmino quando un corso è in attesa), barra del video con spinner, orologio dei dati. Si ridisegna 4 volte al secondo senza sfarfallio e senza leggere più file di prima.
- In alto compare la **versione installata** accanto al tuo nome.
- **Q ora è chiaro**: chiude *questa scheda* del Terminale — non l'app e non le altre finestre, che possono fare altro. Niente più promesse tipo "chiudere non ferma nulla": se la chiusura interrompe i processi, il guardiano li riavvia entro ~2 minuti, e se il guardiano non è attivo la plancia lo dice in giallo. **F** resta la fermata vera, **Ctrl-C** esce lasciando la scheda aperta.
- La plancia e `./status.sh` mostrano l'**auto-aggiornamento**: "controllato 4m fa · già all'ultima versione", oppure un avviso giallo se non controlla da più di 35 minuti o se non è attivo su quel Mac. Prima, quando non c'era niente di nuovo, l'auto-update non lasciava traccia e sembrava fermo.
- Se il Mac si aggiorna **mentre la plancia è aperta**, la plancia lo dice: "Si è aggiornato da solo (964824c ▸ 1a2b3c4) — questa finestra mostra ancora la versione precedente, chiudila con Q e rilancia il comando curl".
- **Notifica macOS** ad aggiornamento riuscito ("Aggiornato all'ultima versione"), così te ne accorgi anche senza nessun terminale aperto.
- "Guarda dal vivo" (tasto **L**) è di sola lettura e non ferma niente: si torna alla plancia con **Q**.
- Se annulli o chiudi il Terminale durante la **prima configurazione**, al rilancio il setup **riprende da dove eri** invece di dare errore: prima "Aggiorna e avvia" si bloccava a ogni tentativo.
- Corretto un problema serio: scegliendo **"Mantieni account attuale"** per cambiare solo gli orari, il link di accesso e il nominativo venivano **cancellati** da `config.json` (e al riavvio sembrava "configurazione non valida"). Ora l'account resta al suo posto.
- Nuovo **editor dei turni**: i turni impostati sono voci del menu e basta selezionarne uno per cambiarne inizio e fine (orari attuali già precompilati, Invio li tiene). Alla conferma si passa come sempre al riepilogo finale.
- Scegliendo "Tutti i giorni" ora viene salvata anche la **domenica** (prima veniva scartata in silenzio).
- Le risposte imparate dalla piattaforma si **distribuiscono da sole** ai colleghi a fine di ogni sessione: prima uscivano solo quelle risolte dall'AI.
- Se la riconfigurazione dell'account viene annullata a metà, gli orari precedenti vengono ripristinati anche quando `config.json` era rimasto incompleto.

## 2026-07-21

- Claude Code ora lavora **solo on-demand**: con inbox quiz vuota non partono neppure le CLI di verifica/installazione AI e non viene consumata nessuna richiesta.
- Se Claude o la distribuzione delle risposte falliscono, il sistema conserva tutto e ritenta: 30 minuti per il batch, marker persistente per lo share ai colleghi.
- Il launcher esegue sync/harvest/resolve/start in modo deterministico; Claude riceve solo domanda, opzioni e guess, restituisce JSON validato e termina insieme al proxy.
- Lo scheduler richiama il batch su un nuovo fingerprint quando entra in `awaiting_ai`, senza tenere una TUI o riaprire il browser del corso in loop.
- Il login resta quello semplice di Ollama nel browser (`ollama signin`) e compare soltanto quando serve realmente un quiz; OpenCode installato in precedenza viene lasciato intatto ma non usato.
- Il proxy supporta le route Anthropic di Claude, conserva il budget rolling e limita ogni batch a 8 richieste generative.

- Il supervisore OpenCode usa di nuovo il login browser gestito da Ollama: `ollama signin`, daemon locale e modello Cloud completo. Non richiede più di creare o incollare API key; il proxy locale continua ad applicare budget e limiti.
- Il supervisore ripulisce i proxy Ollama rimasti bloccati, verifica il ponte locale prima di aprire OpenCode e conserva il token del proxy nella sessione per evitare falsi `Unauthorized`.
- Il menu del curl è stato ridisegnato da zero: mascotte persistente, layout centrato, descrizioni separate e voce consigliata evidenziata. Il renderer viene aggiornato prima del primo menu, così il nuovo aspetto si vede già al primo rilancio.
- Il benvenuto è stato semplificato a una sola mascotte, senza fumetti duplicati; il ridimensionamento usa ora i bounds nativi macOS quando il Terminale non applica il comando ANSI.
- Il comando curl accoglie i colleghi con una piccola mascotte, pannelli più leggibili e adatta automaticamente Terminal.app/iTerm2 quando la finestra è troppo piccola, senza ridurre quelle già grandi.
- Lo scheduler mostra `off_hours` con heartbeat e prossimo turno, senza lasciare vecchi errori come se fossero ancora attivi.
- Prima di ogni browser viene verificato il contratto dei selettori: se il controllo fallisce, nessun corso o quiz viene aperto.
- Il lock anti-doppio-avvio verifica PID, comando e token casuale: un PID riciclato non può più essere scambiato per l'autoplay.
- Riaperture e reset creano backup recuperabili dello stato corsi, con checksum e controllo dell'account; il database membri non viene incluso.
- La banca risposte rileva duplicati Unicode e risposte discordanti, blocca i conflitti e può confrontare la copia locale con `main`.
- L'harvester ora ha un vero `--help`, rifiuta opzioni sconosciute e richiede `--yes` per qualunque riapertura esplicita.

## 2026-07-19

- Fine video più affidabile: ascolta l'evento "ended" del player e controlla più spesso vicino alla fine della lezione.
- I dump di errore/diagnostica non salvano più token video o di accesso in chiaro.
- Il censimento corsi mostra di nuovo le **percentuali corrette** dalla dashboard (prima spesso compariva "?").
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
