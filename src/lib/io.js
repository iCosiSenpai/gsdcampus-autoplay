/**
 * io.js — primitive di I/O sicure per file di stato JSON.
 *
 * - writeJsonAtomic(file, obj): scrive via tmp + rename (atomico sullo stesso
 *   filesystem). Un crash/kill/SIGTERM a metà scrittura non lascia il file
 *   troncato: resta l'ultima versione integra finché il rename non avviene.
 * - readJsonSafe(file, fallback): legge e parsea, ritorna `fallback` (default
 *   {}) se il file non esiste o è corrotto, loggando il problema.
 *
 * Usato da course-state, quiz, monitor, dashboard, autoplay per tutti gli
 * stati persistenti critici (course_state, known_answers, status, dashboard,
 * session_state, need_answer, pending).
 */

const fs = require('fs');
const path = require('path');

function writeJsonAtomic(file, obj, indent = 2) {
  const dir = path.dirname(file);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* esiste già */ }
  const tmp = file + '.tmp';
  // Scrive su file temporaneo poi rename atomico. Stesso filesystem → rename
  // è atomico su POSIX: nessuna finestra in cui il file destino è troncato.
  fs.writeFileSync(tmp, JSON.stringify(obj, null, indent));
  fs.renameSync(tmp, file);
}

function readJsonSafe(file, fallback = {}, opts = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const missing = e && e.code === 'ENOENT';
    if (!missing && opts.warn !== false) {
      // File esiste ma non parsea: corrotto. Non silenzioso.
      try { process.stderr.write(`[io] file JSON corrotto, uso fallback: ${file} (${e.message})\n`); } catch (_) {}
    }
    return fallback;
  }
}

module.exports = { writeJsonAtomic, readJsonSafe };