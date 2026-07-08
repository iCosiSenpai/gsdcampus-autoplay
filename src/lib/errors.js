/**
 * errors.js — classi di errore tipizzate condivise tra autoplay, quiz e video.
 *
 * Centralizzate qui (invece di definirle in autoplay.js) così anche le lib
 * (es. video.js) possono lanciare SessionError e runAutoplay le riconosce
 * tramite instanceof, attivando il path corretto (cooldown scheduler ecc.).
 */

class OffHoursExit extends Error {
  constructor(message) {
    super(message);
    this.name = 'OffHoursExit';
    this.code = 'OFF_HOURS';
  }
}

class AutologinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutologinError';
    this.code = 'AUTOLOGIN_INVALID';
  }
}

class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
    this.code = 'SESSION_LOST';
  }
}

class AllCoursesNeedHelpExit extends Error {
  constructor(message) {
    super(message);
    this.name = 'AllCoursesNeedHelpExit';
    this.code = 'ALL_NEED_HELP';
  }
}

// Dashboard vuota subito dopo il login: quasi sicuramente una pagina di blocco
// (informativa privacy/scheda tecnica/...) non gestita dall'autoplay. Catturata
// in runAutoplay che scrive phase:'post_login_blocked' ed esce con exit 4
// (cooldown scheduler, NON crash): evita il blackout da interstitial sconosciuti.
// Distinta da AllCoursesNeedHelpExit (che è "tutti i corsi done/need_help" = exit 0)
// e da SessionError (sessione caduta su /login): qui il login è riuscito ma la
// dashboard non renderizza alcun corso.
class DashboardEmptyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DashboardEmptyError';
    this.code = 'DASHBOARD_EMPTY';
  }
}

// Lanciata dalle lib (es. quiz.js) quando serve fermarsi per intervento AI/utente.
// Catturata in runAutoplay che chiude il browser e scrive phase:'need_help'.
class NeedHelpExit extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedHelpExit';
  }
}

module.exports = { OffHoursExit, AutologinError, SessionError, AllCoursesNeedHelpExit, DashboardEmptyError, NeedHelpExit };