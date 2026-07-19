/**
 * course-runner.js — esecuzione di un singolo corso (lezioni + quiz finale).
 *
 * Estratto da autoplay.js (solo confini di modulo): login/discover restano
 * in autoplay; qui runCourse e helper correlati.
 *
 * createCourseRunner(deps) riceve le dipendenze runtime (log, monitor, config…).
 */

const fs = require('fs');
const courseState = require('./course-state');
const { solveQuiz } = require('./quiz');
const { watchVideo } = require('./video');
const {
  handleCourseInformativa,
  acceptUsageDeclaration,
} = require('./login-flow');
const { isLoginPage, isDashboardLoaded } = require('./page-detect');
const { OffHoursExit, SessionError } = require('./errors');
const {
  dashboardUrl,
  PROGRESS_PERSIST_MS,
  DASHBOARD_POLL_MS,
  COURSE_SETTLE_MS,
  POST_SUBMIT_MS,
  INTERSTITIAL_CLICK_MS,
} = require('./platform');
const { SELECTORS } = require('./selectors');
const { appendMetric } = require('./metrics');
const { isOnDashboardUrl } = require('./session-policy');

const MAX_MISSING_PERMISSION = 3;
const MAX_COURSE_ITER = 120;

/** Course link on dashboard: SELECTORS.dashboard.courseLinks narrowed by id. */
function courseLinkSelector(courseId) {
  // SELECTORS.dashboard.courseLinks = 'a[href*="/corso/show/"]'
  return `a[href*="/corso/show/${courseId}"]`;
}

function lessonLinkSelector() {
  return SELECTORS.course.lessonLinks; // a[href*="/lezione/show/"]
}

/**
 * @param {object} deps
 * @param {string} deps.root
 * @param {function} deps.log
 * @param {object} deps.monitor
 * @param {object} deps.config
 * @param {boolean} deps.ignoreHours
 * @param {object} deps.paths - account.stateFilePaths result
 * @param {function} deps.saveSession
 */
