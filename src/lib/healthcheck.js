/**
 * healthcheck.js — sonda LIVE dell'autologin.
 *
 * Apre un browser headless, segue il link di autologin di config.json fino alla
 * dashboard e riporta in modo ONESTO se l'accesso funziona adesso, quanti corsi
 * sono visibili e (se serve) il motivo del fallimento.
 *
 * È la fonte di verità da preferire a logs/status.json quando bisogna decidere
 * se l'autologin è davvero scaduto: status.json può essere VECCHIO (scritto da
 * un run terminato giorni fa) e indurre a dire all'utente che il link è morto
 * quando in realtà funziona.
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { isLoginPage, isDashboardLoaded, countCourseLinks } = require('./page-detect');

const DASHBOARD_URL = 'https://tecsial.gsdcampus.it/corso/listAllByUser';

/**
 * @returns {Promise<{ok:boolean, reason:string, courseLinks:number, finalUrl:string|null, durationMs:number, checkedAt:string}>}
 */
async function checkAutologin(root, opts = {}) {
  const timeoutMs = opts.timeoutMs || 60000;
  const started = Date.now();
  const result = {
    ok: false,
    reason: '',
    courseLinks: 0,
    finalUrl: null,
    durationMs: 0,
    checkedAt: new Date().toISOString(),
  };

  let config;
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  } catch (e) {
    result.reason = 'config.json mancante o non valido';
    result.durationMs = Date.now() - started;
    return result;
  }
  if (!config.autologinUrl) {
    result.reason = 'autologinUrl non configurato in config.json';
    result.durationMs = Date.now() - started;
    return result;
  }

  let browser;
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const page = await ctx.newPage();

    await page.goto(config.autologinUrl, { waitUntil: 'networkidle', timeout: timeoutMs });
    let attempts = 0;
    while (page.url().includes('autologin') && attempts < 30) {
      await page.waitForTimeout(1000);
      attempts++;
    }

    await page.goto(DASHBOARD_URL, { waitUntil: 'networkidle', timeout: timeoutMs });
    for (let w = 0; w < 20; w++) {
      if (await isDashboardLoaded(page)) break;
      if (await isLoginPage(page)) break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(1000);

    result.finalUrl = page.url();
    result.courseLinks = await countCourseLinks(page);

    if (await isLoginPage(page)) {
      result.ok = false;
      result.reason = 'La piattaforma mostra la pagina di login: autologin scaduto o non valido.';
    } else if (await isDashboardLoaded(page)) {
      result.ok = true;
      result.reason = `Autologin valido: dashboard raggiunta (${result.courseLinks} corsi visibili).`;
    } else {
      result.ok = false;
      result.reason = 'Pagina inattesa dopo autologin (né dashboard né login). Riprova.';
    }
  } catch (e) {
    result.ok = false;
    result.reason = `Errore durante la verifica: ${e.message}`;
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  result.durationMs = Date.now() - started;
  return result;
}

module.exports = { checkAutologin };
