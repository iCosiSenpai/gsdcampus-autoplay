/**
 * Stato persistente per corso.
 * Tiene memoria di quali corsi sono completati e quali richiedono aiuto (need_help)
 * perché il quiz finale non è superato e servono risposte aggiuntive.
 * NON blocca automaticamente i corsi: lascia sempre all'AI/utente la possibilità
 * di intervenire.
 */

const fs = require('fs');
const path = require('path');
const account = require('./account');

const STATE_FILE = 'course_state.json';

function stateFile(root) {
  // Per-account se il CF è noto; fallback al file flat legacy altrimenti.
  return account.stateFilePaths(root).courseState;
}

function readState(root) {
  const file = stateFile(root);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeState(root, state) {
  const file = stateFile(root);
  try {
    // Assicura che la cartella account esista.
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) {
    // non bloccante: lo stato è un aiuto, non un requisito
  }
}

function courseIdFromUrl(url) {
  const m = String(url).match(/\/corso\/show\/(\d+)/);
  return m ? m[1] : null;
}

function getCourse(state, url) {
  const id = courseIdFromUrl(url);
  if (!id) return { status: 'in_progress', quizAttempts: 0, completedLessons: [] };
  return state[id] || { status: 'in_progress', quizAttempts: 0, completedLessons: [] };
}

function updateCourse(root, state, url, updates) {
  const id = courseIdFromUrl(url);
  if (!id) return state;
  state[id] = { ...getCourse(state, url), ...updates, updatedAt: new Date().toISOString() };
  writeState(root, state);
  return state;
}

function markCourseDone(root, state, url) {
  return updateCourse(root, state, url, { status: 'done', quizAttempts: 0, needHelpReason: null });
}

function markCourseNeedHelp(root, state, url, reason) {
  return updateCourse(root, state, url, { status: 'need_help', needHelpReason: reason || 'quiz non superato, serve risposta' });
}

function incrementQuizAttempt(root, state, url, result) {
  const c = getCourse(state, url);
  return updateCourse(root, state, url, {
    quizAttempts: (c.quizAttempts || 0) + 1,
    lastQuizResult: result || c.lastQuizResult
  });
}

function addCompletedLesson(root, state, url, lessonUrl) {
  const c = getCourse(state, url);
  const list = Array.isArray(c.completedLessons) ? c.completedLessons : [];
  if (!list.includes(lessonUrl)) {
    list.push(lessonUrl);
  }
  return updateCourse(root, state, url, { completedLessons: list });
}

function isCourseDoneOrNeedHelp(state, url) {
  const c = getCourse(state, url);
  return c.status === 'done' || c.status === 'need_help';
}

function summarize(state) {
  const values = Object.values(state || {});
  return {
    total: values.length,
    done: values.filter(c => c.status === 'done').length,
    needHelp: values.filter(c => c.status === 'need_help').length,
    inProgress: values.filter(c => c.status !== 'done' && c.status !== 'need_help').length
  };
}

function allDoneOrNeedHelp(state, urls) {
  if (!urls || urls.length === 0) return false;
  return urls.every(url => isCourseDoneOrNeedHelp(state, url));
}

function resetCourse(root, state, url) {
  const id = courseIdFromUrl(url);
  if (!id || !state[id]) return state;
  delete state[id];
  writeState(root, state);
  return state;
}

module.exports = {
  readState,
  writeState,
  getCourse,
  updateCourse,
  markCourseDone,
  markCourseNeedHelp,
  incrementQuizAttempt,
  addCompletedLesson,
  isCourseDoneOrNeedHelp,
  summarize,
  allDoneOrNeedHelp,
  resetCourse
};
