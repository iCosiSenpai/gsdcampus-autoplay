const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { createLogger } = require('./lib/logger');
const { Monitor } = require('./lib/monitor');
const { solveQuiz } = require('./lib/quiz');
const { watchVideo } = require('./lib/video');
const { isWorkTime, nextWorkEnd, nextWorkStart, describeSchedule } = require('./lib/schedule');
const courseState = require('./lib/course-state');

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
const MAX_MISSING_PERMISSION = 3;
const MAX_COURSE_ITER = 80;
const MAX_LOGIN_DROPS = 4;

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

async function solveQuizWrapper(page, courseUrl) {
  try {
    const result = await solveQuiz(page, ROOT, log, monitor);
    // Backward compat: solveQuiz restituisce un oggetto.
    if (result && typeof result === 'object') {
      return result;
    }
    return { outcome: result ? 'solved' : 'failed', passed: !!result };
  } catch (e) {
    await monitor.recordError(page, e, 'solveQuiz');
    return { outcome: 'error', passed: false, error: e.message };
  }
}

// Gestisce la pagina di informativa/accettazione che precede alcuni corsi.
// Spunta le checkbox della privacy/scheda tecnica e clicca "Prosegui".
async function handleCourseInformativa(page, log) {
  const url = page.url();
  if (!url.includes('/corso/informativa/')) return false;
  log(`Pagina informativa rilevata (${url}). Cerco checkbox da accettare...`);
  try {
    const checkboxes = await page.locator('input[type="checkbox"].form-check-input.accept').all();
    if (checkboxes.length === 0) {
      log('Nessuna checkbox di accettazione trovata.');
      return false;
    }
    for (const cb of checkboxes) {
      await cb.check().catch(() => {});
    }
    log(`Spuntate ${checkboxes.length} checkbox. Attendo abilitazione bottone...`);
    await page.waitForTimeout(1000);
    const submitBtn = page.locator('button[type="submit"].btn.btn-primary');
    const exists = await submitBtn.count().catch(() => 0) > 0;
    if (!exists) {
      log('Bottone Prosegui non trovato.');
      return false;
    }
    const isDisabled = await submitBtn.isDisabled().catch(() => true);
    if (isDisabled) {
      log('Bottone ancora disabilitato; forzo enabled via JS.');
      await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"].btn.btn-primary');
        if (btn) btn.disabled = false;
      });
    }
    await submitBtn.click().catch(e => log(`Errore click submit: ${e.message}`));
    await page.waitForTimeout(4000);
    log(`Dopo submit: URL = ${page.url()}`);
    return true;
  } catch (e) {
    log(`Errore gestione informativa: ${e.message}`);
    return false;
  }
}

