const fs = require('fs');
const path = require('path');
const account = require('./account');
const { writeJsonAtomic, readJsonSafe, readJsonCached } = require('./io');
const { NeedHelpExit } = require('./errors');
const { normKey, findKnownAnswer, similarity } = require('./quiz-match');
const { redactSensitiveText } = require('./logger');
const {
  POST_SUBMIT_MS,
  POST_CONFIRM_MS,
  INTERSTITIAL_CLICK_MS,
  QUIZ_STEP_MS,
  QUIZ_QUESTION_MS,
} = require('./platform');
const { SELECTORS } = require('./selectors');
const { mergeIntoKnown, ensureKnownBankSeeded } = require('./quiz-bank');
const { extractScore, scoreLooksPassing, detectOutcomeFromText } = require('./quiz-outcome');
const {
  mergeQuestionList,
  saveNeedAnswer,
  saveAiQuizRequest,
  clearResolvedFromHandoff,
} = require('./quiz-handoff');

// Tetto di sicurezza sul numero di domande per quiz: evita loop infiniti se la
// piattaforma renderizza una nuova domanda a ogni iterazione senza mai finire.
// 200 è abbondante per i quiz del corso (tipicamente <50); superato emette warning.
const MAX_QUIZ_QUESTIONS = 200;

// Locator delle opzioni risposta, scoped al form della domanda corrente.
// Se il form id non è presente (layout anomalo), ricade sul selettore globale.
// Scope: evita di cliccare l'opzione di un'altra domanda se la pagina ne
// renderizza più di una contemporaneamente.
async function optionsLocator(page) {
  const formSel = SELECTORS.quiz.form;
  const optSel = SELECTORS.quiz.option;
  const scoped = page.locator(`${formSel} ${optSel}`);
  const n = await scoped.count().catch(() => 0);
  if (n > 0) return scoped;
  return page.locator(optSel);
}

// Estrae tutte le domande e opzioni dalla pagina di quiz attiva.
async function extractQuestionsFromPage(page) {
  try {
    return await page.evaluate(() => {
      // Una domanda per schermata (form#aggiungi_risposta): heading numerato +
      // card .opzione-risposta. BUG STORICO: le opzioni sono ANCHE .card, quindi
      // card.closest('.card') restituiva l'opzione stessa e la domanda (sorella,
      // non figlia) non veniva trovata → []. Ora prendiamo heading e opzioni
      // separatamente dallo scope del form (come fa scripts/harvest-answers.js).
      const scope = document.querySelector('form#aggiungi_risposta') || document.querySelector('form') || document;
      const options = Array.from(scope.querySelectorAll('.opzione-risposta')).map(c => {
        const lbl = c.querySelector('label');
        const p = c.querySelector('p');
        return (lbl ? lbl.innerText.trim() : (p ? p.innerText.trim() : c.innerText.trim()));
      }).filter(Boolean);
      if (options.length === 0) return [];
      const heads = Array.from(scope.querySelectorAll('h1, h2, h3, h4, h5, .question-text, legend'))
        .map(h => h.innerText.trim()).filter(Boolean);
      let qText = (heads.find(h => /^\s*\d+\s*[.)]/.test(h)) || heads[heads.length - 1] || '')
        .replace(/^\s*\d+\s*[.)]\s*/, '').trim();  // rimuovi numero randomizzato
      if (!qText || qText.length < 4) return [];
      return [{ question: qText, options }];
    });
  } catch (e) {
    return [];
  }
}

// Estrae le risposte corrette dalla pagina di esito, se la piattaforma le mostra
// in blocchi domanda+risposta-corretta. Ritorna SOLO coppie {question, answer}
// complete (niente question:null): senza la domanda accoppiata, una risposta
// non è promuovibile nella banca trusted. Se la piattaforma non espone i blocchi
// strutturati, ritorna [] (nessuna promozione: sicuro, non possiamo verificare).
async function extractCorrectAnswers(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const blocks = document.querySelectorAll('.question-block, .domanda, .quiz-question, form .card, [class*="corretta"]');
      blocks.forEach(block => {
        const qEl = block.querySelector('h1, h2, h3, h4, h5, .question-text, .domanda-testo, legend');
        const aEl = block.querySelector('.risposta-corretta, .correct-answer, .text-success, .bg-success');
        if (qEl && aEl) {
          const q = qEl.innerText.trim();
          const a = aEl.innerText.trim();
          // Scarta heading vuoti o che sono solo numerazione/punteggiatura.
          if (q && a && q.length > 3 && !seen.has(q)) {
            seen.add(q);
            out.push({ question: q, answer: a });
          }
        }
      });
      return out;
    });
  } catch (e) {
    return [];
  }
}

