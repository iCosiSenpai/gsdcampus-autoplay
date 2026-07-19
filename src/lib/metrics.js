/**
 * metrics.js — eventi operativi privacy-safe (append-only).
 *
 * File: logs/metrics.jsonl (gitignored con logs/).
 * Una riga per cambio di fase rilevante. Niente CF, token, URL completi,
 * lastError testuale: solo phase, id numerici corso/lezione, classe errore.
 */

const fs = require('fs');
const path = require('path');

const MAX_METRICS_BYTES = 5 * 1024 * 1024; // 5 MB → ruota in .1
const ALLOWED_KEYS = new Set([
  'ts', 'event', 'phase', 'courseId', 'lessonId', 'quiz', 'errorClass', 'uptimeSec',
]);

function metricsPath(root) {
  return path.join(root, 'logs', 'metrics.jsonl');
}

/** Estrae solo ID numerici da URL corso/lezione (nessun host/token). */
function extractIds(url) {
  const s = String(url || '');
  const course = (s.match(/\/corso\/show\/(\d+)/) || [])[1] || null;
  const lesson = (s.match(/\/lezione\/show\/(\d+)/) || [])[1] || null;
  return { courseId: course, lessonId: lesson };
}

/** Classifica l'esito quiz da lastQuizResult (solo etichette grezze). */
function classifyQuizResult(text) {
  if (text == null || text === '') return null;
  const t = String(text).toLowerCase();
  if (/sospeso|need_answers|da risolvere/.test(t)) return 'sospeso';
  if (/non\s+superato|insufficiente|da\s+ripet/.test(t)) return 'non_superato';
  if (/superato|idoneo/.test(t)) return 'superato';
  if (/ignoto/.test(t)) return 'ignoto';
  return 'altro';
}

/**
 * Costruisce un evento sanitizzato. Scarta chiavi non ammesse e valori non scalari sicuri.
 */
function buildMetricEvent(partial) {
  const out = {
    ts: new Date().toISOString(),
    event: 'phase',
  };
  if (partial && typeof partial === 'object') {
    if (partial.phase != null) out.phase = String(partial.phase).slice(0, 64);
    if (partial.courseId != null) out.courseId = String(partial.courseId).replace(/\D/g, '').slice(0, 16) || null;
    if (partial.lessonId != null) out.lessonId = String(partial.lessonId).replace(/\D/g, '').slice(0, 16) || null;
    if (partial.quiz != null) out.quiz = String(partial.quiz).slice(0, 32);
    if (partial.errorClass != null) out.errorClass = String(partial.errorClass).slice(0, 64);
    if (partial.uptimeSec != null && Number.isFinite(Number(partial.uptimeSec))) {
      out.uptimeSec = Math.max(0, Math.floor(Number(partial.uptimeSec)));
    }
    if (partial.event) out.event = String(partial.event).slice(0, 32);
    // Convenience: pass full URLs → only IDs
    if (partial.courseUrl && !out.courseId) {
      const ids = extractIds(partial.courseUrl);
      if (ids.courseId) out.courseId = ids.courseId;
    }
    if (partial.lessonUrl && !out.lessonId) {
      const ids = extractIds(partial.lessonUrl);
      if (ids.lessonId) out.lessonId = ids.lessonId;
      if (ids.courseId && !out.courseId) out.courseId = ids.courseId;
    }
    if (partial.lastQuizResult != null && out.quiz == null) {
      out.quiz = classifyQuizResult(partial.lastQuizResult);
    }
  }
  // Drop null/undefined optional fields for compactness
  for (const k of Object.keys(out)) {
    if (out[k] == null || out[k] === '') delete out[k];
    if (!ALLOWED_KEYS.has(k)) delete out[k];
  }
  return out;
}

function rotateIfNeeded(file) {
  try {
    const st = fs.statSync(file);
    if (st.size < MAX_METRICS_BYTES) return;
    const bak = file + '.1';
    try { fs.unlinkSync(bak); } catch (_) {}
    fs.renameSync(file, bak);
  } catch (_) {
    // missing file ok
  }
}

/**
 * Appende una riga a logs/metrics.jsonl. Non lancia mai.
 */
function appendMetric(root, partial) {
  try {
    const dir = path.join(root, 'logs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    const file = metricsPath(root);
    rotateIfNeeded(file);
    const ev = buildMetricEvent(partial);
    fs.appendFileSync(file, JSON.stringify(ev) + '\n');
    return ev;
  } catch (_) {
    return null;
  }
}

/**
 * Legge e aggrega conteggi per phase nelle ultime `hours` ore.
 * Ritorna { total, byPhase, hours, from, to }.
 */
function summarizeMetrics(root, opts = {}) {
  const hours = opts.hours != null ? Number(opts.hours) : 24;
  const file = opts.file || metricsPath(root);
  const cutoff = Date.now() - hours * 3600 * 1000;
  const byPhase = {};
  let total = 0;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { raw = ''; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch (_) { continue; }
    if (!ev || !ev.ts) continue;
    const t = Date.parse(ev.ts);
    if (!Number.isFinite(t) || t < cutoff) continue;
    total++;
    const p = ev.phase || '(none)';
    byPhase[p] = (byPhase[p] || 0) + 1;
  }
  return {
    total,
    byPhase,
    hours,
    from: new Date(cutoff).toISOString(),
    to: new Date().toISOString(),
  };
}

/**
 * Ultime N righe parseate (per CLI tail).
 */
function readMetricsTail(root, n = 20) {
  const file = metricsPath(root);
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const slice = lines.slice(-Math.max(1, n));
  const out = [];
  for (const line of slice) {
    try { out.push(JSON.parse(line)); } catch (_) {}
  }
  return out;
}

module.exports = {
  appendMetric,
  buildMetricEvent,
  extractIds,
  classifyQuizResult,
  summarizeMetrics,
  readMetricsTail,
  metricsPath,
  ALLOWED_KEYS,
  MAX_METRICS_BYTES,
};
