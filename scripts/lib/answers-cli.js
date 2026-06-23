#!/usr/bin/env node
/**
 * answers-cli.js — gestione della banca risposte condivisa (data/known_answers.json).
 *
 * Strumento per il MANUTENTORE (chi prepara i rilasci per i colleghi). Serve ad arricchire
 * la banca condivisa con le risposte raccolte dalle macchine, prima di un nuovo rilascio.
 *
 * Comandi:
 *   node scripts/lib/answers-cli.js stats
 *       Mostra quante risposte note, pending e in attesa ci sono.
 *
 *   node scripts/lib/answers-cli.js list
 *       Elenca le domande note (troncate).
 *
 *   node scripts/lib/answers-cli.js merge
 *       Aggiunge a known_answers.json le risposte presenti in pending_quiz_answers.json
 *       che non sono già note (non sovrascrive le esistenti). Stampa cosa ha aggiunto.
 *
 *   node scripts/lib/answers-cli.js set "testo domanda" "testo risposta"
 *       Aggiunge/aggiorna manualmente una risposta nota.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const KNOWN = path.join(DATA, 'known_answers.json');
const PENDING = path.join(DATA, 'pending_quiz_answers.json');
const NEED = path.join(DATA, 'need_answer.json');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

const cmd = process.argv[2] || 'stats';

if (cmd === 'stats') {
  const known = readJson(KNOWN, {});
  const pending = readJson(PENDING, {});
  const need = readJson(NEED, null);
  console.log(`Risposte note (known_answers.json):   ${Object.keys(known).length}`);
  console.log(`Risposte pending (da verificare):     ${Object.keys(pending).length}`);
  console.log(`In attesa di intervento (need_answer): ${need ? 1 : 0}`);
  if (need && need.question) console.log(`  → "${String(need.question).slice(0, 80)}"`);
} else if (cmd === 'list') {
  const known = readJson(KNOWN, {});
  Object.entries(known).forEach(([q, a], i) => {
    console.log(`${String(i + 1).padStart(3)}. ${q.slice(0, 70)}  →  ${String(a).slice(0, 40)}`);
  });
  console.log(`\nTotale: ${Object.keys(known).length} risposte note.`);
} else if (cmd === 'merge') {
  const known = readJson(KNOWN, {});
  const pending = readJson(PENDING, {});
  let added = 0;
  const addedList = [];
  for (const [q, a] of Object.entries(pending)) {
    if (!known[q]) { known[q] = a; added++; addedList.push(q); }
  }
  if (added > 0) {
    writeJson(KNOWN, known);
    console.log(`Aggiunte ${added} risposte alla banca condivisa:`);
    addedList.forEach(q => console.log(`  + ${q.slice(0, 80)}`));
    console.log('\nRicontrolla che siano corrette prima di rilasciare il pacchetto ai colleghi.');
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
  known[q] = a;
  writeJson(KNOWN, known);
  console.log(`Salvata: "${q.slice(0, 70)}" → "${a.slice(0, 50)}"`);
} else {
  console.error(`Comando sconosciuto: ${cmd}\nComandi: stats | list | merge | set`);
  process.exit(1);
}