// Salva HTML + screenshot + bodyText della pagina del quiz in debug/quiz/.
// A prova di bomba: qualsiasi esito non chiaro o cattura fallita lascia artefatti
// per diagnosi, così l'autopilot non fallisce MAI in silenzio. Non lancia mai.
async function dumpQuizDiagnostics(page, root, label, bodyText) {
  try {
    const dir = path.join(root, 'debug', 'quiz');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(dir, `${ts}_${label}`);
    let html = '';
    try { html = await page.content(); } catch (e) { /* pagina chiusa? */ }
    try { fs.writeFileSync(base + '.html', redactSensitiveText(html || '')); } catch (e) { /* ignora */ }
    try { await page.screenshot({ path: base + '.png', fullPage: true }); } catch (e) { /* ignora */ }
    try {
      const meta = {
        label,
        ts: new Date().toISOString(),
        url: redactSensitiveText((page.url && page.url()) ? page.url() : ''),
        bodyText: bodyText ? redactSensitiveText(bodyText) : null,
      };
      fs.writeFileSync(base + '.json', JSON.stringify(meta, null, 2));
    } catch (e) { /* ignora */ }
    return base;
  } catch (e) {
    return null;
  }
}

// Cerca un bottone per riprovare / avviare il quiz.
async function findRetryButton(page) {
  const retryLabels = /riprova|nuovo\s+tentativo|avvia\s+compilazione|inizia\s+questionario|inizia/i;
  try {
    const btns = await page.locator('a.btn-primary, button.btn-primary, a.btn, button.btn, a, button').all();
    for (const btn of btns) {
      const text = (await btn.innerText().catch(() => '')).trim();
      if (retryLabels.test(text)) return btn;
    }
  } catch (e) { /* ignora */ }
  return null;
}

async function clickRetryButton(page, log) {
  const btn = await findRetryButton(page);
  if (!btn) return false;
  const text = (await btn.innerText().catch(() => '')).trim();
  log(`Trovato bottone '${text}'. Clicco per riprovare/riavviare il quiz...`);
  await btn.click().catch(() => {});
  await page.waitForTimeout(POST_SUBMIT_MS);
  return true;
}

// Testi dei bottoni che FINALIZZANO il quiz (consumano un tentativo): NON vanno
// mai cliccati da clickNextButton. La finalizzazione ("Conferma" al Riepilogo)
// avviene solo nel ramo controllato di solveActiveQuestions, quando è sicuro.
const FINALIZE_RE = /conferma|finalizz|invia|termina|concludi|salva e invia/i;

// Avanza alla domanda successiva SENZA rischiare di finalizzare. Preferisce il
// testo "Avanti"/"Prosegui" esplicito; il vecchio ordine provava
// `button[type=submit]` per primo, che su una pagina di Riepilogo poteva essere
// il bottone di finalizzazione (tentativo bruciato). Ritorna true se ha avanzato.
async function clickNextButton(page, log) {
  const preferred = [
    { sel: 'button:has-text("Avanti")', label: 'Avanti' },
    { sel: 'a.btn-primary:has-text("Avanti")', label: 'Avanti link' },
    { sel: 'button:has-text("Prosegui")', label: 'Prosegui' },
  ];
  for (const { sel, label } of preferred) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      log(`Cliccato bottone ${label}`);
      await page.waitForTimeout(QUIZ_STEP_MS);
      return true;
    }
  }
  // Fallback: un submit generico, ma SOLO se il suo testo non è di finalizzazione.
  const submit = page.locator('button[type="submit"]').first();
  if (await submit.isVisible().catch(() => false)) {
    const txt = (await submit.innerText().catch(() => '')) || '';
    if (!FINALIZE_RE.test(txt)) {
      await submit.click().catch(() => {});
      log(`Cliccato bottone submit ('${txt.trim().slice(0, 20)}')`);
      await page.waitForTimeout(QUIZ_STEP_MS);
      return true;
    }
    log(`Submit '${txt.trim().slice(0, 20)}' sembra finalizzare: NON lo clicco qui.`);
  }
  return false;
}

