'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const account = require('../src/lib/account');
const { clearResolvedFromHandoff } = require('../src/lib/quiz-handoff');

const CF = 'AAABBB00C00D000E';

// Si scrive direttamente il file che clearResolvedFromHandoff legge: passare da
// saveAiQuizRequest legherebbe il test al modo in cui si risolve l'account attivo
// (config.json), che qui non esiste.
function withHandoff(questions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
  const paths = account.stateFilePaths(root, CF);
  fs.mkdirSync(paths.accountDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.accountDir, 'ai_quiz_request.json'),
    JSON.stringify({ schemaVersion: 2, reason: 'domande non note', questions }, null, 2)
  );
  return { root, file: path.join(paths.accountDir, 'ai_quiz_request.json') };
}

function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

describe('handoff delle domande aperte', () => {
  it('una domanda risolta esce dall elenco', () => {
    const { root, file } = withHandoff([
      { question: 'Qual e il primo principio?', contexts: [{ courseId: '100' }] },
    ]);
    const removed = clearResolvedFromHandoff(root, ['Qual e il primo principio?'], { cf: CF });
    assert.equal(removed, 1);
    assert.equal(read(file).questions.length, 0);
  });

  it('la spaziatura diversa non impedisce di togliere la domanda', () => {
    // normKey NON comprime gli spazi interni: "qual  e il principio" e
    // "qual e  il principio" restano chiavi diverse. Prima di questa correzione la
    // domanda restava nell'elenco, unblockResolvedQuizCourses vedeva una domanda
    // ancora in attesa, e IL CORSO NON RIPARTIVA MAI.
    const { root } = withHandoff([
      { question: '3  Qual e   il primo principio?', contexts: [{ courseId: '100' }] },
    ]);
    const removed = clearResolvedFromHandoff(root, ['Qual e il primo principio?'], { cf: CF });
    assert.equal(removed, 1, 'deve uscire anche con spaziatura e numerazione diverse');
  });

  it('una domanda diversa non viene tolta per sbaglio', () => {
    const { root, file } = withHandoff([
      { question: 'Qual e il primo principio?', contexts: [{ courseId: '100' }] },
      { question: 'Quale norma regola il rischio elettrico?', contexts: [{ courseId: '100' }] },
    ]);
    const removed = clearResolvedFromHandoff(root, ['Qual e il primo principio?'], { cf: CF });
    assert.equal(removed, 1);
    const after = read(file);
    assert.equal(after.questions.length, 1);
    assert.match(after.questions[0].question, /rischio elettrico/);
  });
});
