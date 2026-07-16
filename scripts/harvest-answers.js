#!/usr/bin/env node
/**
 * harvest-answers.js — raccoglie le DOMANDE (con le 4 opzioni) dei questionari
 * finali dei corsi, così l'AI supervisore può risolverle PRIMA che l'autoplay
 * arrivi al quiz. Le risposte verificate finiranno poi nel glossario.
 *
 * ── SICUREZZA (la piattaforma consuma un tentativo SOLO alla finalizzazione) ──
 * L'harvester sfoglia il questionario ma NON lo finalizza MAI:
 *   • clicca SOLO "Avvia compilazione" e "Avanti" (e "Esci" per uscire);
 *   • si FERMA appena vede il "Riepilogo" (il punto in cui "Conferma" invierebbe);
 *   • NON clicca MAI Conferma/Finalizza/Invia/Termina/Concludi né seleziona
 *     alcuna opzione di risposta.
 * Nessun tentativo viene consumato.
 *
 * Uso:
 *   node scripts/harvest-answers.js --dry-run            # 1 corso, apre e cattura
 *                                                        # SOLO la prima schermata
 *   node scripts/harvest-answers.js --course <url>       # un corso specifico
 *   node scripts/harvest-answers.js                      # tutti i corsi (attivo)
 *   node scripts/harvest-answers.js --cf <CF>            # account da members.db
 *   node scripts/harvest-answers.js --to-ai-request      # scrive anche in
 *                                                        # ai_quiz_request (attivo)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { redactUrl } = require('../src/lib/logger');
const { isLoginPage, isDashboardLoaded } = require('../src/lib/page-detect');
const { dashboardUrl, userAgent } = require('../src/lib/platform');
const { saveAiQuizRequest } = require('../src/lib/quiz');
const db = require('../src/lib/db');

const ROOT = path.resolve(__dirname, '..');
const MAX_STEPS = 60;   // tetto di sicurezza sul numero di domande sfogliate

// Testi dei bottoni che FINALIZZANO il quiz: non vanno MAI cliccati.
const FORBIDDEN_RE = /conferma|finalizz|invia|termina|concludi|salva e invia/i;

function log(...a) { console.log(`[harvest] ${a.join(' ')}`); }

function parseArgs(argv) {
  const args = argv.slice(2);
  const o = { cf: null, dryRun: false, course: null, toAiRequest: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cf') o.cf = args[++i];
    else if (args[i] === '--dry-run') o.dryRun = true;
    else if (args[i] === '--course') o.course = args[++i];
    else if (args[i] === '--to-ai-request') o.toAiRequest = true;
  }
  return o;
}

function resolveAccount(cf) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')); } catch (_) {}
  if (cf) {
    const m = db.getMember(ROOT, cf);
    if (!m || !m.autologin_url) throw new Error(`Membro ${cf} non trovato o senza autologin in members.db`);
    return { ...config, autologinUrl: m.autologin_url, codice_fiscale: cf, memberName: `${m.nome} ${m.cognome}` };
  }
  if (!config.autologinUrl) throw new Error('config.json senza autologinUrl e nessun --cf');
  return config;
}

async function login(page, ctx, config, timeoutMs) {
  for (let a = 1; a <= 3; a++) {
    try {
      await ctx.clearCookies({ domain: 'tecsial.gsdcampus.it' }).catch(() => {});
      await page.goto(config.autologinUrl, { waitUntil: 'load', timeout: timeoutMs });
      let g = 0;
      while (page.url().includes('autologin') && g < 20) { await page.waitForTimeout(1000); g++; }
      await page.waitForTimeout(3000);
      await page.goto(dashboardUrl(config), { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      for (let w = 0; w < 30; w++) {
        if (await isDashboardLoaded(page)) break;
        if (await isLoginPage(page)) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1500);
      if (await isDashboardLoaded(page) && !(await isLoginPage(page))) return true;
      if (a < 3) await page.waitForTimeout(3000);
    } catch (e) { if (a < 3) await page.waitForTimeout(2000); }
  }
  return false;
}

// Elenca i testi dei bottoni/link visibili — per diagnosi e per decidere in modo
// sicuro cosa cliccare (allowlist), senza indovinare selettori a scatola chiusa.
async function visibleButtons(page) {
  return await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a.btn, a.btn-primary, input[type="submit"]')];
    return els
      .filter(e => e.offsetParent !== null)
      .map(e => (e.innerText || e.value || '').trim())
      .filter(Boolean);
  });
}

// Estrae la domanda corrente (una per schermata) + le 4 opzioni.
// Il formato reale: h1 = titolo corso, h2 = "N. testo domanda", opzioni in card
// `.opzione-risposta` (che sono ANCHE `.card`, per questo non uso il container
// generico di quiz.js che le confonde). Ritorna {question, options} o null.
async function extractCurrentQuestion(page) {
  return await page.evaluate(() => {
    const options = [...document.querySelectorAll('.opzione-risposta')].map(c => {
      const l = c.querySelector('label');
      const p = c.querySelector('p');
      return (l ? l.innerText : (p ? p.innerText : c.innerText)).trim();
    }).filter(Boolean);
    if (options.length === 0) return null;
    const heads = [...document.querySelectorAll('form h1, form h2, form h3, form h4, form h5, h2, h3')]
      .map(h => h.innerText.trim()).filter(Boolean);
    // Preferisci l'heading numerato ("1. ...", "12) ..."); fallback all'ultimo.
    let q = heads.find(h => /^\d+\s*[.)]/.test(h)) || heads[heads.length - 1] || '';
    // La piattaforma RANDOMIZZA l'ordine delle domande: il numero iniziale
    // cambia a ogni sessione, quindi va rimosso dalla chiave (altrimenti la
    // stessa domanda con numero diverso non matcha nel glossario).
    q = q.replace(/^\s*\d+\s*[.)]\s*/, '').trim();
    return q && q.length > 3 ? { question: q, options } : null;
  });
}