// Seleziona l'opzione `index` e VERIFICA che sia davvero selezionata (un
// input:checked nella card). Se il click sulla card non ha propagato all'input,
// riprova cliccando label/input interni. Ritorna true se risulta selezionata.
async function selectOption(page, optsLoc, index) {
  const card = optsLoc.nth(index);
  await card.click().catch(() => {});
  await page.waitForTimeout(300);
  const checked = () => card.locator('input:checked').count().then(c => c > 0).catch(() => false);
  if (await checked()) return true;
  // Fallback 1: clicca la label interna.
  await card.locator('label').first().click().catch(() => {});
  await page.waitForTimeout(200);
  if (await checked()) return true;
  // Fallback 2: clicca direttamente l'input radio/checkbox.
  await card.locator('input[type="radio"], input[type="checkbox"]').first().check().catch(() => {});
  await page.waitForTimeout(200);
  return await checked();
}

// Strategia ATTEMPT-PROTECTIVE: la piattaforma consuma un tentativo SOLO alla
// finalizzazione (Conferma al Riepilogo). Quindi finalizziamo SOLO se OGNI
// domanda ha una risposta NOTA nel glossario (known_answers). Qualunque domanda
// non nota rende il quiz "incerto": non la rispondiamo, la passiamo all'AI, e al
// Riepilogo usciamo SENZA finalizzare (nessun tentativo bruciato). Il batch
// Claude on-demand risolve le domande dell'inbox in known_answers; al retry il
// corso finalizza con tutte le risposte note. Nessun modello viene invocato da
// questo processo browser.
async function solveActiveQuestions(page, root, log, monitor, context = null) {
  const sessionAnswers = {};       // risposte scelte in questo quiz (da note)
  const capturedAnswers = {};      // tutte le domande con la risposta scelta
  const aiRequests = [];           // domande incerte → handoff AI
  const knownAnswersPath = path.join(root, 'data', 'known_answers.json');
  ensureKnownBankSeeded(root);
  let uncertainCount = 0;          // domande non note (bloccano la finalizzazione)
  let finalized = false;            // true solo dopo click Conferma controllato
  const seenQuestions = new Set(); // per non ri-contare la stessa domanda

  for (let i = 0; i < MAX_QUIZ_QUESTIONS; i++) {
    await page.waitForTimeout(QUIZ_QUESTION_MS);
    await page.waitForSelector('form h1, form h2, form h3, form h4, form h5, .opzione-risposta, button:has-text("Conferma"), button:has-text("Avanti")', { timeout: 10000 }).catch(() => {});

    const isRiepilogo = await page.evaluate(() => document.body.innerText.includes('Riepilogo')).catch(() => false);
    if (isRiepilogo) {
      if (uncertainCount > 0) {
        // GATE: non finalizzare con domande incerte → nessun tentativo consumato.
        log(`Riepilogo raggiunto ma ${uncertainCount} domanda/e NON nota/e: NON finalizzo (non consumo tentativi). Le passo all'AI e riprovo dopo.`);
        if (aiRequests.length > 0) {
          const n = saveAiQuizRequest(root, aiRequests, `quiz sospeso: ${uncertainCount} domande da risolvere (tentativo protetto)`, context);
          log(`[AI_QUIZ_REQUEST] ${n} domande salvate in ai_quiz_request.json per l'AI.`);
        }
        return { sessionAnswers, capturedAnswers, aiRequests, status: 'needs_answers_bailed', uncertainCount };
      }
      log('Riepilogo raggiunto e TUTTE le risposte note: finalizzo (Conferma).');
      const confirmBtn = page.locator('button:has-text("Conferma")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        finalized = true;
        await page.waitForTimeout(POST_CONFIRM_MS);
        if (await page.evaluate(() => document.querySelector('form h1, form h2, form h3, form h4, form h5')).catch(() => false)) continue;
        else break;
      }
    }

    const q = await page.evaluate(() => {
      const form = document.querySelector('form#aggiungi_risposta') || document.querySelector('form');
      if (!form) return null;
      const heading = form.querySelector('h1, h2, h3, h4, h5, .question-text');
      if (!heading) return null;
      // La piattaforma RANDOMIZZA l'ordine: rimuovi il numero iniziale ("1. "),
      // altrimenti la stessa domanda con numero diverso non matcha nel glossario.
      const text = heading.innerText.trim().replace(/^\s*\d+\s*[.)]\s*/, '');
      const opts = Array.from(form.querySelectorAll('.opzione-risposta')).map((c, idx) => {
        const lbl = c.querySelector('label');
        const p = c.querySelector('p');
        return { text: (lbl ? lbl.innerText.trim() : (p ? p.innerText.trim() : c.innerText.trim())), index: idx };
      });
      return { text, opts };
    }).catch(() => null);

    if (!q || !q.text) {
      // Non c'è più domanda attiva: potremmo essere finiti o sulla pagina esito.
      return { sessionAnswers, capturedAnswers, aiRequests, status: 'no_active_question', finalized };
    }

    log(`Domanda ${i + 1}: ${q.text.slice(0, 60)}...`);

    // readJsonCached (mtime): la banca è consultata a OGNI domanda; la cache si
    // invalida da sola quando mergeIntoKnown/answers-cli la riscrivono (rename).
    const knownAnswers = readJsonCached(knownAnswersPath, {});
    const knownMatch = findKnownAnswer(q.text, q.opts, knownAnswers);

    if (knownMatch) {
      // Risposta NOTA: selezioniamo e verifichiamo la selezione, poi Avanti.
      log(`Risposta nota (confidenza ${(knownMatch.score * 100).toFixed(0)}%): ${knownMatch.optionText.slice(0, 50)}...`);
      const optsLoc = await optionsLocator(page);
      const ok = await selectOption(page, optsLoc, knownMatch.optionIndex);
      if (!ok) log('ATTENZIONE: la selezione dell\'opzione non risulta confermata (input non :checked).');
      capturedAnswers[q.text] = knownMatch.optionText;
      sessionAnswers[q.text] = knownMatch.optionText;
      await clickNextButton(page, log);
      continue;
    }

    // Domanda NON nota → incerta. NON rispondiamo (proteggiamo il tentativo).
    // Chiediamo comunque a Ollama un SUGGERIMENTO da allegare per l'AI.
    if (!seenQuestions.has(q.text)) {
      seenQuestions.add(q.text);
      uncertainCount++;
    }
    log(`!!! DOMANDA NON NOTA: ${q.text.slice(0, 60)}... — non rispondo, la passo all'AI.`);
    // L'autoplay non interroga mai Ollama direttamente: prima persiste
    // l'handoff, poi il launcher/scheduler applica il gate openQuizRequests e
    // avvia l'unico batch Claude protetto da proxy e budget.
    log('Handoff diretto al supervisore Claude on-demand; nessun processo AI aperto dal browser autoplay.');
    aiRequests.push({ question: q.text, options: q.opts.map(o => o.text) });
    saveNeedAnswer(root, [{ question: q.text, options: q.opts.map(o => o.text) }], 'domanda non nota (tentativo protetto)', context);
    // Avanti SENZA rispondere (consentito dalla piattaforma; non finalizza).
    await clickNextButton(page, log);
  }

  log(`ATTENZIONE: raggiunto il tetto di ${MAX_QUIZ_QUESTIONS} domande nel quiz. Esito valutato sulla pagina.`);
  return { sessionAnswers, capturedAnswers, aiRequests, status: 'max_iterations', finalized };
}

