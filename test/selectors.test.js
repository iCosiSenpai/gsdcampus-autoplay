'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { probeHtml, probeFixtures, SELECTORS, PROBES } = require('../src/lib/selectors');

const FIXTURES = path.join(__dirname, 'fixtures', 'selectors');

describe('SELECTORS catalog', () => {
  it('ha dashboard e quiz', () => {
    assert.ok(SELECTORS.dashboard.courseLinks);
    assert.ok(SELECTORS.quiz.form);
    assert.ok(SELECTORS.quiz.option);
  });
  it('ha probe required per le 4 pagine', () => {
    const pages = new Set(PROBES.filter((p) => p.required).map((p) => p.page));
    for (const p of ['dashboard', 'course', 'quiz', 'usage']) {
      assert.ok(pages.has(p), `manca probe required per ${p}`);
    }
  });
});

describe('probeHtml', () => {
  it('trova form quiz', () => {
    const html = '<form id="aggiungi_risposta"><div class="opzione-risposta"></div><button>Avanti</button></form>';
    const r = probeHtml(html, 'quiz');
    assert.equal(r.ok, true);
  });
  it('manca option → not ok', () => {
    const html = '<form id="aggiungi_risposta"><button>Avanti</button></form>';
    const r = probeHtml(html, 'quiz');
    assert.equal(r.ok, false);
    assert.ok(r.missing.includes('quiz.option'));
  });
});

describe('probeFixtures', () => {
  it('tutte le fixture required passano', () => {
    const r = probeFixtures(FIXTURES);
    assert.equal(r.ok, true, 'missing: ' + (r.missing || []).join(','));
  });
});
