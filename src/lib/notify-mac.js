/**
 * notify-mac.js — notifiche macOS best-effort dall'autoplay (Node).
 *
 * Specchio di scripts/lib/notify.sh: opt-out config.notifications===false,
 * throttle per tipo (marker in logs/.notify_*), mai throw.
 *
 * Throttle:
 *  - default 6h (come notify.sh)
 *  - course_done: 2 min + suffisso courseId per non collidere tra corsi
 *  - quiz_sospeso: 6h per fingerprint + courseId
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const { extractIds } = require('./metrics');
const account = require('./account');

const DEFAULT_THROTTLE_MIN = 360; // 6h
const THROTTLE_BY_TYPE = {
  course_done: 2,
  quiz_sospeso: 360,
  need_help: 360,
  general: 360,
};

/**
 * @param {string|null|undefined} courseUrl
 * @returns {string|null}
 */
function courseIdFromUrl(courseUrl) {
  return extractIds(courseUrl).courseId || null;
}

/**
 * @param {string} type
 * @param {string|null} courseId
 * @returns {string}
 */
function markerName(type, courseId) {
  const safe = String(type || 'general').replace(/[^a-zA-Z0-9_-]/g, '') || 'general';
  if (courseId && (type === 'course_done' || type === 'quiz_sospeso')) {
    return `.notify_${safe}_${courseId}`;
  }
  return `.notify_${safe}`;
}

/**
 * @param {string} root
 * @param {string} type
 * @param {string|null} [courseId]
 * @returns {boolean} true se si può notificare
 */
function throttleAllows(root, type, courseId, fingerprint = null) {
  const mins = THROTTLE_BY_TYPE[type] != null ? THROTTLE_BY_TYPE[type] : DEFAULT_THROTTLE_MIN;
  const marker = path.join(root, 'logs', markerName(type, courseId));
  try {
    const st = fs.statSync(marker);
    const ageMin = (Date.now() - st.mtimeMs) / 60000;
    const previous = fingerprint ? fs.readFileSync(marker, 'utf8').trim() : null;
    // Un fingerprint nuovo (nuove domande/assessment) passa subito; lo stesso
    // lavoro viene ricordato per il throttle lungo, evitando notifiche a ogni
    // run dello scheduler.
    if (!(fingerprint && previous && previous !== String(fingerprint)) && ageMin < mins) return false;
  } catch (_) {
    // missing = ok
  }
  try {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(marker, fingerprint ? String(fingerprint) : new Date().toISOString());
  } catch (_) { /* best-effort */ }
  return true;
}

function quizRequestFingerprint(root, courseId = null) {
  try {
    const paths = account.stateFilePaths(root);
    const req = JSON.parse(fs.readFileSync(path.join(paths.accountDir, 'ai_quiz_request.json'), 'utf8'));
    const questions = Array.isArray(req.questions) ? req.questions : [];
    const relevant = questions.filter(q => {
      if (!courseId) return true;
      return (q.contexts || []).some(c => String(c.courseId || '') === String(courseId))
        || String(req.courseId || '') === String(courseId);
    }).map(q => [q.question, (q.options || []).join('|')].join('::')).sort();
    if (relevant.length === 0) return null;
    return crypto.createHash('sha256').update(JSON.stringify(relevant)).digest('hex').slice(0, 24);
  } catch (_) { return null; }
}

/**
 * @param {string} root
 * @returns {boolean}
 */
function notificationsEnabled(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    if (cfg && cfg.notifications === false) return false;
  } catch (_) { /* default yes */ }
  return true;
}

/**
 * @param {string} title
 * @param {string} message
 */
function displayNotification(title, message) {
  // argv: no injection into AppleScript source
  const child = spawn(
    'osascript',
    [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
      String(title || 'GSD Campus'),
      String(message || ''),
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
}

/**
 * @param {string} root
 * @param {string} title
 * @param {string} message
 * @param {string} [type]
 * @param {{ courseUrl?: string|null }} [opts]
 * @returns {boolean} true se notificata
 */
function notifyMac(root, title, message, type = 'general', opts = {}) {
  try {
    if (!message) return false;
    if (!notificationsEnabled(root)) return false;
    const courseId = courseIdFromUrl(opts.courseUrl || null);
    const fingerprint = opts.fingerprint || (type === 'quiz_sospeso' ? quizRequestFingerprint(root, courseId) : null);
    if (!throttleAllows(root, type, courseId, fingerprint)) return false;
    displayNotification(title, message);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Messaggi standard (pure helpers per test).
 * @param {string|null} courseId
 */
function msgCourseDone(courseId) {
  return courseId
    ? `Corso #${courseId} completato.`
    : 'Un corso è stato completato.';
}

/**
 * @param {string|null} courseId
 * @param {string|null} [quizHint]
 */
function msgQuizSospeso(courseId, quizHint) {
  const base = courseId
    ? `Quiz da risolvere (corso #${courseId}).`
    : 'Quiz da risolvere: apri il Terminale / AI supervisore.';
  if (quizHint && /sospeso/i.test(quizHint)) return base + ' (tentativo protetto)';
  return base;
}

module.exports = {
  notifyMac,
  courseIdFromUrl,
  msgCourseDone,
  msgQuizSospeso,
  throttleAllows,
  quizRequestFingerprint,
  notificationsEnabled,
  THROTTLE_BY_TYPE,
};
