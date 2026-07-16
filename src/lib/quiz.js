const fs = require('fs');
const path = require('path');
const account = require('./account');
const { askQuizQuestion } = require('./ollama-quiz');
const { writeJsonAtomic, readJsonSafe, readJsonCached } = require('./io');
const { NeedHelpExit } = require('./errors');

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
const tokenize = (s) => normalize(s).split(/\s+/).filter(t => t.length > 2);

// Tetto di sicurezza sul numero di domande per quiz: evita loop infiniti se la
// piattaforma renderizza una nuova domanda a ogni iterazione senza mai finire.
// 200 è abbondante per i quiz del corso (tipicamente <50); superato emette warning.
const MAX_QUIZ_QUESTIONS = 200;

// Soglia di confidenza Ollama sotto la quale una domanda (anche se Ollama ha
// dato un best-guess e il quiz procede) viene segnalata all'AI supervisore in
// ai_quiz_request.json, per far crescere la banca TRUSTED con risposte verificate
// (WebSearch + ragionamento) prima che il collega successivo ci sbatta contro.
const AI_REQUEST_CONFIDENCE_THRESHOLD = 0.8;

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

// Normalizza una chiave domanda togliendo il prefisso di numerazione ("1. ",
// "2. "…) che la piattaforma a volte aggiunge: senza questo, la banca duplicava
// la stessa domanda come "X" e "1. X" e non le riconciliava. Va applicata sia
// in lettura (findKnownAnswer) che in scrittura (mergeIntoKnown/scrape).
function normKey(s) {
  return normalize(s).replace(/^\d+\s+/, '').trim();
}

