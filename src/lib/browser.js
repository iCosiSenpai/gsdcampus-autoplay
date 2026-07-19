/**
 * browser.js — launch Playwright con fallback Chrome di sistema → Chromium bundled.
 *
 * Problema: autoplay/healthcheck usavano solo channel:'chrome'. Su Mac senza
 * Google Chrome.app il launch fallisce ("distribution 'chrome' is not found")
 * anche se Playwright ha scaricato Chromium. Questo modulo prova Chrome e,
 * se manca, usa chromium.launch() senza channel.
 *
 * config.json opzionale:
 *   browserChannel: null | "chrome" | "chromium" | "msedge"
 *   null/assente = auto (chrome poi chromium).
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DEFAULT_LAUNCH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
];

function defaultLog(msg) {
  try { process.stderr.write(`[browser] ${msg}\n`); } catch (_) {}
}

/** True se l'errore indica Chrome di sistema assente / non lanciabile. */
function isChromeMissingError(err) {
  const m = String(err && err.message ? err.message : err || '');
  return /chrome.*not found|distribution ['"]chrome['"]|Executable doesn't exist|Failed to launch.*chrome/i.test(m);
}

/**
 * Piano di launch pure (testabile senza aprire browser).
 * @returns {{ mode: 'fixed'|'auto', attempts: Array<{ backend: string, channel?: string }> }}
 */
function resolveLaunchPlan(config = {}) {
  const raw = config && config.browserChannel != null
    ? String(config.browserChannel).trim().toLowerCase()
    : '';
  if (raw === 'chrome' || raw === 'msedge') {
    return { mode: 'fixed', attempts: [{ backend: raw, channel: raw }] };
  }
  if (raw === 'chromium' || raw === 'bundled') {
    return { mode: 'fixed', attempts: [{ backend: 'chromium' }] };
  }
  // auto
  return {
    mode: 'auto',
    attempts: [
      { backend: 'chrome', channel: 'chrome' },
      { backend: 'chromium' },
    ],
  };
}

function readBrowserConfig(root) {
  try {
    const p = path.join(root || path.join(__dirname, '..', '..'), 'config.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * @param {object} [options]
 * @param {boolean} [options.headless=true]
 * @param {string[]} [options.args]
 * @param {function} [options.log]
 * @param {object} [options.config] — se assente, legge config.json
 * @param {string} [options.root]
 * @returns {Promise<{ browser: import('playwright').Browser, backend: string, headless: boolean }>}
 */
async function launchBrowser(options = {}) {
  const headless = options.headless !== false;
  const args = Array.isArray(options.args) && options.args.length
    ? options.args
    : DEFAULT_LAUNCH_ARGS.slice();
  const log = typeof options.log === 'function' ? options.log : defaultLog;
  const config = options.config || readBrowserConfig(options.root);
  const plan = resolveLaunchPlan(config);

  let lastErr = null;
  for (const attempt of plan.attempts) {
    try {
      const launchOpts = { headless, args };
      if (attempt.channel) launchOpts.channel = attempt.channel;
      const browser = await chromium.launch(launchOpts);
      if (attempt.backend === 'chromium' && plan.mode === 'auto') {
        log('Chrome di sistema non disponibile: uso Chromium Playwright (bundled).');
      } else {
        log(`Avviato browser backend=${attempt.backend}`);
      }
      return { browser, backend: attempt.backend, headless };
    } catch (e) {
      lastErr = e;
      const canFallback =
        plan.mode === 'auto' &&
        attempt.backend === 'chrome' &&
        isChromeMissingError(e);
      if (canFallback) {
        log(`Chrome non avviabile (${e.message}); provo Chromium bundled…`);
        continue;
      }
      // fixed mode o errore non-missing: non insistere se non c'è altro attempt utile
      if (plan.mode === 'fixed' || attempt.backend === 'chromium') {
        throw e;
      }
      // altri errori su chrome in auto: prova comunque chromium
      log(`Launch ${attempt.backend} fallito (${e.message}); provo fallback…`);
    }
  }
  throw lastErr || new Error('Impossibile avviare alcun browser (chrome/chromium)');
}

module.exports = {
  launchBrowser,
  resolveLaunchPlan,
  isChromeMissingError,
  DEFAULT_LAUNCH_ARGS,
  readBrowserConfig,
};
