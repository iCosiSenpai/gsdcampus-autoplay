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
const { redactUrl } = require('./logger');
const { chromium } = require('playwright');
const { isLoginPage, isDashboardLoaded, countCourseLinks } = require('./page-detect');
const { dashboardUrl, userAgent } = require('./platform');

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
      userAgent: userAgent(config),
    });
    const page = await ctx.newPage();

    // La piattaforma fallisce spesso l'autologin al PRIMO tentativo e va a buon
    // fine al secondo (visibile nei log: "tentativo 1" → login, "tentativo 2" →
    // dashboard). Una sonda a tentativo singolo darebbe quindi falsi "scaduto".
    // Ritentiamo come fa autoplay, e dichiariamo KO solo se TUTTI i tentativi
    // finiscono sulla pagina di login.
    const MAX_ATTEMPTS = opts.attempts || 3;
    result.attempts = 0;
    let reachedDashboard = false;
    let everLogin = false;

    for (let a = 1; a <= MAX_ATTEMPTS && !reachedDashboard; a++) {
      result.attempts = a;
      try {
        // Sessione pulita a ogni tentativo, come fa autoplay.
        await ctx.clearCookies({ domain: 'tecsial.gsdcampus.it' }).catch(() => {});

        await page.goto(config.autologinUrl, { waitUntil: 'load', timeout: timeoutMs });
        let guard = 0;
        while (page.url().includes('autologin') && guard < 20) {
          await page.waitForTimeout(1000);
          guard++;
        }
        await page.waitForTimeout(3000);

        await page.goto(dashboardUrl(config), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        for (let w = 0; w < 30; w++) {
          if (await isDashboardLoaded(page)) break;
          if (await isLoginPage(page)) break;
          await page.waitForTimeout(500);
        }
        await page.waitForTimeout(2000);

        // redactUrl: se il redirect si è fermato a metà, l'URL può ancora
        // contenere il token di autologin — non deve uscire in chiaro (la CLI
        // lo stampa a video e può finire in log/issue).
        result.finalUrl = redactUrl(page.url());

        if (await isDashboardLoaded(page) && !(await isLoginPage(page))) {
          reachedDashboard = true;
          result.courseLinks = await countCourseLinks(page);
          break;
        }
        if (await isLoginPage(page)) {
          everLogin = true;
          // Pausa breve prima del prossimo tentativo (la sessione si stabilizza).
          if (a < MAX_ATTEMPTS) await page.waitForTimeout(3000);
        }
      } catch (e) {
        result.lastAttemptError = e.message;
        if (a < MAX_ATTEMPTS) await page.waitForTimeout(2000);
      }
    }

    if (reachedDashboard) {
      result.ok = true;
      result.reason = `Autologin valido: dashboard raggiunta (${result.courseLinks} corsi visibili) al tentativo ${result.attempts}.`;
    } else if (everLogin) {
      result.ok = false;
      result.reason = `La piattaforma mostra la pagina di login dopo ${result.attempts} tentativi: autologin scaduto o non valido.`;
    } else {
      result.ok = false;
      result.reason = `Impossibile raggiungere la dashboard dopo ${result.attempts} tentativi (problema di rete o pagina inattesa). Riprova.`;
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