// Se solveActiveQuestions ha accumulato domande aperte (aiRequests),
// scrive l'handoff ai_quiz_request.json (merge) ed emette il marker di log
// [AI_QUIZ_REQUEST] che il Monitor del supervisore cattura. Non blocca il corso:
// l'AI risolve in autonomia (WebSearch + ragionamento) e popola la banca trusted.
function writeAiRequestIfAny(root, solveResult, reason, courseUrl, context, log, monitor) {
  const items = solveResult && solveResult.aiRequests ? solveResult.aiRequests : [];
  if (items.length === 0) return;
  let courseId = null;
  if (courseUrl) {
    const m = String(courseUrl).match(/\/corso\/show\/(\d+)/);
    if (m) courseId = m[1];
  }
  const n = saveAiQuizRequest(root, items, reason, { courseUrl, courseId, ...(context || {}) });
  log(`[AI_QUIZ_REQUEST] ${n} domande aperte salvate in ai_quiz_request.json per verifica AI (reason: ${reason}).`);
  // phase 'quiz_needs_answers' come segnale morbido: autoplay può poi
  // sovrascriverlo con done/need_help a seconda dell'esito. Il marker di log
  // sopra resta la fonte affidabile per il Monitor.
  try { monitor?.update({ phase: 'quiz_needs_answers' }); } catch (_) {}
}

