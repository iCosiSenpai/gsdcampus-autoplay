/**
 * scripts/explore.js — strumento di MANUTENZIONE (non fa parte dell'automazione).
 *
 * Esplora uno o più account GSD Campus tramite link autologin e salva in
 * debug/exploration/<codice>/ la struttura reale di dashboard, lezioni e quiz.
 * Serve per: (a) confermare che gli ID corso variano per account, (b) validare i
 * selettori usati dall'engine, (c) raccogliere le domande dei quiz per la banca
 * risposte condivisa.
 *
 * Uso:
 *   node scripts/explore.js <autologin1> [autologin2] ...
 *   node scripts/explore.js --file links.txt        (un link per riga)
 *
 * NB: i link autologin sono dati personali. debug/ è in .gitignore: nessun output
 * di questo script va committato.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'debug', 'exploration');
const BASE = 'https://tecsial.gsdcampus.it';

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function parseArgs(argv) {
  const links = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') {
      const file = argv[++i];
      const lines = fs.readFileSync(file, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
      links.push(...lines);
    } else if (argv[i].startsWith('http')) {
      links.push(argv[i].trim());
    }
  }
  return links;
}

function codiceFromUrl(url) {
  const m = url.match(/\/autologin\/([^/]+)\//);
  return m ? m[1] : 'unknown_' + Math.random().toString(36).slice(2, 8);
}

async function dump(page, outDir, name) {
  try {
    fs.writeFileSync(path.join(outDir, name + '.html'), await page.content());
  } catch (e) { /* ignore */ }
}

