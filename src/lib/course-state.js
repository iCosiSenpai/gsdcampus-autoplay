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
const { createCourseStateBackup } = require('./state-backup');

const STATE_FILE = 'course_state.json';

function stateFile(root, cf = null) {
  // Per-account se il CF e noto; fallback al file flat legacy altrimenti.
  return account.stateFilePaths(root, cf).courseState;
}

function readState(root, cf = null) {
  const file = stateFile(root, cf);
  // readJsonSafe ritorna {} se assente; se il file è CORROTTO lo segnala su
  // stderr (non silenzioso) e ricomincia da stato vuoto.
  return readJsonSafe(file, {});
}

function writeState(root, state, cf = null) {
  const file = stateFile(root, cf);
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

function updateCourse(root, state, url, updates, cf = null) {
  const id = courseIdFromUrl(url);
  if (!id) return state;
  state[id] = { ...getCourse(state, url), ...updates, updatedAt: new Date().toISOString() };
  mergeWriteState(root, state, { currentId: id, cf });
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
  const { currentId = null, removeId = null, cf = null } = opts;
  const disk = readState(root, cf);
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
  try { writeJsonAtomic(stateFile(root, cf), merged); } catch (e) { /* non bloccante */ }
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

// Il numero del questionario dentro l'indirizzo. E' l'identita' VERA di un
// questionario: /questionario/VA/dashboard/69/modulo/920 e
// /questionario/VA/dashboard/69/corso/156 sono lo stesso questionario #69.
function questionnaireNumberFromUrl(url) {
  const m = String(url || '').match(/\/questionario\/[^/]+\/[^/]+\/(\d+)/i);
  return m ? m[1] : null;
}

// Un questionario risulta GIA' superato? Raggruppa come allAssessmentsPassed:
// se lo stesso questionario e' registrato sotto piu' id, basta che uno sia
// 'passed'.
//
// Serve a NON rientrare in un questionario chiuso. Il ciclo dei corsi chiamava
// solveQuizWrapper su ogni assessment elencato, anche su quelli gia' superati:
// con il questionario elencato due volte (come modulo e come corso) significava
// riaprire ogni volta una prova gia' passata a 27/30. Ed e' cosi' che l'id
// 'corso:NNN' finiva 'failed' con resultText 'ignoto' — non fallito, mai
// ottenuto. Il tentativo si consuma solo alla finalizzazione, quindi non era una
// perdita certa, ma era un'esposizione inutile ripetuta a ogni giro.
function isQuestionnairePassed(state, courseUrl, assessmentUrl) {
  const c = getCourse(state, courseUrl);
  const assessments = c.assessments || {};
  const wanted = questionnaireNumberFromUrl(assessmentUrl);
  const id = assessmentIdFromUrl(assessmentUrl);
  for (const [key, entry] of Object.entries(assessments)) {
    if (!entry || entry.status !== 'passed') continue;
    if (key === id) return true;
    // Stesso questionario per numero: vale anche se l'id e' diverso.
    if (wanted && questionnaireNumberFromUrl(entry.url) === wanted) return true;
  }
  return false;
}

function allAssessmentsPassed(state, courseUrl, assessmentUrls = null) {
  const c = getCourse(state, courseUrl);
  const assessments = c.assessments || {};
  const ids = Array.isArray(assessmentUrls)
    ? assessmentUrls.map(assessmentIdFromUrl).filter(Boolean)
    : Object.keys(assessments);
  if (ids.length === 0) return false;

  // Si raggruppa per QUESTIONARIO, non per id.
  //
  // assessmentIdFromUrl ricava due id dallo stesso questionario, perche' la
  // pagina del corso lo elenca due volte: una volta come questionario del
  // modulo (modulo/920) e una come questionario del corso (corso/156).
  // Misurato dal vivo: i due indirizzi portano alla stessa pagina, stesso
  // titolo ("SISTEMI DIGITALI MODULO: SVILUPPARE CONTENUTI DIGITALI") e stesso
  // esito ("superato! 27/30").
  //
  // Superandolo una volta l'esito si registra sotto UN id solo; l'altro resta
  // 'failed' con resultText 'ignoto' — cioe' mai ottenuto, non fallito. Con la
  // regola precedente (ogni id deve essere passed) quei corsi non potevano
  // chiudersi MAI. Sul conto reale succedeva su 5 corsi su 5, tutti con il
  // questionario davvero superato (27/30, 30/30, 30/30, 27/30, 30/30).
  //
  // Un esito 'passed' su QUALSIASI id del gruppo vale per il questionario.
  // L'intenzione originale resta intatta: due questionari DIVERSI hanno numeri
  // diversi, quindi restano due gruppi e servono due esiti positivi.
  const groups = new Map();
  for (const id of ids) {
    const entry = assessments[id];
    // Senza indirizzo registrato l'id fa gruppo da solo: non si accorpa a caso.
    const key = questionnaireNumberFromUrl(entry && entry.url) || `id:${id}`;
    const passed = Boolean(entry && entry.status === 'passed');
    groups.set(key, (groups.get(key) || false) || passed);
  }
  return [...groups.values()].every(Boolean);
}

// Riapre un corso mantenendo lezioni e ledger assessment. Diversamente da
// resetCourse, e adatto allo sblocco automatico dopo la risoluzione delle
// domande: non butta via evidenze utili e non tocca altri account.
function reopenCourse(root, state, url, cf = null) {
  const id = courseIdFromUrl(url);
  if (!id || !state[id]) return state;
  try { createCourseStateBackup(root, state, { reason: 'before-reopen', courseId: id, cf }); } catch (_) { /* non blocca il corso */ }
  return updateCourse(root, state, url, {
    status: 'in_progress',
    needHelpReason: null,
    needHelpCode: null,
  }, cf);
}

function addCompletedLesson(root, state, url, lessonUrl) {
  const c = getCourse(state, url);
  const list = Array.isArray(c.completedLessons) ? c.completedLessons : [];
  if (!list.includes(lessonUrl)) {
    list.push(lessonUrl);
  }
  return updateCourse(root, state, url, { completedLessons: list });
}

// Predicato terminale su un SINGOLO record. Estratto perché i due chiamanti
// (isCourseDoneOrNeedHelp su URL, allDoneOrNeedHelp anche su ID nudi) devono
// decidere allo stesso modo: prima divergevano, e un done legacy da
// ricontrollare risultava "da lavorare" per la scoperta corsi ma "terminale"
// per il controllo di fine lavoro. Su una dashboard vuota questo mascherava un
// post_login_blocked da "tutti i corsi completati".
function isTerminalCourse(c) {
  if (!c) return false;
  // I done legacy senza prova di quiz/no-assessment vanno ricontrollati una
  // volta. I record nuovi portano completionEvidence e restano terminali.
  if (c.status === 'done' && c.finalQuizPassed === false && !c.completionEvidence) return false;
  return c.status === 'done' || c.status === 'need_help';
}

// Conteggio ONESTO dei corsi: incrocia lo stato locale con le percentuali del
// censimento e, in caso di disaccordo, crede alla piattaforma.
//
// Il conteggio dei 'done' da solo mente. Su un percorso reale ha detto "7 su 7
// finiti" mentre la dashboard dava un corso al 10,39%: il record era rimasto
// 'done' da un giro in cui le lezioni successive non erano ancora sbloccate.
//
// Il modello della piattaforma, verificato: la percentuale di /corso/show/<id>
// conta SOLO le lezioni ed e' pesata sulla durata; le lezioni si sbloccano a
// scaglioni; il questionario compare quando la percentuale arriva a 100; e il
// 100% NON vuol dire questionario superato. Quindi un corso e' concluso quando il
// contenuto e' al 100% E le valutazioni sono superate. Mai per uno solo dei due.
//
// @param {object} state - lo stato dei corsi (id -> record)
// @param {Array<{url?:string, pct?:number}>} censusCourses - i corsi dal censimento
// @returns {{finished:number, awaitingAssessment:number, incomplete:number,
//            blocked:number, disagreeing:number, total:number, sentence:string,
//            perCourse:Array<{id:string, standing:string, pct:number|null}>}}
function honestCourseCounts(state, censusCourses) {
  const counts = { finished: 0, awaitingAssessment: 0, incomplete: 0, blocked: 0, disagreeing: 0 };
  const perCourse = [];
  for (const entry of censusCourses || []) {
    const id = courseIdFromUrl(entry && entry.url);
    if (!id) continue;
    const record = (state || {})[id];
    const pct = entry && Number.isFinite(entry.pct) ? entry.pct : null;

    let standing;
    if (record && record.status === 'need_help') {
      standing = 'bloccato';
      counts.blocked++;
    } else if (pct != null && pct < 100) {
      if (record && record.status === 'done') {
        standing = `in corso (${pct}%) — lo stato lo dava per concluso`;
        counts.disagreeing++;
      } else {
        standing = `in corso (${pct}%)`;
        counts.incomplete++;
      }
    } else {
      // Contenuto al 100% (o percentuale ignota): decidono le valutazioni.
      const url = `/corso/show/${id}`;
      const hasAssessments = record && record.assessments && Object.keys(record.assessments).length > 0;
      // Senza questionari registrati vale solo una prova VERA.
      //
      // completionEvidence porta tre valori, e due sono il contrario di una prova (li
      // scrive markCourseDone qui sopra):
      //
      //   all_assessments_passed   le valutazioni sono superate       <- prova
      //   no_assessment_confirmed  nessuna valutazione confermata     <- il contrario
      //   content_only             solo il contenuto; delle valutazioni non si sa nulla
      //
      // Contarli tutti come «concluso» rimetteva in piedi il falso concluso che questo
      // conteggio esiste per smascherare. Misurato sul percorso di ANNA GUGLIELMI: 4187
      // «PARTE GENERALE» e 4204 «SPECIFICA ADDETTO ALLE PULIZIE» sono al 100% con
      // content_only e zero tentativi, e risultavano «concluso» senza che nessuno avesse
      // mai guardato i loro questionari.
      //
      // E finalQuizPassed vale solo CORROBORATO da un tentativo: la dichiarazione nuda su
      // zero tentativi e' un residuo di quando i questionari non si tracciavano (corso
      // 8122: done, finalQuizPassed true, quizAttempts 0, due questionari). E' la stessa
      // regola del lato Swift (CourseReconciliation.assessmentsPassed): due risposte alla
      // stessa domanda finiscono sempre per divergere, e questo conteggio e quello della
      // app devono dire lo stesso numero.
      const passed = hasAssessments
        ? allAssessmentsPassed({ [id]: record }, url)
        : Boolean(record && (
          record.completionEvidence === 'all_assessments_passed'
          || (record.finalQuizPassed === true && (record.quizAttempts || 0) > 0)
        ));
      if (passed) {
        standing = 'concluso';
        counts.finished++;
      } else {
        standing = 'video completati, questionario da fare';
        counts.awaitingAssessment++;
      }
    }
    perCourse.push({ id, standing, pct });
  }

  const total = counts.finished + counts.awaitingAssessment + counts.incomplete
    + counts.blocked + counts.disagreeing;
  const parts = [`${counts.finished} su ${total} conclusi`];
  if (counts.awaitingAssessment > 0) {
    parts.push(counts.awaitingAssessment === 1
      ? '1 con il questionario da fare'
      : `${counts.awaitingAssessment} con il questionario da fare`);
  }
  if (counts.disagreeing > 0) {
    parts.push(counts.disagreeing === 1
      ? '1 dato per concluso ma incompleto'
      : `${counts.disagreeing} dati per conclusi ma incompleti`);
  }
  if (counts.incomplete > 0) parts.push(`${counts.incomplete} in corso`);
  if (counts.blocked > 0) parts.push(counts.blocked === 1 ? '1 bloccato' : `${counts.blocked} bloccati`);

  return { ...counts, total, sentence: parts.join(', '), perCourse };
}

function isCourseDoneOrNeedHelp(state, url) {
  return isTerminalCourse(getCourse(state, url));
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
// Usa lo STESSO predicato della scoperta corsi (isTerminalCourse): un done
// legacy ancora da ricontrollare non deve chiudere il lavoro.
function allDoneOrNeedHelp(state, urls) {
  if (!urls || urls.length === 0) return false;
  return urls.every(u => {
    const id = courseIdFromUrl(u);
    return isTerminalCourse(id ? getCourse(state, u) : state[u]);
  });
}

function resetCourse(root, state, url) {
  const id = courseIdFromUrl(url);
  if (!id || !state[id]) return state;
  try { createCourseStateBackup(root, state, { reason: 'before-reset', courseId: id }); } catch (_) { /* non blocca il reset */ }
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
  isQuestionnairePassed,
  questionnaireNumberFromUrl,
  honestCourseCounts,
  reopenCourse,
  isTerminalCourse,
  isCourseDoneOrNeedHelp,
  summarize,
  allDoneOrNeedHelp,
  resetCourse,
  courseIdFromUrl, // pure; esposto per test unitari
};
