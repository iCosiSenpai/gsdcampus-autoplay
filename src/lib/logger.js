const fs = require('fs');
const path = require('path');

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(logFile) {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size < MAX_LOG_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fs.renameSync(logFile, path.join(path.dirname(logFile), `autoplay.${stamp}.log`));
  } catch (e) {
    // log non esiste ancora
  }
}

// redactUrl(u): rimuove le credenziali da un URL prima che finisca nei log.
// Il link di autologin (/autologin/<CF>/<token>) è una credenziale permanente:
// loggarlo in chiaro in logs/autoplay.log lo espone a chiunque legga i log
// (inclusi dump diagnostici e issue report). Redige anche query token/key/auth.
// Puro e infallibile: su qualsiasi errore ritorna l'input com'era.
function redactUrl(u) {
  try {
    let s = String(u);
    // /autologin/<CF>/<token>[...] → /autologin/<CF>/[REDATTO]
    s = s.replace(/(\/autologin\/[^/?#]+\/)[^/?#]+/gi, '$1[REDATTO]');
    // query ?token=..., &key=..., &auth...=...
    s = s.replace(/([?&](?:token|key|auth[^=&]*)=)[^&#]*/gi, '$1[REDATTO]');
    return s;
  } catch (e) {
    return u;
  }
}

function createLogger(root) {
  const logsDir = path.join(root, 'logs');
  ensureDir(logsDir);
  const logFile = path.join(logsDir, 'autoplay.log');
  const heartbeatFile = path.join(logsDir, 'heartbeat.txt');

  function log(...args) {
    // redactUrl sull'intera riga: gli errori di Playwright (es. TimeoutError su
    // page.goto) includono l'URL di autologin COMPLETO nel message — passano dai
    // catch (`log(e.message)`) e finivano in chiaro nei log anche con i singoli
    // punti di log già redatti. La redazione centrale copre ogni percorso.
    const line = redactUrl(`${new Date().toLocaleTimeString('it-IT')} | ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}`) + '\n';
    process.stdout.write(line);
    rotateIfNeeded(logFile);
    // Le scritture su file non devono MAI propagare eccezioni (disco pieno,
    // permessi rotti): log() è chiamato anche fuori da try block, e un'eccezione
    // qui diventerebbe un uncaughtException fatale senza cleanup del browser.
    try { fs.appendFileSync(logFile, line); } catch (e) {
      try { process.stderr.write(`[logger] append fallito: ${e.message}\n`); } catch (_) {}
    }
    try { fs.writeFileSync(heartbeatFile, `Last active: ${new Date().toLocaleTimeString('it-IT')} (${new Date().toISOString()})`); } catch (e) {
      try { process.stderr.write(`[logger] heartbeat fallito: ${e.message}\n`); } catch (_) {}
    }
  }

  return log;
}

module.exports = { createLogger, redactUrl };
