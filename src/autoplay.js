const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { createLogger } = require('./lib/logger');
const { Monitor } = require('./lib/monitor');
const { solveQuiz } = require('./lib/quiz');
const { watchVideo } = require('./lib/video');
const { isWorkTime, nextWorkEnd, nextWorkStart } = require('./lib/schedule');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session_state.json');
const STATE_FILE = path.join(DATA_DIR, 'storage_state.json');

const log = createLogger(ROOT);
const monitor = new Monitor(ROOT, log);

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const IGNORE_HOURS = process.argv.includes('--ignore-hours');
const CHECK_INTERVAL_MS = 60000; // controlla orario ogni minuto

class OffHoursExit extends Error {
  constructor(message) {
    super(message);
    this.name = 'OffHoursExit';
    this.code = 'OFF_HOURS';
  }
}

function saveSession(state) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ...state, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) {
    log('Errore salvataggio sessione:', e.message);
  }
}

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const ageMin = (Date.now() - new Date(data.savedAt).getTime()) / 60000;
    if (ageMin < 120) return data;
  } catch (e) {
    // nessuna sessione valida
  }
  return null;
}

async function solveQuizWrapper(page) {
  try {
    return await solveQuiz(page, ROOT, log);
  } catch (e) {
    await monitor.recordError(page, e, 'solveQuiz');
    return false;
  }
}

