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
const { writeJsonAtomic, readJsonSafe } = require('./io');

const STATE_FILE = 'course_state.json';

function stateFile(root) {
  // Per-account se il CF è noto; fallback al file flat legacy altrimenti.
  return account.stateFilePaths(root).courseState;
}

function readState(root) {
  const file = stateFile(root);
  // readJsonSafe ritorna {} se assente; se il file è CORROTTO lo segnala su
  // stderr (non silenzioso) e ricomincia da stato vuoto.
  return readJsonSafe(file, {});
}

function writeState(root, state) {
  const file = stateFile(root);
  try {
    // Scrittura atomica (tmp + rename): un crash a metà non corrompe lo stato.
    writeJsonAtomic(file, state);
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
  mergeWriteState(root, state, { currentId: id });
  return state;
}

/**
 * Scrittura consapevole del disco: autoplay è autorità SOLO sul corso corrente
 * (o su quello da rimuovere); per gli ALTRI corsi vince il disco. Così le
 * correzioni esterne fatte da AI/utente su course_state.json durante un run
 * (es. resettare un corso need_help) non vengono sovrascritte al primo update
 * di autoplay. Risincronizza anche la copia in memoria con eventuali corsi
 * esterni nuovi.
 *   - currentId: corso di cui autoplay è autorità (sovrascrive il disco).
 *   - removeId:  corso da rimuovere (resetCourse): non viene scritto.
 */
function mergeWriteState(root, state, opts = {}) {
  const { currentId = null, removeId = null } = opts;
  const disk = readState(root);
  const merged = { ...disk };
  if (removeId) delete merged[removeId];
  if (currentId && state[currentId]) merged[currentId] = state[currentId];
  // Corsi presenti solo in memoria (non su disco): aggiungili.
  for (const k of Object.keys(state)) {
    if (k === removeId) continue;
    if (!(k in merged)) merged[k] = state[k];
  }
  // Risincronizza la copia in memoria con i corsi esterni nuovi.
  for (const k of Object.keys(merged)) {
    if (!(k in state)) state[k] = merged[k];
  }
  try { writeJsonAtomic(stateFile(root), merged); } catch (e) { /* non bloccante */ }
  return state;
}

// finalQuizPassed (opzionale): true se il corso è done perché il questionario
// finale è stato SUPERATO; false per i done "senza quiz" (solo PDF, o terminato
// senza questionario). Informativo: aiuta a riconoscere i done sospetti (un
// done con finalQuizPassed:false + questionario pendente sulla piattaforma è un
// falso-done — v. harvest-answers.js --reconcile).
function markCourseDone(root, state, url, finalQuizPassed = null) {
  const updates = { status: 'done', quizAttempts: 0, needHelpReason: null };
  if (finalQuizPassed !== null) updates.finalQuizPassed = finalQuizPassed;
  return updateCourse(root, state, url, updates);
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

// True se TUTTI i corsi indicati sono 'done' o 'need_help'. Accetta sia URL
// completi (/corso/show/123) sia ID nudi ("123"): lo stato è keyed per ID, ma
// alcuni chiamanti passano Object.keys(state) (ID nudi). isCourseDoneOrNeedHelp
// via courseIdFromUrl gestisce gli URL; per gli ID nudi guardiamo direttamente
// state[id]. Un corso non presente in state NON conta come done/need_help.
function allDoneOrNeedHelp(state, urls) {
  if (!urls || urls.length === 0) return false;
  return urls.every(u => {
    const id = courseIdFromUrl(u);
    const c = id ? getCourse(state, u) : state[u];
    return c && (c.status === 'done' || c.status === 'need_help');
  });
}

function resetCourse(root, state, url) {
  const id = courseIdFromUrl(url);
  if (!id || !state[id]) return state;
  delete state[id];
  // Merge consapevole: scrive memoria + corsi esterni, SENZA il corso resettato
  // (altrimenti, se un corso esterno fosse su disco ma non in memoria, verrebbe
  // perso). removeId assicura che il corso resettato non rientri dal disco.
  mergeWriteState(root, state, { removeId: id });
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
  resetCourse,
  courseIdFromUrl, // pure; esposto per test unitari
};
