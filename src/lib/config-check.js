// @ts-check
/**
 * config-check.js — completezza di config.json (account + orari di lavoro).
 *
 * Serve a distinguere "configurazione completa" da "prima configurazione
 * interrotta a metà": se l'utente sceglie il membro in «Chi sei?» e poi annulla
 * o chiude il Terminale, config.json esiste, è JSON valido e ha l'autologin, ma
 * NON ha `workSchedule`. In quel caso src/lib/schedule.js ripiega sui default
 * (lun-ven 09:00-13:00 / 16:00-20:00), quindi un controllo basato sugli orari
 * "effettivi" (describe / is-work-time) non si accorge di nulla e il setup
 * automatico fallisce più a valle.
 *
 * Pure (nessun side-effect): usato da scripts/lib/config-check-cli.js e, via
 * quel wrapper, da setup.sh (is_config_valid) e launch-ai-supervisor.sh.
 */

const fs = require('fs');
const path = require('path');
const { normalizeDays, normalizeShifts } = require('./schedule');
const { validateAutologinUrl } = require('./import-csv');

// Placeholder tipici di config.json.example / configurazioni abbozzate a mano.
const PLACEHOLDER_RE = /(CODICEFISCALE\/TOKEN|YOUR_AUTOLOGIN|example)/i;

/**
 * @typedef {Object} ConfigCheckResult
 * @property {boolean} ok            true se account e orari sono entrambi completi
 * @property {string} reason         'ok' | 'missing_file' | 'bad_json' | 'missing_autologin' | 'missing_schedule'
 * @property {boolean} hasAccount    autologin presente e nel formato atteso
 * @property {boolean} hasSchedule   almeno un giorno e un turno validi
 * @property {boolean} interrupted   account valido ma orari mancanti (setup interrotto a metà)
 */

/**
 * Verifica che config.json contenga account (autologin) e orari validi.
 * @param {string} [root] radice del progetto
 * @returns {ConfigCheckResult}
 */
function checkConfig(root = path.join(__dirname, '..', '..')) {
  const cfgPath = path.join(root, 'config.json');
  const fail = (reason, extra = {}) => ({
    ok: false,
    reason,
    hasAccount: false,
    hasSchedule: false,
    interrupted: false,
    ...extra,
  });

  if (!fs.existsSync(cfgPath)) return fail('missing_file');

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch (_) {
    return fail('bad_json');
  }
  if (!cfg || typeof cfg !== 'object') return fail('bad_json');

  const url = String(cfg.autologinUrl || '').trim();
  const hasAccount = url !== '' && !PLACEHOLDER_RE.test(url) && validateAutologinUrl(url);

  const ws = cfg.workSchedule && typeof cfg.workSchedule === 'object' ? cfg.workSchedule : null;
  const rawDays = ws && Array.isArray(ws.days) ? ws.days : [];
  const rawShifts = ws && Array.isArray(ws.shifts) ? ws.shifts : [];
  // normalizeDays ripiega sui default quando l'array è vuoto: qui vogliamo sapere
  // se l'utente ha davvero scelto dei giorni, quindi controlliamo prima il raw.
  const daysOk = rawDays.some((d) => Number.isInteger(Number(d)) && Number(d) >= 0 && Number(d) <= 6)
    && normalizeDays(rawDays).length > 0;
  const hasSchedule = daysOk && normalizeShifts(rawShifts).length > 0;

  if (!hasAccount) {
    return { ok: false, reason: 'missing_autologin', hasAccount, hasSchedule, interrupted: false };
  }
  if (!hasSchedule) {
    return { ok: false, reason: 'missing_schedule', hasAccount, hasSchedule, interrupted: true };
  }
  return { ok: true, reason: 'ok', hasAccount, hasSchedule, interrupted: false };
}

module.exports = { checkConfig, PLACEHOLDER_RE };
