'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  assessmentIdFromUrl,
  registerAssessments,
  markAssessment,
  allAssessmentsPassed,
  isQuestionnairePassed,
  isCourseDoneOrNeedHelp,
  incrementProtectedSuspension,
} = require('../src/lib/course-state');
const { mergeQuestionList } = require('../src/lib/quiz-handoff');
const { buildAiTodo } = require('../src/lib/ai-todo');
const { throttleAllows } = require('../src/lib/notify-mac');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-hardening-'));
}

describe('quiz hardening: multi-assessment state', () => {
  it('identifica modulo e corso come assessment distinti', () => {
    assert.equal(assessmentIdFromUrl('https://x/questionario/VA/dashboard/73/modulo/923'), 'modulo:923');
    assert.equal(assessmentIdFromUrl('https://x/questionario/VA/dashboard/73/corso/159'), 'corso:159');
  });

  it('non completa il corso finche tutti gli assessment non sono passati', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const course = 'https://x/corso/show/159';
    // Due questionari DAVVERO distinti: numeri diversi (#73 e #75). Prima qui
    // c'erano /dashboard/73/modulo/923 e /dashboard/73/corso/159, che sono lo
    // STESSO questionario #73 raggiunto per due strade — quindi il test
    // pretendeva due esiti positivi per un solo questionario, ed e' il motivo
    // per cui 5 corsi con il questionario superato non si chiudevano mai.
    const a = 'https://x/questionario/VA/dashboard/73/modulo/923';
    const b = 'https://x/questionario/VA/dashboard/75/modulo/925';
    const state = {};
    registerAssessments(root, state, course, [a, b]);
    markAssessment(root, state, course, a, 'passed');
    assert.equal(allAssessmentsPassed(state, course, [a, b]), false);
    markAssessment(root, state, course, b, 'passed');
    assert.equal(allAssessmentsPassed(state, course, [a, b]), true);
  });

  it('lo stesso questionario elencato due volte conta una volta sola', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const course = 'https://x/corso/show/156';
    // Misurato sul conto reale: la pagina del corso elenca lo stesso
    // questionario #69 due volte, come questionario del modulo e come
    // questionario del corso. Aprendo i due indirizzi si arriva alla stessa
    // pagina, stesso titolo e stesso esito ("superato! 27/30"). L'automazione
    // registra l'esito sotto un id solo e lascia l'altro 'failed'/'ignoto'.
    const asModulo = 'https://x/questionario/VA/dashboard/69/modulo/920';
    const asCorso = 'https://x/questionario/VA/dashboard/69/corso/156';
    const state = {};
    registerAssessments(root, state, course, [asModulo, asCorso]);
    markAssessment(root, state, course, asModulo, 'passed', { resultText: 'superato (27/30)' });
    markAssessment(root, state, course, asCorso, 'failed', { resultText: 'ignoto' });
    assert.equal(
      allAssessmentsPassed(state, course, [asModulo, asCorso]),
      true,
      'il questionario e superato: il corso deve poter chiudersi'
    );
  });

  it('un id senza indirizzo registrato non si accorpa ad altri', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const course = 'https://x/corso/show/200';
    // Il raggruppamento si basa sull'indirizzo salvato. Se manca, l'id resta
    // gruppo a se: meglio un corso che non si chiude che uno chiuso a torto.
    const state = {
      200: {
        status: 'in_progress',
        assessments: {
          'modulo:1': { id: 'modulo:1', url: 'https://x/questionario/VA/dashboard/80/modulo/1', status: 'passed' },
          'corso:2': { id: 'corso:2', status: 'failed' },
        },
      },
    };
    assert.equal(allAssessmentsPassed(state, course), false);
  });

  it('un questionario gia superato non si riapre', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const course = 'https://x/corso/show/156';
    const asModulo = 'https://x/questionario/VA/dashboard/69/modulo/920';
    const asCorso = 'https://x/questionario/VA/dashboard/69/corso/156';
    const state = {};
    registerAssessments(root, state, course, [asModulo, asCorso]);
    markAssessment(root, state, course, asModulo, 'passed', { resultText: 'superato (27/30)' });
    // Lo stesso questionario raggiunto per l'altra strada risulta superato:
    // rientrarci sarebbe riaprire una prova chiusa a 27/30.
    assert.equal(isQuestionnairePassed(state, course, asCorso), true);
    assert.equal(isQuestionnairePassed(state, course, asModulo), true);
  });

  it('un questionario diverso non viene scambiato per superato', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const course = 'https://x/corso/show/156';
    const passato = 'https://x/questionario/VA/dashboard/69/modulo/920';
    const daFare = 'https://x/questionario/VA/dashboard/70/modulo/921';
    const state = {};
    registerAssessments(root, state, course, [passato, daFare]);
    markAssessment(root, state, course, passato, 'passed');
    assert.equal(isQuestionnairePassed(state, course, daFare), false);
  });

  it('conta una sospensione protetta separatamente dai tentativi', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    const course = 'https://x/corso/show/159';
    const state = { 159: { status: 'need_help', quizAttempts: 0 } };
    incrementProtectedSuspension(root, state, course, 'sospeso: 1 domanda');
    assert.equal(state[159].quizAttempts, 0);
    assert.equal(state[159].protectedSuspensions, 1);
  });

  it('riapre i done legacy senza evidenza di completamento per ricontrollarli', () => {
    assert.equal(isCourseDoneOrNeedHelp({ 159: { status: 'done', finalQuizPassed: false } }, 'https://x/corso/show/159'), false);
    assert.equal(isCourseDoneOrNeedHelp({ 159: { status: 'done', finalQuizPassed: false, completionEvidence: 'content_only' } }, 'https://x/corso/show/159'), true);
  });
});

