// @ts-check
/**
 * course-page-diag.js — perché la pagina di un corso non contiene lezioni (pure).
 *
 * Nasce da un errore reale arrivato a tutta la flotta:
 *
 *   MONITOR ERROR courseParsing: No lesson/quiz links found
 *   Debug artifacts saved: debug/dumps/error_2026-07-28T14-28-38.html
 *   Verifico quiz finale...
 *
 * Il dump non era la pagina del corso: era l'**informativa** (privacy + piano
 * formativo + scheda tecnica) che la piattaforma serve anche su
 * /corso/show/<id>, senza redirect. Il messaggio non lo diceva, e chi leggeva il
 * log pensava a un corso rotto.
 *
 * Qui trasformiamo pochi flag raccolti dal DOM in una diagnosi leggibile e in due
 * decisioni: se vale la pena riprovare (accettare l'informativa) e se serve
 * davvero registrare un errore con dump.
 */

/**
 * @typedef {Object} CoursePageFlags
 * @property {boolean} [hasInformativaForm] form dell'informativa presente
 * @property {boolean} [hasCertificate]     link "scarica attestato" presente
 * @property {boolean} [hasPdf]             solo materiale PDF
 * @property {boolean} [isLoginPage]        siamo tornati alla login
 * @property {boolean} [hasGateNotice]      "Completa l'attività corrente…"
 * @property {number}  [anchorCount]        quanti <a> ha la pagina
 */

/**
 * @typedef {Object} CoursePageDiagnosis
 * @property {string} reason      informativa|attestato|pdf|login|gate|vuota|sconosciuto
 * @property {string} message     riga di log in italiano, pronta da stampare
 * @property {boolean} retryInformativa conviene accettare l'informativa e rileggere
 * @property {boolean} recordError serve dump + MONITOR ERROR
 */

/**
 * @param {CoursePageFlags} flags
 * @returns {CoursePageDiagnosis}
 */
function diagnoseEmptyCoursePage(flags = {}) {
  const f = flags || {};
  if (f.isLoginPage) {
    return {
      reason: 'login',
      message: 'la pagina mostrata è la login (sessione caduta): riprovo dopo il re-login, non è un problema del corso.',
      retryInformativa: false,
      recordError: false,
    };
  }
  if (f.hasInformativaForm) {
    return {
      reason: 'informativa',
      message: "è l'informativa del corso (privacy/piano formativo/scheda tecnica) servita sull'URL del corso: la accetto e rileggo la pagina.",
      retryInformativa: true,
      recordError: false,
    };
  }
  if (f.hasCertificate) {
    return {
      reason: 'attestato',
      message: 'il corso risulta concluso (in pagina c\'è il download dell\'attestato): niente lezioni da seguire.',
      retryInformativa: false,
      recordError: false,
    };
  }
  if (f.hasGateNotice) {
    return {
      reason: 'gate',
      message: "la piattaforma chiede di completare l'attività corrente prima di aprire altri contenuti: riprendo dal contenuto in corso.",
      retryInformativa: false,
      recordError: false,
    };
  }
  if (f.hasPdf) {
    return {
      reason: 'pdf',
      message: 'il corso offre solo materiale PDF, nessun video o questionario da eseguire.',
      retryInformativa: false,
      recordError: false,
    };
  }
  if ((f.anchorCount || 0) < 5) {
    return {
      reason: 'vuota',
      message: `la pagina è praticamente vuota (${f.anchorCount || 0} link): probabile caricamento interrotto, salvo il dump.`,
      retryInformativa: false,
      recordError: true,
    };
  }
  return {
    reason: 'sconosciuto',
    message: 'nessuna lezione, nessun questionario e nessuna causa riconosciuta: salvo il dump per analisi.',
    retryInformativa: false,
    recordError: true,
  };
}

module.exports = { diagnoseEmptyCoursePage };
