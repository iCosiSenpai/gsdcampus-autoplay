'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isActivePhase,
  reconcileStatusObject,
} = require('../src/lib/status-reconcile');

describe('isActivePhase', () => {
  it('video/quiz sono attive', () => {
    assert.equal(isActivePhase('video'), true);
    assert.equal(isActivePhase('quiz'), true);
    assert.equal(isActivePhase('starting'), true);
  });
  it('need_help/done/stopped sono terminali', () => {
    assert.equal(isActivePhase('need_help'), false);
    assert.equal(isActivePhase('done'), false);
    assert.equal(isActivePhase('stopped'), false);
    assert.equal(isActivePhase('off_hours'), false);
  });
});

describe('reconcileStatusObject', () => {
  it('processo vivo → no-op', () => {
    const s = { running: true, phase: 'video', courseUrl: 'https://x/corso/show/1' };
    const r = reconcileStatusObject(s, { processAlive: true });
    assert.equal(r.changed, false);
    assert.equal(r.status.running, true);
    assert.equal(r.status.phase, 'video');
  });

  it('running orfano + phase attiva → stopped', () => {
    const s = { running: true, phase: 'quiz', courseUrl: 'https://x/corso/show/99' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'stopped');
    assert.ok(r.status.note);
    assert.equal(r.status.courseUrl, 'https://x/corso/show/99'); // conservato
  });

  it('need_help non viene rimpiazzato', () => {
    const s = { running: true, phase: 'need_help' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'need_help');
  });

  it('running true ma phase già stopped → solo running', () => {
    const s = { running: true, phase: 'stopped' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'stopped');
  });

  it('running false + phase attiva orfana → phase stopped', () => {
    const s = { running: false, phase: 'video' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, true);
    assert.equal(r.status.phase, 'stopped');
    assert.equal(r.status.running, false);
  });

  it('forceStopped ignora processAlive true', () => {
    const s = { running: true, phase: 'video' };
    const r = reconcileStatusObject(s, { processAlive: true, forceStopped: true });
    assert.equal(r.changed, true);
    assert.equal(r.status.running, false);
    assert.equal(r.status.phase, 'stopped');
  });

  it('idle coerente → no-op', () => {
    const s = { running: false, phase: 'idle' };
    const r = reconcileStatusObject(s, { processAlive: false });
    assert.equal(r.changed, false);
  });
});
