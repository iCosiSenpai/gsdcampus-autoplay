#!/usr/bin/env node
/**
 * answers-cli.js — gestione della banca risposte condivisa (data/known_answers.json).
 *
 * Strumento per il MANUTENTORE e l'AI supervisore. La banca known_answers.json è
 * TRUSTED: cresce solo con risposte verificate dalla piattaforma (scrape post-quiz)
 * o fornite dall'AI supervisore (WebSearch + ragionamento). I guess Ollama NON
 * vengono mai promossi automaticamente (restano in pending_quiz_answers.json).
 *
 * Comandi:
 *   node scripts/lib/answers-cli.js stats
 *       Mostra risposte note (trusted), pending (guess Ollama, per-account) e
 *       richieste AI in attesa (ai_quiz_request, per-account). Legge i path
 *       per-account dell'account attivo (CF da config.json) oltre ai legacy flat.
 *
 *   node scripts/lib/answers-cli.js list
 *       Elenca le domande note (troncate).
 *
 *   node scripts/lib/answers-cli.js merge
 *       Aggiunge a known_answers.json le risposte presenti in pending_quiz_answers.json
 *       (per-account) che non sono già note (non sovrascrive). Stampa cosa ha aggiunto.
 *       NOTA: i pending sono guess Ollama NON verificati — usare con cautela, solo
 *       dopo averli controllati. Scrittura atomica.
 *
 *   node scripts/lib/answers-cli.js set "testo domanda" "testo risposta"
 *       Aggiunge/aggiorna (overwrite) una risposta trusted. È il canale con cui
 *       l'AI supervisore scrive le risposte verificate nella banca condivisa.
 *       Scrittura atomica.
 *
 *   node scripts/lib/answers-cli.js audit
 *       Elenca le voci della banca trusted (utile per il cleanup: le voci storiche
 *       promosse in passato da guess Ollama andrebbero verificate con WebSearch).
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'io'));
const account = require(path.join(__dirname, '..', '..', 'src', 'lib', 'account'));

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const KNOWN = path.join(DATA, 'known_answers.json');

// Path per-account dell'account attivo (CF da config.json), con fallback ai
// legacy flat in data/ se il CF non è determinabile.
function perAccountPaths() {
  const paths = account.stateFilePaths(ROOT);
  return {
    pending: paths.pending,
    needAnswer: paths.needAnswer,
    aiRequest: path.join(paths.accountDir, 'ai_quiz_request.json'),
    cf: paths.codiceFiscale
  };
}

function readJson(p, fallback) { return readJsonSafe(p, fallback); }

const cmd = process.argv[2] || 'stats';

if (cmd === 'stats') {
  const known = readJson(KNOWN, {});
  const pa = perAccountPaths();
  const pending = readJson(pa.pending, {});
  const need = readJson(pa.needAnswer, null);
  const aiReq = readJson(pa.aiRequest, null);
  const knownCount = Object.keys(known).filter(k => !String(k).startsWith('README')).length;
  console.log(`Risposte trusted (known_answers.json):    ${knownCount}`);
  console.log(`Pending guess Ollama (per-account${pa.cf ? ' ' + pa.cf : ' (legacy)'}): ${Object.keys(pending).length}  [${pa.pending}]`);
  console.log(`Richieste AI in attesa (ai_quiz_request):  ${aiReq && Array.isArray(aiReq.questions) ? aiReq.questions.length : 0}  [${pa.aiRequest}]`);
  console.log(`need_answer.json:                          ${need ? (Array.isArray(need.questions) ? need.questions.length : 1) : 0}  [${pa.needAnswer}]`);
  if (aiReq && Array.isArray(aiReq.questions) && aiReq.questions.length > 0) {
    console.log(`  → reason: ${aiReq.reason || '?'}`);
    aiReq.questions.slice(0, 5).forEach(q => {
      const g = q.ollamaGuess;
      const guess = g ? ` (guess Ollama: ${g.letter || '?'} conf ${(g.confidence != null ? Math.round(g.confidence * 100) : '?')}%)` : ' (nessun guess)';
      console.log(`    • ${String(q.question).slice(0, 70)}${guess}`);
    });
  }
} else if (cmd === 'list') {
  const known = readJson(KNOWN, {});
  Object.entries(known).forEach(([q, a], i) => {
    console.log(`${String(i + 1).padStart(3)}. ${q.slice(0, 70)}  →  ${String(a).slice(0, 40)}`);
  });
  console.log(`\nTotale: ${Object.keys(known).length} risposte note.`);
} else if (cmd === 'merge') {
  const known = readJson(KNOWN, {});
  const pa = perAccountPaths();
  const pending = readJson(pa.pending, {});
  let added = 0;
  const addedList = [];
  for (const [q, a] of Object.entries(pending)) {
    if (!known[q]) { known[q] = a; added++; addedList.push(q); }
  }
  if (added > 0) {
    writeJsonAtomic(KNOWN, known);
    console.log(`Aggiunte ${added} risposte (pending→trusted) alla banca condivisa:`);
    addedList.forEach(q => console.log(`  + ${q.slice(0, 80)}`));
    console.log('\nATTENZIONE: i pending sono guess Ollama NON verificati. Ricontrolla che siano corrette prima di rilasciare il pacchetto ai colleghi.');
  } else {
    console.log('Nessuna nuova risposta da aggiungere (le pending sono già note o assenti).');
  }
} else if (cmd === 'set') {
  const q = process.argv[3];
  const a = process.argv[4];
  if (!q || !a) {
    console.error('Uso: node scripts/lib/answers-cli.js set "testo domanda" "testo risposta"');
    process.exit(1);
  }
  const known = readJson(KNOWN, {});
  known[q] = a; // overwrite: l'AI supervisore corregge anche risposte sbagliate
  writeJsonAtomic(KNOWN, known);
  console.log(`Salvata (trusted): "${q.slice(0, 70)}" → "${a.slice(0, 50)}"`);
} else if (cmd === 'audit') {
  const known = readJson(KNOWN, {});
  const entries = Object.entries(known).filter(([q]) => !String(q).startsWith('README'));
  console.log(`Voci banca trusted: ${entries.length}`);
  console.log('Queste voci dovrebbero essere verificate (piattaforma-scrape o AI).');
  console.log('Le voci storiche promosse da guess Ollama (pre-redesign) vanno controllate con WebSearch.\n');
  entries.forEach(([q, a], i) => {
    console.log(`${String(i + 1).padStart(3)}. ${q.slice(0, 80)}  →  ${String(a).slice(0, 40)}`);
  });
} else {
  console.error(`Comando sconosciuto: ${cmd}\nComandi: stats | list | merge | set | audit`);
  process.exit(1);
}