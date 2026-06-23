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

function createLogger(root) {
  const logsDir = path.join(root, 'logs');
  ensureDir(logsDir);
  const logFile = path.join(logsDir, 'autoplay.log');
  const heartbeatFile = path.join(logsDir, 'heartbeat.txt');

  function log(...args) {
    const line = `${new Date().toLocaleTimeString('it-IT')} | ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
    process.stdout.write(line);
    rotateIfNeeded(logFile);
    fs.appendFileSync(logFile, line);
    fs.writeFileSync(heartbeatFile, `Last active: ${new Date().toLocaleTimeString('it-IT')} (${new Date().toISOString()})`);
  }

  return log;
}

module.exports = { createLogger };