describe('quiz hardening: handoff context', () => {
  it('deduplica la domanda ma conserva contesti di corsi diversi', () => {
    const merged = mergeQuestionList(
      [{ question: 'Qual è la risposta?', options: ['A', 'B'], contexts: [{ courseId: '159', assessmentId: 'modulo:923' }] }],
      [{ question: ' 1. Qual è la risposta?', options: ['A', 'B'], contexts: [{ courseId: '160', assessmentId: 'corso:160' }] }]
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].contexts.length, 2);
  });
});

describe('ai todo fleet', () => {
  it('somma le richieste di tutti gli account senza toccare members.db', () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'data', 'accounts', 'AAAAAA00A00A000A'), { recursive: true });
    fs.mkdirSync(path.join(root, 'data', 'accounts', 'BBBBBB00B00B000B'), { recursive: true });
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ codice_fiscale: 'AAAAAA00A00A000A' }));
    fs.writeFileSync(path.join(root, 'data', 'accounts', 'AAAAAA00A00A000A', 'ai_quiz_request.json'), JSON.stringify({ questions: [{ question: 'A' }] }));
    fs.writeFileSync(path.join(root, 'data', 'accounts', 'BBBBBB00B00B000B', 'ai_quiz_request.json'), JSON.stringify({ questions: [{ question: 'B' }, { question: 'C' }] }));
    const todo = buildAiTodo(root);
    assert.equal(todo.openQuizRequests, 3);
    assert.equal(todo.accounts.length, 2);
    assert.ok(todo.workFingerprint);
  });
});

describe('notification hardening', () => {
  it('deduplica lo stesso fingerprint ma lascia passare un nuovo lavoro', () => {
    const root = tempRoot();
    assert.equal(throttleAllows(root, 'quiz_sospeso', '159', 'old-work'), true);
    assert.equal(throttleAllows(root, 'quiz_sospeso', '159', 'old-work'), false);
    assert.equal(throttleAllows(root, 'quiz_sospeso', '159', 'new-work'), true);
  });
});


describe('conteggio onesto dei corsi', () => {
  const { honestCourseCounts } = require('../src/lib/course-state');

  it('un corso dato per concluso ma sotto il 100% non conta come concluso', () => {
    // E' l'equivoco misurato: la plancia diceva "7 su 7 finiti" mentre la
    // dashboard dava un corso al 10,39%. Il record era rimasto 'done' da un giro
    // in cui le lezioni successive non erano ancora sbloccate.
    const state = {
      100: { status: 'done', finalQuizPassed: false },
    };
    const census = [{ url: 'https://x/corso/show/100', pct: 10.39 }];
    const r = honestCourseCounts(state, census);
    assert.equal(r.finished, 0);
    assert.equal(r.disagreeing, 1);
    assert.match(r.sentence, /0 su 1 conclusi/);
    assert.match(r.sentence, /dato per concluso ma incompleto/);
  });

  it('video al 100% con questionario da fare non e un corso concluso', () => {
    // La percentuale conta SOLO le lezioni: il 100% dice che i video sono stati
    // visti, non che la valutazione e' superata.
    const state = {
      100: {
        status: 'in_progress',
        assessments: {
          'modulo:920': {
            id: 'modulo:920',
            url: 'https://x/questionario/VA/dashboard/69/modulo/920',
            status: 'pending',
          },
        },
      },
    };
    const r = honestCourseCounts(state, [{ url: 'https://x/corso/show/100', pct: 100 }]);
    assert.equal(r.finished, 0);
    assert.equal(r.awaitingAssessment, 1);
    assert.match(r.sentence, /questionario da fare/);
  });

  it('video al 100% e valutazione superata: concluso', () => {
    const state = {
      100: {
        status: 'done',
        completionEvidence: 'all_assessments_passed',
        assessments: {
          'modulo:920': {
            id: 'modulo:920',
            url: 'https://x/questionario/VA/dashboard/69/modulo/920',
            status: 'passed',
          },
          'corso:156': {
            id: 'corso:156',
            url: 'https://x/questionario/VA/dashboard/69/corso/156',
            status: 'failed',
          },
        },
      },
    };
    // Lo stesso questionario sotto due id conta una volta: e' superato.
    const r = honestCourseCounts(state, [{ url: 'https://x/corso/show/100', pct: 100 }]);
    assert.equal(r.finished, 1);
    assert.equal(r.sentence, '1 su 1 conclusi');
  });

  it('un corso bloccato si conta a parte', () => {
    const state = { 100: { status: 'need_help', needHelpReason: 'domande non note' } };
    const r = honestCourseCounts(state, [{ url: 'https://x/corso/show/100', pct: 100 }]);
    assert.equal(r.blocked, 1);
    assert.match(r.sentence, /1 bloccato/);
  });
});