function createCourseRunner(deps) {
  const {
    root: ROOT,
    log,
    monitor,
    config,
    ignoreHours: IGNORE_HOURS,
    paths: _paths,
    saveSession,
  } = deps;

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

  // Naviga sulla pagina del corso e restituisce la percentuale di completamento
  // riportata dalla piattaforma per una specifica lezione.
  async function getLessonProgressOnCoursePage(page, courseUrl, lessonHref) {
    try {
      await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      // 8s: la piattaforma può impiegare diversi secondi a persistere il 100% dopo
      // la fine del video (visto: 97% subito dopo fine video, 100% ~10s dopo). Con
      // 3s capitava spesso il "Tentativo 1" inutile; PROGRESS_PERSIST_MS dà margine.
      await page.waitForTimeout(PROGRESS_PERSIST_MS);
      // Su sessione fragile il goto rimbalza su /login: NON tornare null silenzioso
      // (sennà runCourse crede "lezione non completata" e dopo 3 tentativi marca
      // need_help un corso legittimamente completato). Segnala il drop di sessione:
      // runAutoplay esce con session_unstable + cooldown invece di insistere.
      if (await isLoginPage(page)) {
        throw new SessionError('Sessione caduta verificando il progresso della lezione (redirect a /login dopo goto corso).');
      }
      const lessonSel = lessonLinkSelector();
      const rows = await page.evaluate((sel) => {
        const all = [...document.querySelectorAll(sel)];
        return all.map(a => {
          const block = (a.closest('tr, .row, li, .card, .card-body') || a.parentElement);
          const txt = (block?.innerText || '').replace(/\s+/g, ' ').trim();
          const m = txt.match(/(\d+[.,]\d+)\s*%/);
          return { href: a.href, pct: m ? parseFloat(m[1].replace(',', '.')) : null };
        });
      }, lessonSel);
      const found = rows.find(r => r.href === lessonHref);
      return found ? found.pct : null;
    } catch (e) {
      if (e instanceof SessionError) throw e; // propaga il drop, non inghiottirlo
      return null;
    }
  }

  async function runCourse(page, courseUrl, sessionState, state, shiftCheck) {
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
      // Check fine turno anche qui, in cima a ogni iterazione del corso: senza
      // questo, il while sulle lezioni poteva girare a lungo (un video lungo) e
      // oltrepassare la fine turno. Con shiftCheck condiviso, la tolleranza di
      // extra-time è la stessa del loop esterno e di watchVideo.
      if (shiftCheck && !IGNORE_HOURS) {
        const s = shiftCheck.evaluate();
        if (s.extraTimeArmed) log(`Turno appena terminato. Extra-time fino alle ${s.extraTimeUntil ? new Date(s.extraTimeUntil).toISOString() : 'N/A'} per completare il contenuto in corso (corso ${courseUrl}).`);
        if (s.stop) {
          log(`Fuori orario durante il corso ${courseUrl}. Fermo graceful: lo scheduler riprenderà al prossimo turno.`);
          throw new OffHoursExit('Fine turno durante il corso');
        }
      }
      monitor.update({ phase: 'checking', courseUrl });

      try {
        // Se siamo già sulla dashboard (es. subito dopo discoverCourses), NON
        // ricaricarla: ogni goto in più stressa la sessione quando è fragile e
        // la piattaforma può rimbalzarci su /login. Ricarichiamo solo se serve.
        if (!isOnDashboardUrl(page.url())) {
          log('Ritorno dashboard per accesso al corso...');
          await page.goto(dashboardUrl(config), { waitUntil: 'domcontentloaded', timeout: 60000 });
        }
        for (let w = 0; w < 30; w++) {
          if (await isDashboardLoaded(page)) break;
          if (await isLoginPage(page)) break;
          await page.waitForTimeout(DASHBOARD_POLL_MS);
        }
        await page.waitForTimeout(DASHBOARD_POLL_MS * 4);

        const targetId = courseUrl.split('/show/')[1];
        log(`Searching for course ID ${targetId} in dashboard...`);

        // Cliccare il link "Apri" del corso nella dashboard è il percorso "naturale"
        // che la piattaforma riconosce: preserva la sessione molto meglio di una
        // goto diretta a /corso/show/X (che su sessione fragile rimbalza su /login).
        // Aspettiamo che il link sia nel DOM (la dashboard può renderizzare le card
        // in lazy) e preferiamo sempre il click alla goto diretta.
        const linkSel = courseLinkSelector(targetId);
        let courseLink = null;
        for (let w = 0; w < 20; w++) {
          if (await page.locator(linkSel).count().catch(() => 0) > 0) {
            courseLink = page.locator(linkSel).first();
            break;
          }
          if (await isLoginPage(page)) break;
          await page.waitForTimeout(DASHBOARD_POLL_MS);
        }

        if (courseLink && (await courseLink.isVisible().catch(() => false))) {
          log(`Link corso trovato tramite href per ID ${targetId}. Clicco per entrare...`);
          try {
            await courseLink.click({ timeout: 10000 });
          } catch (clickErr) {
            log(`Click corso non andato a buon fine (${clickErr.message}); provo click JS forzato.`);
            await page.evaluate((sel) => { const a = document.querySelector(sel); if (a) a.click(); }, linkSel).catch(() => {});
          }
          await page.waitForTimeout(COURSE_SETTLE_MS);
        } else if (courseLink) {
          // Link presente nel DOM ma non "visibile" (card collassata/off-screen/animazione):
          // click via JS invece di arrenderci e fare la goto diretta (che fa cadere la sessione).
          log(`Link corso per ID ${targetId} presente ma non visibile. Click JS forzato...`);
          await page.evaluate((sel) => { const a = document.querySelector(sel); if (a) a.click(); }, linkSel).catch(() => {});
          await page.waitForTimeout(COURSE_SETTLE_MS);
        } else {
          log(`Link corso per ID ${targetId} NON trovato in dashboard. Provo navigazione diretta...`);
          await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(COURSE_SETTLE_MS);
        }
      } catch (e) {
        log(`Errore durante l'accesso al corso ${courseUrl}: ${e.message}`);
        await monitor.recordError(page, e, 'accessCourse');
        await page.waitForTimeout(COURSE_SETTLE_MS);
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
        try {
          appendMetric(ROOT, {
            event: 'session',
            phase: 'checking',
            errorClass: 'missing_permission',
            missingPermission: 1,
            courseUrl,
          });
        } catch (_) {}
        if (missingPermissionCount >= MAX_MISSING_PERMISSION) {
          log(`Corso ${courseUrl} non accessibile: troppi MISSING_PERMISSION. Salto al prossimo corso.`);
          courseState.markCourseNeedHelp(ROOT, state, courseUrl, 'missing_permission');
          monitor.update({
            phase: 'need_help',
            courseUrl,
            lastError: 'missing_permission',
            courseStateSummary: courseState.summarize(state),
          });
          return;
        }
        try {
          await page.goto(config.autologinUrl, { waitUntil: 'load', timeout: 60000 });
          let attempts = 0;
          while (page.url().includes('autologin') && attempts < 20) {
            await page.waitForTimeout(DASHBOARD_POLL_MS * 2);
            attempts++;
          }
          await page.waitForTimeout(COURSE_SETTLE_MS);
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
        await page.waitForTimeout(DASHBOARD_POLL_MS * 4);
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
              await page.waitForTimeout(DASHBOARD_POLL_MS * 2);
              attempts++;
            }
            await page.waitForTimeout(COURSE_SETTLE_MS);
          } catch (e) {
            log(`Errore re-login: ${e.message}`);
          }
          continue;
        }

        log('Verifico quiz finale...');
        try {
          // Rilevazione robusta: oltre al link diretto /questionario/, guardiamo
          // anche il bottone "Avvia compilazione" e la sezione "Questionari finali".
          // Serve a non marcare done un corso che HA un questionario pendente ma il
          // cui link non è un <a href="/questionario/"> (falso-done storico).
          const quizInfo = await page.evaluate(() => {
            const a = document.querySelector('a[href*="/questionario/"]');
            const btns = [...document.querySelectorAll('a, button')];
            const avvia = btns.find(b => /avvia compilazione/i.test(b.innerText || ''));
            const avviaHref = avvia && avvia.tagName === 'A' ? avvia.href : null;
            const body = document.body ? document.body.innerText : '';
            return {
              quizHref: a ? a.href : (avviaHref || null),
              hasQuestionnaireSignal: !!a || !!avvia || /questionari finali/i.test(body),
            };
          });
          const quizLink = quizInfo.quizHref;
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
            await page.waitForTimeout(POST_SUBMIT_MS);
            const quizResult = await solveQuizWrapper(page, courseUrl);

            if (quizResult.passed) {
              log(`Quiz finale di ${courseUrl} superato.`);
              courseState.markCourseDone(ROOT, state, courseUrl, true);
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
          // C'è un segnale di questionario (sezione "Questionari finali" o bottone
          // "Avvia compilazione") ma non siamo riusciti a risolverne il link:
          // NON marchiamo done a torto (falso-done storico). Segnaliamo need_help
          // così la riconciliazione/AI lo recupera invece di perderlo.
          if (quizInfo.hasQuestionnaireSignal) {
            log(`Corso ${courseUrl}: rilevato un questionario finale ma non raggiungibile automaticamente. Segnalo need_help (non marco done).`);
            courseState.markCourseNeedHelp(ROOT, state, courseUrl, 'questionario finale presente ma link non risolvibile automaticamente');
            monitor.update({ phase: 'need_help', courseUrl, courseStateSummary: courseState.summarize(state) });
            return;
          }
        } catch (e) {
          log(`Errore quiz: ${e.message}`);
          await monitor.recordError(page, e, 'finalQuiz');
        }

        log(`Corso ${courseUrl} TERMINATO (nessun questionario finale).`);
        courseState.markCourseDone(ROOT, state, courseUrl, false);
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
        await page.waitForTimeout(POST_SUBMIT_MS);
      } catch (e) {
        log(`Errore apertura lezione via click: ${e.message}. Provo con goto diretto...`);
        try {
          await page.goto(nextHref, { waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
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

      // h1..h5 (non solo h4): stessa lista di quiz.js — un quiz con la domanda in
      // un heading diverso da h4 non veniva riconosciuto e la lezione era trattata
      // come contenuto generico.
      const isQuiz = await page.evaluate(() => !!document.querySelector('form h1, form h2, form h3, form h4, form h5')).catch(() => false);
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
        await watchVideo(page, log, monitor, shiftCheck);

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

      // Lezione senza <video>: PDF / testo / SCORM / bottone "completa".
      // Non loopare in silenzio: prova handler dedicati, poi skip o need_help.
      const nonVideo = await handleNonVideoLesson(page, nextHref, log);
      if (nonVideo === 'completed') {
        log(`Lezione non-video ${nextHref}: fruizione segnata (${nonVideo}).`);
        emptyUrls.clear();
        courseState.addCompletedLesson(ROOT, state, courseUrl, nextHref);
        continue;
      }
      if (nonVideo === 'pdf_ok') {
        log(`Lezione PDF ${nextHref}: link scarica presente; marco localmente e proseguo.`);
        emptyUrls.clear();
        courseState.addCompletedLesson(ROOT, state, courseUrl, nextHref);
        continue;
      }
      log(`Senza contenuto fruibile automaticamente (${nextHref}, kind=${nonVideo}).`);
      const attempts = (lessonAttempts.get(nextHref) || 0) + 1;
      lessonAttempts.set(nextHref, attempts);
      if (attempts >= 3) {
        log(`Lezione non-video ${nextHref} non gestibile dopo 3 tentativi. La salto.`);
        stuckUrls.add(nextHref);
      } else {
        emptyUrls.add(nextHref);
      }
      await page.waitForTimeout(COURSE_SETTLE_MS);
    }
  }

  /**
   * Handler lezioni senza video (C2). Ritorna:
   *  - 'completed' se ha cliccato un bottone di fruizione/completa
   *  - 'pdf_ok' se c'è solo PDF scaricabile
   *  - 'unknown' altrimenti
   */
  async function handleNonVideoLesson(page, lessonUrl, log) {
    try {
      const info = await page.evaluate(() => {
        const body = (document.body && document.body.innerText) || '';
        const anchors = [...document.querySelectorAll('a, button')];
        const completeBtn = anchors.find((el) =>
          /segna\s+come\s+(complet|fruit)|completa\s+lezione|ho\s+letto|conferma\s+fruizione|prosegui|continua/i.test(
            (el.innerText || el.value || '').trim()
          )
        );
        const pdf = anchors.find((el) => {
          const h = (el.href || '') + ' ' + (el.innerText || '');
          return /scarica\s+il\s+pdf|\.pdf(\?|$)|application\/pdf/i.test(h);
        });
        const hasVideo = !!document.querySelector('video');
        const hasQuizForm = !!document.querySelector('form#aggiungi_risposta, form h1, form h2, form h3, form h4');
        return {
          hasVideo,
          hasQuizForm,
          completeText: completeBtn ? (completeBtn.innerText || '').trim().slice(0, 80) : null,
          hasPdf: !!pdf,
          bodyHint: body.slice(0, 200),
        };
      });
      if (info.hasVideo || info.hasQuizForm) return 'unknown';
      if (info.completeText) {
        log(`Lezione non-video: clicco '${info.completeText}'...`);
        const clicked = await page.evaluate(() => {
          const anchors = [...document.querySelectorAll('a, button')];
          const btn = anchors.find((el) =>
            /segna\s+come\s+(complet|fruit)|completa\s+lezione|ho\s+letto|conferma\s+fruizione|prosegui|continua/i.test(
              (el.innerText || el.value || '').trim()
            )
          );
          if (!btn) return false;
          btn.click();
          return true;
        });
        if (clicked) {
          await page.waitForTimeout(POST_SUBMIT_MS);
          return 'completed';
        }
      }
      if (info.hasPdf) return 'pdf_ok';
      return 'unknown';
    } catch (e) {
      log(`handleNonVideoLesson: ${e.message}`);
      return 'unknown';
    }
  }


  return { runCourse, getLessonProgressOnCoursePage, solveQuizWrapper };
}

module.exports = { createCourseRunner, MAX_MISSING_PERMISSION, MAX_COURSE_ITER };
