const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { createLogger } = require('./lib/logger');
const { Monitor } = require('./lib/monitor');
const { solveQuiz } = require('./lib/quiz');
const { watchVideo } = require('./lib/video');
const { isWorkTime, nextWorkEnd, nextWorkStart, describeSchedule } = require('./lib/schedule');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'session_state.json');
const STATE_FILE = path.join(DATA_DIR, 'storage_state.json');

const log = createLogger(ROOT);
const monitor = new Monitor(ROOT, log);

let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch (e) {
  log('FATAL: impossibile leggere config.json:', e.message);
  process.exit(1);
}

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

// Errore NON ritentabile: il link autologin non ha autenticato (token errato o scaduto).
// Ritentare il login o riavviare il browser non aiuta: serve un link valido in config.json.
class AutologinError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AutologinError';
    this.code = 'AUTOLOGIN_INVALID';
  }
}

// Sessione caduta ripetutamente durante l'esecuzione (token autologin scaduto/consumato a
// metà sessione). Bubbla al loop esterno per un riavvio pulito del browser invece di
// ritentare il login all'infinito.
class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
    this.code = 'SESSION_LOST';
  }
}

// La piattaforma è una SPA: quando la sessione non è valida, qualsiasi URL mostra la pagina
// di login (campo password presente) o redirige su /login. È il modo affidabile per
// distinguere "loggato" da "non loggato", verificato sui 5 account reali esplorati con
// scripts/explore.js.
async function isLoginPage(page) {
  if (/\/login(\?|$|\/)/.test(page.url())) return true;
  return await page.evaluate(() => {
    return !!document.querySelector('input[type="password"]') ||
      /inserisci le tue credenziali/i.test(document.body ? document.body.innerText : '');
  }).catch(() => false);
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
    return await solveQuiz(page, ROOT, log, monitor);
  } catch (e) {
    await monitor.recordError(page, e, 'solveQuiz');
    return false;
  }
}

