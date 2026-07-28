#!/usr/bin/env node
/**
 * undef-probe.js — cerca gli helper dei NOSTRI moduli usati in un file senza
 * essere stati importati. Gate per dev-check.
 *
 * Perché esiste: un `require` dimenticato non lo becca né `node --check` (la
 * sintassi è valida) né i test unitari (il codice sta dentro funzioni che girano
 * solo col browser). Ed è arrivato in produzione: `ReferenceError: isLessonUrl
 * is not defined` faceva crashare OGNI corso su tutti i Mac della flotta.
 *
 * Come funziona: raccoglie i nomi esportati da src/lib/*.js e src/*.js, poi per
 * ogni file controlla se un nome è chiamato come funzione (`nome(`) senza essere
 * dichiarato localmente né destrutturato da un require/import. Euristica
 * volutamente prudente: guarda solo i NOSTRI simboli, quindi zero rumore da
 * globali di Node o del browser.
 *
 * Uso: node scripts/lib/undef-probe.js [--json]
 * Exit 0 = nessun sospetto · 1 = trovati usi non importati.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = [
  ['src'], ['src', 'lib'], ['scripts'], ['scripts', 'lib'],
];

function listJs(dirParts) {
  const dir = path.join(ROOT, ...dirParts);
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

const SELF = path.join(ROOT, 'scripts', 'lib', 'undef-probe.js');
const files = [...new Set(SCAN_DIRS.flatMap(listJs))].filter((f) => f !== SELF);

/** Via commenti e stringhe: gli esempi nei commenti non sono codice. */
function stripNoise(code) {
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

// 1. Nomi esportati dai nostri moduli (blocco module.exports oppure exports.nome = …).
const ourExports = new Set();
for (const file of files) {
  const code = stripNoise(fs.readFileSync(file, 'utf8'));
  const block = code.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/);
  if (block) {
    for (const raw of block[1].split(',')) {
      const name = raw.split(':')[0].replace(/\/\/.*$/gm, '').trim();
      if (/^[A-Za-z_$][\w$]{2,}$/.test(name)) ourExports.add(name);   // >=3 caratteri: gli helper hanno nomi parlanti
    }
  }
  for (const m of code.matchAll(/exports\.([A-Za-z_$][\w$]*)\s*=/g)) ourExports.add(m[1]);
}

// 2. Per ogni file: nomi disponibili (require destrutturati, dichiarazioni,
//    parametri) vs nomi dei nostri helper chiamati come funzione.
const problems = [];
for (const file of files) {
  const code = stripNoise(fs.readFileSync(file, 'utf8'));
  const available = new Set();

  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().trim();
      if (name) available.add(name);
    }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) available.add(m[1]);
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) available.add(m[1]);
  for (const m of code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) available.add(m[1]);
  // Parametri di funzione e destrutturazioni generiche: prudenza, li accettiamo tutti.
  for (const m of code.matchAll(/\(([^)]*)\)\s*(?:=>|\{)/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.replace(/[{}[\]]/g, '').split(/[:=]/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) available.add(name);
    }
  }
  for (const m of code.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const raw of m[1].split(',')) {
      const name = raw.split(':').pop().split('=')[0].trim();
      if (name) available.add(name);
    }
  }

  const used = new Map();
  for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (!ourExports.has(name) || available.has(name)) continue;
    if (!used.has(name)) {
      const line = code.slice(0, m.index).split('\n').length;
      used.set(name, line);
    }
  }
  for (const [name, line] of used) {
    problems.push({ file: path.relative(ROOT, file), name, line });
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(problems, null, 2));
} else if (problems.length === 0) {
  console.log(`Nessun helper usato senza import (${files.length} file controllati).`);
} else {
  for (const p of problems) {
    console.log(`${p.file}:${p.line}  usa ${p.name}() senza importarlo`);
  }
}
process.exit(problems.length === 0 ? 0 : 1);
