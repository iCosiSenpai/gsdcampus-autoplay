'use strict';
/**
 * Edge-trigger extra-time fine turno (clock e isWorkTime fake).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { makeShiftChecker, EXTRA_TIME_MIN } = require('../src/lib/shift-watch');

describe('EXTRA_TIME_MIN', () => {
  it('è 15 minuti', () => {
    assert.equal(EXTRA_TIME_MIN, 15);
  });
});

describe('makeShiftChecker (DI clock)', () => {
  it('in orario: stop=false, extraTime=false', () => {
    let t = 1_000_000;
    const checker = makeShiftChecker({
      nowFn: () => t,
      isWorkTimeFn: () => true,
    });
    const s = checker.evaluate();
    assert.equal(s.inWork, true);
    assert.equal(s.stop, false);
    assert.equal(s.extraTime, false);
    assert.equal(s.extraTimeArmed, false);
  });

  it('transizione in→out arma extra-time; durante la finestra stop=false', () => {
    let t = 1_000_000;
    let inWork = true;
    const checker = makeShiftChecker({
      nowFn: () => t,
      isWorkTimeFn: () => inWork,
    });
    // Prima chiamata in orario: stabilisce wasInWork=true.
    assert.equal(checker.evaluate().inWork, true);

    inWork = false;
    const armed = checker.evaluate();
    assert.equal(armed.inWork, false);
    assert.equal(armed.extraTimeArmed, true);
    assert.equal(armed.extraTime, true);
    assert.equal(armed.stop, false);
    assert.ok(armed.extraTimeUntil === t + EXTRA_TIME_MIN * 60000);

    // Ancora dentro i 15 min: non ri-arma, stop ancora false.
    t += 5 * 60000;
    const mid = checker.evaluate();
    assert.equal(mid.extraTimeArmed, false);
    assert.equal(mid.extraTime, true);
    assert.equal(mid.stop, false);
  });

  it('scaduta la tolleranza: stop=true', () => {
    let t = 1_000_000;
    let inWork = true;
    const checker = makeShiftChecker({
      nowFn: () => t,
      isWorkTimeFn: () => inWork,
    });
    checker.evaluate();
    inWork = false;
    checker.evaluate(); // arma

    t += EXTRA_TIME_MIN * 60000 + 1;
    const s = checker.evaluate();
    assert.equal(s.extraTime, false);
    assert.equal(s.stop, true);
  });

  it('partito già fuori orario: non arma, stop subito', () => {
    const checker = makeShiftChecker({
      nowFn: () => 5_000_000,
      isWorkTimeFn: () => false,
    });
    const s = checker.evaluate();
    assert.equal(s.inWork, false);
    assert.equal(s.extraTimeArmed, false);
    assert.equal(s.extraTime, false);
    assert.equal(s.stop, true);
  });

  it('rientro in orario resetta; nuovo passaggio out ri-arma', () => {
    let t = 1_000_000;
    let inWork = true;
    const checker = makeShiftChecker({
      nowFn: () => t,
      isWorkTimeFn: () => inWork,
    });
    checker.evaluate();
    inWork = false;
    checker.evaluate(); // primo arm
    t += EXTRA_TIME_MIN * 60000 + 1;
    assert.equal(checker.evaluate().stop, true);

    // Nuovo turno
    inWork = true;
    t += 60_000;
    assert.equal(checker.evaluate().inWork, true);

    inWork = false;
    const again = checker.evaluate();
    assert.equal(again.extraTimeArmed, true);
    assert.equal(again.stop, false);
  });
});
