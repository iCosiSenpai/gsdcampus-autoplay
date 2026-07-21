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

// Identita stabile dei questionari. La piattaforma espone normalmente URL del
// tipo /questionario/VA/dashboard/<piano>/modulo/<id> oppure .../corso/<id>.
// Conservare entrambi evita il falso-done storico: un corso puo avere un quiz
// di modulo e uno di corso, e superarene uno non completa automaticamente l'altro.
function assessmentIdFromUrl(url) {
  const m = String(url || '').match(/\/questionario\/[^?#]*\/(modulo|corso)\/(\d+)/i);
  if (m) return `${m[1].toLowerCase()}:${m[2]}`;
  const fallback = String(url || '').match(/\/questionario\/([^?#]+)/i);
  return fallback ? `url:${fallback[1].replace(/\/+$/, '')}` : null;
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
  const current = getCourse(state, url);
  // Non azzerare la cronologia: quizAttempts deve riflettere solo Conferme
  // realmente inviate, mentre le sospensioni protette vivono in un contatore
  // separato. Le vite della piattaforma restano quindi auditabili.
  const updates = { status: 'done', quizAttempts: current.quizAttempts || 0, needHelpReason: null };
  if (finalQuizPassed !== null) updates.finalQuizPassed = finalQuizPassed;
  updates.needHelpCode = null;
  updates.completionEvidence = finalQuizPassed === true
    ? 'all_assessments_passed'
    : (finalQuizPassed === false ? 'no_assessment_confirmed' : 'content_only');
  return updateCourse(root, state, url, updates);
}

function markCourseNeedHelp(root, state, url, reason, code = null) {
  return updateCourse(root, state, url, {
    status: 'need_help',
    needHelpReason: reason || 'quiz non superato, serve risposta',
    needHelpCode: code || null,
  });
}

function incrementQuizAttempt(root, state, url, result) {
  const c = getCourse(state, url);
  return updateCourse(root, state, url, {
    quizAttempts: (c.quizAttempts || 0) + 1,
    lastQuizResult: result || c.lastQuizResult
  });
}

// Una sospensione attempt-protective non e un tentativo: la piattaforma non ha
// ricevuto la Conferma finale. La contiamo separatamente per non mostrare vite
// consumate inesistenti e per mantenere auditabile il gate di sicurezza.
function incrementProtectedSuspension(root, state, url, result) {
  const c = getCourse(state, url);
  return updateCourse(root, state, url, {
    protectedSuspensions: (c.protectedSuspensions || 0) + 1,
    lastQuizResult: result || c.lastQuizResult,
  });
}

function registerAssessments(root, state, courseUrl, assessmentUrls) {
  const c = getCourse(state, courseUrl);
  const assessments = { ...(c.assessments || {}) };
  const seenAt = new Date().toISOString();
  for (const url of assessmentUrls || []) {
    const id = assessmentIdFromUrl(url);
    if (!id) continue;
    const prev = assessments[id] || {};
    assessments[id] = {
      ...prev,
      id,
      url,
      status: prev.status || 'pending',
      lastSeenAt: seenAt,
    };
  }
  updateCourse(root, state, courseUrl, { assessments });
  return assessments;
}

function markAssessment(root, state, courseUrl, assessmentUrl, status, details = {}) {
  const c = getCourse(state, courseUrl);
  const assessments = { ...(c.assessments || {}) };
  const id = assessmentIdFromUrl(assessmentUrl);
  if (!id) return state;
  assessments[id] = {
    ...(assessments[id] || {}),
    id,
    url: assessmentUrl,
    status,
    ...details,
    updatedAt: new Date().toISOString(),
  };
  return updateCourse(root, state, courseUrl, { assessments });
}

function allAssessmentsPassed(state, courseUrl, assessmentUrls = null) {
  const c = getCourse(state, courseUrl);
  const assessments = c.assessments || {};
  const ids = Array.isArray(assessmentUrls)
    ? assessmentUrls.map(assessmentIdFromUrl).filter(Boolean)
    : Object.keys(assessments);
  return ids.length > 0 && ids.every(id => assessments[id] && assessments[id].status === 'passed');
}

// Riapre un corso mantenendo lezioni e ledger assessment. Diversamente da
// resetCourse, e adatto allo sblocco automatico dopo la risoluzione delle
// domande: non butta via evidenze utili e non tocca altri account.
function reopenCourse(root, state, url) {
  const id = courseIdFromUrl(url);
  if (!id || !state[id]) return state;
  return updateCourse(root, state, url, {
    status: 'in_progress',
    needHelpReason: null,
    needHelpCode: null,
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
  // I done legacy senza prova di quiz/no-assessment vanno ricontrollati una
  // volta. I record nuovi portano completionEvidence e restano terminali.
  if (c.status === 'done' && c.finalQuizPassed === false && !c.completionEvidence) return false;
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
  incrementProtectedSuspension,
  addCompletedLesson,
  assessmentIdFromUrl,
  registerAssessments,
  markAssessment,
  allAssessmentsPassed,
  reopenCourse,
  isCourseDoneOrNeedHelp,
  summarize,
  allDoneOrNeedHelp,
  resetCourse,
  courseIdFromUrl, // pure; esposto per test unitari
};
