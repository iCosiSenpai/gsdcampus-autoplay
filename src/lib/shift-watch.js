const { isWorkTime, nextWorkEnd, nextWorkStart } = require('./schedule');

// Minuti di tolleranza OLTRE la fine del turno per completare il contenuto
// (video/lezione) in corso prima di fermarsi. La piattaforma salva la posizione
// di fruizione, quindi tagliare a metà un video è sicuro: lo scheduler riprende
// al turno successivo dal punto esatto. Scaduta la tolleranza ci si ferma
// comunque (non si rimanda all'infinito).
const EXTRA_TIME_MIN = 15;

// Checker stateful di fine turno, EDGE-TRIGGERED sul passaggio in→out orario.
//
// Perché esiste: l'ora di fine turno si controllava SOLO in cima al loop
// esterno di autoplay.js, raggiungibile solo a corsi finiti. Ma watchVideo ha
// un while che dura anche ore (un video lungo fino a 3h) e runCourse ha il suo
// while sulle lezioni: nessuno dei due controllava mai l'orario, così
// l'autoplay attraversava la fine turno senza fermarsi (seguito live: video
// che proseguiva alle 16:07 nonostante il turno finisse alle 13:00).
//
// Questo checker si crea UNA volta per run e si passa a tutti i loop (loop
// esterno, runCourse, watchVideo): così il check avviene anche in mezzo a un
// video, ogni 30s, e la decisione "fermarsi o no" è unica e coerente.
//
// Edge-triggered (vs il vecchio "minutesSinceEnd <= 15"): calcoliamo
// l'extra-time UNA sola volta, sul reale passaggio da in-orario a fuori-orario
// (wasInWork true→false). Il vecchio approccio usava nextWorkEnd() che, DURANTE
// un gap tra turni (es. 13:00→16:30), restituisce la FINE del turno FUTURO
// (20:00) → minutesSinceEnd NEGATIVO → "≤ 15" sempre vero → extra-time
// ri-armato all'infinito → non ci si fermava MAI durante un gap lungo. Con il
// transizione-edge, durante il gap wasInWork resta false e l'extra-time non si
// ri-arma: ci si ferma davvero a 15 min dalla vera fine turno.
function makeShiftChecker() {
  let extraTimeUntil = 0; // 0 = nessuna extra-time attiva
  let wasInWork = isWorkTime(new Date());

  // Valuta lo stato di turno. Ritorna:
  //   { inWork, stop, extraTime, extraTimeArmed, end, start, extraTimeUntil }
  // - inWork: siamo dentro un turno configurato.
  // - stop: fuori orario E tolleranza scaduta (è ora di fermarsi graceful).
  // - extraTime: fuori orario ma dentro la finestra di tolleranza (continua).
  // - extraTimeArmed: true SOLO sulla chiamata che ha armato la tolleranza
  //   (utile per loggarla una volta, non a ogni 30s).
  // - end/start: prossimi confini di turno (per log e monitor).
  function evaluate() {
    const now = Date.now();
    const d = new Date(now);
    const inWork = isWorkTime(d);
    const end = nextWorkEnd(d);
    const start = nextWorkStart(d);

    if (inWork) {
      // Dentro un turno: resetta lo stato della tolleranza (era di un turno
      // precedente, già concluso). wasInWork true → prossimo passaggio fuori
      // arremerà di nuovo l'extra-time.
      wasInWork = true;
      extraTimeUntil = 0;
      return { inWork: true, stop: false, extraTime: false, extraTimeArmed: false, end, start, extraTimeUntil: null };
    }

    // Fuori orario. Arma l'extra-time UNA sola volta, sul reale passaggio
    // in→out (wasInWork true). Se eravamo già fuori (gap lungo, o processo
    // partito fuori orario), wasInWork è false e NON si arma: ci si ferma
    // subito (non c'è un "turno appena finito" da onorare).
    let armed = false;
    if (wasInWork && extraTimeUntil === 0) {
      extraTimeUntil = now + EXTRA_TIME_MIN * 60000;
      armed = true;
    }
    wasInWork = false;

    const extraTime = extraTimeUntil > 0 && now < extraTimeUntil;
    return {
      inWork: false,
      stop: !extraTime, // fuori orario e tolleranza scaduta
      extraTime,
      extraTimeArmed: armed,
      end,
      start,
      extraTimeUntil: extraTimeUntil > 0 ? extraTimeUntil : null,
    };
  }

  return { evaluate, EXTRA_TIME_MIN };
}

module.exports = { makeShiftChecker, EXTRA_TIME_MIN };