const fs = require('fs');
const path = require('path');
const account = require('./account');
const { askQuizQuestion } = require('./ollama-quiz');
const { writeJsonAtomic, readJsonSafe } = require('./io');
const { NeedHelpExit } = require('./errors');

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
const tokenize = (s) => normalize(s).split(/\s+/).filter(t => t.length > 2);

// Tetto di sicurezza sul numero di domande per quiz: evita loop infiniti se la
// piattaforma renderizza una nuova domanda a ogni iterazione senza mai finire.
// 200 è abbondante per i quiz del corso (tipicamente <50); superato emette warning.
const MAX_QUIZ_QUESTIONS = 200;

// Mappa lettera (A,B,C,D,E) → indice opzione.
function letterToIndex(letter) {
  const i = ['A', 'B', 'C', 'D', 'E'].indexOf(String(letter || '').toUpperCase());
  return i; // -1 se non valido
}

// Locator delle opzioni risposta, scoped al form della domanda corrente.
// Se il form id non è presente (layout anomalo), ricade sul selettore globale.
// Scope: evita di cliccare l'opzione di un'altra domanda se la pagina ne
// renderizza più di una contemporaneamente.
async function optionsLocator(page) {
  const scoped = page.locator('form#aggiungi_risposta .opzione-risposta');
  const n = await scoped.count().catch(() => 0);
  if (n > 0) return scoped;
  return page.locator('.opzione-risposta');
}

