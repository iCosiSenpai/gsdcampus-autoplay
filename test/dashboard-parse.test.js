'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  parsePctCandidates,
  enrichCourseRows,
  parseCoursesFromDashboardHtml,
} = require('../src/lib/dashboard-parse');

describe('parsePctCandidates', () => {
  it('legge width da style anche se aria è la ditta (bug storico)', () => {
    const pct = parsePctCandidates({
      style: 'width: 30.51%;',
      aria: 'Ditta: C&C S.P.A.',
    });
    assert.equal(pct, 30.51);
  });

  it('100% e 0%', () => {
    assert.equal(parsePctCandidates({ style: 'width: 100.00%;' }), 100);
    assert.equal(parsePctCandidates({ style: 'width: 0.00%;' }), 0);
  });

  it('aria senza % e style vuoto → null', () => {
    assert.equal(parsePctCandidates({ style: '', aria: 'Ditta: X' }), null);
  });

  it('aria con % funziona come fallback', () => {
    assert.equal(parsePctCandidates({ style: '', aria: 'Completato al 80%' }), 80);
  });

  it('non usa il ramo aria||style sbagliato', () => {
    const wrong = ('Ditta: C&C' || 'width: 50%;').match(/([\d]+(?:[.,]\d+)?)\s*%/);
    assert.equal(wrong, null);
    assert.equal(
      parsePctCandidates({ style: 'width: 50%;', aria: 'Ditta: C&C' }),
      50
    );
  });
});

describe('enrichCourseRows', () => {
  it('aggiunge courseId e pct', () => {
    const rows = enrichCourseRows([
      {
        url: 'https://tecsial.gsdcampus.it/corso/show/18387',
        title: 'Comunicazione',
        style: 'width: 30.51%;',
        aria: 'Ditta: X',
      },
    ]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].courseId, '18387');
    assert.equal(rows[0].pct, 30.51);
  });
});

describe('parseCoursesFromDashboardHtml (fixture live-like)', () => {
  it('estrae 3 corsi con % corrette', () => {
    const html = fs.readFileSync(
      path.join(__dirname, 'fixtures/dashboard/cards-sample.html'),
      'utf8'
    );
    const courses = parseCoursesFromDashboardHtml(html);
    assert.equal(courses.length, 3);
    const byId = Object.fromEntries(courses.map((c) => [c.courseId, c]));
    assert.equal(byId['8122'].pct, 100);
    assert.equal(byId['18387'].pct, 30.51);
    assert.equal(byId['18949'].pct, 0);
  });
});
