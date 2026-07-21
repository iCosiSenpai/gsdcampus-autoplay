const fs = require('fs');
const path = require('path');

const { launchBrowser } = require('./lib/browser');
const { createLogger, redactUrl } = require('./lib/logger');
const { Monitor } = require('./lib/monitor');
const { describeSchedule } = require('./lib/schedule');
const { makeShiftChecker } = require('./lib/shift-watch');
const courseState = require('./lib/course-state');
const { writeDashboard } = require('./lib/dashboard');
const { writeAiTodo } = require('./lib/ai-todo');
const {
  handlePostLoginInterstitial,
  acceptInformativa,
} = require('./lib/login-flow');
const { collectCoursesFromDom, enrichCourseRows } = require('./lib/dashboard-parse');
const { createCourseRunner } = require('./lib/course-runner');
const { maybeAdvanceOnAllDone } = require('./lib/member-queue');

// Finalizza lo stato su disco a fine run: dashboard aggregata + inbox unico
// dell'AI (logs/ai_todo.json). Non lancia mai.
function finalizeState() {
  try { writeDashboard(ROOT); } catch (_) {}
  try { writeAiTodo(ROOT); } catch (_) {}
}
const { writeJsonAtomic } = require('./lib/io');
const { OffHoursExit, AutologinError, SessionError, AllCoursesNeedHelpExit, DashboardEmptyError, NeedHelpExit } = require('./lib/errors');
const {
  dashboardUrl,
  userAgent,
  DASHBOARD_POLL_MS,
  INTERSTITIAL_CLICK_MS,
  POST_SUBMIT_MS,
} = require('./lib/platform');

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
const MAX_LOGIN_DROPS = 4;

// La riconciliazione live puo scoprire assessment pendenti su corsi marcati
// done da una versione precedente. Per 24h usiamo quel report come override
// locale, cosi il runner nuovo li riprocessa senza richiedere un reset manuale.
function recentlyReconciledPendingCourses() {
  try {
    const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'pending_questionnaires.json'), 'utf8'));
    const checked = new Date(report.checkedAt || 0).getTime();
    if (!Number.isFinite(checked) || Date.now() - checked > 24 * 60 * 60 * 1000) return new Set();
    return new Set((report.coursesWithPendingQuiz || [])
      .filter(c => c && c.localDone && c.resetApplied !== true && c.course)
      .map(c => String(c.course)));
  } catch (_) { return new Set(); }
}

// Predicati di riconoscimento pagina (login vs dashboard) centralizzati in
// src/lib/page-detect.js, condivisi con l'health-check per evitare derive.
const { isLoginPage, isDashboardLoaded } = require('./lib/page-detect');

// Handler interstitial/informativa/dichiarazione: src/lib/login-flow.js

function saveSession(state) {
  try {
    // Scrittura atomica (tmp + rename): session_state.json non deve mai restare
    // troncato a metà (lo legge il cleanup, ma un file corrotto confondere).
    writeJsonAtomic(SESSION_FILE, { ...state, savedAt: new Date().toISOString() });
  } catch (e) {
    log('Errore salvataggio sessione:', e.message);
  }
}


// Runner del singolo corso (lezioni + quiz). Dipendenze iniettate.
const courseRunner = createCourseRunner({
  root: ROOT,
  log,
  monitor,
  config,
  ignoreHours: IGNORE_HOURS,
  paths: _paths,
  saveSession,
});
const { runCourse } = courseRunner;

