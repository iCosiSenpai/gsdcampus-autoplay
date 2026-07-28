// @ts-check
/**
 * lesson-url.js — identità di una lezione a partire dall'URL (pure).
 *
 * La piattaforma serve i contenuti su più rotte:
 *   /lezione/show/<id>            lezione classica
 *   /lezioneAsincrona/show/<id>   lezione "asincrona" (fa spesso da cancello:
 *                                 "Completa l'attività corrente prima di
 *                                 accedere a questo contenuto")
 *
 * Il selettore storico `a[href*="/lezione/show/"]` NON matcha
 * `/lezioneAsincrona/show/` (la stringa cercata non è una sottostringa), quindi
 * le lezioni asincrone erano invisibili al runner: apriva una lezione normale,
 * la piattaforma reindirizzava al cancello asincrono, il runner guardava QUEL
 * video ma poi verificava il progresso della lezione CHIESTA — sempre 0% —
 * bruciando 3 tentativi da una ventina di minuti l'uno e bloccando il corso.
 *
 * Qui teniamo le funzioni per riconoscere e confrontare le lezioni.
 */

// Cattura la famiglia (lezione, lezioneAsincrona, …) e l'id numerico.
const LESSON_RE = /\/(lezione[A-Za-z]*)\/show\/(\d+)/i;

/**
 * Chiave canonica della lezione, es. "lezioneasincrona:14062".
 * @param {string} url
 * @returns {string|null} null se l'URL non è una lezione
 */
function lessonKey(url) {
  const m = String(url || '').match(LESSON_RE);
  if (!m) return null;
  return `${m[1].toLowerCase()}:${m[2]}`;
}

/**
 * True se l'URL è una pagina di lezione (qualunque famiglia).
 * @param {string} url
 */
function isLessonUrl(url) {
  return lessonKey(url) !== null;
}

/**
 * True se i due URL puntano alla STESSA lezione (ignora host, query e hash).
 * @param {string} a
 * @param {string} b
 */
function sameLesson(a, b) {
  const ka = lessonKey(a);
  const kb = lessonKey(b);
  return ka !== null && ka === kb;
}

/**
 * Id numerico della lezione (stringa) oppure null.
 * @param {string} url
 */
function lessonId(url) {
  const m = String(url || '').match(LESSON_RE);
  return m ? m[2] : null;
}

module.exports = { LESSON_RE, lessonKey, isLessonUrl, sameLesson, lessonId };
