/**
 * quiz-handoff.js — need_answer / ai_quiz_request (artefatti per-account).
 */
const fs = require('fs');
const path = require('path');
const account = require('./account');
const courseState = require('./course-state');
const { writeJsonAtomic, readJsonSafe } = require('./io');
const { normKey } = require('./quiz-match');

// Dedup di una lista di domande per testo domanda (normalizzato): tiene la
// prima occorrenza, ma se una successiva porta più info (es. ha ollamaGuess)
// la fonde nella prima. Usato da saveNeedAnswer e saveAiQuizRequest.
function mergeContexts(existing, incoming) {
  const byKey = new Map();
  for (const ctx of [...(existing || []), ...(incoming || [])]) {
    if (!ctx || typeof ctx !== 'object') continue;
    const key = [ctx.courseId || '', ctx.assessmentId || '', ctx.courseUrl || '', ctx.assessmentUrl || ''].join('|');
    if (!key.replace(/\|/g, '')) continue;
    const prev = byKey.get(key) || {};
    byKey.set(key, { ...prev, ...ctx });
  }
  return [...byKey.values()];
}

function mergeQuestionList(existing, incoming) {
  const byKey = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || !item.question) continue;
    const k = normKey(item.question);
    if (!byKey.has(k)) {
      byKey.set(k, { ...item, contexts: mergeContexts([], item.contexts) });
    } else {
      const prev = byKey.get(k);
      // Arricchisci: se il nuovo ha campi che il vecchio non aveva, copiali.
      for (const f of ['options', 'ollama', 'ollamaGuess']) {
        if (item[f] && !prev[f]) prev[f] = item[f];
      }
      prev.contexts = mergeContexts(prev.contexts, item.contexts);
    }
  }
  return [...byKey.values()];
}

function contextualize(items, ctx) {
  if (!ctx) return items || [];
  const now = new Date().toISOString();
  const context = {
    courseUrl: ctx.courseUrl || null,
    courseId: ctx.courseId || null,
    assessmentUrl: ctx.assessmentUrl || null,
    assessmentId: ctx.assessmentId || null,
    capturedAt: now,
  };
  return (items || []).map(item => ({
    ...item,
    contexts: mergeContexts(item.contexts, [context]),
  }));
}

function saveNeedAnswer(root, questions, reason, ctx = null) {
  if (!questions || questions.length === 0) return;
  const needPath = account.stateFilePaths(root).needAnswer;
  try {
    // Merge (non overwrite): catture multiple nello stesso run non si perdono.
    const prev = fs.existsSync(needPath) ? readJsonSafe(needPath, null) : null;
    const merged = mergeQuestionList(prev && Array.isArray(prev.questions) ? prev.questions : [], contextualize(questions, ctx));
    // Scrittura atomica: il file need_answer è letto dall'AI per intervenire,
    // non deve mai restare troncato a metà.
    writeJsonAtomic(needPath, { schemaVersion: 2, reason, questions: merged, savedAt: new Date().toISOString() });
  } catch (e) { /* ignora */ }
}

// Handoff arricchito per l'AI supervisore: per ogni domanda sconosciuta o a
// bassa confidenza salva domanda + opzioni + guess Ollama + confidenza, così
// l'AI può risolvere con WebSearch + ragionamento e scrivere la risposta
// verificata nella banca TRUSTED (answers-cli set). Merge non overwrite.
// Artefatto per-account: data/accounts/<CF>/ai_quiz_request.json.
function saveAiQuizRequest(root, items, reason, ctx) {
  if (!items || items.length === 0) return 0;
  const paths = account.stateFilePaths(root);
  const reqPath = path.join(paths.accountDir, 'ai_quiz_request.json');
  try {
    const prev = fs.existsSync(reqPath) ? readJsonSafe(reqPath, null) : null;
    const enriched = contextualize(items, ctx);
    const merged = mergeQuestionList(prev && Array.isArray(prev.questions) ? prev.questions : [], enriched);
    writeJsonAtomic(reqPath, {
      schemaVersion: 2,
      reason,
      courseUrl: (ctx && ctx.courseUrl) || null,
      courseId: (ctx && ctx.courseId) || null,
      questions: merged,
      savedAt: new Date().toISOString()
    });
    return merged.length;
  } catch (e) { /* ignora */ }
  return 0;
}

// Rimuove dall'handoff (ai_quiz_request.json + need_answer.json) le domande già
// RISOLTE (aggiunte alla banca trusted). Dopo che l'AI risponde, l'inbox si
// svuota da solo: niente dati stale, niente "reset dimenticato" (l'AI non
// ri-lavora domande già fatte). Matching robusto via normKey (ignora numero
// randomizzato/formattazione). Ritorna quante voci ha rimosso.
function clearResolvedFromHandoff(root, resolvedQuestions) {
  if (!resolvedQuestions || resolvedQuestions.length === 0) return 0;
  const resolvedKeys = new Set(resolvedQuestions.map(q => normKey(q)));
  const paths = account.stateFilePaths(root);
  const files = [path.join(paths.accountDir, 'ai_quiz_request.json'), paths.needAnswer];
  let removed = 0;
  for (const f of files) {
    try {
      if (!fs.existsSync(f)) continue;
      const data = readJsonSafe(f, null);
      if (!data || !Array.isArray(data.questions)) continue;
      const before = data.questions.length;
      const kept = data.questions.filter(q => !resolvedKeys.has(normKey(q.question || '')));
      if (kept.length !== before) {
        removed += before - kept.length;
        writeJsonAtomic(f, { ...data, questions: kept, savedAt: new Date().toISOString() });
      }
    } catch (e) { /* ignora */ }
  }
  // Se l'ultima domanda dell'inbox e stata risolta, riapri solo i corsi che
  // erano bloccati dal gate quiz. I blocchi di sessione/parsing/lezioni restano
  // intatti e richiedono una diagnosi diversa.
  try { unblockResolvedQuizCourses(root); } catch (_) { /* best-effort */ }
  return removed;
}

function unblockResolvedQuizCourses(root) {
  const paths = account.stateFilePaths(root);
  const files = [path.join(paths.accountDir, 'ai_quiz_request.json'), paths.needAnswer];
  const openQuestions = [];
  for (const f of files) {
    const data = readJsonSafe(f, null);
    if (data && Array.isArray(data.questions)) openQuestions.push(...data.questions);
  }
  const state = courseState.readState(root);
  const reopened = [];
  for (const [id, item] of Object.entries(state || {})) {
    if (!item || item.status !== 'need_help') continue;
    const quizBlocked = item.needHelpCode === 'quiz_answers_pending'
      || /domande non note|tentativo protetto|risposta.*serve/i.test(String(item.needHelpReason || ''));
    if (!quizBlocked) continue;
    const hasContext = openQuestions.some(q => (q.contexts || []).some(ctx => String(ctx.courseId || '') === String(id)));
    // Legacy handoff senza contesti: e sicuro riaprire solo quando l'inbox e
    // completamente vuoto, cosi non si crea un retry prematuro.
    if (openQuestions.length === 0 || !hasContext && openQuestions.every(q => !(q.contexts || []).length)) {
      courseState.reopenCourse(root, state, `/corso/show/${id}`);
      reopened.push(id);
    }
  }
  return reopened;
}

module.exports = {
  mergeContexts,
  mergeQuestionList,
  contextualize,
  saveNeedAnswer,
  saveAiQuizRequest,
  clearResolvedFromHandoff,
  unblockResolvedQuizCourses,
};
