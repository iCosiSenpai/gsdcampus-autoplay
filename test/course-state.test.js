'use strict';
/**
 * Stato corsi: pure helpers in-memory (niente disco / config).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  courseIdFromUrl,
  getCourse,
  summarize,
  allDoneOrNeedHelp,
  isCourseDoneOrNeedHelp,
  isTerminalCourse,
} = require('../src/lib/course-state');

describe('courseIdFromUrl', () => {
  it('estrae l\'ID numerico', () => {
    assert.equal(
      courseIdFromUrl('https://tecsial.gsdcampus.it/corso/show/18387'),
      '18387'
    );
  });
  it('null su URL non corso', () => {
    assert.equal(courseIdFromUrl('https://tecsial.gsdcampus.it/corso/listAllByUser'), null);
    assert.equal(courseIdFromUrl(''), null);
  });
});

describe('getCourse', () => {
  it('default in_progress se assente', () => {
    const c = getCourse({}, 'https://x/corso/show/1');
    assert.equal(c.status, 'in_progress');
    assert.equal(c.quizAttempts, 0);
    assert.deepEqual(c.completedLessons, []);
  });
  it('legge lo stato esistente', () => {
    const state = { '42': { status: 'done', quizAttempts: 0, completedLessons: [] } };
    const c = getCourse(state, 'https://x/corso/show/42');
    assert.equal(c.status, 'done');
  });
});

describe('summarize', () => {
  it('conteggia done / need_help / in_progress', () => {
    const state = {
      a: { status: 'done' },
      b: { status: 'need_help' },
      c: { status: 'in_progress' },
      d: { status: 'done' },
    };
    assert.deepEqual(summarize(state), {
      total: 4,
      done: 2,
      needHelp: 1,
      inProgress: 1,
    });
  });
  it('state vuoto', () => {
    assert.deepEqual(summarize({}), {
      total: 0,
      done: 0,
      needHelp: 0,
      inProgress: 0,
    });
  });
});

describe('allDoneOrNeedHelp / isCourseDoneOrNeedHelp', () => {
  const state = {
    '10': { status: 'done' },
    '20': { status: 'need_help' },
    '30': { status: 'in_progress' },
  };

  it('isCourseDoneOrNeedHelp su URL', () => {
    assert.equal(isCourseDoneOrNeedHelp(state, 'https://x/corso/show/10'), true);
    assert.equal(isCourseDoneOrNeedHelp(state, 'https://x/corso/show/30'), false);
  });

  it('allDoneOrNeedHelp con URL', () => {
    assert.equal(
      allDoneOrNeedHelp(state, [
        'https://x/corso/show/10',
        'https://x/corso/show/20',
      ]),
      true
    );
    assert.equal(
      allDoneOrNeedHelp(state, [
        'https://x/corso/show/10',
        'https://x/corso/show/30',
      ]),
      false
    );
  });

  it('allDoneOrNeedHelp con ID nudi (Object.keys)', () => {
    assert.equal(allDoneOrNeedHelp(state, ['10', '20']), true);
    assert.equal(allDoneOrNeedHelp(state, ['10', '30']), false);
  });

  it('lista vuota → false', () => {
    assert.equal(allDoneOrNeedHelp(state, []), false);
  });
});

// Regressione: i due predicati divergevano su un done legacy (status done ma
// finalQuizPassed false e nessuna completionEvidence). La scoperta corsi lo
// teneva come lavoro da fare, il controllo di fine lavoro lo contava come
// terminale: a dashboard vuota l'autoplay dichiarava "tutti i corsi completati"
// invece di segnalare post_login_blocked.
describe('done legacy da ricontrollare: predicati allineati', () => {
  const legacy = {
    status: 'done',
    finalQuizPassed: false,
    completedLessons: ['https://x/lezione/show/1'],
  };
  const state = { '19568': legacy, '8122': { status: 'done', finalQuizPassed: true } };

  it('non è terminale: va ancora lavorato', () => {
    assert.equal(isTerminalCourse(legacy), false);
    assert.equal(isCourseDoneOrNeedHelp(state, 'https://x/corso/show/19568'), false);
  });

  it('allDoneOrNeedHelp concorda, sia su URL sia su ID nudi', () => {
    assert.equal(allDoneOrNeedHelp(state, ['19568', '8122']), false);
    assert.equal(
      allDoneOrNeedHelp(state, [
        'https://x/corso/show/19568',
        'https://x/corso/show/8122',
      ]),
      false
    );
  });

  it('un done con prova di completamento resta terminale', () => {
    assert.equal(isTerminalCourse({ status: 'done', finalQuizPassed: true }), true);
    assert.equal(
      isTerminalCourse({ status: 'done', finalQuizPassed: false, completionEvidence: 'no-assessment' }),
      true
    );
  });

  it('record assente non è terminale', () => {
    assert.equal(isTerminalCourse(undefined), false);
    assert.equal(allDoneOrNeedHelp(state, ['99999']), false);
  });
});
