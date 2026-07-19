'use strict';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  extractIds,
  classifyQuizResult,
  buildMetricEvent,
  appendMetric,
  summarizeMetrics,
  ALLOWED_KEYS,
} = require('../src/lib/metrics');

describe('extractIds', () => {
  it('estrae courseId e lessonId', () => {
    assert.deepEqual(
      extractIds('https://tecsial.gsdcampus.it/corso/show/18387'),
      { courseId: '18387', lessonId: null }
    );
    assert.deepEqual(
      extractIds('https://tecsial.gsdcampus.it/lezione/show/14102'),
      { courseId: null, lessonId: '14102' }
    );
  });
  it('non espone host/token', () => {
    const r = extractIds('https://tecsial.gsdcampus.it/autologin/CSOLSS95L23D862R/secrettok/corso/show/1');
    assert.equal(r.courseId, '1');
    assert.ok(!JSON.stringify(r).includes('secret'));
    assert.ok(!JSON.stringify(r).includes('CSOLSS'));
  });
});

describe('classifyQuizResult', () => {
  it('etichette grezze', () => {
    assert.equal(classifyQuizResult('superato (30/30)'), 'superato');
    assert.equal(classifyQuizResult('non superato'), 'non_superato');
    assert.equal(classifyQuizResult('sospeso: 2 domande da risolvere'), 'sospeso');
    assert.equal(classifyQuizResult(null), null);
  });
});

describe('buildMetricEvent privacy', () => {
  it('solo chiavi ammesse; ID da URL', () => {
    const ev = buildMetricEvent({
      phase: 'video',
      courseUrl: 'https://tecsial.gsdcampus.it/corso/show/99',
      lessonUrl: 'https://tecsial.gsdcampus.it/lezione/show/11',
      lastQuizResult: 'superato',
      lastError: 'https://tecsial.gsdcampus.it/autologin/CSOLSS95L23D862R/token',
      codice_fiscale: 'CSOLSS95L23D862R',
      uptimeSec: 42,
    });
    for (const k of Object.keys(ev)) {
      assert.ok(ALLOWED_KEYS.has(k), `chiave non ammessa: ${k}`);
    }
    assert.equal(ev.courseId, '99');
    assert.equal(ev.lessonId, '11');
    assert.equal(ev.quiz, 'superato');
    assert.equal(ev.uptimeSec, 42);
    const dump = JSON.stringify(ev);
    assert.ok(!dump.includes('CSOLSS'));
    assert.ok(!dump.includes('token'));
    assert.ok(!dump.includes('autologin'));
    assert.ok(!('lastError' in ev));
    assert.ok(!('codice_fiscale' in ev));
  });
});

describe('appendMetric + summarizeMetrics', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-metrics-'));
    fs.mkdirSync(path.join(tmp, 'logs'));
  });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  });

  it('scrive e aggrega per phase', () => {
    appendMetric(tmp, { phase: 'video', courseUrl: 'https://x/corso/show/1' });
    appendMetric(tmp, { phase: 'quiz' });
    appendMetric(tmp, { phase: 'video' });
    const file = path.join(tmp, 'logs', 'metrics.jsonl');
    assert.ok(fs.existsSync(file));
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
    const s = summarizeMetrics(tmp, { hours: 24 });
    assert.equal(s.total, 3);
    assert.equal(s.byPhase.video, 2);
    assert.equal(s.byPhase.quiz, 1);
  });
});
