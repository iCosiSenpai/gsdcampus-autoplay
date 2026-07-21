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
    const a = 'https://x/questionario/VA/dashboard/73/modulo/923';
    const b = 'https://x/questionario/VA/dashboard/73/corso/159';
    const state = {};
    registerAssessments(root, state, course, [a, b]);
    markAssessment(root, state, course, a, 'passed');
    assert.equal(allAssessmentsPassed(state, course, [a, b]), false);
    markAssessment(root, state, course, b, 'passed');
    assert.equal(allAssessmentsPassed(state, course, [a, b]), true);
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