// Cerca una risposta nota usando matching esatto, sottostringa (con copertura
// minima) e similarità Jaccard.
function findKnownAnswer(question, options, knownAnswers) {
  const normQ = normKey(question);
  const labels = ['A','B','C','D'];
  let bestMatch = null;
  let bestScore = 0;

  for (const [knownQ, knownA] of Object.entries(knownAnswers)) {
    const normKnownQ = normKey(knownQ);
    let score = 0;
    if (normQ === normKnownQ) {
      score = 1;
    } else if (normQ.includes(normKnownQ) || normKnownQ.includes(normQ)) {
      // Sottostringa: accetta SOLO se la domanda più corta copre >=80% dei token
      // di quella più lunga. Senza questo gate, una domanda corta nota hijackava
      // una domanda lunga nuova (falso match a 0.9).
      const tokShort = new Set(tokenize(normQ.length < normKnownQ.length ? normQ : normKnownQ));
      const tokLong  = new Set(tokenize(normQ.length < normKnownQ.length ? normKnownQ : normQ));
      const coverage = tokLong.size > 0 ? (new Set([...tokShort].filter(t => tokLong.has(t))).size / tokLong.size) : 0;
      score = coverage >= 0.8 ? 0.9 : 0;
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

// Promuove nella banca condivisa TRUSTED (known_answers.json) SOLO risposte
// verificate: dalla piattaforma (scrape post-quiz di .risposta-corretta) o
// dall'AI supervisore. I guess Ollama NON passano di qui (vanno in pending).
// Non sovrascrive entry esistenti (l'overwrite esplicito lo fa l'AI via
// answers-cli set). Normalizza le chiavi (normKey) per non duplicare "X" / "1. X".
function mergeIntoKnown(root, newAnswers, log) {
  if (!newAnswers || Object.keys(newAnswers).length === 0) return 0;
  const knownPath = path.join(root, 'data', 'known_answers.json');
  // readJsonSafe: se la banca condivisa è corrotta, non la azzera silenziosamente:
  // lo segnala e parte da {} (perdendo solo il merge di questo run, non tutto).
  let known = readJsonSafe(knownPath, {});
  // Indice delle chiavi normalizzate già presenti (per dedup "X" vs "1. X").
  const existingNorm = new Set(Object.keys(known).map(normKey));
  let added = 0;
  for (const [q, a] of Object.entries(newAnswers)) {
    const nk = normKey(q);
    if (!known[q] && !existingNorm.has(nk)) {
      known[q] = a;
      existingNorm.add(nk);
      added++;
    }
  }
  if (added > 0) {
    try {
      // Scrittura atomica (tmp + rename): un crash a metà non corrompe la banca.
      writeJsonAtomic(knownPath, known);
      log(`Banca trusted aggiornata: +${added} risposte verificate (piattaforma/AI).`);
    } catch (e) {
      log(`Impossibile aggiornare known_answers.json: ${e.message}`);
    }
  }
  return added;
}

// Seede la banca trusted locale (data/known_answers.json) dalla banca condivisa
// (data/known_answers_public.json) se il file locale manca. known_answers.json è
// gitignorato (banca di lavoro mutata a runtime dall'autoplay): su un clone fresco
// è assente e va inizializzato dalla banca pubblica tracciata, altrimenti il primo
// quiz partirebbe con banca vuota. Idempotente: se il file esiste già non fa nulla
// (l'autoplay e update-known-answers.sh lo arricchiscono a runtime).
function ensureKnownBankSeeded(root) {
  const knownPath = path.join(root, 'data', 'known_answers.json');
  if (fs.existsSync(knownPath)) return;
  const publicPath = path.join(root, 'data', 'known_answers_public.json');
  let pub = {};
  try { pub = JSON.parse(fs.readFileSync(publicPath, 'utf8')); } catch (_) { pub = {}; }
  if (pub && Object.keys(pub).length > 0) {
    try { writeJsonAtomic(knownPath, pub); } catch (_) { /* non bloccante */ }
  }
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

// Dedup di una lista di domande per testo domanda (normalizzato): tiene la
// prima occorrenza, ma se una successiva porta più info (es. ha ollamaGuess)
// la fonde nella prima. Usato da saveNeedAnswer e saveAiQuizRequest.
function mergeQuestionList(existing, incoming) {
  const byKey = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || !item.question) continue;
    const k = normKey(item.question);
    if (!byKey.has(k)) {
      byKey.set(k, { ...item });
    } else {
      const prev = byKey.get(k);
      // Arricchisci: se il nuovo ha campi che il vecchio non aveva, copiali.
      for (const f of ['options', 'ollama', 'ollamaGuess']) {
        if (item[f] && !prev[f]) prev[f] = item[f];
      }
    }
  }
  return [...byKey.values()];
}

function saveNeedAnswer(root, questions, reason) {
  if (!questions || questions.length === 0) return;
  const needPath = account.stateFilePaths(root).needAnswer;
  try {
    // Merge (non overwrite): catture multiple nello stesso run non si perdono.
    const prev = fs.existsSync(needPath) ? readJsonSafe(needPath, null) : null;
    const merged = mergeQuestionList(prev && Array.isArray(prev.questions) ? prev.questions : [], questions);
    // Scrittura atomica: il file need_answer è letto dall'AI per intervenire,
    // non deve mai restare troncato a metà.
    writeJsonAtomic(needPath, { reason, questions: merged, savedAt: new Date().toISOString() });
  } catch (e) { /* ignora */ }
}

// Handoff arricchito per l'AI supervisore: per ogni domanda sconosciuta o a
// bassa confidenza salva domanda + opzioni + guess Ollama + confidenza, così
// l'AI può risolvere con WebSearch + ragionamento e scrivere la risposta
// verificata nella banca TRUSTED (answers-cli set). Merge non overwrite.
// Artefatto per-account: data/accounts/<CF>/ai_quiz_request.json.
function saveAiQuizRequest(root, items, reason, ctx) {
  if (!items || items.length === 0) return 0;
  const paths = account.stateFilePaths(root);
  const reqPath = path.join(paths.accountDir, 'ai_quiz_request.json');
  try {
    const prev = fs.existsSync(reqPath) ? readJsonSafe(reqPath, null) : null;
    const merged = mergeQuestionList(prev && Array.isArray(prev.questions) ? prev.questions : [], items);
    writeJsonAtomic(reqPath, {
      reason,
      courseUrl: (ctx && ctx.courseUrl) || null,
      courseId: (ctx && ctx.courseId) || null,
      questions: merged,
      savedAt: new Date().toISOString()
    });
    return merged.length;
  } catch (e) { /* ignora */ }
  return 0;
}

// Rimuove dall'handoff (ai_quiz_request.json + need_answer.json) le domande già
// RISOLTE (aggiunte alla banca trusted). Dopo che l'AI risponde, l'inbox si
// svuota da solo: niente dati stale, niente "reset dimenticato" (l'AI non
// ri-lavora domande già fatte). Matching robusto via normKey (ignora numero
// randomizzato/formattazione). Ritorna quante voci ha rimosso.
function clearResolvedFromHandoff(root, resolvedQuestions) {
  if (!resolvedQuestions || resolvedQuestions.length === 0) return 0;
  const resolvedKeys = new Set(resolvedQuestions.map(q => normKey(q)));
  const paths = account.stateFilePaths(root);
  const files = [path.join(paths.accountDir, 'ai_quiz_request.json'), paths.needAnswer];
  let removed = 0;
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const data = readJsonSafe(f, null);
      if (!data || !Array.isArray(data.questions)) continue;
      const before = data.questions.length;
      const kept = data.questions.filter(q => !resolvedKeys.has(normKey(q.question || '')));
      if (kept.length !== before) {
        removed += before - kept.length;
        writeJsonAtomic(f, { ...data, questions: kept, savedAt: new Date().toISOString() });
      }
    } catch (e) { /* ignora */ }
  }
  return removed;
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
      await page.waitForTimeout(1000);
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
      await page.waitForTimeout(1000);
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
// Riepilogo usciamo SENZA finalizzare (nessun tentativo bruciato). L'AI risolve
// le domande in ai_quiz_request → known_answers, poi il corso viene ritentato e
// finalizzato con tutte le risposte note. Ollama qui serve solo come SUGGERIMENTO
// per l'AI (ollamaGuess), non per finalizzare.
async function solveActiveQuestions(page, root, log, monitor) {
  const sessionAnswers = {};       // risposte scelte in questo quiz (da note)
  const capturedAnswers = {};      // tutte le domande con la risposta scelta
  const aiRequests = [];           // domande incerte → handoff AI
  const knownAnswersPath = path.join(root, 'data', 'known_answers.json');
  ensureKnownBankSeeded(root);
  let uncertainCount = 0;          // domande non note (bloccano la finalizzazione)
  const seenQuestions = new Set(); // per non ri-contare la stessa domanda

  for (let i = 0; i < MAX_QUIZ_QUESTIONS; i++) {
    await page.waitForTimeout(1500);
    await page.waitForSelector('form h1, form h2, form h3, form h4, form h5, .opzione-risposta, button:has-text("Conferma"), button:has-text("Avanti")', { timeout: 10000 }).catch(() => {});

    const isRiepilogo = await page.evaluate(() => document.body.innerText.includes('Riepilogo')).catch(() => false);
    if (isRiepilogo) {
      if (uncertainCount > 0) {
        // GATE: non finalizzare con domande incerte → nessun tentativo consumato.
        log(`Riepilogo raggiunto ma ${uncertainCount} domanda/e NON nota/e: NON finalizzo (non consumo tentativi). Le passo all'AI e riprovo dopo.`);
        if (aiRequests.length > 0) {
          const n = saveAiQuizRequest(root, aiRequests, `quiz sospeso: ${uncertainCount} domande da risolvere (tentativo protetto)`, null);
          log(`[AI_QUIZ_REQUEST] ${n} domande salvate in ai_quiz_request.json per l'AI.`);
        }
        return { sessionAnswers, capturedAnswers, aiRequests, status: 'needs_answers_bailed', uncertainCount };
      }
      log('Riepilogo raggiunto e TUTTE le risposte note: finalizzo (Conferma).');
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
      return { sessionAnswers, capturedAnswers, aiRequests, status: 'no_active_question' };
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
    let ollamaGuess = null;
    try {
      const a = await askQuizQuestion(q.text, q.opts.map(o => o.text), log, root);
      if (a) ollamaGuess = { letter: a.letter, text: a.text, confidence: a.confidence, strategy: a.strategy };
    } catch (_) { /* Ollama è solo un hint: se non risponde, pazienza */ }
    aiRequests.push({ question: q.text, options: q.opts.map(o => o.text), ollamaGuess });
    saveNeedAnswer(root, [{ question: q.text, options: q.opts.map(o => o.text) }], 'domanda non nota (tentativo protetto)');
    // Avanti SENZA rispondere (consentito dalla piattaforma; non finalizza).
    await clickNextButton(page, log);
  }

  log(`ATTENZIONE: raggiunto il tetto di ${MAX_QUIZ_QUESTIONS} domande nel quiz. Esito valutato sulla pagina.`);
  return { sessionAnswers, capturedAnswers, aiRequests, status: 'max_iterations' };
}

// Se solveActiveQuestions ha accumulato domande a bassa confidenza (aiRequests),
// scrive l'handoff ai_quiz_request.json (merge) ed emette il marker di log
// [AI_QUIZ_REQUEST] che il Monitor del supervisore cattura. Non blocca il corso:
// l'AI risolve in autonomia (WebSearch + ragionamento) e popola la banca trusted.
function writeAiRequestIfAny(root, solveResult, reason, courseUrl, log, monitor) {
  const items = solveResult && solveResult.aiRequests ? solveResult.aiRequests : [];
  if (items.length === 0) return;
  let courseId = null;
  if (courseUrl) {
    const m = String(courseUrl).match(/\/corso\/show\/(\d+)/);
    if (m) courseId = m[1];
  }
  const n = saveAiQuizRequest(root, items, reason, { courseUrl, courseId });
  log(`[AI_QUIZ_REQUEST] ${n} domande a bassa confidenza salvate in ai_quiz_request.json per verifica AI (reason: ${reason}).`);
  // phase 'quiz_needs_answers' come segnale morbido: autoplay può poi
  // sovrascriverlo con done/need_help a seconda dell'esito. Il marker di log
  // sopra resta la fonte affidabile per il Monitor.
  try { monitor?.update({ phase: 'quiz_needs_answers' }); } catch (_) {}
}

async function solveQuiz(page, root, log, monitor, courseUrl) {
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
      reason: 'domande non note: non finalizzato per non consumare tentativi (le risolverà l\'AI)'
    };
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
    // NON promuoviamo i guess Ollama (sessionAnswers/capturedAnswers) nella banca
    // trusted: un quiz superato al 24/30 = 80% contiene comunque ~6 risposte
    // SBAGLIATE che, promosse, verrebbero riusate per tutti i colleghi. La banca
    // trusted cresce SOLO da risposte verificate dalla piattaforma (scrape) o
    // dall'AI supervisore. I guess restano in pending_quiz_answers.json.
    const extracted = await extractCorrectAnswers(page);
    if (extracted.length > 0) {
      log(`Scrape post-quiz: ${extracted.length} risposte verificate dalla piattaforma.`);
      const extra = {};
      for (const item of extracted) {
        if (item.question && item.answer) extra[item.question] = item.answer;
      }
      mergeIntoKnown(root, extra, log);
    }
    // Handoff AI per le domande a bassa confidenza: anche se il quiz è superato,
    // l'AI può verificare i guess dubbi e far crescere la banca trusted (opportuno,
    // non bloccante: il corso procede, niente reset).
    writeAiRequestIfAny(root, solveResult, 'quiz superato con domande a bassa confidenza', courseUrl, log, monitor);
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
    // Se la cattura dalla pagina fallisce ma abbiamo le domande negli aiRequests
    // (catturate durante la risoluzione), usiamo quelle per need_answer: così
    // l'AI ha comunque le domande anche se la pagina esito non le espone più.
    if (captured.length === 0 && solveResult.aiRequests && solveResult.aiRequests.length > 0) {
      captured = solveResult.aiRequests.map(r => ({ question: r.question, options: r.options }));
    }
    saveNeedAnswer(root, captured, `quiz non superato (${resultText})`);
    if (captured.length === 0) {
      await dumpQuizDiagnostics(page, root, 'failed_nocapture', finalOutcome.bodyText);
    }
    // Handoff arricchito: ai_quiz_request porta anche i guess Ollama + confidenza.
    writeAiRequestIfAny(root, solveResult, `quiz non superato (${resultText})`, courseUrl, log, monitor);
    return { outcome: 'need_help', passed: false, score: finalScoreText, resultText, reason: 'quiz non superato' };
  }

  log('Quiz in stato ignoto: nessun esito chiaro rilevato. Catturo le domande per sicurezza...');
  monitor?.update({ lastQuizResult: 'ignoto' });
  let captured = await extractQuestionsFromPage(page);
  if (captured.length === 0 && solveResult.aiRequests && solveResult.aiRequests.length > 0) {
    captured = solveResult.aiRequests.map(r => ({ question: r.question, options: r.options }));
  }
  if (captured.length > 0) {
    saveNeedAnswer(root, captured, 'esito quiz non chiaro');
  } else {
    // Nessun esito chiaro E nessuna domanda catturata: lascio artefatti per diagnosi
    // (a prova di bomba: mai un fallimento silenzioso senza poter capire perché).
    await dumpQuizDiagnostics(page, root, 'ignoto_nocapture', finalOutcome.bodyText);
  }
  writeAiRequestIfAny(root, solveResult, 'esito quiz non chiaro', courseUrl, log, monitor);
  return { outcome: 'unknown', passed: false, score: null, resultText: 'ignoto' };
}

module.exports = { solveQuiz, extractScore, detectOutcomeFromText, extractQuestionsFromPage, saveNeedAnswer, saveAiQuizRequest, clearResolvedFromHandoff, dumpQuizDiagnostics, NeedHelpExit, MAX_QUIZ_QUESTIONS };
