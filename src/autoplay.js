const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const { createLogger } = require('./lib/logger');
const { Monitor } = require('./lib/monitor');
const { solveQuiz } = require('./lib/quiz');
const { watchVideo } = require('./lib/video');
const { isWorkTime, nextWorkEnd, nextWorkStart, describeSchedule, minutesUntilShiftEnd } = require('./lib/schedule');
const courseState = require('./lib/course-state');
const { writeDashboard } = require('./lib/dashboard');
const { writeJsonAtomic } = require('./lib/io');
const { OffHoursExit, AutologinError, SessionError, AllCoursesNeedHelpExit, DashboardEmptyError, NeedHelpExit } = require('./lib/errors');
const { dashboardUrl, userAgent } = require('./lib/platform');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const account = require('./lib/account');

const log = createLogger(ROOT);
const monitor = new Monitor(ROOT, log);

let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
} catch (e) {
  log('FATAL: impossibile leggere config.json:', e.message);
  process.exit(1);
}

// Path di stato per l'account attivo (data/accounts/<CF>/). Fallback legacy
// (file flat in data/) se il CF non è determinabile. session_state è solo un
// path di cleanup; lo stato di sessione vero è in-memory.
const _paths = account.stateFilePaths(ROOT);
const SESSION_FILE = path.join(_paths.accountDir, 'session_state.json');
const STATE_FILE = _paths.storageState;
const ACTIVE_CF = _paths.codiceFiscale;
if (ACTIVE_CF) {
  log(`Account attivo: CF ${ACTIVE_CF} (stato in data/accounts/${ACTIVE_CF}/)`);
  const mig = account.migrateLegacyState(ROOT, log);
  if (mig.moved > 0) log(`Stato legacy migrato in data/accounts/${ACTIVE_CF}/ (${mig.moved} file).`);
}

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

const IGNORE_HOURS = process.argv.includes('--ignore-hours');
const CHECK_INTERVAL_MS = 60000; // controlla orario ogni minuto
const MAX_MISSING_PERMISSION = 3;
const MAX_COURSE_ITER = 120;
const MAX_LOGIN_DROPS = 4;

// Predicati di riconoscimento pagina (login vs dashboard) centralizzati in
// src/lib/page-detect.js, condivisi con l'health-check per evitare derive.
const { isLoginPage, isDashboardLoaded } = require('./lib/page-detect');

// Gestisce eventuali pagine intermedie post-autologin, come:
// - scelta utente/ruolo;
// - accettazione termini/privacy;
// - pop-up "Continua".
async function handlePostLoginInterstitial(page, log) {
  try {
    const bodyText = await page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
    const currentUrl = page.url();

    // Pop-up o pagina con bottone "Continua", "Accedi", "Conferma", "Prosegui".
    // I selettori con testo esplicito hanno la priorità; il submit generico è
    // ultimo resort e viene blindato contro submit di logout/uscita (per non
    // cliccare il bottone sbagliato su pagine con più form).
    const proceedSelectors = [
      'button:has-text("Continua")',
      'button:has-text("Prosegui")',
      'button:has-text("Conferma")',
      'button:has-text("Accedi")',
      'a:has-text("Continua")',
      'a:has-text("Prosegui")',
      'input[type="submit"]'
    ];
    for (const sel of proceedSelectors) {
      const btn = page.locator(sel).first();
      if (await btn.isVisible().catch(() => false)) {
        // Blindatura del submit generico: salta bottoni che sembrano logout/uscita.
        if (sel === 'input[type="submit"]') {
          const val = (await btn.getAttribute('value').catch(() => '')) || '';
          if (/esci|logout|chiudi|annulla|esc/i.test(String(val))) {
            log(`Pagina intermedia (${currentUrl}): submit '${val}' sembra logout, lo salto.`);
            continue;
          }
          log(`Pagina intermedia rilevata (${currentUrl}). Clicco submit '${val}'...`);
        } else {
          log(`Pagina intermedia rilevata (${currentUrl}). Clicco '${sel}'...`);
        }
        await btn.click().catch(() => {});
        await page.waitForTimeout(3000);
        return true;
      }
    }

    // Checkbox di accettazione privacy/termini
    if (/accetto|termini|privacy|condizioni/i.test(bodyText)) {
      const checkboxes = await page.locator('input[type="checkbox"]').all();
      let checked = 0;
      for (const cb of checkboxes) {
        try {
          await cb.check();
          checked++;
        } catch (_) {}
      }
      if (checked > 0) {
        log(`Spuntate ${checked} checkbox di accettazione.`);
        const submitBtn = page.locator('button[type="submit"], button.btn-primary, input[type="submit"]').first();
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click().catch(() => {});
          await page.waitForTimeout(3000);
        }
        return true;
      }
    }

    return false;
  } catch (e) {
    log(`Errore gestione pagina intermedia: ${e.message}`);
    return false;
  }
}

function saveSession(state) {
  try {
    // Scrittura atomica (tmp + rename): session_state.json non deve mai restare
    // troncato a metà (lo legge il cleanup, ma un file corrotto confondere).
    writeJsonAtomic(SESSION_FILE, { ...state, savedAt: new Date().toISOString() });
  } catch (e) {
    log('Errore salvataggio sessione:', e.message);
  }
}

