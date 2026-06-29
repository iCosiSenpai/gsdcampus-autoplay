#!/usr/bin/env node
/**
 * import-members.js — CLI per importare l'elenco membri (CSV) nel database SQLite.
 *
 * Uso:
 *   node scripts/import-members.js [path-csv]
 *
 * Default: ~/Downloads/elenco utenti FNC.csv
 * Exit code: 0 ok | 1 file mancante | 2 zero righe valide
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const { importCsv } = require(path.join(ROOT, 'src', 'lib', 'import-csv'));
const { countMembers } = require(path.join(ROOT, 'src', 'lib', 'db'));

const csvPath = process.argv[2] || path.join(os.homedir(), 'Downloads', 'elenco utenti FNC.csv');

if (!fs.existsSync(csvPath)) {
  console.error(`File CSV non trovato: ${csvPath}`);
  console.error('Esporta l\'elenco da Numbers: File ▸ Esporta ▸ CSV, poi passa il percorso come argomento.');
  process.exit(1);
}

const res = importCsv(ROOT, csvPath);
console.log(`Import membri da: ${csvPath}`);
console.log(`  Importati : ${res.imported}`);
console.log(`  Saltati   : ${res.skipped}`);
if (res.errors.length) {
  console.log(`  Errori    : ${res.errors.length}`);
  res.errors.slice(0, 20).forEach(e => console.log(`    - ${e}`));
  if (res.errors.length > 20) console.log(`    ... e altri ${res.errors.length - 20}`);
}
console.log(`Totale membri nel database: ${countMembers(ROOT)}`);

if (res.imported === 0) process.exit(2);
process.exit(0);