// Similarità Jaccard normalizzata tra due stringhe (0..1). Ignora le stop word
// italiane comuni per concentrarsi sulle parole semanticamente rilevanti.
function similarity(a, b) {
  const stopWords = new Set(['che','cui','del','della','dei','delle','il','la','lo','gli','le','un','una','uno','con','per','tra','fra','sul','sulla','su','di','a','da','in','e','o','ma','è','sono','come','non','si']);
  const tokensA = new Set(tokenize(a).filter(t => !stopWords.has(t)));
  const tokensB = new Set(tokenize(b).filter(t => !stopWords.has(t)));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

// Cerca una risposta nota usando matching esatto, sottostringa e similarità.
function findKnownAnswer(question, options, knownAnswers) {
  const normQ = normalize(question);
  const labels = ['A','B','C','D'];
  let bestMatch = null;
  let bestScore = 0;

  for (const [knownQ, knownA] of Object.entries(knownAnswers)) {
    const normKnownQ = normalize(knownQ);
    // Match esatto o sottostringa: punteggio alto
    let score = 0;
    if (normQ === normKnownQ) {
      score = 1;
    } else if (normQ.includes(normKnownQ) || normKnownQ.includes(normQ)) {
      score = 0.9;
    } else {
      score = similarity(question, knownQ);
    }

    if (score > bestScore) {
      const normA = normalize(knownA);
      const optIndex = options.findIndex(o =>
        normalize(o.text).includes(normA) || normA.includes(normalize(o.text)) || similarity(o.text, knownA) > 0.85
      );
      if (optIndex !== -1) {
        bestScore = score;
        bestMatch = { question: knownQ, answer: knownA, optionIndex: optIndex, optionText: options[optIndex].text, score };
      }
    }
  }

  // Soglia minima di confidenza per evitare falsi positivi.
  if (bestScore >= 0.75) {
    return bestMatch;
  }
  return null;
}

// Promuove nella banca condivisa (known_answers.json) le risposte date in questo quiz,
// ma solo se il quiz è stato superato.
function mergeIntoKnown(root, newAnswers, log) {
  if (!newAnswers || Object.keys(newAnswers).length === 0) return 0;
  const knownPath = path.join(root, 'data', 'known_answers.json');
  // readJsonSafe: se la banca condivisa è corrotta, non la azzera silenziosamente:
  // lo segnala e parte da {} (perdendo solo il merge di questo run, non tutto).
  let known = readJsonSafe(knownPath, {});
  let added = 0;
  for (const [q, a] of Object.entries(newAnswers)) {
    if (!known[q]) { known[q] = a; added++; }
  }
  if (added > 0) {
    try {
      // Scrittura atomica (tmp + rename): un crash a metà non corrompe la banca.
      writeJsonAtomic(knownPath, known);
      log(`Banca risposte aggiornata: +${added} risposte verificate (quiz superato).`);
    } catch (e) {
      log(`Impossibile aggiornare known_answers.json: ${e.message}`);
    }
  }
  return added;
}

function extractScore(text) {
  const t = (text || '').toLowerCase();
  // 1) Priorità: frazione vicino alle parole chiave "punteggio" o "voto [finale]".
  // Evita di catturare numeri casuali del menù/indice (es. "4.3 38-39" nel sillabo).
  const ctx = t.match(/(?:punteggio|voto(?:\s+finale)?)\s*:?\s*(\d{1,3})\s*\/\s*(\d{1,3})/);
  if (ctx) {
    const got = parseInt(ctx[1], 10);
    const total = parseInt(ctx[2], 10);
    return { text: `${got}/${total}`, pct: total ? (got / total) * 100 : 0, type: 'frac', got, total };
  }
  // 2) Forma italiana "X su Y" (es. "24 su 30").
  const su = t.match(/(\d{1,3})\s+su\s+(\d{1,3})/);
  if (su) {
    const got = parseInt(su[1], 10);
    const total = parseInt(su[2], 10);
    return { text: `${got}/${total}`, pct: total ? (got / total) * 100 : 0, type: 'frac', got, total };
  }
  // 3) Percentuale esplicita.
  const pct = t.match(/(\d{1,3}([.,]\d+)?)\s*%/);
  if (pct) return { text: `${pct[1]}%`, pct: parseFloat(pct[1].replace(',', '.')), type: 'pct' };
  // 4) Fallback: prima frazione generica "X/Y".
  const frac = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (frac) {
    const got = parseInt(frac[1], 10);
    const total = parseInt(frac[2], 10);
    return { text: `${got}/${total}`, pct: total ? (got / total) * 100 : 0, type: 'frac', got, total };
  }
  return null;
}

// Un punteggio >= 80% è considerato superato anche se la piattaforma scrive "non superato"
// (workaround per esiti visualizzati male).
function scoreLooksPassing(score) {
  return score && Number.isFinite(score.pct) && score.pct >= 80;
}

function detectOutcomeFromText(text) {
  const low = (text || '').toLowerCase();
  // Pattern esito: copriamo le formulazioni reali della piattaforma GSD Campus
  // ("Questionario superato!", "Complimenti, hai superato...", "non superato",
  // "insufficiente", "da ripetere"...).
  const failedText = /non\s+superato|non\s+idoneo|non\s+hai\s+superato|insufficiente|da\s+ripetere|da\s+rifare/.test(low);
  const score = extractScore(text);
  // Se il testo dice superato/idoneo/complimenti ed esplicitamente NON dice "non", è superato.
  const passedText = !failedText && /superato|idoneo|complimenti|hai\s+superato/.test(low);
  // Fallback sul punteggio: >= 80% conta come superato anche in assenza di testo chiaro.
  const passed = passedText || scoreLooksPassing(score);
  return { passed, failed: failedText, score };
}

// Estrae tutte le domande e opzioni dalla pagina di quiz attiva.
async function extractQuestionsFromPage(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const seenQuestions = new Set();
      // Le opzioni sono in card .opzione-risposta; risaliamo al container comune
      // e prendiamo il primo heading come testo della domanda.
      // Fallback selettori: la piattaforma può usare classi leggermente diverse.
      const optionCards = document.querySelectorAll('.opzione-risposta, .opzione, [class*="opzione-risposta"], .risposta, [class*="risposta"]');
      optionCards.forEach(card => {
        const container = card.closest('form, .card, fieldset, .question-block, [class*="question"]') || card.parentElement;
        if (!container) return;
        // Cerca il testo della domanda nel container o nel form/card genitore.
        let qEl = container.querySelector('h1, h2, h3, h4, h5, .question-text, legend');
        if (!qEl) {
          const parent = container.closest('form, .card');
          if (parent) qEl = parent.querySelector('h1, h2, h3, h4, h5, .question-text');
        }
        if (!qEl) return;
        const qText = qEl.innerText.trim();
        if (seenQuestions.has(qText)) return;
        seenQuestions.add(qText);
        const options = Array.from(container.querySelectorAll('.opzione-risposta')).map(c => {
          const lbl = c.querySelector('label');
          const p = c.querySelector('p');
          return (lbl ? lbl.innerText.trim() : (p ? p.innerText.trim() : c.innerText.trim()));
        }).filter(Boolean);
        if (options.length > 0) {
          out.push({ question: qText, options });
        }
      });
      return out;
    });
  } catch (e) {
    return [];
  }
}