// loadSession rimosso: era codice morto (mai chiamato). Lo stato di sessione
// vero è in-memory; SESSION_FILE è solo un artefatto di cleanup.

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
  let fatalShuttingDown = false;
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
    // Re-entrancy guard: uncaughtException e unhandledRejection possono scatenarsi
    // a raffica (es. un errore in cleanup genera un'altra eccezione). Senza guard,
    // fatalShutdown si re-invocherebbe più volte lanciando browser.close() su
    // browser già chiuso e process.exit() più volte. shuttingDown copre solo il
    // path graceful; qui serve un flag separato perché fatal deve comunque
    // eseguire anche se graceful era partito.
    if (fatalShuttingDown) return;
    fatalShuttingDown = true;
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

  // Checker di fine turno condiviso tra il loop esterno, runCourse e watchVideo:
  // così il check dell'orario avviene anche IN MEZZO a un video/lezione lunghi,
  // non solo in cima al loop esterno (raggiunto solo a corsi finiti). Senza questo,
  // l'autoplay attraversava la fine turno senza fermarsi (v. src/lib/shift-watch.js).
  const shiftCheck = makeShiftChecker();

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

      const launched = await launchBrowser({ headless: true, log, config });
      browser = launched.browser;
      log(`Browser backend: ${launched.backend}`);

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
            await page.waitForTimeout(DASHBOARD_POLL_MS * 2);
            attempts++;
          }
          // Pausa per stabilizzare la sessione dopo l'autologin
          await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
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
            await page.waitForTimeout(DASHBOARD_POLL_MS);
          }
          await page.waitForTimeout(DASHBOARD_POLL_MS * 4);

          // Test di salute: verifica che la dashboard contenga corsi.
          const dashboardLinks = await page.evaluate(() =>
            [...document.querySelectorAll('a[href*="/corso/show/"]')].map(a => a.href)
          ).catch(() => []);
          log(`Link corsi rilevati in dashboard: ${dashboardLinks.length}`);

          if (await isLoginPage(page)) {
            log(`Login non riuscito al tentativo ${la} (la piattaforma mostra la pagina di login).`);
            await page.waitForTimeout(POST_SUBMIT_MS);
            continue;
          }
          if (!(await isDashboardLoaded(page))) {
            log(`Attenzione: la dashboard non sembra caricata al tentativo ${la}. Riprovo.`);
            await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
            continue;
          }
          loggedIn = true;
          tokenProvenValid = true; // il link autologin FUNZIONA in questo run
          log(`URL finale dopo login: ${redactUrl(page.url())}`);
        } catch (e) {
          log(`Errore durante l'autologin (tentativo ${la}): ${e.message}`);
          await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
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

      // NOTA: non salviamo più ctx.storageState() su file. Il contesto browser
      // è sempre creato pulito (v. ctxOptions sopra) e NESSUNO rileggeva il file:
      // era solo I/O sprecato + una copia dei cookie di sessione su disco.
      // Gli unlink di STATE_FILE restano per ripulire i file legacy.

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
              await page.waitForTimeout(DASHBOARD_POLL_MS);
            }
            await page.waitForTimeout(DASHBOARD_POLL_MS * 4);
            // Card + progress-bar style width (stesso parser del census).
            const rawCards = await page.evaluate(collectCoursesFromDom);
            const discovered = enrichCourseRows(rawCards);
            const links = discovered.map(c => c.url);
            const reconciledPending = recentlyReconciledPendingCourses();
            const fresh = links.filter(url => !courseState.isCourseDoneOrNeedHelp(state, url) || reconciledPending.has(url));
            if (fresh.length === 0 && links.length > 0) {
              log('Tutti i corsi scoperti risultano completati o bloccati.');
            }
            if (fresh.length > 0) {
              const pctHint = discovered
                .filter(c => fresh.includes(c.url))
                .map(c => `#${c.courseId}${c.pct != null ? ' ' + c.pct + '%' : ''}`)
                .join(', ');
              log(`Trovati ${fresh.length} corsi attivi su ${links.length} totali${pctHint ? ` (${pctHint})` : ''}.`);
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
      while (true) {
        if (!IGNORE_HOURS) {
          // Check fine turno condiviso (v. shift-watch.js): il checker è lo stesso
          // usato da runCourse e watchVideo, così ci si ferma anche a metà di un
          // video lungo, non solo a corsi finiti. extraTimeArmed è true una sola
          // volta (sul reale passaggio in→out): lo logghiamo qui; gli inner loop
          // lo loggheranno a loro volta con il loro contesto.
          const s = shiftCheck.evaluate();
          if (s.extraTimeArmed) {
            log(`Turno appena terminato. Extra-time attivo fino alle ${s.extraTimeUntil ? new Date(s.extraTimeUntil).toISOString() : 'N/A'} per completare il contenuto in corso.`);
          }
          if (s.stop) {
            log(`Fuori orario lavorativo. Stop programmato: ${s.end ? s.end.toISOString() : 'N/A'}, prossimo avvio: ${s.start ? s.start.toISOString() : 'N/A'}`);
            monitor.update({ phase: 'off_hours', nextStart: s.start ? s.start.toISOString() : null, nextEnd: s.end ? s.end.toISOString() : null, running: false });
            throw new OffHoursExit('Fine turno lavorativo');
          }
        }

        let worked = false;
        for (const courseUrl of courseUrls) {
          log(`Controllo corso: ${courseUrl}`);
          // Con --ignore-hours non passare shiftCheck: altrimenti watchVideo
          // ferma il video a fine turno (extra-time) anche in ignore-hours.
          await runCourse(page, courseUrl, sessionState, state, IGNORE_HOURS ? null : shiftCheck);
          worked = true;
        }

        // Riscopri corsi: potrebbero esserne stati aggiunti di nuovi, o lo stato potrebbe cambiare.
        courseUrls = await discoverCourses();
        monitor.update({ courseStateSummary: courseState.summarize(state) });
        finalizeState();
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
        finalizeState();
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
        finalizeState();
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
          finalizeState();
          process.exit(4); // exit 4 = session_unstable: lo scheduler fa cooldown lungo
        }
        log('AUTOLOGIN NON VALIDO:', e.message);
        monitor.update({ running: false, phase: 'autologin_invalid', lastError: e.message });
        if (browser) { try { await browser.close(); } catch (_) {} }
        process.exit(3);
      }
      if (e instanceof AllCoursesNeedHelpExit || e.code === 'ALL_NEED_HELP') {
        log('TUTTI I CORSI COMPLETATI O IN ATTESA DI AIUTO:', e.message);
        const summary = courseState.summarize(state);
        let todo = null;
        try { todo = writeAiTodo(ROOT); } catch (_) {}
        const terminalPhase = summary.needHelp > 0
          ? (todo && todo.openQuizRequests > 0 ? 'awaiting_ai' : 'need_help')
          : 'complete';
        monitor.update({
          running: false,
          phase: terminalPhase,
          courseUrl: null,
          lessonUrl: null,
          lastQuizResult: null,
          lastError: e.message,
          courseStateSummary: summary,
        });
        // Coda multi-CF: se config.memberQueue ha ≥2 entry, avanza al prossimo.
        try {
          const adv = maybeAdvanceOnAllDone(ROOT, config, true, log);
          if (adv && adv.ok) {
            monitor.update({ phase: 'member_queue_advanced', lastError: `next=${adv.to}` });
            try {
              const { notifyMac } = require('./lib/notify-mac');
              notifyMac(
                ROOT,
                'GSD Campus',
                `Coda: passo a ${adv.name || adv.to}.`,
                'course_done',
                {}
              );
            } catch (_) {}
          }
        } catch (advErr) {
          log(`member-queue: ${advErr.message}`);
        }
        if (browser) { try { await browser.close(); } catch (_) {} }
        finalizeState();
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
        finalizeState();
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
          finalizeState();
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
