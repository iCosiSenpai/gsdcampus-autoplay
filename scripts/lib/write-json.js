#!/usr/bin/env node
/**
 * write-json.js — helper riusabile per scritture JSON atomiche dai CLI in
 * scripts/lib/. Mirror shell-side di src/lib/io.js#writeJsonAtomic.
 *
 * Perché atomico: i CLI (members-cli, whoareyou-cli, setup) scrivono file
 * critici (config.json, .members_last_list.json). Una scrittura non atomica
 * interrotta a metà (SIGTERM/SIGINT/kill -9 durante setup) lascerebbe il file
 * troncato/corrotto. tmp+renameSync è atomico sullo stesso filesystem: o
 * c'è il vecchio o il nuovo, mai un file a metà.
 *
 * Uso come modulo:
 *   const { writeJsonAtomic, readJsonSafe } = require('./write-json');
 *   writeJsonAtomic('/path/config.json', obj);
 *
 * Uso da CLI (scrive su <path> il JSON passato via stdin):
 *   echo '{"a":1}' | node scripts/lib/write-json.js /path/file.json
 */

const fs = require('fs');
const path = require('path');

function writeJsonAtomic(file, obj, indent = 2) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* esiste già */ }
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback = {}, opts = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const missing = e && e.code === 'ENOENT';
    if (!missing && opts.warn !== false) {
      try { process.stderr.write(`[write-json] file JSON corrotto, uso fallback: ${file} (${e.message})\n`); } catch (_) {}
    }
    return fallback;
  }
}

// Se invocato come `node write-json.js <path>`: legge JSON da stdin e lo scrive
// atomicamente. Comodo per gli script shell che hanno già il JSON in una stringa.
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    process.stderr.write('Uso: node write-json.js <path>  (JSON letto da stdin)\n');
    process.exit(2);
  }
  let chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const obj = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      writeJsonAtomic(target, obj);
    } catch (e) {
      process.stderr.write(`[write-json] stdin non è JSON valido: ${e.message}\n`);
      process.exit(1);
    }
  });
  process.stdin.on('error', e => {
    process.stderr.write(`[write-json] errore lettura stdin: ${e.message}\n`);
    process.exit(1);
  });
}

module.exports = { writeJsonAtomic, readJsonSafe };