// Rileva la pagina di Riepilogo (il punto in cui "Conferma" finalizzerebbe).
async function isRiepilogo(page) {
  return await page.evaluate(() => /riepilogo/i.test(document.body ? document.body.innerText : '')).catch(() => false);
}

// Clicca in modo SICURO un bottone il cui testo visibile combacia con `re`,
// MAI se il testo è nella blocklist dei finalizzatori. Ritorna true se cliccato.
async function safeClickByText(page, re) {
  const btns = await page.$$('button, a.btn, a.btn-primary, input[type="submit"]');
  for (const b of btns) {
    const txt = ((await b.innerText().catch(() => '')) || (await b.getAttribute('value').catch(() => '')) || '').trim();
    if (!txt) continue;
    if (FORBIDDEN_RE.test(txt)) continue;            // guardia assoluta
    if (re.test(txt)) {
      if (!(await b.isVisible().catch(() => false))) continue;
      await b.click().catch(() => {});
      return true;
    }
  }
  return false;
}

// Sfoglia UN questionario e cattura domande+opzioni. NON finalizza mai.
async function harvestQuestionnaire(page, outDir, quizUrl, dryRun) {
  const captured = [];
  const seen = new Set();

  await page.goto(quizUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  // Numero di tentativi mostrato accanto ad "Avvia compilazione": SOLO log, non
  // consumiamo nulla, ma è bene che resti tracciato.
  const startInfo = await page.evaluate(() => document.body ? document.body.innerText.slice(0, 4000) : '');
  const attemptsMatch = startInfo.match(/tentativ\w*[^\d]{0,20}(\d+)/i);
  if (attemptsMatch) log(`  tentativi indicati sulla pagina: ${attemptsMatch[1]} (non ne consumo nessuno)`);

  // Se il questionario è già SUPERATO non ha "Avvia compilazione": niente da
  // raccogliere (le domande non sono più mostrabili senza riaprirlo, ed è già
  // fatto). Lo saltiamo senza toccarlo.
  const alreadyPassed = /superato/i.test(startInfo) && !/avvia compilazione/i.test(startInfo);
  if (alreadyPassed) {
    log(`  questionario già superato: salto (${redactUrl(quizUrl)}).`);
    return { started: false, captured };
  }

  // Avvia compilazione (non consuma tentativi finché non si finalizza).
  const started = await safeClickByText(page, /avvia compilazione/i);
  if (!started) {
    log(`  nessun bottone "Avvia compilazione" qui (${redactUrl(quizUrl)}). Salto.`);
    return { started: false, captured };
  }
  await page.waitForTimeout(2000);

  for (let step = 1; step <= MAX_STEPS; step++) {
    // STOP assoluto: se siamo al Riepilogo, non tocchiamo nulla ed usciamo.
    if (await isRiepilogo(page)) { log(`  Riepilogo raggiunto allo step ${step}: mi fermo (non finalizzo).`); break; }

    const q = await extractCurrentQuestion(page);
    if (q && q.question && !seen.has(q.question)) { seen.add(q.question); captured.push(q); }
    const btns = await visibleButtons(page);
    log(`  step ${step}: ${q ? '“' + q.question.slice(0, 55) + '…” (' + q.options.length + ' opz.)' : 'nessuna domanda'}, bottoni: [${btns.join(' | ')}]`);
    if (outDir) {
      try { fs.writeFileSync(path.join(outDir, `step_${String(step).padStart(2, '0')}.html`), await page.content()); } catch (_) {}
    }

    if (dryRun) { log('  --dry-run: catturata la prima schermata, non proseguo.'); break; }

    // Avanza SOLO con "Avanti" (mai Conferma/submit di finalizzazione).
    const advanced = await safeClickByText(page, /^avanti$/i);
    if (!advanced) { log(`  nessun "Avanti" allo step ${step}: fine del questionario o solo Conferma → esco.`); break; }
    await page.waitForTimeout(1200);
  }

  // Uscita sicura: se c'è un bottone "Esci" lo usiamo, altrimenti navighiamo via
  // (uscire senza finalizzare NON consuma tentativi).
  await safeClickByText(page, /^esci/i).catch(() => {});
  return { started: true, captured };
}

async function main() {
  const opt = parseArgs(process.argv);
  const config = resolveAccount(opt.cf);
  const who = config.codice_fiscale || 'attivo';
  const outDir = path.join(ROOT, 'debug', 'harvest', who);
  fs.mkdirSync(outDir, { recursive: true });
  log(`account: ${config.memberName || who}${opt.dryRun ? ' · DRY-RUN' : ''}`);

  const browser = await chromium.launch({
    channel: 'chrome', headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const allQuestions = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, userAgent: userAgent(config) });
    const page = await ctx.newPage();
    if (!(await login(page, ctx, config, 60000))) {
      log('LOGIN FALLITO: il link autologin non è valido adesso. Interrompo (nessun tentativo toccato).');
      await browser.close();
      process.exit(2);
    }
    log('login ok, dashboard raggiunta.');

    // Corsi da visitare.
    let courseUrls;
    if (opt.course) {
      courseUrls = [opt.course];
    } else {
      courseUrls = await page.evaluate(() => {
        const s = new Set();
        document.querySelectorAll('a[href*="/corso/show/"]').forEach(a => s.add(a.href));
        return [...s];
      });
      if (opt.dryRun) courseUrls = courseUrls.slice(0, 1);
    }
    log(`corsi da esaminare: ${courseUrls.length}`);

    const seenQuiz = new Set();
    for (const courseUrl of courseUrls) {
      try {
        await page.goto(courseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1500);
        // Link ai questionari finali del corso.
        const quizUrls = await page.evaluate(() => {
          const s = new Set();
          document.querySelectorAll('a[href*="/questionario/"]').forEach(a => s.add(a.href));
          return [...s];
        });
        log(`corso ${redactUrl(courseUrl)}: ${quizUrls.length} questionario/i`);
        let startedOne = false;
        for (const quizUrl of quizUrls) {
          if (seenQuiz.has(quizUrl)) continue;
          seenQuiz.add(quizUrl);
          const { started, captured } = await harvestQuestionnaire(page, outDir, quizUrl, opt.dryRun);
          captured.forEach(q => allQuestions.push({ ...q, courseUrl: redactUrl(courseUrl) }));
          if (started) startedOne = true;
          // In dry-run ci fermiamo dopo il PRIMO questionario effettivamente
          // avviato (non su quelli già superati/senza bottone, che scorriamo).
          if (opt.dryRun && startedOne) break;
        }
      } catch (e) {
        log(`errore su corso ${redactUrl(courseUrl)}: ${e.message}`);
      }
      if (opt.dryRun && allQuestions.length) break;
    }

    // Salvataggio: file di revisione (sempre) + opzionale ai_quiz_request.
    const reviewFile = path.join(ROOT, 'data', 'harvested_questions.json');
    let existing = { questions: [] };
    try { existing = JSON.parse(fs.readFileSync(reviewFile, 'utf8')); } catch (_) {}
    const byQ = new Map((existing.questions || []).map(q => [q.question, q]));
    allQuestions.forEach(q => byQ.set(q.question, q));
    fs.writeFileSync(reviewFile, JSON.stringify({ account: who, savedAt: new Date().toISOString(), questions: [...byQ.values()] }, null, 2));
    log(`catturate ${allQuestions.length} domande → ${reviewFile} (file di revisione).`);

    if (opt.toAiRequest && !opt.cf && allQuestions.length) {
      // Solo per l'account ATTIVO (saveAiQuizRequest scrive nella sua cartella).
      const n = saveAiQuizRequest(ROOT, allQuestions.map(q => ({ question: q.question, options: q.options })), 'harvest_questionari_finali', {});
      log(`inoltrate all'AI: ai_quiz_request ora contiene ${n} domande da risolvere.`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(`[harvest] errore fatale: ${e.message}`); process.exit(1); });
