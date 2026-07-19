/**
 * quiz-bank.js — banca TRUSTED locale (known_answers.json) + seed da public.
 */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./io');
const { normKey } = require('./quiz-match');

function mergeIntoKnown(root, newAnswers, log) {
  if (!newAnswers || Object.keys(newAnswers).length === 0) return 0;
  const knownPath = path.join(root, 'data', 'known_answers.json');
  let known = readJsonSafe(knownPath, {});
  const existingNorm = new Set(Object.keys(known).map(normKey));
  let added = 0;
  for (const [qq, a] of Object.entries(newAnswers)) {
    const nk = normKey(qq);
    if (!known[qq] && !existingNorm.has(nk)) {
      known[qq] = a;
      existingNorm.add(nk);
      added++;
    }
  }
  if (added > 0) {
    try {
      writeJsonAtomic(knownPath, known);
      log(`Banca trusted aggiornata: +${added} risposte verificate (piattaforma/AI).`);
    } catch (e) {
      log(`Impossibile aggiornare known_answers.json: ${e.message}`);
    }
  }
  return added;
}

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

module.exports = { mergeIntoKnown, ensureKnownBankSeeded };