async function runCourse(page, courseUrl, sessionState) {
  const emptyUrls = new Set();
  let missingPermissionCount = 0;
  const MAX_MISSING_PERMISSION = 3;
  // Tetto di iterazioni per singolo corso: evita loop infiniti se un corso non avanza mai.
  let iter = 0;
  const MAX_ITER = 80;

  while (true) {
    if (++iter > MAX_ITER) {
      log(`Corso ${courseUrl}: superato il limite di ${MAX_ITER} iterazioni senza completamento. Passo al prossimo.`);
      return;
    }
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

    // Sessione caduta a metà corso: la pagina è tornata al login. Conta i drop e, se troppi,
    // bubbla al loop esterno per un riavvio pulito del browser invece di ritentare a vuoto.
    if (await isLoginPage(page)) {
      sessionState.loginDrops++;
      log(`Sessione persa (pagina di login). Drop ${sessionState.loginDrops}/${sessionState.maxLoginDrops}. Ritento autologin...`);
      if (sessionState.loginDrops >= sessionState.maxLoginDrops) {
        throw new SessionError('Sessione instabile: l\'accesso cade ripetutamente dopo il login (token autologin probabilmente scaduto/consumato).');
      }
      try {
        await page.goto(config.autologinUrl, { waitUntil: 'networkidle', timeout: 60000 });
        await page.waitForTimeout(4000);
      } catch (e) {
        log(`Errore re-login: ${e.message}`);
      }
      continue;
    }

    if (page.url().includes('error?code=missing_permission')) {
      missingPermissionCount++;
      log(`Siamo in pagina MISSING_PERMISSION (tentativo ${missingPermissionCount}/${MAX_MISSING_PERMISSION}).`);
      if (missingPermissionCount >= MAX_MISSING_PERMISSION) {
        log(`Corso ${courseUrl} non accessibile: troppi MISSING_PERMISSION. Salto al prossimo corso.`);
        return;
      }
      try {
        await page.goto(config.autologinUrl, { waitUntil: 'networkidle' });
        await page.waitForTimeout(5000);
      } catch (e) {
        log(`Errore durante il re-login: ${e.message}`);
      }
      continue;
    }
    missingPermissionCount = 0;
    sessionState.loginDrops = 0; // siamo su una pagina valida: sessione sana

    let scoredLinks = [];
    try {
      scoredLinks = await page.evaluate(() => {
        // Percorso validato sui 5 account reali: i bottoni "Apri" delle lezioni hanno classe
        // "btn btn-sm btn-primary". Fallback per href se la classe dovesse cambiare.
        let links = [...document.querySelectorAll('a.btn.btn-sm.btn-primary')];
        if (links.length === 0) {
          links = [...document.querySelectorAll('a[href*="/lezione/show/"], a[href*="/questionario/"]')];
        }
        return links.map(a => {
          const block = (a.closest('tr, .row, li, .card-body, .card') || a.parentElement || a);
          const text = (block.innerText || '');
          const m = text.match(/(\d+[.,]\d+)\s*%/);
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
        try {
          await page.goto(config.autologinUrl, { waitUntil: 'networkidle' });
          await page.waitForTimeout(5000);
        } catch (e) {
          log(`Errore re-login: ${e.message}`);
        }
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

  log('========================================');
  log('Avvio GSD Campus autoplay');
  log('Orario configurato:', describeSchedule());
  log('IGNORE_HOURS:', IGNORE_HOURS);
  log('========================================');

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

      // Login con ritentativi: una pagina di login al primo tentativo può essere transitoria
      // (redirect lento o token rate-limited momentaneamente) e NON significa link invalido.
      // Verifichiamo l'accesso caricando la dashboard e ritentiamo prima di concludere.
      log('Sincronizzazione Login...');
      const MAX_LOGIN_ATTEMPTS = 3;
      let loggedIn = false;
      for (let la = 1; la <= MAX_LOGIN_ATTEMPTS && !loggedIn; la++) {
        try {
          log(`Navigazione verso autologin (tentativo ${la}/${MAX_LOGIN_ATTEMPTS})`);
          await page.goto(config.autologinUrl, { waitUntil: 'networkidle', timeout: 60000 });
          let attempts = 0;
          while (page.url().includes('autologin') && attempts < 30) {
            await page.waitForTimeout(2000);
            attempts++;
          }
          // Verifica reale dell'accesso: la dashboard non deve essere la pagina di login.
          await page.goto('https://tecsial.gsdcampus.it/corso/listAllByUser', { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(2500);
          if (await isLoginPage(page)) {
            log(`Login non riuscito al tentativo ${la} (la piattaforma mostra la pagina di login).`);
            await page.waitForTimeout(4000);
            continue;
          }
          loggedIn = true;
          log(`URL finale dopo login: ${page.url()}`);
        } catch (e) {
          log(`Errore durante l'autologin (tentativo ${la}): ${e.message}`);
          await page.waitForTimeout(3000);
        }
      }
      if (!loggedIn) {
        const err = new AutologinError('Autologin non valido o scaduto: il link non ha effettuato l\'accesso dopo più tentativi. Aggiorna il link autologin in config.json.');
        await monitor.recordError(page, err, 'autologin');
        throw err;
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
            // Distingue "sessione scaduta" (pagina login) da "account senza corsi assegnati".
            if (await isLoginPage(page)) {
              throw new AutologinError('La dashboard mostra la pagina di login: autologin non valido o scaduto. Aggiorna il link in config.json.');
            }
            log('Nessun corso trovato in dashboard (login valido ma nessun corso assegnato/visibile). Verifica i permessi dell\'account.');
            return [];
          }
          log(`Trovati ${links.length} corsi: ${links.join(', ')}`);
          return links;
        } catch (e) {
          if (e instanceof AutologinError) throw e;
          log(`Errore scoperta corsi: ${e.message}`);
          return [];
        }
      }

      let courseUrls = await discoverCourses();
      if (courseUrls.length === 0) {
        throw new Error('Nessun corso disponibile dopo autologin. Verificare il link autologin e i permessi account.');
      }

      // Loop corsi
      // sessionState è condiviso tra i corsi della stessa sessione browser per contare i
      // "drop" di sessione (cadute al login) e fermarsi prima di entrare in loop infiniti.
      const sessionState = { loginDrops: 0, maxLoginDrops: 4 };
      let lastHourCheck = 0;
      while (true) {
        if (!IGNORE_HOURS && Date.now() - lastHourCheck > CHECK_INTERVAL_MS) {
          lastHourCheck = Date.now();
          if (!isWorkTime()) {
            const end = nextWorkEnd(new Date());
            const start = nextWorkStart(new Date());
            log(`Fuori orario lavorativo. Stop programmato: ${end ? end.toISOString() : 'N/A'}, prossimo avvio: ${start ? start.toISOString() : 'N/A'}`);
            monitor.update({ phase: 'off_hours', nextStart: start ? start.toISOString() : null, nextEnd: end ? end.toISOString() : null, running: false });
            throw new OffHoursExit('Fine turno lavorativo');
          }
        }

        for (const courseUrl of courseUrls) {
          log(`Controllo corso: ${courseUrl}`);
          await runCourse(page, courseUrl, sessionState);
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
      // Autologin non valido/scaduto: inutile ritentare. Esci subito con messaggio chiaro
      // così il supervisore AID/lo status comunica al collega di aggiornare il link.
      if (e instanceof AutologinError || e.code === 'AUTOLOGIN_INVALID') {
        log('AUTOLOGIN NON VALIDO:', e.message);
        monitor.update({ running: false, phase: 'autologin_invalid', lastError: e.message });
        if (browser) { try { await browser.close(); } catch (_) {} }
        process.exit(3);
      }
      // Sessione caduta a metà: scarta lo storage state salvato (può essere la causa) e lascia
      // che il loop esterno riavvii il browser con un autologin pulito.
      if (e instanceof SessionError || e.code === 'SESSION_LOST') {
        log('SESSIONE PERSA:', e.message);
        try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) {}
        monitor.update({ phase: 'session_lost', lastError: e.message });
        // non esce: il blocco finally riavvia il browser (fino a MAX_OUTER_RETRIES)
      } else {
        log('ERRORE CRITICO:', e);
        await monitor.recordError(null, e, 'outer');
      }
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
