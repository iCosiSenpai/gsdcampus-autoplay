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

// Lanciata dalle lib (es. quiz.js) quando serve fermarsi per intervento AI/utente.
// Catturata in runAutoplay che chiude il browser e scrive phase:'need_help'.
class NeedHelpExit extends Error {
  constructor(message) {
    super(message);
    this.name = 'NeedHelpExit';
  }
}

module.exports = { OffHoursExit, AutologinError, SessionError, AllCoursesNeedHelpExit, NeedHelpExit };