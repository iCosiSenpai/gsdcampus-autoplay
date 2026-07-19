/**
 * platform.js — costanti della piattaforma GSD Campus condivise tra autoplay,
 * healthcheck, login-flow e harvest.
 *
 * Timing: la piattaforma ha latenze di persistenza reali (es. 100% video);
 * non azzerare i wait “per snellezza” senza evidenza live.
 */

const DEFAULT_DASHBOARD_URL = 'https://tecsial.gsdcampus.it/corso/listAllByUser';
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// --- Timing (ms) -----------------------------------------------------------
/** Attesa post-video perché la piattaforma salvi il 100% sulla pagina corso. */
const PROGRESS_PERSIST_MS = 8000;
/** Click interstitial generici (Continua/Accedi). */
const INTERSTITIAL_CLICK_MS = 3000;
/** Dopo submit informativa / dichiarazione fruizione. */
const POST_SUBMIT_MS = 4000;
/** Dopo conferma quiz / submit pesanti. */
const POST_CONFIRM_MS = 5000;
/** Poll breve in attesa dashboard/login. */
const DASHBOARD_POLL_MS = 500;
/** Settle dopo goto/click corso. */
const COURSE_SETTLE_MS = 5000;
/** Attesa opzione quiz selezionata / avanti. */
const QUIZ_STEP_MS = 1000;
/** Attesa tra domande quiz. */
const QUIZ_QUESTION_MS = 1500;

function dashboardUrl(config) {
  return config && config.dashboardUrl ? config.dashboardUrl : DEFAULT_DASHBOARD_URL;
}

function userAgent(config) {
  return config && config.userAgent ? config.userAgent : DEFAULT_USER_AGENT;
}

module.exports = {
  DEFAULT_DASHBOARD_URL,
  DEFAULT_USER_AGENT,
  dashboardUrl,
  userAgent,
  PROGRESS_PERSIST_MS,
  INTERSTITIAL_CLICK_MS,
  POST_SUBMIT_MS,
  POST_CONFIRM_MS,
  DASHBOARD_POLL_MS,
  COURSE_SETTLE_MS,
  QUIZ_STEP_MS,
  QUIZ_QUESTION_MS,
};
