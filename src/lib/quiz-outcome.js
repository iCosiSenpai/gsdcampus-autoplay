/**
 * quiz-outcome.js — parsing esito quiz (punteggio / superato).
 * Pure: nessuna I/O, usabile dai test.
 */

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

module.exports = { extractScore, scoreLooksPassing, detectOutcomeFromText };
