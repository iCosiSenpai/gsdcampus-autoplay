// @ts-check
/**
 * lesson-url.js — identità di una lezione a partire dall'URL (pure).
 *
 * La piattaforma serve LA STESSA lezione su rotte diverse:
 *   /lezione/show/<id>            link nell'elenco della pagina corso
 *   /lezioneAsincrona/show/<id>   viewer effettivo di quella lezione
 * (verificato sul corso 17162: l'elenco mostra /lezione/show/14062 e il click
 * porta su /lezioneAsincrona/show/14062, stesso contenuto.)
 *
 * Conseguenze pratiche di cui tenere conto:
 *  1. Il selettore storico `a[href*="/lezione/show/"]` NON matcha
 *     `/lezioneAsincrona/show/`, quindi quelle pagine erano "invisibili".
 *  2. L'identità di una lezione è l'**id numerico**, non la rotta: confrontare
 *     le stringhe intere faceva sembrare diverse due URL della stessa lezione.
 *  3. Aprendo una lezione ancora bloccata la piattaforma reindirizza a un'ALTRA
 *     lezione (il "cancello": "Completa l'attività corrente prima di accedere a
 *     questo contenuto"). Lì l'id cambia: è questo il caso in cui il runner deve
 *     accorgersi di stare guardando un contenuto diverso da quello chiesto.
 */

// Cattura la famiglia (lezione, lezioneAsincrona, …) e l'id numerico.
const LESSON_RE = /\/(lezione[A-Za-z]*)\/show\/(\d+)/i;

/**
 * Id numerico della lezione (stringa) oppure null se l'URL non è una lezione.
 * @param {string} url
 */
function lessonId(url) {
  const m = String(url || '').match(LESSON_RE);
  return m ? m[2] : null;
}

/**
 * Identità canonica della lezione = il suo id. Rotte diverse (lezione /
 * lezioneAsincrona) sono la stessa lezione.
 * @param {string} url
 * @returns {string|null}
 */
function lessonKey(url) {
  return lessonId(url);
}

/**
 * Famiglia della rotta ("lezione", "lezioneAsincrona", …). Solo informativa/log.
 * @param {string} url
 */
function lessonFamily(url) {
  const m = String(url || '').match(LESSON_RE);
  return m ? m[1] : null;
}

/**
 * True se l'URL è una pagina di lezione (qualunque rotta).
 * @param {string} url
 */
function isLessonUrl(url) {
  return lessonId(url) !== null;
}

/**
 * True se i due URL puntano alla STESSA lezione: stesso id, indipendentemente
 * da host, rotta, query e hash.
 * @param {string} a
 * @param {string} b
 */
function sameLesson(a, b) {
  const ka = lessonId(a);
  const kb = lessonId(b);
  return ka !== null && ka === kb;
}

module.exports = { LESSON_RE, lessonKey, lessonId, lessonFamily, isLessonUrl, sameLesson };