// loadSession rimosso: era codice morto (mai chiamato). Lo stato di sessione
// vero è in-memory; SESSION_FILE è solo un artefatto di cleanup.

async function solveQuizWrapper(page, courseUrl) {
  try {
    const result = await solveQuiz(page, ROOT, log, monitor, courseUrl);
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

// Gestisce la pagina di accettazione informativa che appare DOPO il login
// (URL /informativa/acceptPrivacyPolicy, e sibling come /informativa/accept* per
// la scheda tecnica). A differenza di handleCourseInformativa (che è sulla
// pagina /corso/informativa/ con checkbox), qui NON ci sono checkbox: basta
// cliccare il bottone "Confermo" del form. Il form ha un hidden csrf_token, e il
// click sul submit sottomette nativamente (POST con csrf), niente POST manuale.
// Idempotente: torna false se non siamo sulla pagina (es. privacy già accettata
// in un run precedente).
async function acceptInformativa(page, log) {
  const url = page.url();
  if (!url.includes('/informativa/accept')) return false;
  log(`Pagina informativa post-login rilevata (${url}). Clicco conferma...`);
  try {
    let btn = page.locator('form[id^="accept_"] button[type="submit"]').first();
    if (await btn.count().catch(() => 0) === 0) {
      // Fallback: qualsiasi submit primario nella pagina
      btn = page.locator('button[type="submit"].btn-primary').first();
      if (await btn.count().catch(() => 0) === 0) {
        log('Bottone conferma informativa non trovato.');
        return false;
      }
    }
    await btn.click().catch(e => log(`Errore click conferma informativa: ${e.message}`));
    await page.waitForTimeout(4000);
    log(`Dopo conferma informativa: URL = ${page.url()}`);
    return true;
  } catch (e) {
    log(`Errore gestione conferma informativa: ${e.message}`);
    return false;
  }
}

// Gestisce il modal "Dichiarazione di fruizione" che appare direttamente sulla
// pagina /corso/show/XXXX. La piattaforma non registra i progressi delle lezioni
// (e non sblocca il quiz/attestato) finché l'utente non clicca "Confermo e proseguo".
async function acceptUsageDeclaration(page, log) {
  try {
    const needsAcceptance = await page.evaluate(() => {
      const bodyText = document.body ? document.body.innerText : '';
      if (!/Dichiarazione di fruizione|Confermo e proseguo/i.test(bodyText)) return false;
      const btn = [...document.querySelectorAll('button')].find(b => /confermo e proseguo/i.test(b.innerText));
      return btn ? { found: true, text: btn.innerText.trim() } : { found: false };
    }).catch(() => ({ found: false }));
    if (!needsAcceptance.found) return false;
    log(`Dichiarazione di fruizione rilevata. Accetto e proseguo...`);
    const btn = page.locator('button:has-text("Confermo e proseguo")').first();
    const form = page.locator('#conferma_vincolo_orario_form');
    const checkboxes = await form.locator('input[type="checkbox"]').all();
    for (const cb of checkboxes) {
      await cb.check().catch(() => {});
    }
    await btn.click({ force: true }).catch(e => log(`Errore click 'Confermo e proseguo': ${e.message}`));
    await page.waitForTimeout(4000);
    
    // Fallback: se il modal SweetAlert rimane aperto e blocca i click futuri, rimuovilo dal DOM.
    await page.evaluate(() => {
      const swal = document.querySelector('.swal2-container');
      if (swal) swal.remove();
    }).catch(() => {});

    log(`Dopo dichiarazione: URL = ${page.url()}`);
    return true;
  } catch (e) {
    log(`Errore accettazione dichiarazione: ${e.message}`);
    return false;
  }
}

// Naviga sulla pagina del corso e restituisce la percentuale di completamento
// riportata dalla piattaforma per una specifica lezione.
async function getLessonProgressOnCoursePage(page, courseUrl, lessonHref) {
  try {
    await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    // Su sessione fragile il goto rimbalza su /login: NON tornare null silenzioso
    // (sennà runCourse crede "lezione non completata" e dopo 3 tentativi marca
    // need_help un corso legittimamente completato). Segnala il drop di sessione:
    // runAutoplay esce con session_unstable + cooldown invece di insistere.
    if (await isLoginPage(page)) {
      throw new SessionError('Sessione caduta verificando il progresso della lezione (redirect a /login dopo goto corso).');
    }
    const rows = await page.evaluate(() => {
      const all = [...document.querySelectorAll('a[href*="/lezione/show/"]')];
      return all.map(a => {
        const block = (a.closest('tr, .row, li, .card, .card-body') || a.parentElement);
        const txt = (block?.innerText || '').replace(/\s+/g, ' ').trim();
        const m = txt.match(/(\d+[.,]\d+)\s*%/);
        return { href: a.href, pct: m ? parseFloat(m[1].replace(',', '.')) : null };
      });
    });
    const found = rows.find(r => r.href === lessonHref);
    return found ? found.pct : null;
  } catch (e) {
    if (e instanceof SessionError) throw e; // propaga il drop, non inghiottirlo
    return null;
  }
}

async function runCourse(page, courseUrl, sessionState, state) {
  const emptyUrls = new Set();
  const stuckUrls = new Set(); // lezioni bloccate al <100% dopo 3 tentativi: saltate, non abbandonano il corso
  const lessonAttempts = new Map();
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
      // Se siamo già sulla dashboard (es. subito dopo discoverCourses), NON
      // ricaricarla: ogni goto in più stressa la sessione quando è fragile e
      // la piattaforma può rimbalzarci su /login. Ricarichiamo solo se serve.
      if (!page.url().includes('/corso/listAllByUser')) {
        log('Ritorno dashboard per accesso al corso...');
        await page.goto(dashboardUrl(config), { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
      for (let w = 0; w < 30; w++) {
        if (await isDashboardLoaded(page)) break;
        if (await isLoginPage(page)) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(2000);

      const targetId = courseUrl.split('/show/')[1];
      log(`Searching for course ID ${targetId} in dashboard...`);

      // Cliccare il link "Apri" del corso nella dashboard è il percorso "naturale"
      // che la piattaforma riconosce: preserva la sessione molto meglio di una
      // goto diretta a /corso/show/X (che su sessione fragile rimbalza su /login).
      // Aspettiamo che il link sia nel DOM (la dashboard può renderizzare le card
      // in lazy) e preferiamo sempre il click alla goto diretta.
      const linkSel = `a[href*="/corso/show/${targetId}"]`;
      let courseLink = null;
      for (let w = 0; w < 20; w++) {
        if (await page.locator(linkSel).count().catch(() => 0) > 0) {
          courseLink = page.locator(linkSel).first();
          break;
        }
        if (await isLoginPage(page)) break;
        await page.waitForTimeout(500);
      }

      if (courseLink && (await courseLink.isVisible().catch(() => false))) {
        log(`Link corso trovato tramite href per ID ${targetId}. Clicco per entrare...`);
        try {
          await courseLink.click({ timeout: 10000 });
        } catch (clickErr) {
          log(`Click corso non andato a buon fine (${clickErr.message}); provo click JS forzato.`);
          await page.evaluate((sel) => { const a = document.querySelector(sel); if (a) a.click(); }, linkSel).catch(() => {});
        }
        await page.waitForTimeout(5000);
      } else if (courseLink) {
        // Link presente nel DOM ma non "visibile" (card collassata/off-screen/animazione):
        // click via JS invece di arrenderci e fare la goto diretta (che fa cadere la sessione).
        log(`Link corso per ID ${targetId} presente ma non visibile. Click JS forzato...`);
        await page.evaluate((sel) => { const a = document.querySelector(sel); if (a) a.click(); }, linkSel).catch(() => {});
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
      // Sessione caduta. NON re-hitiamo l'autologin: ogni hit consuma/degrada il
      // token, e la raffica di re-login è proprio la causa dell'instabilità che
      // stiamo curando (la piattaforma rate-limita l'autologin usato troppe volte
      // nello stesso giorno). Usciamo subito con SessionError: il catch esterno,
      // visto che il token era già valido, emette session_unstable (exit 4) e lo
      // scheduler fa cooldown, così il token recupera e il prossimo run è stabile.
      throw new SessionError('Sessione caduta durante l\'accesso al corso (pagina di login). Token probabilmente degradato dal sovrauso: esco senza re-login per non consumarlo ulteriormente.');
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
        await page.goto(config.autologinUrl, { waitUntil: 'load', timeout: 60000 });
        let attempts = 0;
        while (page.url().includes('autologin') && attempts < 20) {
          await page.waitForTimeout(1000);
          attempts++;
        }
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
    // Gestione modal "Dichiarazione di fruizione" sulla pagina del corso.
    await acceptUsageDeclaration(page, log);

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
    // Fonte di verità per l'avanzamento è la percentuale mostrata dalla piattaforma.
    // Se una lezione era stata segnata come completata localmente ma la piattaforma
    // mostra ancora < 100%, la riprendiamo. emptyUrls serve per saltare temporaneamente
    // lezioni che non contengono video/quiz riconoscibili; stuckUrls per le lezioni
    // bloccate al <100% dopo 3 tentativi (skip persistente nel run, ri-provate nel
    // prossimo run scheduler).
    // SEQUENZIALE: scoredLinks è già in ordine di pagina (DOM, raccolto dal
    // page.evaluate sopra). NON ordiniamo per percentuale: si prosegue nell'ordine
    // naturale (lezione 1, 2, 3...), riprendendo al primo posto le lezioni già
    // iniziate ma non a 100%. Prima il sort per pct saltava alla lezione meno
    // avanzata → "come gli pare".
    const availableLinks = scoredLinks
      .filter(l => l.pct < 100 && !emptyUrls.has(l.href) && !stuckUrls.has(l.href));
    const nextHref = availableLinks.length > 0 ? availableLinks[0].href : null;

    if (!nextHref) {
      if (emptyUrls.size > 0) {
        log('Reset filtri vuoti...');
        emptyUrls.clear();
        continue;
      }

      // Restano solo lezioni bloccate al <100% (stuckUrls): il corso non può
      // progredire oltre → need_help. A differenza del vecchio comportamento
      // (che abbandonava il corso al 3° tentativo di UNA lezione e faceva sì che
      // il for esterno saltasse al corso successivo nella stessa passata), ora
      // abbiamo prima portato avanti tutte le altre lezioni del corso in ordine.
      if (stuckUrls.size > 0) {
        log(`Corso ${courseUrl}: ${stuckUrls.size} lezione/i bloccate al <100% dopo 3 tentativi, nessun'altra progressabile. Segnalo need_help.`);
        courseState.markCourseNeedHelp(ROOT, state, courseUrl, `lezioni bloccate al <100%: ${[...stuckUrls].join(', ')}`);
        monitor.update({ phase: 'need_help', courseUrl, courseStateSummary: courseState.summarize(state) });
        return;
      }

      const currentUrl = page.url();
      if (!currentUrl.includes('/corso/show/')) {
        log(`Spostamento inatteso: ${currentUrl}. Ritorno al login...`);
        try {
          await page.goto(config.autologinUrl, { waitUntil: 'load', timeout: 60000 });
          let attempts = 0;
          while (page.url().includes('autologin') && attempts < 20) {
            await page.waitForTimeout(1000);
            attempts++;
          }
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
          // Clicca il link del quiz dalla pagina corso (il goto diretto può perdere la sessione).
          const quizLocator = page.locator(`a[href="${quizLink}"]`).first();
          try {
            await quizLocator.click({ timeout: 10000 });
          } catch (clickErr) {
            log(`Click quiz non andato a buon fine (${clickErr.message}); provo click forzato/goto.`);
            await quizLocator.click({ force: true, timeout: 10000 }).catch(async () => {
              await page.goto(quizLink);
            });
          }
          await page.waitForTimeout(4000);
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
            const needAnswerPath = _paths.needAnswer;
            const needAnswerSaved = fs.existsSync(needAnswerPath);
            if (needAnswerSaved) {
              log(`Quiz finale di ${courseUrl} non superato (${quizResult.resultText}). Corso segnato come 'need_help'; domande salvate in ${needAnswerPath}. Passo al prossimo corso.`);
            } else {
              log(`Quiz finale di ${courseUrl} non superato (${quizResult.resultText}). Corso segnato come 'need_help'. ATTENZIONE: non sono riuscito a catturare le domande in ${needAnswerPath}; sarà necessario un intervento manuale/AI.`);
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
      // Clicca il link dalla pagina corso: il goto diretto a /lezione/show/... può
      // riportare alla pagina di login dopo aver accettato la dichiarazione di fruizione.
      const lessonLink = page.locator(`a[href="${nextHref}"]`).first();
      try {
        await lessonLink.click({ timeout: 10000 });
      } catch (clickErr) {
        log(`Click lezione non andato a buon fine (${clickErr.message}); provo click forzato.`);
        await lessonLink.click({ force: true, timeout: 10000 }).catch(() => {});
      }
      await page.waitForTimeout(4000);
    } catch (e) {
      log(`Errore apertura lezione via click: ${e.message}. Provo con goto diretto...`);
      try {
        await page.goto(nextHref, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);
      } catch (e2) {
        log(`Errore navigazione: ${e2.message}`);
        await monitor.recordError(page, e2, 'navigateLesson');
        continue;
      }
    }

    if (await isLoginPage(page)) {
      // Stesso principio del drop in dashboard: niente re-login autologin (consuma
      // il token e causa il rate-limit che stiamo curando). Esco subito con
      // SessionError -> session_unstable (exit 4) + cooldown dello scheduler.
      throw new SessionError('Sessione caduta durante l\'apertura della lezione (pagina di login). Esco senza re-login per non degradare il token.');
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
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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

      // Verifica che la piattaforma abbia effettivamente registrato il progresso a 100%.
      const lessonProgress = await getLessonProgressOnCoursePage(page, courseUrl, nextHref);
      if (lessonProgress !== null && lessonProgress >= 99) {
        log(`Lezione ${nextHref} verificata al ${lessonProgress}%: completata.`);
        courseState.addCompletedLesson(ROOT, state, courseUrl, nextHref);
      } else {
        const attempts = (lessonAttempts.get(nextHref) || 0) + 1;
        lessonAttempts.set(nextHref, attempts);
        log(`Lezione ${nextHref} non risulta completata sulla piattaforma (progresso: ${lessonProgress}%). Tentativo ${attempts}.`);
        if (attempts >= 3) {
          // NON abbandonare il corso per una singola lezione bloccata: la salto e
          // continuo con le altre lezioni dello STESSO corso (progressione
          // sequenziale). Il corso viene segnato need_help solo se TUTTE le
          // lezioni rimanenti sono bloccate (ramo !nextHref sopra). Il vecchio
          // return qui faceva sì che il for esterno saltasse al corso successivo
          // nella stessa passata → "un po' di tutti i corsi" senza finirne nessuno.
          // Le lezioni saltate sono ri-provate nel prossimo run scheduler
          // (stuckUrls è in-memory), così i race temporanei (piattaforma che
          // persiste il 100% in ritardo) si auto-risolvono.
          log(`Lezione ${nextHref} bloccata a ${lessonProgress}% dopo 3 tentativi. La salto e continuo con le prossime lezioni del corso.`);
          stuckUrls.add(nextHref);
        } else {
          emptyUrls.add(nextHref);
        }
      }
      continue;
    }

    log(`Senza contenuto (${nextHref}).`);
    emptyUrls.add(nextHref);
    await page.waitForTimeout(5000);
  }
}

async function runAutoplay() {
  let browser;
  let ctx;
  let outerRetries = 0;
  const MAX_OUTER_RETRIES = 5;
  // True se in QUALCHE outer retry di questo run abbiamo raggiunto la dashboard con
  // una sessione autenticata (loggedIn=true, visto >=1 link corso). Se poi i
  // tentativi successivi falliscono, NON è il link autologin a essere scaduto: è
  // la piattaforma che rate-limita i re-login dopo la nostra raffica di tentativi
  // (nei log si vede il token "esaurirsi" sotto la raffica e riprendere decine di
  // minuti dopo). Va distinto dal caso "link davvero morto" (mai visto un corso)
  // per non dire al collega "aggiorna il link" quando il link funziona.
  let tokenProvenValid = false;

  log('========================================');
  log('Avvio GSD Campus autoplay');
  log('Orario configurato:', describeSchedule());
  log('IGNORE_HOURS:', IGNORE_HOURS);
  log('========================================');

  const state = courseState.readState(ROOT);
  const initialSummary = courseState.summarize(state);
  log(`Stato corsi caricato: ${JSON.stringify(initialSummary)}`);
  monitor.update({ courseStateSummary: initialSummary });

  // --- Gestione segnali / crash: chiusura sicura del browser ---
  // Senza questi handler, uno SIGTERM (es. da ./stop.sh) o un crash uccide il
  // processo saltando il finally -> il chromium resta orfano (leak a ogni stop).
  let shuttingDown = false;
  async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    try { log(`Ricevuto ${signal}: chiusura sicura...`); } catch (_) {}
    try { monitor.update({ running: false, phase: 'stopped' }); } catch (_) {}
    if (browser) { try { await browser.close(); } catch (_) {} browser = null; }
    if (ctx) { try { await ctx.close(); } catch (_) {} ctx = null; }
    process.exit(0);
  }
  async function fatalShutdown(reason, err) {
    try { log(`FATAL (${reason}):`, err?.message || err); } catch (_) {}
    try { monitor.update({ running: false, phase: 'fatal', lastError: String(err?.message || err) }); } catch (_) {}
    if (browser) { try { await browser.close(); } catch (_) {} browser = null; }
    if (ctx) { try { await ctx.close(); } catch (_) {} ctx = null; }
    process.exit(1);
  }
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => fatalShutdown('uncaughtException', err));
  process.on('unhandledRejection', (err) => fatalShutdown('unhandledRejection', err));

  while (outerRetries < MAX_OUTER_RETRIES) {
    outerRetries++;
    // Rileva divergenze: se config.json è stato cambiato durante il run (es.
    // members-cli set-active da parte dell'AI/utente), il CF attivo può divergere
    // da quello con cui abbiamo caricato lo stato. Avvisa: lo stato/cookie
    // finirebbero nella cartella dell'account sbagliato. Richiede riavvio.
    const _nowPaths = account.stateFilePaths(ROOT);
    if (_nowPaths.codiceFiscale && ACTIVE_CF && _nowPaths.codiceFiscale !== ACTIVE_CF) {
      log(`ATTENZIONE: l'account attivo in config.json (${_nowPaths.codiceFiscale}) è diverso da quello all'avvio (${ACTIVE_CF}). Stato e cookie stanno nella cartella dell'account sbagliato: riavvia (./stop.sh && ./start.sh) per usare il nuovo account.`);
    }
    monitor.update({ phase: 'starting', running: true, lastError: null });
    try {
      log('Avvio browser in modalità headless...');
      // Pulizia preventiva: lo storage state locale può contenere cookie/sessioni
      // vecchie che interferiscono con il nuovo autologin. Rimuoviamolo PRIMA di
      // creare il contesto browser, così il browser parte sempre pulito.
      try {
        if (fs.existsSync(STATE_FILE)) {
          fs.unlinkSync(STATE_FILE);
          log('Storage state precedente rimosso per evitare conflitti di sessione.');
        }
        if (fs.existsSync(SESSION_FILE)) {
          fs.unlinkSync(SESSION_FILE);
        }
      } catch (e) {
        log('Impossibile rimuovere storage/session state precedente:', e.message);
      }

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

      // Contesto pulito: NON carichiamo mai vecchi storageState. Il login
      // via autologin URL imposterà i cookie corretti da zero.
      const ctxOptions = {
        viewport: { width: 1440, height: 900 },
        userAgent: userAgent(config)
      };

      ctx = await browser.newContext(ctxOptions);

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
          // Al primo tentativo puliamo i cookie per partire da zero. Ai tentativi
          // successivi NON li puliamo: il re-goto all'autologin potrebbe aver
          // impostato cookie che il server riconosce al prossimo redirect.
          if (la === 1) {
            await ctx.clearCookies({ domain: 'tecsial.gsdcampus.it' }).catch(() => {});
          }
          // Usiamo 'load' invece di 'networkidle': la piattaforma GSD Campus ha
          // script persistenti (analytics, polling) che impediscono a networkidle
          // di risolvere, causando timeout che fanno scadere la sessione server-side.
          await page.goto(config.autologinUrl, { waitUntil: 'load', timeout: 60000 });
          // Attendi il redirect dall'autologin (normalmente immediato)
          let attempts = 0;
          while (page.url().includes('autologin') && attempts < 20) {
            await page.waitForTimeout(1000);
            attempts++;
          }
          // Pausa per stabilizzare la sessione dopo l'autologin
          await page.waitForTimeout(3000);
          // Gestisci la pagina di accettazione informativa (privacy/scheda tecnica)
          // che la piattaforma mostra dopo il login. Va PRIMA di handlePostLoginInterstitial:
          // quella matcha "privacy" nel testo ma cerca checkbox (qui non ce ne sono) e il
          // bottone "Confermo" non matcha i suoi selettori "Conferma/Continua/Prosegui".
          await acceptInformativa(page, log);
          // Gestisci pagine intermedie post-autologin (termini, scelta ruolo, ecc.)
          await handlePostLoginInterstitial(page, log);

          // Naviga alla dashboard con 'domcontentloaded' (veloce e affidabile)
          await page.goto(dashboardUrl(config), { waitUntil: 'domcontentloaded', timeout: 60000 });
          await handlePostLoginInterstitial(page, log);

          // Attendiamo che il DOM sia stabilizzato e la dashboard sia effettivamente caricata.
          // Usiamo un timeout lungo perché il rendering dei corsi è asincrono.
          for (let w = 0; w < 40; w++) {
            if (await isDashboardLoaded(page)) break;
            if (await isLoginPage(page)) break;
            await page.waitForTimeout(500);
          }
          await page.waitForTimeout(2000);

          // Test di salute: verifica che la dashboard contenga corsi.
          const dashboardLinks = await page.evaluate(() =>
            [...document.querySelectorAll('a[href*="/corso/show/"]')].map(a => a.href)
          ).catch(() => []);
          log(`Link corsi rilevati in dashboard: ${dashboardLinks.length}`);

          if (await isLoginPage(page)) {
            log(`Login non riuscito al tentativo ${la} (la piattaforma mostra la pagina di login).`);
            await page.waitForTimeout(4000);
            continue;
          }
          if (!(await isDashboardLoaded(page))) {
            log(`Attenzione: la dashboard non sembra caricata al tentativo ${la}. Riprovo.`);
            await page.waitForTimeout(3000);
            continue;
          }
          loggedIn = true;
          tokenProvenValid = true; // il link autologin FUNZIONA in questo run
          log(`URL finale dopo login: ${page.url()}`);
        } catch (e) {
          log(`Errore durante l'autologin (tentativo ${la}): ${e.message}`);
          await page.waitForTimeout(3000);
        }
      }
      if (!loggedIn) {
        // Se il login non è riuscito, eliminiamo lo storage state in modo che il
        // prossimo avvio parta senza cookie vecchi/invalidi.
        try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) {}
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
          // Se la dashboard finisce sulla pagina di login, ritenta l'autologin:
          // può capitare che la sessione cada transitoriamente tra il login
          // iniziale e la scoperta corsi (non significa che il link sia scaduto).
          const DC_MAX = 3;
          for (let dcAttempt = 1; dcAttempt <= DC_MAX; dcAttempt++) {
            // Usiamo 'domcontentloaded' per evitare che networkidle resti appeso
            // sugli script persistenti della piattaforma causando timeout e
            // conseguente scadenza della sessione server-side.
            // Al primo tentativo, se siamo GIÀ sulla dashboard caricata (es. subito
            // dopo il login), NON ricaricarla: ogni goto in più stressa la sessione
            // quando è fragile e la piattaforma può rimbalzarci su /login (era questa
            // la causa dei "Sessione caduta subito dopo il login durante la scoperta").
            // Ricarichiamo solo ai retry o se non siamo in dashboard.
            const alreadyOnDash = page.url().includes('/corso/listAllByUser') && (await isDashboardLoaded(page).catch(() => false));
            if (!(dcAttempt === 1 && alreadyOnDash)) {
              await page.goto(dashboardUrl(config), { waitUntil: 'domcontentloaded', timeout: 60000 });
            }
            // Belt-and-suspenders: se il goto dashboard rimbalza su un'informativa
            // non gestita al login (es. scheda tecnica dopo la privacy), gestiscila qui.
            // Idempotente: torna false se non sulla pagina.
            await acceptInformativa(page, log);
            // Attesa esplicita per il rendering dei corsi (più affidabile di networkidle)
            for (let w = 0; w < 30; w++) {
              if (await isDashboardLoaded(page)) break;
              if (await isLoginPage(page)) break;
              await page.waitForTimeout(500);
            }
            await page.waitForTimeout(2000);
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
            if (fresh.length > 0) {
              log(`Trovati ${fresh.length} corsi attivi su ${links.length} totali.`);
              // Salva lo storage state ora che la sessione funziona
              try { await ctx.storageState({ path: STATE_FILE }); } catch (_) {}
              return fresh;
            }
            if (links.length > 0) {
              // Corsi trovati ma tutti done/need_help: non è un errore di login.
              log('Nessun corso attivo trovato in dashboard.');
              return [];
            }
            if (await isLoginPage(page)) {
              // Sessione caduta subito dopo il login. NON re-hitiamo l'autologin
              // (consuma il token e causa il rate-limit che stiamo curando): esco
              // subito con SessionError -> session_unstable (exit 4) + cooldown.
              throw new SessionError('La sessione cade subito dopo il login durante la scoperta corsi. Token probabilmente degradato dal sovrauso: esco senza re-login.');
            }
            // Nessun link e nessun login: pagina vuota/errore. Riprova con
            // backoff crescente (3s, 10s, 25s): tentativi ravvicinati a 3s fissi
            // stressano la sessione fragile esattamente come i re-login sconsigliati.
            if (dcAttempt < DC_MAX) {
              const dcBackoff = [3000, 10000, 25000][Math.min(dcAttempt - 1, 2)] || 3000;
              log(`Dashboard vuota durante la scoperta (tentativo ${dcAttempt}/${DC_MAX}), riprovo tra ${Math.round(dcBackoff / 1000)}s...`);
              await page.waitForTimeout(dcBackoff);
              continue;
            }
            log('Nessun corso attivo trovato in dashboard.');
            return [];
          }
          return [];
        } catch (e) {
          if (e instanceof AutologinError || e instanceof SessionError) throw e;
          log(`Errore scoperta corsi: ${e.message}`);
          return [];
        }
      }

      let courseUrls = await discoverCourses();
      if (courseUrls.length === 0) {
        if (courseState.allDoneOrNeedHelp(state, Object.keys(state))) {
          throw new AllCoursesNeedHelpExit('Tutti i corsi sono completati o bloccati. Serve intervento manuale per i corsi bloccati.');
        }
        // Dashboard vuota = quasi sicuramente una pagina di blocco (informativa)
        // non gestita. Dump della pagina per diagnosi AI (page è in scope qui dentro
        // il try), poi lancio DashboardEmptyError -> il catch mappa a
        // phase 'post_login_blocked' + exit 4 (cooldown, NON crash): evita il
        // blackout da interstitial sconosciuti.
        await monitor.recordError(page, new Error('Dashboard vuota dopo login'), 'dashboard_empty');
        throw new DashboardEmptyError('Dashboard vuota dopo il login: probabile pagina di blocco (informativa) non gestita. Dump salvato in debug/dumps+screenshots.');
      }

      const sessionState = { loginDrops: 0, maxLoginDrops: MAX_LOGIN_DROPS };
      let lastHourCheck = 0;
      let extraTimeUntil = 0; // timestamp entro cui completare il contenuto in corso
      while (true) {
        if (!IGNORE_HOURS) {
          const now = Date.now();
          if (now - lastHourCheck > CHECK_INTERVAL_MS) {
            lastHourCheck = now;
            if (!isWorkTime()) {
              const end = nextWorkEnd(new Date());
              const start = nextWorkStart(new Date());
              // Tolleranza: se il turno è appena finito (meno di 15 min fa) e stavamo
              // guardando un video o completando una lezione, concediamo extra-time per
              // terminare il contenuto in corso. Altrimenti ci fermiamo regolarmente.
              if (end) {
                const minutesSinceEnd = (now - end.getTime()) / 60000;
                if (minutesSinceEnd <= 15) {
                  extraTimeUntil = now + 15 * 60000;
                  log(`Turno appena terminato. Extra-time attivo fino alle ${new Date(extraTimeUntil).toISOString()} per completare il contenuto in corso.`);
                }
              }
              if (now < extraTimeUntil) {
                log('Sono fuori orario ma in extra-time per completare il contenuto in corso.');
              } else {
                log(`Fuori orario lavorativo. Stop programmato: ${end ? end.toISOString() : 'N/A'}, prossimo avvio: ${start ? start.toISOString() : 'N/A'}`);
                monitor.update({ phase: 'off_hours', nextStart: start ? start.toISOString() : null, nextEnd: end ? end.toISOString() : null, running: false });
                throw new OffHoursExit('Fine turno lavorativo');
              }
            }
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
        try { writeDashboard(ROOT); } catch (_) {}
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
        if (ctx) { try { await ctx.close(); } catch (_) {} ctx = null; }
        if (browser) { try { await browser.close(); } catch (_) {} browser = null; }
        try { writeDashboard(ROOT); } catch (_) {}
        process.exit(0);
      }
      if (e instanceof NeedHelpExit) {
        // Quiz sospeso (domanda senza risposta nota): chiude il browser e scrive
        // phase need_help PRIMA di exit. Prima questo avveniva con process.exit(2)
        // dentro quiz.js, che orfanava il chromium e saltava il finally.
        log('NEED HELP:', e.message);
        monitor.update({ running: false, phase: 'need_help', lastError: e.message, courseStateSummary: courseState.summarize(state) });
        if (ctx) { try { await ctx.close(); } catch (_) {} ctx = null; }
        if (browser) { try { await browser.close(); } catch (_) {} browser = null; }
        try { writeDashboard(ROOT); } catch (_) {}
        process.exit(2);
      }
      if (e instanceof AutologinError || e.code === 'AUTOLOGIN_INVALID') {
        if (tokenProvenValid) {
          // Il link FUNZIONA: in questo run abbiamo già raggiunto la dashboard con
          // una sessione valida. I tentativi falliti adesso sono rate-limiting della
          // piattaforma causato dalla nostra raffica di re-login, NON un link
          // scaduto. Non diciamo "aggiorna il link" (sarebbe falso e porterebbe il
          // collega a riconfigurare un account che funziona): usciamo con fase
          // recoverable session_unstable, così il supervisore sa che basta riprovare.
          log('SESSIONE INSTABILE (token valido, rate-limit dei re-login):', e.message);
          monitor.update({
            running: false,
            phase: 'session_unstable',
            lastError: 'Token autologin valido ma la piattaforma limita i re-login. Riprova tra qualche minuto.'
          });
          if (browser) { try { await browser.close(); } catch (_) {} }
          try { writeDashboard(ROOT); } catch (_) {}
          process.exit(4); // exit 4 = session_unstable: lo scheduler fa cooldown lungo
        }
        log('AUTOLOGIN NON VALIDO:', e.message);
        monitor.update({ running: false, phase: 'autologin_invalid', lastError: e.message });
        if (browser) { try { await browser.close(); } catch (_) {} }
        process.exit(3);
      }
      if (e instanceof AllCoursesNeedHelpExit || e.code === 'ALL_NEED_HELP') {
        log('TUTTI I CORSI COMPLETATI O IN ATTESA DI AIUTO:', e.message);
        monitor.update({ running: false, phase: 'need_help', lastError: e.message, courseStateSummary: courseState.summarize(state) });
        if (browser) { try { await browser.close(); } catch (_) {} }
        try { writeDashboard(ROOT); } catch (_) {}
        process.exit(0);
      }
      if (e instanceof DashboardEmptyError || e.code === 'DASHBOARD_EMPTY') {
        // Dashboard vuota dopo login: blocco da interstitial non gestito (non un
        // crash). recordError è già stato chiamato al throw site (page in scope
        // lì) per il dump HTML+screenshot in debug/. Qui chiudo browser+ctx e
        // esco con exit 4: lo scheduler fa cooldown 30 min SENZA incrementare il
        // crash counter -> niente blackout. La fase 'post_login_blocked' (vs
        // 'session_unstable') dice all'AI che è un blocco post-login, non un
        // token degradato. L'AI legge il dump e aggiunge l'handler per il nuovo
        // interstitial. Il finally NON gira dopo process.exit: chiudo ctx+browser
        // esplicitamente (come fa il ramo OffHoursExit).
        log('DASHBOARD VUOTA / BLOCCO POST-LOGIN:', e.message);
        monitor.update({ running: false, phase: 'post_login_blocked', lastError: e.message, courseStateSummary: courseState.summarize(state) });
        if (ctx) { try { await ctx.close(); } catch (_) {} ctx = null; }
        if (browser) { try { await browser.close(); } catch (_) {} browser = null; }
        try { writeDashboard(ROOT); } catch (_) {}
        process.exit(4);
      }
      if (e instanceof SessionError || e.code === 'SESSION_LOST') {
        log('SESSIONE PERSA:', e.message);
        try { if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE); } catch (_) {}
        if (tokenProvenValid) {
          // Token già dimostrato valido in questo run (login riuscito) ma la
          // sessione è caduta. Re-hitare l'autologin consumerebbe un altro hit del
          // token, degradandolo e causando proprio l'instabilità che stiamo curando.
          // Usciamo subito con session_unstable (exit 4): lo scheduler fa cooldown
          // lungo (es. 30 min) così il token recupera e il prossimo run ha sessione
          // stabile. Niente outer-retry, niente raffica.
          log('Token valido ma sessione instabile: esco senza re-login per non consumare il token.');
          monitor.update({ running: false, phase: 'session_unstable', lastError: 'Sessione instabile con token valido. Attendo il cooldown dello scheduler prima di riprovare.' });
          if (browser) { try { await browser.close(); } catch (_) {} }
          try { writeDashboard(ROOT); } catch (_) {}
          process.exit(4);
        }
        monitor.update({ phase: 'session_lost', lastError: e.message });
      } else {
        log('ERRORE CRITICO:', e);
        await monitor.recordError(null, e, 'outer');
      }
    } finally {
      if (ctx) {
        try { await ctx.close(); } catch (e) {}
        ctx = null;
      }
      if (browser) {
        try { await browser.close(); } catch (e) {}
        browser = null;
      }
      if (outerRetries < MAX_OUTER_RETRIES) {
        // Backoff crescente: 30s, 60s, 120s, 240s. La piattaforma GSD Campus
        // rate-limita l'autologin se colpito troppe volte in poco tempo (il token
        // si "esaurisce" sotto la raffica di re-login e riprende decine di minuti
        // dopo). Spaziare i tentativi riduce il rate-limiting e dà alla sessione
        // il tempo di stabilizzarsi, invece di martellare a 30s fissi.
        const backoffMs = 30000 * Math.pow(2, outerRetries - 1); // 30, 60, 120, 240...
        const backoffSec = Math.round(backoffMs / 1000);
        log(`Riavvio browser tra ${backoffSec} secondi (tentativo ${outerRetries}/${MAX_OUTER_RETRIES})...`);
        await new Promise(r => setTimeout(r, backoffMs));
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
