/**
 * status-reconcile.js — allinea logs/status.json alla realtà dei processi.
 *
 * Problema: running:true e phase "video"/"quiz" restano su disco dopo crash,
 * stop incompleto o smoke test Monitor → l'AI crede che il corso giri ancora.
 *
 * Se nessuno scheduler/autoplay è vivo: running=false e phase attive → stopped.
 * Se un processo è vivo: no-op.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { writeJsonAtomic, readJsonSafe } = require('./io');

/** Fasi che indicano un run IN CORSO (non terminali). */
const ACTIVE_PHASES = new Set([
  'starting',
  'checking',
  'lesson',
  'video',
  'quiz',
  'quiz_dashboard',
  'quiz_needs_answers',
  // residuali / smoke
  'running',
]);

/** Fasi terminali: non le rinominiamo (restano informative). */
const TERMINAL_PHASES = new Set([
  'stopped',
  'done',
  'need_help',
  'off_hours',
  'fatal',
  'idle',
  'autologin_invalid',
  'session_lost',
  'session_unstable',
  'post_login_blocked',
  'crash_loop',
  'error',
  'all_need_help',
]);

function isActivePhase(phase) {
  if (phase == null || phase === '') return false;
  const p = String(phase);
  if (TERMINAL_PHASES.has(p)) return false;
  if (ACTIVE_PHASES.has(p)) return true;
  // Sconosciuta ma running: trattala come attiva se non terminale
  return true;
}

/**
 * Pure: riconcilia un oggetto status in memoria.
 * @param {object} status
 * @param {{ processAlive: boolean, forceStopped?: boolean }} opts
 * @returns {{ status: object, changed: boolean, reason: string|null }}
 */
function reconcileStatusObject(status, opts = {}) {
  // forceStopped: dopo stop.sh, non fidarsi di pgrep residui.
  const processAlive = opts.forceStopped ? false : !!opts.processAlive;
  const base = status && typeof status === 'object' ? { ...status } : {};
  let changed = false;
  let reason = null;

  if (processAlive) {
    return { status: base, changed: false, reason: null };
  }

  // Processo non vivo.
  if (base.running) {
    base.running = false;
    changed = true;
    reason = 'running_orphaned';
  }

  if (isActivePhase(base.phase)) {
    base.phase = 'stopped';
    changed = true;
    reason = reason || 'active_phase_orphaned';
  }

  // running false ma phase attiva e status vecchio: stessa correzione
  // (già coperto da isActivePhase sopra)

  if (changed) {
    base.lastUpdate = new Date().toISOString();
    base.note = 'Processo non attivo: status riconciliato (running/phase non riflettevano un run vivo).';
  }

  return { status: base, changed, reason };
}

function readPidFile(root) {
  try {
    const raw = fs.readFileSync(path.join(root, '.autoplay_pid'), 'utf8').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
  } catch (_) {
    return null;
  }
}

function commandForPid(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return String(out || '').trim();
  } catch (_) {
    return '';
  }
}

function pidAliveMatching(pid, patternRe) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (_) {
    return false;
  }
  const cmd = commandForPid(pid);
  if (!cmd) return false;
  return patternRe.test(cmd);
}

/**
 * True se gira scheduler o autoplay.js (path-indipendente).
 * Non matcha autoplay.log.
 */
function isAnyAutomationAlive(root) {
  const r = root || path.join(__dirname, '..', '..');
  const pid = readPidFile(r);
  if (pidAliveMatching(pid, /scheduler|autoplay\.js/i)) return true;

  // Fallback: scansiona processi (macOS/Linux).
  try {
    const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
      encoding: 'utf8',
      timeout: 3000,
      maxBuffer: 2 * 1024 * 1024,
    });
    for (const line of out.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const cmd = m[2];
      if (/autoplay\.js/.test(cmd) && !/autoplay\.log/.test(cmd)) return true;
      if (/scheduler\.sh/.test(cmd)) return true;
    }
  } catch (_) { /* ps non disponibile */ }

  return false;
}

/**
 * Legge e, se serve, riscrive logs/status.json.
 * @param {string} root
 * @param {{ processAlive?: boolean, forceStopped?: boolean }} [opts]
 *   Se processAlive è undefined, viene calcolato con isAnyAutomationAlive.
 */
function reconcileStatusFile(root, opts = {}) {
  const r = root || path.join(__dirname, '..', '..');
  const statusPath = path.join(r, 'logs', 'status.json');
  const current = readJsonSafe(statusPath, null);
  if (!current || typeof current !== 'object') {
    return { changed: false, status: current, reason: null };
  }

  let processAlive = opts.processAlive;
  if (opts.forceStopped) processAlive = false;
  else if (processAlive === undefined) processAlive = isAnyAutomationAlive(r);

  const { status, changed, reason } = reconcileStatusObject(current, {
    processAlive: !!processAlive,
    forceStopped: !!opts.forceStopped,
  });

  if (changed) {
    try {
      writeJsonAtomic(statusPath, status);
    } catch (_) {
      return { changed: false, status: current, reason: 'write_failed' };
    }
  }
  return { changed, status, reason };
}

module.exports = {
  ACTIVE_PHASES,
  TERMINAL_PHASES,
  isActivePhase,
  reconcileStatusObject,
  reconcileStatusFile,
  isAnyAutomationAlive,
  pidAliveMatching,
};
