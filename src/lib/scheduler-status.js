/** Stato/heartbeat dello scheduler quando autoplay non sta eseguendo un browser. */
const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./io');

const SCHEDULER_PHASES = new Set(['scheduler_starting', 'scheduler_launching', 'off_hours', 'awaiting_ai']);

function buildSchedulerStatus(previous, phase, opts = {}, now = new Date()) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const ts = now.toISOString();
  const schedulerRunning = !['stopped', 'preflight_failed', 'crash_loop'].includes(phase);
  const next = {
    ...prev,
    phase,
    running: false,
    schedulerRunning,
    lastUpdate: ts,
    schedulerHeartbeat: ts,
    nextStart: opts.nextStart || null,
    note: opts.note || null,
  };

  // Un errore di un run precedente resta auditabile, ma non deve apparire come
  // errore corrente mentre lo scheduler sta semplicemente aspettando il turno.
  if (SCHEDULER_PHASES.has(phase) && prev.lastError) {
    next.previousRun = {
      phase: prev.phase || null,
      lastError: prev.lastError,
      lastUpdate: prev.lastUpdate || null,
    };
    next.lastError = null;
  }
  if (opts.error) next.lastError = String(opts.error);
  return next;
}

function writeSchedulerStatus(root, phase, opts = {}) {
  const file = path.join(root, 'logs', 'status.json');
  const prev = readJsonSafe(file, {});
  const status = buildSchedulerStatus(prev, phase, opts);
  writeJsonAtomic(file, status);
  try {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'logs', 'heartbeat.txt'), `Scheduler: ${phase} · ${status.schedulerHeartbeat}\n`);
  } catch (_) {}
  try { require('./ai-todo').writeAiTodo(root); } catch (_) {}
  return status;
}

function stopSchedulerStatus(root) {
  const file = path.join(root, 'logs', 'status.json');
  const prev = readJsonSafe(file, {});
  if (!prev.schedulerRunning && !SCHEDULER_PHASES.has(prev.phase)) return prev;
  return writeSchedulerStatus(root, 'stopped', { note: 'Scheduler arrestato.' });
}

module.exports = { SCHEDULER_PHASES, buildSchedulerStatus, writeSchedulerStatus, stopSchedulerStatus };
