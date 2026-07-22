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

// Handoff arricchito per l'AI supervisore: per ogni domanda sconosciuta salva
// domanda + opzioni + eventuale guess legacy, così il batch può risolverla con
// WebSearch/ragionamento e scrivere la risposta verificata nella banca TRUSTED
// (answers-cli resolve). Merge non overwrite.
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
function targetAccountIds(root, options = {}) {
  if (options.cf) return [String(options.cf).toUpperCase()];
  if (!options.allAccounts) return [account.stateFilePaths(root).codiceFiscale || null];
  let ids = [];
  try {
    ids = fs.readdirSync(account.accountsDir(root))
      .filter((name) => /^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$/.test(name));
  } catch (_) {}
  const active = account.stateFilePaths(root).codiceFiscale;
  if (active && !ids.includes(active)) ids.push(active);
  return ids.length > 0 ? ids : [null];
}

function clearResolvedFromHandoff(root, resolvedQuestions, options = {}) {
  if (!resolvedQuestions || resolvedQuestions.length === 0) return 0;
  const resolvedKeys = new Set(resolvedQuestions.map(q => normKey(q)));
  let removed = 0;
  for (const cf of targetAccountIds(root, options)) {
    const paths = account.stateFilePaths(root, cf);
    const files = [path.join(paths.accountDir, 'ai_quiz_request.json'), paths.needAnswer];
    const affectedCourseIds = new Set();
    for (const f of files) {
      try {
        if (!fs.existsSync(f)) continue;
        const data = readJsonSafe(f, null);
        if (!data || !Array.isArray(data.questions)) continue;
        const removedItems = data.questions.filter(q => resolvedKeys.has(normKey(q.question || '')));
        const kept = data.questions.filter(q => !resolvedKeys.has(normKey(q.question || '')));
        if (removedItems.length > 0) {
          removed += removedItems.length;
          for (const item of removedItems) {
            const contexts = Array.isArray(item.contexts) ? item.contexts : [];
            for (const ctx of contexts) {
              if (ctx && ctx.courseId != null) affectedCourseIds.add(String(ctx.courseId));
            }
            // Handoff legacy: usa il corso top-level soltanto quando la domanda
            // non aveva gia contesti propri, evitando associazioni spurie.
            if (contexts.length === 0) {
              const topLevelId = data.courseId
                || String(data.courseUrl || '').match(/\/corso\/show\/(\d+)/)?.[1];
              if (topLevelId != null) affectedCourseIds.add(String(topLevelId));
            }
          }
          writeJsonAtomic(f, { ...data, questions: kept, savedAt: new Date().toISOString() });
        }
      } catch (e) { /* ignora */ }
    }
    // Riapre soltanto i corsi toccati dalle domande appena risolte e privi di
    // altre domande aperte. Per handoff legacy senza corso, attende inbox vuota.
    try {
      unblockResolvedQuizCourses(root, { cf, affectedCourseIds: [...affectedCourseIds] });
    } catch (_) { /* best-effort */ }
  }
  return removed;
}

function unblockResolvedQuizCourses(root, options = {}) {
  const cf = options.cf || null;
  const affectedCourseIds = new Set((options.affectedCourseIds || []).map(String));
  const paths = account.stateFilePaths(root, cf);
  const files = [path.join(paths.accountDir, 'ai_quiz_request.json'), paths.needAnswer];
  let openQuestions = [];
  for (const f of files) {
    const data = readJsonSafe(f, null);
    if (data && Array.isArray(data.questions)) {
      openQuestions = mergeQuestionList(openQuestions, data.questions);
    }
  }
  const state = courseState.readState(root, cf);
  const reopened = [];
  for (const [id, item] of Object.entries(state || {})) {
    if (!item || item.status !== 'need_help') continue;
    const quizBlocked = item.needHelpCode === 'quiz_answers_pending'
      || /domande non note|tentativo protetto|risposta.*serve/i.test(String(item.needHelpReason || ''));
    if (!quizBlocked) continue;
    const hasOpenQuestionForCourse = openQuestions.some(q => (q.contexts || [])
      .some(ctx => String(ctx.courseId || '') === String(id)));
    const inboxEmpty = openQuestions.length === 0;
    const resolvedForCourse = affectedCourseIds.has(String(id)) && !hasOpenQuestionForCourse;
    if (inboxEmpty || resolvedForCourse) {
      courseState.reopenCourse(root, state, `/corso/show/${id}`, cf);
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
