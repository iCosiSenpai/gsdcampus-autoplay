/**
 * page-detect.js — predicati condivisi per riconoscere lo stato di una pagina
 * GSD Campus (login vs dashboard). Centralizzati qui per evitare che autoplay.js
 * e l'health-check vadano in deriva tra loro: un falso "autologin scaduto" nasce
 * proprio quando questi controlli divergono.
 */

// Marker testuali che indicano in modo affidabile la dashboard dell'utente.
// Stringa (non RegExp) perché viene serializzata dentro page.evaluate.
const DASHBOARD_MARKERS =
  'i miei corsi|i tuoi corsi|formazione|benvenut|dashboard|corsi disponibili|i miei piani formativi|attestati|attivi \\(|in attesa di esito';

/**
 * True se la pagina è (ancora) la schermata di login.
 * Logica anti-falso-positivo: se ci sono link ai corsi o marker di dashboard,
 * NON è login anche se il layout contiene un form di login nascosto. I campi
 * password contano solo se EFFETTIVAMENTE visibili.
 */
async function isLoginPage(page) {
  if (/\/login(\?|$|\/)/.test(page.url())) return true;
  return await page
    .evaluate((markers) => {
      const bodyText = document.body ? document.body.innerText : '';
      const hasCourseLinks =
        document.querySelectorAll('a[href*="/corso/show/"]').length > 0;
      const hasDashboardMarkers = new RegExp(markers, 'i').test(bodyText);
      if (hasCourseLinks || hasDashboardMarkers) return false;
      const visiblePassword = [
        ...document.querySelectorAll('input[type="password"]'),
      ].some((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return (
          r.width > 0 &&
          r.height > 0 &&
          s.visibility !== 'hidden' &&
          s.display !== 'none'
        );
      });
      return visiblePassword || /inserisci le tue credenziali/i.test(bodyText);
    }, DASHBOARD_MARKERS)
    .catch(() => false);
}

/** True se la dashboard è caricata (link corsi o marker testuali presenti). */
async function isDashboardLoaded(page) {
  return await page
    .evaluate((markers) => {
      const bodyText = document.body ? document.body.innerText : '';
      const hasCourseLinks =
        document.querySelectorAll('a[href*="/corso/show/"]').length > 0;
      const hasDashboardMarkers = new RegExp(markers, 'i').test(bodyText);
      return hasCourseLinks || hasDashboardMarkers;
    }, DASHBOARD_MARKERS)
    .catch(() => false);
}

/** Numero di link a corsi distinti (/corso/show/<id>) presenti nella pagina. */
async function countCourseLinks(page) {
  return await page
    .evaluate(() => {
      const seen = new Set();
      [...document.querySelectorAll('a[href*="/corso/show/"]')].forEach((a) => {
        const id = (a.href.match(/\/corso\/show\/(\d+)/) || [])[1];
        if (id) seen.add(id);
      });
      return seen.size;
    })
    .catch(() => 0);
}

module.exports = {
  DASHBOARD_MARKERS,
  isLoginPage,
  isDashboardLoaded,
  countCourseLinks,
};