async function runCourse(page, courseUrl) {
  const emptyUrls = new Set();
  const session = loadSession();
  let missingPermissionCount = 0;
  const MAX_MISSING_PERMISSION = 3;

  while (true) {
    monitor.update({ phase: 'checking', courseUrl });

    try {
      // Torniamo sempre alla dashboard per simulare navigazione umana
      log('Ritorno dashboard per accesso al corso...');
      await page.goto('https://tecsial.gsdcampus.it/corso/listAllByUser', { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);

      const targetId = courseUrl.split('/show/')[1];
      log(`Searching for course ID ${targetId} in dashboard...`);

      const courseLink = page.locator(`a[href*="/corso/show/${targetId}"]`).first();
      if (await courseLink.isVisible().catch(() => false)) {
        log(`Link corso trovato tramite href per ID ${targetId}. Clicco per entrare...`);
        await courseLink.click();
        await page.waitForTimeout(5000);
      } else {
        log(`Link corso per ID ${targetId} NON trovato in dashboard. Provo navigazione diretta...`);
        await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
      }
    } catch (e) {
      log(`Errore durante l'accesso al corso ${courseUrl}: ${e.message}`);
      await monitor.recordError(page, e, 'accessCourse');
      await page.waitForTimeout(5000);
      continue;
    }

    if (page.url().includes('error?code=missing_permission')) {
      missingPermissionCount++;
      log(`Siamo in pagina MISSING_PERMISSION (tentativo ${missingPermissionCount}/${MAX_MISSING_PERMISSION}).`);
      if (missingPermissionCount >= MAX_MISSING_PERMISSION) {
        log(`Corso ${courseUrl} non accessibile: troppi MISSING_PERMISSION. Salto al prossimo corso.`);
        return;
      }
      await page.goto(config.autologinUrl, { waitUntil: 'networkidle' });
      await page.waitForTimeout(5000);
      continue;
    }
    missingPermissionCount = 0;

    let scoredLinks = [];
    try {
      scoredLinks = await page.evaluate(() => {
        const links = [...document.querySelectorAll('a.btn.btn-sm.btn-primary')];
        return links.map(a => {
          const block = (a.closest('tr, .row, li, .card-body') || a.parentElement).innerText;
          const m = block.match(/(\d+[.,]\d+)\s*%/);
          const pct = m ? parseFloat(m[1].replace(',', '.')) : 100;
          return { href: a.href, pct };
        });
      });
    } catch (e) {
      log(`Errore parsing link: ${e.message}`);
      await page.waitForTimeout(2000);
      continue;
    }

    const availableLinks = scoredLinks.filter(l => !emptyUrls.has(l.href)).sort((x, y) => x.pct - y.pct);
    const nextHref = (availableLinks.length > 0 && availableLinks[0].pct < 100) ? availableLinks[0].href : null;

    if (!nextHref) {
      if (emptyUrls.size > 0) {
        log('Reset filtri vuoti...');
        emptyUrls.clear();
        continue;
      }

      const currentUrl = page.url();
      if (!currentUrl.includes('/corso/show/')) {
        log(`Spostamento inatteso: ${currentUrl}. Ritorno al login...`);
        await page.goto(config.autologinUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
        continue;
      }

      log('Verifico quiz finale...');
      try {
        const quizLink = await page.evaluate(() => {
          const a = document.querySelector('a[href*="/questionario/"]');
          return a ? a.href : null;
        });
        if (quizLink) {
          await page.goto(quizLink);
          const solved = await solveQuizWrapper(page);
          if (solved) {
            log(`Quiz finale di ${courseUrl} risolto/completato.`);
            saveSession({ courseUrl, phase: 'quiz_done' });
            monitor.update({ phase: 'done' });
            return;
          }
          continue;
        }
      } catch (e) {
        log(`Errore quiz: ${e.message}`);
        await monitor.recordError(page, e, 'finalQuiz');
      }

      log(`Corso ${courseUrl} TERMINATO.`);
      saveSession({ courseUrl, phase: 'done' });
      monitor.update({ phase: 'done' });
      return;
    }

    log(`Apertura: ${nextHref}`);
    saveSession({ courseUrl, lessonUrl: nextHref, phase: 'lesson' });

    try {
      await page.goto(nextHref, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    } catch (e) {
      log(`Errore navigazione: ${e.message}`);
      await monitor.recordError(page, e, 'navigateLesson');
      continue;
    }

    const isQuizDashboard = await page.evaluate(() => {
      const btn = document.querySelector('a.btn-primary, button.btn-primary');
      return !!btn && btn.innerText.toLowerCase().includes('avvia compilazione');
    }).catch(() => false);

    if (isQuizDashboard) {
      monitor.update({ phase: 'quiz_dashboard', lessonUrl: nextHref });
      log('Dashboard Quiz...');
      const startUrl = await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('a.btn-primary')).find(a => a.innerText.toLowerCase().includes('avvia compilazione'));
        return btn ? btn.href : null;
      }).catch(() => null);
      if (startUrl) {
        emptyUrls.clear();
        await page.goto(startUrl, { waitUntil: 'networkidle' });
        await solveQuizWrapper(page);
      } else {
        emptyUrls.add(nextHref);
      }
      continue;
    }

    const isQuiz = await page.evaluate(() => !!document.querySelector('form h4')).catch(() => false);
    if (isQuiz) {
      monitor.update({ phase: 'quiz', lessonUrl: nextHref });
      emptyUrls.clear();
      await solveQuizWrapper(page);
      continue;
    }

    const hasVideo = await page.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (hasVideo) {
      monitor.update({ phase: 'video', lessonUrl: nextHref });
      emptyUrls.clear();
      await watchVideo(page, log, monitor);
      continue;
    }

    log(`Senza contenuto (${nextHref}).`);
    emptyUrls.add(nextHref);
    await page.waitForTimeout(5000);
  }
}

