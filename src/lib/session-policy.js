// @ts-check
/**
 * session-policy.js — cooldown e policy anti-stress sessione (pure).
 *
 * config.sessionUnstableCooldownMin — minuti di attesa dopo exit 4 (default 30).
 * config.sessionUnstableCooldownMs  — override in ms (se presente vince sul min).
 */

const DEFAULT_COOLDOWN_MIN = 30;
const MIN_COOLDOWN_MS = 60 * 1000; // 1 min
const MAX_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Millisecondi di cooldown post session_unstable.
 * @param {object} [config]
 * @returns {number}
 */
function sessionUnstableCooldownMs(config) {
  if (config && config.sessionUnstableCooldownMs != null) {
    const n = Number(config.sessionUnstableCooldownMs);
    if (Number.isFinite(n)) {
      return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.floor(n)));
    }
  }
  let min = DEFAULT_COOLDOWN_MIN;
  if (config && config.sessionUnstableCooldownMin != null) {
    const m = Number(config.sessionUnstableCooldownMin);
    if (Number.isFinite(m) && m > 0) min = m;
  }
  return Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, Math.floor(min * 60 * 1000)));
}

/**
 * True se l'URL corrente è già la dashboard corsi (evita goto ridondanti).
 */
function isOnDashboardUrl(url) {
  return /\/corso\/listAllByUser/i.test(String(url || ''));
}

module.exports = {
  sessionUnstableCooldownMs,
  isOnDashboardUrl,
  DEFAULT_COOLDOWN_MIN,
  MIN_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
};
