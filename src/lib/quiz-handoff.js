/**
 * quiz-handoff.js — need_answer / ai_quiz_request (artefatti per-account).
 */
const fs = require('fs');
const path = require('path');
const account = require('./account');
const { writeJsonAtomic, readJsonSafe } = require('./io');
const { normKey } = require('./quiz-match');

// Dedup di una lista di domande per testo domanda (normalizzato): tiene la
// prima occorrenza, ma se una successiva porta più info (es. ha ollamaGuess)
// la fonde nella prima. Usato da saveNeedAnswer e saveAiQuizRequest.
function mergeQuestionList(existing, incoming) {
  const byKey = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    if (!item || !item.question) continue;
    const k = normKey(item.question);
    if (!byKey.has(k)) {
      byKey.set(k, { ...item });
    } else {
      const prev = byKey.get(k);
      // Arricchisci: se il nuovo ha campi che il vecchio non aveva, copiali.
      for (const f of ['options', 'ollama', 'ollamaGuess']) {
        if (item[f] && !prev[f]) prev[f] = item[f];
      }
    }
  }
  return [...byKey.values()];
}

function saveNeedAnswer(root, questions, reason) {
  if (!questions || questions.length === 0) return;
  const needPath = account.stateFilePaths(root).needAnswer;
  try {
    // Merge (non overwrite): catture multiple nello stesso run non si perdono.
    const prev = fs.existsSync(needPath) ? readJsonSafe(needPath, null) : null;
    const merged = mergeQuestionList(prev && Array.isArray(prev.questions) ? prev.questions : [], questions);
    // Scrittura atomica: il file need_answer è letto dall'AI per intervenire,
    // non deve mai restare troncato a metà.
    writeJsonAtomic(needPath, { reason, questions: merged, savedAt: new Date().toISOString() });
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
    const merged = mergeQuestionList(prev && Array.isArray(prev.questions) ? prev.questions : [], items);
    writeJsonAtomic(reqPath, {
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
  return removed;
}

module.exports = {
  mergeQuestionList,
  saveNeedAnswer,
  saveAiQuizRequest,
  clearResolvedFromHandoff,
};
