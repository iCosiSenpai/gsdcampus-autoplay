const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dashboardToCsv, statusFromSummary } = require('../src/lib/dashboard');

describe('statusFromSummary', () => {
  it('maps statuses', () => {
    assert.equal(statusFromSummary({ total: 0 }), 'not_started');
    assert.equal(statusFromSummary({ total: 2, done: 2, needHelp: 0 }), 'done');
    assert.equal(statusFromSummary({ total: 2, done: 1, needHelp: 1 }), 'need_help');
    assert.equal(statusFromSummary({ total: 2, done: 1, needHelp: 0 }), 'in_progress');
  });
});

describe('dashboardToCsv', () => {
  it('emits header and rows', () => {
    const csv = dashboardToCsv({
      perMember: [{
        codice_fiscale: 'CSOLSS95L23D862R',
        name: 'COSI ALESSIO',
        status: 'in_progress',
        summary: { done: 4, needHelp: 0, inProgress: 1, total: 5 },
        lastActivity: '2026-07-19T10:00:00.000Z',
        stateAgeMin: 12,
        lastPhase: 'video',
        lastUpdate: '2026-07-19T11:00:00.000Z',
        running: true,
      }],
    });
    const lines = csv.trim().split('\n');
    assert.ok(lines[0].includes('codice_fiscale'));
    assert.ok(lines[1].includes('CSOLSS95L23D862R'));
    assert.ok(lines[1].includes('video'));
    assert.ok(lines[1].endsWith('1') || lines[1].includes(',1'));
  });
});
