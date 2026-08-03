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


describe('il corso fermo al questionario riparte', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { unblockResolvedQuizCourses } = require('../src/lib/quiz-handoff');

  const CF = 'RSSMRA80A01H501Z';

  function fakeAccount(record) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-handoff-'));
    const dir = path.join(root, 'data', 'accounts', CF);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'course_state.json'), JSON.stringify({ 100: record }));
    // Inbox vuota: nessuna domanda in attesa, quindi la riapertura vale per tutti i corsi
    // bloccati da un questionario.
    fs.writeFileSync(path.join(dir, 'ai_quiz_request.json'), JSON.stringify({ questions: [] }));
    return root;
  }

  it('riconosce quiz_capability_missing, scritto dal motore nativo', () => {
    // Trovato il 3 agosto 2026 provando la strada che al primo questionario di ANNA
    // GUGLIELMI avrebbe dovuto funzionare, e prima che servisse. Il motore scrive quel
    // codice quando arriva a un questionario e non ha la facolta' di aprirlo; nessun ramo
    // qui lo riconosceva, e il corso sarebbe rimasto bloccato per sempre — entrambi i motori
    // saltano i need_help, quindi senza riapertura non c'e' nessuna strada per consegnare
    // quel questionario, nemmeno passando a Playwright.
    const root = fakeAccount({
      status: 'need_help',
      needHelpCode: 'quiz_capability_missing',
      needHelpReason: 'questionario da fare: il motore non ha la facolta di aprirlo',
      completedLessons: ['https://x/lezione/show/1'],
    });
    const reopened = unblockResolvedQuizCourses(root, { cf: CF });
    assert.deepEqual(reopened, ['100']);

    const after = JSON.parse(
      fs.readFileSync(path.join(root, 'data', 'accounts', CF, 'course_state.json'), 'utf8')
    );
    assert.equal(after['100'].status, 'in_progress');
    assert.equal(after['100'].needHelpCode, null);
    // Conservativa: le lezioni fatte restano.
    assert.equal(after['100'].completedLessons.length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('un corso bloccato per altro non viene riaperto per sbaglio', () => {
    // Il verso opposto: un quiz davvero NON superato, con il tentativo consumato, non e' una
    // domanda in attesa di risposta e non si riapre da se'.
    const root = fakeAccount({
      status: 'need_help',
      needHelpCode: 'quiz_failed',
      needHelpReason: 'quiz non superato',
      completedLessons: [],
    });
    assert.deepEqual(unblockResolvedQuizCourses(root, { cf: CF }), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('«letto, tutte le risposte note» non si riapre: aspetta una decisione, non una risposta', () => {
    // La distinzione che evita un ciclo. Quando il motore legge un questionario e la banca
    // copre tutte le domande, non manca una risposta: manca il permesso di consegnare. Se
    // questo caso finisse fra quelli «in attesa di risposte», con l'inbox vuota verrebbe
    // riaperto, riletto e risospeso a ogni giro — cioe' una pagina di questionario aperta in
    // ciclo, di notte, senza nessuno davanti.
    const root = fakeAccount({
      status: 'need_help',
      needHelpCode: 'quiz_ready_to_deliver',
      needHelpReason: 'questionario letto: 10 domande, tutte in banca. Manca solo il permesso di consegnarlo.',
      completedLessons: [],
    });
    assert.deepEqual(unblockResolvedQuizCourses(root, { cf: CF }), []);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('«letto, N senza risposta nota» invece si riapre quando le risposte arrivano', () => {
    // L'altra attesa: qui una risposta risolta e' esattamente ci  che serve, e la riapertura
    // automatica e' quello che fa ripartire il corso senza che nessuno se ne ricordi.
    const root = fakeAccount({
      status: 'need_help',
      needHelpCode: 'quiz_answers_pending',
      needHelpReason: 'questionario letto: 10 domande, 3 senza risposta nota',
      completedLessons: [],
    });
    assert.deepEqual(unblockResolvedQuizCourses(root, { cf: CF }), ['100']);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
