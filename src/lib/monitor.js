const fs = require('fs');
const path = require('path');
const { writeJsonAtomic } = require('./io');
const { redactUrl } = require('./logger');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

class Monitor {
  constructor(root, log) {
    this.root = root;
    this.log = log;
    this.logsDir = path.join(root, 'logs');
    this.debugDir = path.join(root, 'debug');
    this.screenshotDir = path.join(this.debugDir, 'screenshots');
    this.dumpDir = path.join(this.debugDir, 'dumps');
    ensureDir(this.logsDir);
    ensureDir(this.screenshotDir);
    ensureDir(this.dumpDir);
    this.startedAt = new Date().toISOString();
    this.status = {
      pid: process.pid,
      startedAt: this.startedAt,
      lastUpdate: this.startedAt,
      phase: 'starting',
      courseUrl: null,
      lessonUrl: null,
      lessonTitle: null,
      videoProgress: null,
      lastQuizResult: null,
      lastError: null,
      uptimeSec: 0,
      headless: true,
      running: true,
      courseStateSummary: null
    };
    this._tick();
  }

  _tick() {
    this._timer = setInterval(() => {
      this.status.uptimeSec = Math.floor((Date.now() - new Date(this.startedAt).getTime()) / 1000);
      this._write();
    }, 5000);
    // unref: il timer non tiene vivo il event loop. Se mai runAutoplay dovesse
    // terminare "naturalmente" senza process.exit, il processo può uscire.
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _write() {
    this.status.lastUpdate = new Date().toISOString();
    this.status.pid = process.pid;
    try {
      // Scrittura atomica: uno status.json troncato confonderebbe il supervisore.
      writeJsonAtomic(path.join(this.logsDir, 'status.json'), this.status);
    } catch (e) {
      // non bloccante
    }
  }

  update(updates) {
    Object.assign(this.status, updates);
    this.status.lastUpdate = new Date().toISOString();
    this._write();
  }

  async recordError(page, error, context = '') {
    // redactUrl: i message di Playwright possono contenere l'URL di autologin
    // completo; lastError finisce in logs/status.json (letto anche dall'AI e
    // citato negli issue report).
    const msg = redactUrl(context ? `${context}: ${error?.message || error}` : String(error?.message || error));
    this.log('MONITOR ERROR', msg);
    this.update({ phase: 'error', lastError: msg });
    const stamp = ts();
    try {
      if (page) {
        const htmlPath = path.join(this.dumpDir, `error_${stamp}.html`);
        const pngPath = path.join(this.screenshotDir, `error_${stamp}.png`);
        fs.writeFileSync(htmlPath, await page.content().catch(() => 'Unable to dump HTML'));
        await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
        this.log(`Debug artifacts saved: ${htmlPath}, ${pngPath}`);
      }
    } catch (e) {
      this.log('Failed to save debug artifacts:', e.message);
    }
  }
}

module.exports = { Monitor };