async function exploreAccount(browser, autologinUrl, summary) {
  const codice = codiceFromUrl(autologinUrl);
  const outDir = path.join(OUT_ROOT, codice);
  ensureDir(outDir);
  const acct = { codice, autologinHost: BASE, courses: [], errors: [] };
  console.log(`\n=== Account ${codice} ===`);

  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  try {
    // 1. Login
    await page.goto(autologinUrl, { waitUntil: 'networkidle', timeout: 60000 });
    let attempts = 0;
    while (page.url().includes('autologin') && attempts < 20) {
      await page.waitForTimeout(1500); attempts++;
    }
    acct.urlAfterLogin = page.url();
    const loggedIn = !page.url().includes('autologin') && !/login/i.test(page.url());
    console.log(`  login → ${page.url()} (${loggedIn ? 'OK' : 'FALLITO'})`);
    if (!loggedIn) {
      acct.errors.push('login fallito: ' + page.url());
      await dump(page, outDir, 'login_failed');
      return acct;
    }

    // 2. Dashboard corsi
    await page.goto(`${BASE}/corso/listAllByUser`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    await dump(page, outDir, 'dashboard');

    // Raccoglie i link corso + contesto (titolo, % e classi del bottone) per validare i selettori.
    const courseData = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const anchors = [...document.querySelectorAll('a[href*="/corso/show/"]')];
      for (const a of anchors) {
        const id = (a.href.match(/\/corso\/show\/(\d+)/) || [])[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const block = (a.closest('tr, .row, li, .card, .card-body') || a.parentElement);
        out.push({
          id,
          href: a.href,
          anchorText: (a.innerText || '').trim().slice(0, 80),
          anchorClass: a.className,
          blockText: block ? (block.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160) : ''
        });
      }
      // anche tutti i bottoni "primary" visibili, per capire le classi reali
      const primaryBtns = [...document.querySelectorAll('a.btn-primary, button.btn-primary')]
        .slice(0, 10)
        .map(b => ({ tag: b.tagName, class: b.className, text: (b.innerText || '').trim().slice(0, 40), href: b.href || null }));
      return { courses: out, primaryBtns };
    });
    acct.courses = courseData.courses;
    acct.primaryButtonsOnDashboard = courseData.primaryBtns;
    console.log(`  corsi trovati: ${courseData.courses.length} → ID [${courseData.courses.map(c => c.id).join(', ')}]`);

    fs.writeFileSync(path.join(outDir, 'courses.json'), JSON.stringify(courseData, null, 2));

    // 3. Apri il primo corso e analizza la struttura lezioni
    if (courseData.courses.length > 0) {
      const first = courseData.courses[0];
      try {
        await page.goto(first.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);
        await dump(page, outDir, 'course_first');

        const lessonInfo = await page.evaluate(() => {
          // Tutti i link "azione" della pagina corso, con % nel blocco circostante
          const links = [...document.querySelectorAll('a.btn, a[href*="/lezione/show/"], a[href*="/questionario/"]')];
          const items = links.slice(0, 60).map(a => {
            const block = (a.closest('tr, .row, li, .card, .card-body') || a.parentElement);
            const txt = block ? (block.innerText || '').replace(/\s+/g, ' ').trim() : '';
            const pct = (txt.match(/(\d+[.,]\d+)\s*%/) || [])[1] || null;
            return {
              href: a.href,
              class: a.className,
              text: (a.innerText || '').trim().slice(0, 40),
              pct,
              kind: /\/lezione\/show\//.test(a.href) ? 'lezione' : (/\/questionario\//.test(a.href) ? 'questionario' : 'altro')
            };
          });
          return items;
        });
        acct.firstCourseId = first.id;
        acct.firstCourseLinks = lessonInfo;
        fs.writeFileSync(path.join(outDir, 'course_first_links.json'), JSON.stringify(lessonInfo, null, 2));
        console.log(`  primo corso ${first.id}: ${lessonInfo.length} link (lezioni/quiz)`);

        // 4. Apri una lezione video e ispeziona il player
        const lessonLink = lessonInfo.find(l => l.kind === 'lezione');
        if (lessonLink) {
          await page.goto(lessonLink.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(3000);
          await dump(page, outDir, 'lesson_sample');
          const videoInfo = await page.evaluate(() => {
            const v = document.querySelector('video');
            return {
              hasVideo: !!v,
              videoTag: v ? { class: v.className, src: v.currentSrc || v.src || null, duration: v.duration, hasControls: v.controls } : null,
              iframeCount: document.querySelectorAll('iframe').length,
              iframeSrcs: [...document.querySelectorAll('iframe')].map(f => f.src).slice(0, 5)
            };
          });
          acct.videoSample = videoInfo;
          console.log(`  lezione campione: video=${videoInfo.hasVideo} iframe=${videoInfo.iframeCount}`);
        }

        // 5. Apri un quiz e raccogli le domande
        const quizLink = lessonInfo.find(l => l.kind === 'questionario');
        if (quizLink) {
          await page.goto(quizLink.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(2500);
          await dump(page, outDir, 'quiz_dashboard');
          const quizMeta = await page.evaluate(() => {
            const startBtn = [...document.querySelectorAll('a.btn-primary, button.btn-primary')]
              .find(b => /avvia compilazione/i.test(b.innerText || ''));
            return {
              startBtnFound: !!startBtn,
              startHref: startBtn ? startBtn.href || null : null,
              optionClassSample: [...document.querySelectorAll('.opzione-risposta')].length
            };
          });
          acct.quizMeta = quizMeta;
          console.log(`  quiz: avvia-compilazione=${quizMeta.startBtnFound}`);
        }
      } catch (e) {
        acct.errors.push('analisi corso: ' + e.message);
        console.log(`  ! errore analisi corso: ${e.message}`);
      }
    }
  } catch (e) {
    acct.errors.push('fatale: ' + e.message);
    console.log(`  ! errore: ${e.message}`);
    await dump(page, outDir, 'error');
  } finally {
    await ctx.close().catch(() => {});
    fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(acct, null, 2));
  }
  summary.accounts.push(acct);
  return acct;
}

(async () => {
  const links = parseArgs(process.argv.slice(2));
  if (links.length === 0) {
    console.error('Nessun link autologin fornito.\nUso: node scripts/explore.js <url1> [url2] ...  oppure  --file links.txt');
    process.exit(1);
  }
  ensureDir(OUT_ROOT);
  const summary = { startedAt: new Date().toISOString(), accounts: [] };

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  for (const link of links) {
    await exploreAccount(browser, link, summary).catch(e => console.log('account error', e.message));
  }

  await browser.close().catch(() => {});

  // Report comparativo
  fs.writeFileSync(path.join(OUT_ROOT, '_summary.json'), JSON.stringify(summary, null, 2));
  console.log('\n========== RIEPILOGO ==========');
  const allCourseIds = new Set();
  for (const a of summary.accounts) {
    const ids = a.courses.map(c => c.id);
    ids.forEach(id => allCourseIds.add(id));
    console.log(`${a.codice}: ${a.courses.length} corsi [${ids.join(', ')}]${a.errors.length ? ' ERRORI: ' + a.errors.join('; ') : ''}`);
  }
  console.log(`\nID corso distinti tra tutti gli account: ${allCourseIds.size} → [${[...allCourseIds].join(', ')}]`);
  console.log(`Output completo in: ${OUT_ROOT}`);
})();
