const fs = require('fs');
const path = require('path');
const { askQuizQuestion } = require('./ollama-quiz');

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Promuove nella banca condivisa (known_answers.json) solo le risposte date da Ollama in
// QUESTO quiz, e solo se il quiz è stato superato. Così la banca cresce esclusivamente con
// risposte verificate dall'esito reale, non con guess non confermati.
function promoteVerifiedAnswers(root, sessionAnswers, log) {
  const keys = Object.keys(sessionAnswers);
  if (keys.length === 0) return 0;
  const knownPath = path.join(root, 'data', 'known_answers.json');
  let known = {};
  try { known = JSON.parse(fs.readFileSync(knownPath, 'utf8')); } catch (e) { /* parte vuota */ }
  let added = 0;
  for (const [q, a] of Object.entries(sessionAnswers)) {
    if (!known[q]) { known[q] = a; added++; }
  }
  if (added > 0) {
    try {
      fs.writeFileSync(knownPath, JSON.stringify(known, null, 2));
      log(`Banca risposte aggiornata: +${added} risposte verificate (quiz superato).`);
    } catch (e) {
      log(`Impossibile aggiornare known_answers.json: ${e.message}`);
    }
  }
  return added;
}

function extractScore(text) {
  const t = (text || '').toLowerCase();
  const pct = t.match(/(\d{1,3}([.,]\d+)?)\s*%/);
  const frac = t.match(/(\d+)\s*\/\s*(\d+)/);
  if (pct) return `${pct[1]}%`;
  if (frac) return `${frac[1]}/${frac[2]}`;
  return null;
}

async function solveQuiz(page, root, log, monitor) {
  const knownAnswersPath = path.join(root, 'data', 'known_answers.json');
  // Risposte fornite da Ollama in questa sessione di quiz, da promuovere solo se si supera.
  const sessionAnswers = {};
  log('Rilevato questionario. Inizio risoluzione autonoma...');
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Verifica se siamo nella dashboard del quiz (bottone "Avvia compilazione")
  const startBtn = page.locator('a.btn-primary, button.btn-primary').filter({ hasText: /avvia compilazione/i }).first();
  if (await startBtn.isVisible().catch(() => false)) {
    log("Trovato bottone 'Avvia compilazione'. Clicco per iniziare...");
    await startBtn.click();
    await page.waitForTimeout(3000);
  }

  for (let i = 0; i < 50; i++) {
    await page.waitForTimeout(2000);
    await page.waitForSelector('form h4, .opzione-risposta, button:has-text("Conferma"), text="Riepilogo"', { timeout: 10000 }).catch(() => {});

    const isRiepilogo = await page.evaluate(() => document.body.innerText.includes('Riepilogo')).catch(() => false);
    if (isRiepilogo) {
      log('Riepilogo raggiunto. Clicco Conferma...');
      const confirmBtn = page.locator('button:has-text("Conferma")').first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(5000);
        if (await page.evaluate(() => document.querySelector('form h4')).catch(() => false)) continue;
        else break;
      }
    }

    const q = await page.evaluate(() => {
      const h4 = document.querySelector('form h4');
      if (!h4) return null;
      const text = h4.innerText.trim();
      const opts = Array.from(document.querySelectorAll('.opzione-risposta')).map((c, idx) => {
        const p = c.querySelector('p');
        return { text: p ? p.innerText.trim() : c.innerText.trim(), index: idx };
      });
      return { text, opts };
    }).catch(() => null);

    if (!q || !q.text) {
      log('Nessuna domanda trovata. Verifico esito...');
      const outcome = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const low = text.toLowerCase();
        const passed = low.includes('superato') || low.includes('idoneo');
        const failed = low.includes('non superato') || low.includes('non idoneo');
        return { bodyText: text.slice(0, 2000), passed: passed && !failed, failed };
      }).catch(() => ({ passed: false, failed: false, bodyText: '' }));

      const score = extractScore(outcome.bodyText);

      if (outcome.passed) {
        const result = score ? `superato (${score})` : 'superato';
        log(`Quiz terminato con successo! Esito: ${result}`);
        monitor?.update({ lastQuizResult: result });
        promoteVerifiedAnswers(root, sessionAnswers, log);
        return true;
      }

      if (outcome.failed) {
        const result = score ? `non superato (${score})` : 'non superato';
        log(`Quiz NON superato. Esito: ${result}. Le risposte di Ollama non vengono promosse.`);
        monitor?.update({ lastQuizResult: result });
        return false;
      }

      log('Quiz non completato o in stato ignoto.');
      monitor?.update({ lastQuizResult: 'ignoto' });
      return false;
    }

    log(`Domanda ${i + 1}: ${q.text.slice(0, 60)}...`);

    let knownAnswers = {};
    try {
      knownAnswers = JSON.parse(fs.readFileSync(knownAnswersPath, 'utf8'));
    } catch (e) {
      log('Attenzione: known_answers.json non leggibile', e.message);
    }

    const normQ = normalize(q.text);
    let found = false;

    for (const [knownQ, knownA] of Object.entries(knownAnswers)) {
      if (normQ.includes(normalize(knownQ)) || normalize(knownQ).includes(normQ)) {
        const normA = normalize(knownA);
        const optIndex = q.opts.findIndex(o => normalize(o.text).includes(normA) || normA.includes(normalize(o.text)));

        if (optIndex !== -1) {
          log(`Risposta nota: ${knownA.slice(0, 50)}...`);
          await page.locator('.opzione-risposta').nth(optIndex).click();
          await page.waitForTimeout(500);
          await page.getByRole('button', { name: /avanti/i }).first().click();
          found = true;
          break;
        }
      }
    }

    if (!found) {
      log(`!!! DOMANDA SCONOSCIUTA: ${q.text}`);
      log('Provo a chiedere a Ollama (modello cloud) la risposta...');

      const ollamaAnswer = await askQuizQuestion(q.text, q.opts.map(o => o.text), log);

      if (ollamaAnswer) {
        log(`Ollama suggerisce: ${ollamaAnswer.letter}) ${ollamaAnswer.text.slice(0, 50)}...`);
        await page.locator('.opzione-risposta').nth(q.opts.findIndex(o => o.text === ollamaAnswer.text)).click();
        await page.waitForTimeout(500);
        await page.getByRole('button', { name: /avanti/i }).first().click();
        found = true;
        sessionAnswers[q.text] = ollamaAnswer.text;

        // Salva la risposta data in modo che possa essere verificata/aggiornata
        try {
          const pendingPath = path.join(root, 'data', 'pending_quiz_answers.json');
          const pending = fs.existsSync(pendingPath) ? JSON.parse(fs.readFileSync(pendingPath, 'utf8')) : {};
          pending[q.text] = ollamaAnswer.text;
          fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
        } catch (e) { /* ignora */ }
      }
    }

    if (!found) {
      log("Sospendo l'automazione per intervento dell'agente.");
      fs.writeFileSync(path.join(root, 'data', 'need_answer.json'), JSON.stringify({ question: q.text, options: q.opts.map(o => o.text) }, null, 2));
      process.exit(2);
    }
  }
  return false;
}

module.exports = { solveQuiz };
