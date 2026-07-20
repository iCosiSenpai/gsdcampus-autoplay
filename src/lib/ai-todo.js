/**
 * ai-todo.js — genera l'"inbox" unico dell'AI supervisore: un solo file
 * logs/ai_todo.json che aggrega "cosa serve all'AI adesso", invece di
 * costringerla a correlare 4 file (status.json, ai_quiz_request.json,
 * need_answer.json, pending_questionnaires.json).
 *
 * Scritto dallo scan `harvest-answers.js --all` e a fine run dell'autoplay.
 * Letto da status.sh (riga "Da fare per l'AI") e dall'AI supervisore all'avvio.
 */

const fs = require('fs');
const path = require('path');
const { readJsonSafe, writeJsonAtomic } = require('./io');
const account = require('./account');
const { bankLag } = require('./bank-sync');
const { getQueue, currentIndex, peekNextCf } = require('./member-queue');

// Costruisce l'oggetto todo dallo stato su disco. Non lancia mai.
function buildAiTodo(root) {
  const logsDir = path.join(root, 'logs');
  const status = readJsonSafe(path.join(logsDir, 'status.json'), {});
  const pending = readJsonSafe(path.join(logsDir, 'pending_questionnaires.json'), null);
  const census = readJsonSafe(path.join(logsDir, 'course_census.json'), null);
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch (_) {}

  // Freschezza dello status: età in minuti, esplicita (l'AI non deve dedurla).
  let statusAgeMin = null;
  if (status && status.lastUpdate) {
    const ms = Date.now() - new Date(status.lastUpdate).getTime();
    if (Number.isFinite(ms)) statusAgeMin = Math.floor(ms / 60000);
  }
  // Stale se lastUpdate > 3 min: anche con running:true orfano (status-reconcile
  // lo corregge in status.sh/stop; qui segnaliamo comunque all'AI).
  const statusStale = statusAgeMin != null && statusAgeMin > 3;

  // Richieste quiz aperte (per l'account attivo).
  let openQuizRequests = 0;
  let quizCourse = null;
  try {
    const paths = account.stateFilePaths(root);
    const aiReq = readJsonSafe(path.join(paths.accountDir, 'ai_quiz_request.json'), null);
    if (aiReq && Array.isArray(aiReq.questions)) {
      openQuizRequests = aiReq.questions.length;
      quizCourse = aiReq.courseUrl || null;
    }
  } catch (_) { /* account non determinabile */ }

  // Falsi-done: corsi con questionario pendente ma stato locale done/need_help.
  const falseDones = pending && Array.isArray(pending.coursesWithPendingQuiz)
    ? pending.coursesWithPendingQuiz.filter(c => c.localDone).length
    : null;

  // Fleet: coda multi-CF + lag banca (local vs public file).
  const queue = getQueue(config);
  const qIdx = currentIndex(config);
  const nextCf = peekNextCf(config);
  const queueRemaining = queue.length >= 2
    ? Math.max(0, queue.length - 1) // almeno un altro CF in coda
    : 0;
  let lag = { trusted: 0, publicFile: 0, onlyLocal: 0, onlyPublic: 0 };
  try { lag = bankLag(root); } catch (_) {}

  // Costruisci le azioni consigliate (in ordine di priorità).
  const actions = [];
  if (statusStale && status.running) {
    actions.push('status.json dice running ma è vecchio: probabilmente processo morto — ./status.sh riconcilia, o ./stop.sh + ./start.sh.');
  }
  if (status.phase === 'autologin_invalid') actions.push('Verifica il link autologin con la sonda live (healthcheck-cli.js) prima di concludere che è scaduto.');
  if (status.phase === 'session_unstable') actions.push('session_unstable: link OK, cooldown — non chiedere nuovo autologin; attendi e ./start.sh.');
  if (openQuizRequests > 0) {
    actions.push(`Risolvi ${openQuizRequests} domanda/e in ai_quiz_request.json con WebSearch, poi answers-cli resolve (auto-share ai colleghi), poi resetCourse + start.`);
  }
  if (lag.onlyLocal > 0) {
    actions.push(`${lag.onlyLocal} risposte trusted solo locali: answers-cli share (o resolve già auto-share).`);
  }
  if (lag.onlyPublic > 0) {
    actions.push(`${lag.onlyPublic} risposte in public non ancora in trusted: update-known-answers o start (sync).`);
  }
  if (queue.length >= 2) {
    actions.push(`Coda multi-CF (${queue.length}): attivo idx ${qIdx}, prossimo ${nextCf || '?'}. A fine corsi avanza da solo — non fermarti al primo CF.`);
  }
  if (falseDones) actions.push(`${falseDones} corso/i con questionario finale pendente segnato done: sono già stati rimessi in coda (reconcile).`);
  if (census && census.total != null) actions.push(`Corsi: ${census.total} totali (${census.at100} al 100%, ${census.partial} parziali, ${census.at0} a 0%).`);

  return {
    generatedAt: new Date().toISOString(),
    phase: status.phase || null,
    running: !!status.running,
    statusAgeMin,
    statusStale,
    openQuizRequests,
    quizCourse,
    falseDones,
    census: census ? { total: census.total, at100: census.at100, partial: census.partial, at0: census.at0 } : null,
    // Fleet
    memberQueue: queue,
    memberQueueIndex: qIdx,
    nextMemberCf: nextCf,
    queueRemaining,
    bankLag: lag,
    activeCf: config.codice_fiscale || null,
    memberName: config.memberName || null,
    actions,
  };
}

// Scrive logs/ai_todo.json (atomico). Ritorna l'oggetto scritto.
function writeAiTodo(root) {
  const todo = buildAiTodo(root);
  try { writeJsonAtomic(path.join(root, 'logs', 'ai_todo.json'), todo); } catch (_) { /* non bloccante */ }
  return todo;
}

module.exports = { buildAiTodo, writeAiTodo };