async function runAutoplay() {
  let browser;
  let outerRetries = 0;
  const MAX_OUTER_RETRIES = 5;

  while (outerRetries < MAX_OUTER_RETRIES) {
    outerRetries++;
    monitor.update({ phase: 'starting', running: true, lastError: null });
    try {
      log('Avvio browser in modalità headless...');
      browser = await chromium.launch({
        channel: 'chrome',
        headless: true,
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      });

      const ctxOptions = {
        viewport: { width: 1440, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      };
      if (fs.existsSync(STATE_FILE)) {
        ctxOptions.storageState = STATE_FILE;
      }
      const ctx = await browser.newContext(ctxOptions);

      const page = await ctx.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      // Login
      log('Sincronizzazione Login...');
      try {
        log(`Navigazione verso autologin`);
        await page.goto(config.autologinUrl, { waitUntil: 'networkidle', timeout: 60000 });
        let attempts = 0;
        while (page.url().includes('autologin') && attempts < 10) {
          await page.waitForTimeout(2000);
          attempts++;
        }
        log(`URL finale dopo login: ${page.url()}`);
      } catch (e) {
        log(`Errore durante l'autologin: ${e.message}`);
        await monitor.recordError(page, e, 'autologin');
      }

      // Salva stato storage dopo login
      try {
        await ctx.storageState({ path: STATE_FILE });
      } catch (e) {
        log('Impossibile salvare storage state:', e.message);
      }

      // Scoperta automatica corsi dalla dashboard (se non configurati in config.json)
      async function discoverCourses() {
        if (Array.isArray(config.courseUrls) && config.courseUrls.length > 0) {
          log('Corsi configurati manualmente in config.json.');
          return config.courseUrls;
        }
        log('Scoperta automatica corsi dalla dashboard...');
        try {
          await page.goto('https://tecsial.gsdcampus.it/corso/listAllByUser', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(3000);
          const links = await page.evaluate(() => {
            const seen = new Set();
            return [...document.querySelectorAll('a[href*="/corso/show/"]')]
              .map(a => a.href)
              .filter(href => {
                const id = href.match(/\/corso\/show\/(\d+)/)?.[1];
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
              });
          });
          if (links.length === 0) {
            log('Nessun corso trovato in dashboard. Verifica autologin e permessi.');
            return [];
          }
          log(`Trovati ${links.length} corsi: ${links.join(', ')}`);
          return links;
        } catch (e) {
          log(`Errore scoperta corsi: ${e.message}`);
          return [];
        }
      }

      let courseUrls = await discoverCourses();
      if (courseUrls.length === 0) {
        throw new Error('Nessun corso disponibile dopo autologin. Verificare il link autologin e i permessi account.');
      }

      // Loop corsi
      let lastHourCheck = 0;
      while (true) {
        if (!IGNORE_HOURS && Date.now() - lastHourCheck > CHECK_INTERVAL_MS) {
          lastHourCheck = Date.now();
          if (!isWorkTime()) {
            const end = nextWorkEnd(new Date());
            const start = nextWorkStart(new Date());
            log(`Fuori orario lavorativo. Stop programmato: ${end ? end.toISOString() : 'N/A'}, prossimo avvio: ${start ? start.toISOString() : 'N/A'}`);
            monitor.update({ phase: 'off_hours', nextStart: start ? start.toISOString() : null, nextEnd: end ? end.toISOString() : null, running: false });
            // L'utente ha scelto di avviare, quindi usciamo gracefulmente e lo scheduler riprenderà al prossimo turno
            throw new OffHoursExit('Fine turno lavorativo');
          }
        }

        for (const courseUrl of courseUrls) {
          log(`Controllo corso: ${courseUrl}`);
          await runCourse(page, courseUrl);
        }
        log('Tutti i corsi controllati. Riparto dal primo tra 30 secondi...');
        await page.waitForTimeout(30000);
      }
    } catch (e) {
      if (e instanceof OffHoursExit || e.code === 'OFF_HOURS') {
        log('Uscita per fine turno lavorativo.');
        monitor.update({ running: false, phase: 'off_hours' });
        process.exit(0);
      }
      log('ERRORE CRITICO:', e);
      await monitor.recordError(null, e, 'outer');
    } finally {
      if (browser) {
        try { await browser.close(); } catch (e) {}
        browser = null;
      }
      if (outerRetries < MAX_OUTER_RETRIES) {
        log(`Riavvio browser tra 30 secondi (tentativo ${outerRetries}/${MAX_OUTER_RETRIES})...`);
        await new Promise(r => setTimeout(r, 30000));
      }
    }
  }

  log('Tentativi esauriti. Arresto.');
  monitor.update({ running: false, phase: 'stopped' });
  process.exit(1);

}

runAutoplay().catch(async (e) => {
  log('FATAL:', e);
  await monitor.recordError(null, e, 'fatal');
  monitor.update({ running: false, phase: 'fatal' });
  process.exit(1);
});