async function solveQuiz(page, root, log, monitor, courseUrl, assessmentUrl = null) {
  const courseId = (String(courseUrl || '').match(/\/corso\/show\/(\d+)/) || [])[1] || null;
  const assessmentId = require('./course-state').assessmentIdFromUrl(assessmentUrl);
  const context = { courseUrl, courseId, assessmentUrl, assessmentId };
  log('Rilevato questionario. Inizio risoluzione autonoma...');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const knownAnswersPath = path.join(root, 'data', 'known_answers.json');
  ensureKnownBankSeeded(root);

  // 1) Verifica se la pagina mostra già un esito (quiz già completato o tentato).
  const outcomeCheck = await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    return {
      bodyText: bodyText.slice(0, 12000),
      hasActiveQuestion: !!document.querySelector('form h1, form h2, form h3, form h4, form h5'),
      hasQuizButton: !!document.querySelector('a.btn-primary, button.btn-primary')
    };
  }).catch(() => ({ bodyText: '', hasActiveQuestion: false, hasQuizButton: false }));

  const outcome = detectOutcomeFromText(outcomeCheck.bodyText);
  const scoreText = outcome.score ? outcome.score.text : null;

  if (!outcomeCheck.hasActiveQuestion && outcome.passed) {
    const resultText = scoreText ? `superato (${scoreText})` : 'superato';
    log(`Pagina di esito rilevata: ${resultText}`);
    monitor?.update({ lastQuizResult: resultText });

    // Estrai risposte corrette dalla pagina di esito.
    const extracted = await extractCorrectAnswers(page);
    if (extracted.length > 0) {
      log(`Estratte ${extracted.length} risposte corrette dalla pagina di esito.`);
      const answersToMerge = {};
      for (const item of extracted) {
        if (item.question && item.answer) answersToMerge[item.question] = item.answer;
      }
      mergeIntoKnown(root, answersToMerge, log);
    }

    return { outcome: 'already_done', passed: true, score: scoreText, resultText };
  }

  if (!outcomeCheck.hasActiveQuestion && outcome.failed) {
    const resultText = scoreText ? `non superato (${scoreText})` : 'non superato';
    log(`Pagina di esito rilevata: ${resultText}`);
    monitor?.update({ lastQuizResult: resultText });

    // Se c'è un bottone "Riprova", clicchiamo e continuiamo a risolvere.
    const retryClicked = await clickRetryButton(page, log);
    if (!retryClicked) {
      log('Nessun bottone "Riprova" trovato. Catturo le domande del quiz per intervento AI...');
      // Tenta di catturare le domande direttamente dalla pagina corrente.
      let captured = await extractQuestionsFromPage(page);
      if (captured.length === 0) {
        // Prova a tornare al link del questionario e catturare da lì.
        const quizUrl = page.url();
        if (quizUrl.includes('/questionario/')) {
          await page.goto(quizUrl, { waitUntil: 'networkidle' }).catch(() => {});
          await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
          captured = await extractQuestionsFromPage(page);
        }
      }
      saveNeedAnswer(root, captured, `quiz non superato (${resultText}), nessuna possibilità di riprova`, context);
      if (captured.length === 0) {
        await dumpQuizDiagnostics(page, root, 'failed_noretry_nocapture', outcomeCheck.bodyText);
      }
      return {
        outcome: 'need_help',
        passed: false,
        score: scoreText,
        resultText,
        reason: 'quiz non superato, nessun bottone riprova',
        attemptConsumed: false,
      };
    }
    // Abbiamo cliccato "Riprova", continuiamo con le domande attive.
    await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
  }

  // 2) Verifica se c'è il bottone "Avvia compilazione" (dashboard quiz).
  const startBtn = page.locator('a.btn-primary, button.btn-primary').filter({ hasText: /avvia compilazione/i }).first();
  if (await startBtn.isVisible().catch(() => false)) {
    // Logga i tentativi residui (informativo): con la strategia attempt-protective
    // non finalizziamo mai con risposte incerte, quindi non li bruciamo — ma è
    // utile averlo nei log.
    const tent = await page.evaluate(() => {
      const m = (document.body ? document.body.innerText : '').match(/tentativ\w*[^\d]{0,30}(\d+)/i);
      return m ? m[1] : null;
    }).catch(() => null);
    if (tent != null) log(`Tentativi indicati sulla pagina: ${tent}.`);
    log("Trovato bottone 'Avvia compilazione'. Clicco per iniziare...");
    await startBtn.click();
    await page.waitForTimeout(POST_SUBMIT_MS);
  }

  // 3) Risolvi le domande attive.
  // A prova di bomba: un'eccezione imprevista (pagina chiusa, nav fallita) non deve
  // mai crashare l'autoplay. Lascio un dump diagnostico e dichiaro esito ignoto.
  let solveResult;
  try {
    solveResult = await solveActiveQuestions(page, root, log, monitor, context);
  } catch (e) {
    log(`Errore imprevisto durante la risoluzione delle domande: ${e.message}. Salvo dump diagnostico.`);
    await dumpQuizDiagnostics(page, root, 'exception_solve', null);
    monitor?.update({ lastQuizResult: 'ignoto (eccezione)' });
    return { outcome: 'unknown', passed: false, score: null, resultText: 'ignoto (eccezione)', reason: e.message };
  }

  // Attempt-protective: il quiz aveva domande NON note e NON è stato finalizzato
  // (nessun tentativo consumato). Il corso va in need_help finché l'AI non riempie
  // il glossario; poi resetCourse + retry lo finalizza con tutte le risposte note.
  if (solveResult.status === 'needs_answers_bailed') {
    const resultText = `sospeso: ${solveResult.uncertainCount} domande da risolvere (tentativo protetto)`;
    log(`Quiz NON finalizzato per proteggere i tentativi. ${resultText}.`);
    monitor?.update({ lastQuizResult: resultText });
    return {
      outcome: 'need_help',
      passed: false,
      score: null,
      resultText,
      reason: 'domande non note: non finalizzato per non consumare tentativi (le risolverà l\'AI)',
      attemptConsumed: false,
    };
  }

  // 4) Dopo aver risposto, verifica l'esito finale.
  await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
  const finalOutcome = await page.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    return { bodyText: text.slice(0, 12000) };
  }).catch(() => ({ bodyText: '' }));

  const final = detectOutcomeFromText(finalOutcome.bodyText);
  const finalScoreText = final.score ? final.score.text : null;

  if (final.passed) {
    const resultText = finalScoreText ? `superato (${finalScoreText})` : 'superato';
    log(`Quiz terminato con successo! Esito: ${resultText}`);
    monitor?.update({ lastQuizResult: resultText });
    // Non deduciamo nuove entry dalle selezioni della sessione: la banca cresce
    // soltanto dallo scrape esplicito della piattaforma o da risposte validate
    // dal supervisore. Gli eventuali pending legacy restano non trusted.
    const extracted = await extractCorrectAnswers(page);
    if (extracted.length > 0) {
      log(`Scrape post-quiz: ${extracted.length} risposte verificate dalla piattaforma.`);
      const extra = {};
      for (const item of extracted) {
        if (item.question && item.answer) extra[item.question] = item.answer;
      }
      mergeIntoKnown(root, extra, log);
    }
    // Percorso difensivo: se restano aiRequests nonostante l'esito positivo,
    // persistile per una verifica opportunistica senza riaprire il corso.
    writeAiRequestIfAny(root, solveResult, 'quiz superato con domande aperte', courseUrl, context, log, monitor);
    return { outcome: 'solved', passed: true, score: finalScoreText, resultText, attemptConsumed: !!solveResult.finalized };
  }

  if (final.failed) {
    const resultText = finalScoreText ? `non superato (${finalScoreText})` : 'non superato';
    log(`Quiz NON superato. Esito: ${resultText}. Catturo le domande per intervento AI...`);
    monitor?.update({ lastQuizResult: resultText });
    let captured = await extractQuestionsFromPage(page);
    if (captured.length === 0) {
      // Se non ci sono domande, potrebbe essere la pagina di esito: proviamo a tornare indietro
      // al questionario e catturare da lì.
      const quizUrl = page.url();
      if (quizUrl.includes('/questionario/')) {
        await page.goto(quizUrl, { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(INTERSTITIAL_CLICK_MS);
        captured = await extractQuestionsFromPage(page);
      }
    }
    // Se la cattura dalla pagina fallisce ma abbiamo le domande negli aiRequests
    // (catturate durante la risoluzione), usiamo quelle per need_answer: così
    // l'AI ha comunque le domande anche se la pagina esito non le espone più.
    if (captured.length === 0 && solveResult.aiRequests && solveResult.aiRequests.length > 0) {
      captured = solveResult.aiRequests.map(r => ({ question: r.question, options: r.options }));
    }
    saveNeedAnswer(root, captured, `quiz non superato (${resultText})`, context);
    if (captured.length === 0) {
      await dumpQuizDiagnostics(page, root, 'failed_nocapture', finalOutcome.bodyText);
    }
    // Handoff arricchito: ai_quiz_request porta anche i guess Ollama + confidenza.
    writeAiRequestIfAny(root, solveResult, `quiz non superato (${resultText})`, courseUrl, context, log, monitor);
    return { outcome: 'need_help', passed: false, score: finalScoreText, resultText, reason: 'quiz non superato', attemptConsumed: !!solveResult.finalized };
  }

  log('Quiz in stato ignoto: nessun esito chiaro rilevato. Catturo le domande per sicurezza...');
  monitor?.update({ lastQuizResult: 'ignoto' });
  let captured = await extractQuestionsFromPage(page);
  if (captured.length === 0 && solveResult.aiRequests && solveResult.aiRequests.length > 0) {
    captured = solveResult.aiRequests.map(r => ({ question: r.question, options: r.options }));
  }
  if (captured.length > 0) {
    saveNeedAnswer(root, captured, 'esito quiz non chiaro', context);
  } else {
    // Nessun esito chiaro E nessuna domanda catturata: lascio artefatti per diagnosi
    // (a prova di bomba: mai un fallimento silenzioso senza poter capire perché).
    await dumpQuizDiagnostics(page, root, 'ignoto_nocapture', finalOutcome.bodyText);
  }
  writeAiRequestIfAny(root, solveResult, 'esito quiz non chiaro', courseUrl, context, log, monitor);
  return { outcome: 'unknown', passed: false, score: null, resultText: 'ignoto', attemptConsumed: !!solveResult.finalized };
}

// findKnownAnswer/normKey/similarity: pure in quiz-match.js; re-export qui
// per back-compat (test e eventuali require da quiz).
module.exports = {
  solveQuiz,
  extractScore,
  detectOutcomeFromText,
  extractQuestionsFromPage,
  saveNeedAnswer,
  saveAiQuizRequest,
  clearResolvedFromHandoff,
  dumpQuizDiagnostics,
  NeedHelpExit,
  MAX_QUIZ_QUESTIONS,
  findKnownAnswer,
  normKey,
  similarity,
  scoreLooksPassing,
};