// Estrae le risposte corrette dalla pagina di esito, se la piattaforma le mostra.
async function extractCorrectAnswers(page) {
  try {
    return await page.evaluate(() => {
      const out = [];
      const blocks = document.querySelectorAll('.question-block, .domanda, .quiz-question, form .card, .risposta-corretta, [class*="corretta"]');
      blocks.forEach(block => {
        const qEl = block.querySelector('h4, .question-text, .domanda-testo, p');
        const aEl = block.querySelector('.risposta-corretta, .correct-answer, .text-success, .bg-success');
        if (qEl && aEl) {
          out.push({ question: qEl.innerText.trim(), answer: aEl.innerText.trim() });
        }
      });
      const body = document.body ? document.body.innerText : '';
      const regex = /risposta\s+corretta[\s:]*(.+?)(?=\n|risposta\s+corretta|$)/gi;
      let m;
      while ((m = regex.exec(body)) !== null) {
        out.push({ question: null, answer: m[1].trim() });
      }
      return out;
    });
  } catch (e) {
    return [];
  }
}

function saveNeedAnswer(root, questions, reason) {
  if (!questions || questions.length === 0) return;
  const needPath = account.stateFilePaths(root).needAnswer;
  try {
    // Scrittura atomica: il file need_answer è letto dall'AI per intervenire,
    // non deve mai restare troncato a metà.
    writeJsonAtomic(needPath, { reason, questions, savedAt: new Date().toISOString() });
  } catch (e) { /* ignora */ }
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
    try { fs.writeFileSync(base + '.html', html || ''); } catch (e) { /* ignora */ }
    try { await page.screenshot({ path: base + '.png', fullPage: true }); } catch (e) { /* ignora */ }
    try {
      const meta = {
        label,
        ts: new Date().toISOString(),
        url: (page.url && page.url()) ? page.url() : '',
        bodyText: bodyText || null,
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
  await page.waitForTimeout(4000);
  return true;
}

// Clicca il bottone per andare avanti nel wizard del quiz.
async function clickNextButton(page, log) {
  const selectors = [
    { sel: 'button[type="submit"]', label: 'submit' },
    { sel: 'button:has-text("Avanti")', label: 'Avanti' },
    { sel: 'button:has-text("Conferma")', label: 'Conferma' },
    { sel: 'button:has-text("Prosegui")', label: 'Prosegui' },
    { sel: 'a.btn-primary:has-text("Avanti")', label: 'Avanti link' },
  ];
  for (const { sel, label } of selectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      log(`Cliccato bottone ${label}`);
      await page.waitForTimeout(1000);
      return;
    }
  }
}

async function solveActiveQuestions(page, root, log, monitor) {
  const sessionAnswers = {};       // risposte date da Ollama in questo quiz
  const capturedAnswers = {};      // TUTTE le domande con la risposta che abbiamo scelto
  const knownAnswersPath = path.join(root, 'data', 'known_answers.json');

  for (let i = 0; i < MAX_QUIZ_QUESTIONS; i++) {
    await page.waitForTimeout(2000);
    await page.waitForSelector('form h1, form h2, form h3, form h4, form h5, .opzione-risposta, button:has-text("Conferma"), button[type="submit"]', { timeout: 10000 }).catch(() => {});

    const isRiepilogo = await page.evaluate(() => document.body.innerText.includes('Riepilogo')).catch(() => false);
    if (isRiepilogo) {
      log('Riepilogo raggiunto. Clicco Conferma...');
      const confirmBtn = page.locator('button:has-text("Conferma")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(5000);
        if (await page.evaluate(() => document.querySelector('form h1, form h2, form h3, form h4, form h5')).catch(() => false)) continue;
        else break;
      }
    }

    const q = await page.evaluate(() => {
      const form = document.querySelector('form#aggiungi_risposta') || document.querySelector('form');
      if (!form) return null;
      const heading = form.querySelector('h1, h2, h3, h4, h5, .question-text');
      if (!heading) return null;
      const text = heading.innerText.trim();
      const opts = Array.from(form.querySelectorAll('.opzione-risposta')).map((c, idx) => {
        const lbl = c.querySelector('label');
        const p = c.querySelector('p');
        return { text: (lbl ? lbl.innerText.trim() : (p ? p.innerText.trim() : c.innerText.trim())), index: idx };
      });
      return { text, opts };
    }).catch(() => null);

    if (!q || !q.text) {
      // Non c'è più domanda attiva: potremmo essere finiti o sulla pagina esito.
      return { sessionAnswers, capturedAnswers, status: 'no_active_question' };
    }

    log(`Domanda ${i + 1}: ${q.text.slice(0, 60)}...`);

    let knownAnswers = {};
    try {
      knownAnswers = JSON.parse(fs.readFileSync(knownAnswersPath, 'utf8'));
    } catch (e) {
      log('Attenzione: known_answers.json non leggibile', e.message);
    }

    let found = false;
    let selectedOptionText = null;

    const knownMatch = findKnownAnswer(q.text, q.opts, knownAnswers);
    if (knownMatch) {
      selectedOptionText = knownMatch.optionText;
      log(`Risposta nota (confidenza ${(knownMatch.score * 100).toFixed(0)}%): ${selectedOptionText.slice(0, 50)}...`);
      const optsLoc = await optionsLocator(page);
      await optsLoc.nth(knownMatch.optionIndex).click();
      await page.waitForTimeout(500);
      await clickNextButton(page, log);
      found = true;
    }

    if (!found) {
      log(`!!! DOMANDA SCONOSCIUTA: ${q.text}`);
      log('Provo a chiedere a Ollama (modello cloud) la risposta...');

      const ollamaAnswer = await askQuizQuestion(q.text, q.opts.map(o => o.text), log);

      if (ollamaAnswer) {
        selectedOptionText = ollamaAnswer.text;
        const conf = ollamaAnswer.confidence != null ? `${(ollamaAnswer.confidence * 100).toFixed(0)}%` : '?';
        log(`Ollama suggerisce: ${ollamaAnswer.letter}) ${selectedOptionText.slice(0, 50)}... (confidenza ${conf}, strategia ${ollamaAnswer.strategy || '?'})`);

        // Risolve l'indice dell'opzione in modo robusto: confronto normalizzato
        // (non piu esatto, che fallisce su maiuscole/spazi/markdown) e fallback
        // alla lettera restituita da Ollama. Se nessun match, NON clicca a caso
        // (.nth(-1) lancerebbe): salva la domanda per intervento e continua.
        let optIdx = q.opts.findIndex(o => normalize(o.text) === normalize(ollamaAnswer.text));
        if (optIdx < 0 && ollamaAnswer.letter) {
          const li = letterToIndex(ollamaAnswer.letter);
          if (li >= 0 && li < q.opts.length) optIdx = li;
        }
        if (optIdx < 0) {
          log(`Risposta di Ollama non riconducibile ad alcuna opzione ("${selectedOptionText}"). Salvo per intervento e passo oltre.`);
          saveNeedAnswer(root, [{ question: q.text, options: q.opts.map(o => o.text), ollama: { text: ollamaAnswer.text, letter: ollamaAnswer.letter } }], 'risposta Ollama non riconducibile alle opzioni');
          if (selectedOptionText) capturedAnswers[q.text] = selectedOptionText;
          continue;
        }
        const optsLoc = await optionsLocator(page);
        await optsLoc.nth(optIdx).click();
        await page.waitForTimeout(500);
        await clickNextButton(page, log);
        found = true;
        sessionAnswers[q.text] = selectedOptionText;

        try {
          const pendingPath = account.stateFilePaths(root).pending;
          const pending = fs.existsSync(pendingPath) ? readJsonSafe(pendingPath, {}) : {};
          pending[q.text] = selectedOptionText;
          writeJsonAtomic(pendingPath, pending);
        } catch (e) { /* ignora */ }
      }
    }

    // Salva la risposta scelta per questa domanda (utile per arricchire la banca anche quando
    // la risposta era già nota con una formulazione diversa).
    if (selectedOptionText) {
      capturedAnswers[q.text] = selectedOptionText;
    }

    if (!found) {
      log("Sospendo l'automazione per intervento dell'agente.");
      saveNeedAnswer(root, [{ question: q.text, options: q.opts.map(o => o.text) }], 'domanda senza risposta nota');
      // Non process.exit da una lib: orfanerebbe il browser e saltlerebbe il
      // finally di runAutoplay. Lancia NeedHelpExit, catturata in runAutoplay
      // che chiude browser + scrive phase:'need_help' prima di exit(2).
      throw new NeedHelpExit('quiz sospeso: domanda senza risposta nota');
    }
  }

  log(`ATTENZIONE: raggiunto il tetto di ${MAX_QUIZ_QUESTIONS} domande nel quiz. Esito valutato sulla pagina.`);
  return { sessionAnswers, capturedAnswers, status: 'max_iterations' };
}

async function solveQuiz(page, root, log, monitor) {
  log('Rilevato questionario. Inizio risoluzione autonoma...');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  const knownAnswersPath = path.join(root, 'data', 'known_answers.json');

  // 1) Verifica se la pagina mostra già un esito (quiz già completato o tentato).
  const outcomeCheck = await page.evaluate(() => {
    const bodyText = document.body ? document.body.innerText : '';
    return {
      bodyText: bodyText.slice(0, 12000),
      hasActiveQuestion: !!document.querySelector('form h4'),
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
          await page.waitForTimeout(3000);
          captured = await extractQuestionsFromPage(page);
        }
      }
      saveNeedAnswer(root, captured, `quiz non superato (${resultText}), nessuna possibilità di riprova`);
      if (captured.length === 0) {
        await dumpQuizDiagnostics(page, root, 'failed_noretry_nocapture', outcomeCheck.bodyText);
      }
      return {
        outcome: 'need_help',
        passed: false,
        score: scoreText,
        resultText,
        reason: 'quiz non superato, nessun bottone riprova'
      };
    }
    // Abbiamo cliccato "Riprova", continuiamo con le domande attive.
    await page.waitForTimeout(3000);
  }

  // 2) Verifica se c'è il bottone "Avvia compilazione" (dashboard quiz).
  const startBtn = page.locator('a.btn-primary, button.btn-primary').filter({ hasText: /avvia compilazione/i }).first();
  if (await startBtn.isVisible().catch(() => false)) {
    log("Trovato bottone 'Avvia compilazione'. Clicco per iniziare...");
    await startBtn.click();
    await page.waitForTimeout(4000);
  }

  // 3) Risolvi le domande attive.
  // A prova di bomba: un'eccezione imprevista (pagina chiusa, nav fallita) non deve
  // mai crashare l'autoplay. Lascio un dump diagnostico e dichiaro esito ignoto.
  let solveResult;
  try {
    solveResult = await solveActiveQuestions(page, root, log, monitor);
  } catch (e) {
    log(`Errore imprevisto durante la risoluzione delle domande: ${e.message}. Salvo dump diagnostico.`);
    await dumpQuizDiagnostics(page, root, 'exception_solve', null);
    monitor?.update({ lastQuizResult: 'ignoto (eccezione)' });
    return { outcome: 'unknown', passed: false, score: null, resultText: 'ignoto (eccezione)', reason: e.message };
  }

  // 4) Dopo aver risposto, verifica l'esito finale.
  await page.waitForTimeout(3000);
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
    // Promuovi sia le risposte Ollama che tutte le risposte catturate.
    mergeIntoKnown(root, solveResult.sessionAnswers, log);
    mergeIntoKnown(root, solveResult.capturedAnswers, log);
    // Estrai anche eventuali risposte corrette mostrate nella pagina esito.
    const extracted = await extractCorrectAnswers(page);
    if (extracted.length > 0) {
      const extra = {};
      for (const item of extracted) {
        if (item.question && item.answer) extra[item.question] = item.answer;
      }
      mergeIntoKnown(root, extra, log);
    }
    return { outcome: 'solved', passed: true, score: finalScoreText, resultText };
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
        await page.waitForTimeout(3000);
        captured = await extractQuestionsFromPage(page);
      }
    }
    saveNeedAnswer(root, captured, `quiz non superato (${resultText})`);
    if (captured.length === 0) {
      await dumpQuizDiagnostics(page, root, 'failed_nocapture', finalOutcome.bodyText);
    }
    return { outcome: 'need_help', passed: false, score: finalScoreText, resultText, reason: 'quiz non superato' };
  }

  log('Quiz in stato ignoto: nessun esito chiaro rilevato. Catturo le domande per sicurezza...');
  monitor?.update({ lastQuizResult: 'ignoto' });
  const captured = await extractQuestionsFromPage(page);
  if (captured.length > 0) {
    saveNeedAnswer(root, captured, 'esito quiz non chiaro');
  } else {
    // Nessun esito chiaro E nessuna domanda catturata: lascio artefatti per diagnosi
    // (a prova di bomba: mai un fallimento silenzioso senza poter capire perché).
    await dumpQuizDiagnostics(page, root, 'ignoto_nocapture', finalOutcome.bodyText);
  }
  return { outcome: 'unknown', passed: false, score: null, resultText: 'ignoto' };
}

module.exports = { solveQuiz, extractScore, detectOutcomeFromText, extractQuestionsFromPage, saveNeedAnswer, dumpQuizDiagnostics, NeedHelpExit, MAX_QUIZ_QUESTIONS };