async function runCourse(page, courseUrl, sessionState, state) {
  const emptyUrls = new Set();
  let missingPermissionCount = 0;
  let iter = 0;

  log(`Inizio corso ${courseUrl}. Stato: ${JSON.stringify(courseState.getCourse(state, courseUrl))}`);

  while (true) {
    if (++iter > MAX_COURSE_ITER) {
      log(`Corso ${courseUrl}: superato il limite di ${MAX_COURSE_ITER} iterazioni senza completamento. Passo al prossimo.`);
      return;
    }
    monitor.update({ phase: 'checking', courseUrl });

    try {
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

    if (await isLoginPage(page)) {
      sessionState.loginDrops++;
      log(`Sessione persa (pagina di login). Drop ${sessionState.loginDrops}/${MAX_LOGIN_DROPS}. Ritento autologin...`);
      if (sessionState.loginDrops >= MAX_LOGIN_DROPS) {
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
        courseState.markCourseNeedHelp(ROOT, state, courseUrl, 'missing_permission');
        monitor.update({ phase: 'need_help', courseUrl, courseStateSummary: courseState.summarize(state) });
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
    sessionState.loginDrops = 0;

    // Gestione pagina informativa (privacy/condizioni) che precede alcuni corsi.
    await handleCourseInformativa(page, log);

    let scoredLinks = [];
    try {
      scoredLinks = await page.evaluate(() => {
        const allLinks = [...document.querySelectorAll('a')];
        const lessonOrQuiz = allLinks.filter(a => {
          const href = a.href || '';
          return href.includes('/lezione/show/') || href.includes('/questionario/');
        });
        let links = lessonOrQuiz.length > 0 ? lessonOrQuiz : [];
        // Fallback sui bottoni "Apri" se non abbiamo trovato href diretti.
        if (links.length === 0) {
          links = [...document.querySelectorAll('a.btn.btn-sm.btn-primary, a.btn-primary, button.btn-primary')]
            .filter(a => /apri|inizia|guarda|avvia|visualizza/i.test(a.innerText));
        }
        return links.map(a => {
          const block = (a.closest('tr, .row, li, .card-body, .card') || a.parentElement || a);
          const text = (block.innerText || '');
          const m = text.match(/(\d+[.,]\d+)\s*%/);
          const pct = m ? parseFloat(m[1].replace(',', '.')) : 100;
          const href = a.href || '';
          const linkText = (a.innerText || '').trim();
          const kind = /\/lezione\/show\//.test(href) ? 'lezione' : (/\/questionario\//.test(href) ? 'questionario' : 'altro');
          return { href, text: text.slice(0, 120), linkText, kind, pct };
        });
      });
      const lessonCount = scoredLinks.filter(l => l.kind === 'lezione').length;
      const quizCount = scoredLinks.filter(l => l.kind === 'questionario').length;
      log(`Trovati ${scoredLinks.length} link nel corso (${lessonCount} lezioni, ${quizCount} quiz): ${JSON.stringify(scoredLinks)}`);
      if (scoredLinks.length === 0) {
        log('ATTENZIONE: nessun link lezione/questionario trovato. Salvo dump HTML per analisi.');
        await monitor.recordError(page, new Error('No lesson/quiz links found'), 'courseParsing');
      }
    } catch (e) {
      log(`Errore parsing link: ${e.message}`);
      await page.waitForTimeout(2000);
      continue;
    }

    // Rileva corsi PDF-only guardando il DOM globale: utile quando il corso apre una
    // pagina informativa con solo link "Scarica il PDF" e nessuna lezione/quiz.
    const pageHasPdfOnly = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a')];
      const hasLessonOrQuiz = anchors.some(a => {
        const h = a.href || '';
        return h.includes('/lezione/show/') || h.includes('/questionario/');
      });
      if (hasLessonOrQuiz) return false;
      return anchors.some(a => /scarica\s+il\s+pdf|\.pdf|data:application\/pdf/i.test((a.href || '') + ' ' + (a.innerText || '')));
    });
    const hasLessonsOrQuizzes = scoredLinks.some(l => l.kind === 'lezione' || l.kind === 'questionario');
    if ((!hasLessonsOrQuizzes && pageHasPdfOnly) || (scoredLinks.length === 0 && pageHasPdfOnly)) {
      log(`Corso ${courseUrl} contiene solo PDF (nessuna lezione/video/quiz). Lo marco come completato.`);
      courseState.markCourseDone(ROOT, state, courseUrl);
      monitor.update({ phase: 'done', courseStateSummary: courseState.summarize(state) });
      return;
    }

    const c = courseState.getCourse(state, courseUrl);
    const doneLessons = Array.isArray(c.completedLessons) ? c.completedLessons : [];
    const availableLinks = scoredLinks
      .filter(l => !emptyUrls.has(l.href) && !doneLessons.includes(l.href))
      .sort((x, y) => x.pct - y.pct);
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
          const quizResult = await solveQuizWrapper(page, courseUrl);

          if (quizResult.passed) {
            log(`Quiz finale di ${courseUrl} superato.`);
            courseState.markCourseDone(ROOT, state, courseUrl);
            saveSession({ courseUrl, phase: 'quiz_done' });
            monitor.update({ phase: 'done', courseStateSummary: courseState.summarize(state) });
            return;
          }

          // Quiz non superato: il wrapper ha già catturato le domande in data/need_answer.json.
          // Segnalo il corso come "need_help" e passo al prossimo corso. L'AI/utente leggerà
          // need_answer.json, aggiungerà le risposte a known_answers.json e riavvierà.
          if (quizResult.outcome === 'need_help' || quizResult.outcome === 'failed' || quizResult.outcome === 'unknown') {
            courseState.incrementQuizAttempt(ROOT, state, courseUrl, quizResult.resultText);
            courseState.markCourseNeedHelp(ROOT, state, courseUrl, quizResult.reason || 'quiz non superato');
            const needAnswerPath = path.join(ROOT, 'data', 'need_answer.json');
            const needAnswerSaved = fs.existsSync(needAnswerPath);
            if (needAnswerSaved) {
              log(`Quiz finale di ${courseUrl} non superato (${quizResult.resultText}). Corso segnato come 'need_help'; domande salvate in data/need_answer.json. Passo al prossimo corso.`);
            } else {
              log(`Quiz finale di ${courseUrl} non superato (${quizResult.resultText}). Corso segnato come 'need_help'. ATTENZIONE: non sono riuscito a catturare le domande in data/need_answer.json; sarà necessario un intervento manuale/AI.`);
            }
            monitor.update({ phase: 'need_help', courseUrl, lastQuizResult: quizResult.resultText, courseStateSummary: courseState.summarize(state) });
            return;
          }

          continue;
        }
      } catch (e) {
        log(`Errore quiz: ${e.message}`);
        await monitor.recordError(page, e, 'finalQuiz');
      }

      log(`Corso ${courseUrl} TERMINATO.`);
      courseState.markCourseDone(ROOT, state, courseUrl);
      saveSession({ courseUrl, phase: 'done' });
      monitor.update({ phase: 'done', courseStateSummary: courseState.summarize(state) });
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
        await solveQuizWrapper(page, courseUrl);
      } else {
        emptyUrls.add(nextHref);
      }
      continue;
    }

    const isQuiz = await page.evaluate(() => !!document.querySelector('form h4')).catch(() => false);
    if (isQuiz) {
      monitor.update({ phase: 'quiz', lessonUrl: nextHref });
      emptyUrls.clear();
      await solveQuizWrapper(page, courseUrl);
      continue;
    }

    const hasVideo = await page.evaluate(() => !!document.querySelector('video')).catch(() => false);
    if (hasVideo) {
      monitor.update({ phase: 'video', lessonUrl: nextHref });
      emptyUrls.clear();
      await watchVideo(page, log, monitor);
      courseState.addCompletedLesson(ROOT, state, courseUrl, nextHref);
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

  const state = courseState.readState(ROOT);
  const initialSummary = courseState.summarize(state);
  log(`Stato corsi caricato: ${JSON.stringify(initialSummary)}`);
  monitor.update({ courseStateSummary: initialSummary });

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

      try {
        await ctx.storageState({ path: STATE_FILE });
      } catch (e) {
        log('Impossibile salvare storage state:', e.message);
      }

      async function discoverCourses() {
        if (Array.isArray(config.courseUrls) && config.courseUrls.length > 0) {
          log('Corsi configurati manualmente in config.json.');
          return config.courseUrls.filter(url => !courseState.isCourseDoneOrNeedHelp(state, url));
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
          const fresh = links.filter(url => !courseState.isCourseDoneOrNeedHelp(state, url));
          if (fresh.length === 0 && links.length > 0) {
            log('Tutti i corsi scoperti risultano completati o bloccati.');
          }
          if (fresh.length === 0) {
            if (await isLoginPage(page)) {
              throw new AutologinError('La dashboard mostra la pagina di login: autologin non valido o scaduto. Aggiorna il link in config.json.');
            }
            log('Nessun corso attivo trovato in dashboard.');
            return [];
          }
          log(`Trovati ${fresh.length} corsi attivi su ${links.length} totali.`);
          return fresh;
        } catch (e) {
          if (e instanceof AutologinError) throw e;
          log(`Errore scoperta corsi: ${e.message}`);
          return [];
        }
      }

      let courseUrls = await discoverCourses();
      if (courseUrls.length === 0) {
        if (courseState.allDoneOrNeedHelp(state, Object.keys(state))) {
          throw new AllCoursesNeedHelpExit('Tutti i corsi sono completati o bloccati. Serve intervento manuale per i corsi bloccati.');
        }
        throw new Error('Nessun corso disponibile dopo autologin. Verificare il link autologin e i permessi account.');
      }

      const sessionState = { loginDrops: 0, maxLoginDrops: MAX_LOGIN_DROPS };
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

        let worked = false;
        for (const courseUrl of courseUrls) {
          log(`Controllo corso: ${courseUrl}`);
          await runCourse(page, courseUrl, sessionState, state);
          worked = true;
        }

        // Riscopri corsi: potrebbero esserne stati aggiunti di nuovi, o lo stato potrebbe cambiare.
        courseUrls = await discoverCourses();
        monitor.update({ courseStateSummary: courseState.summarize(state) });
        if (courseUrls.length === 0) {
          throw new AllCoursesNeedHelpExit('Tutti i corsi risultano completati o bloccati.');
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
      if (e instanceof AutologinError || e.code === 'AUTOLOGIN_INVALID') {
        log('AUTOLOGIN NON VALIDO:', e.message);
        monitor.update({ running: false, phase: 'autologin_invalid', lastError: e.message });
        if (browser) { try { await browser.close(); } catch (_) {} }
        process.exit(3);
      }
      if (e instanceof AllCoursesNeedHelpExit || e.code === 'ALL_NEED_HELP') {
        log('TUTTI I CORSI COMPLETATI O IN ATTESA DI AIUTO:', e.message);
        monitor.update({ running: false, phase: 'need_help', lastError: e.message, courseStateSummary: courseState.summarize(state) });
        if (browser) { try { await browser.close(); } catch (_) {} }
        process.exit(0);
      }
      if (e instanceof SessionError || e.code === 'SESSION_LOST') {
        log('SESSIONE PERSA:', e.message);
        try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) {}
        monitor.update({ phase: 'session_lost', lastError: e.message });
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
