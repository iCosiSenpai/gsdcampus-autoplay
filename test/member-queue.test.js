const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  getQueue,
  currentIndex,
  peekNextCf,
  normalizeCf,
  maybeAdvanceOnAllDone,
} = require('../src/lib/member-queue');

describe('member-queue', () => {
  it('normalizeCf uppercases', () => {
    assert.equal(normalizeCf('csolss95l23d862r'), 'CSOLSS95L23D862R');
  });

  it('getQueue empty without array', () => {
    assert.deepEqual(getQueue({}), []);
    assert.deepEqual(getQueue({ memberQueue: 'x' }), []);
  });

  it('currentIndex from codice_fiscale', () => {
    const cfg = {
      memberQueue: ['AAA', 'BBB', 'CCC'],
      codice_fiscale: 'bbb',
    };
    assert.equal(currentIndex(cfg), 1);
    assert.equal(peekNextCf(cfg), 'CCC');
  });

  it('peekNextCf wraps around', () => {
    const cfg = {
      memberQueue: ['AAA', 'BBB'],
      memberQueueIndex: 1,
      codice_fiscale: 'BBB',
    };
    assert.equal(peekNextCf(cfg), 'AAA');
  });

  it('peekNextCf null if single or empty', () => {
    assert.equal(peekNextCf({ memberQueue: ['ONLY'] }), null);
    assert.equal(peekNextCf({}), null);
  });

  it('maybeAdvanceOnAllDone no-op without queue', () => {
    const r = maybeAdvanceOnAllDone('.', { codice_fiscale: 'X' }, true, null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_queue');
  });

  it('maybeAdvanceOnAllDone no-op if not all done', () => {
    const r = maybeAdvanceOnAllDone('.', {
      memberQueue: ['A', 'B'],
      codice_fiscale: 'A',
    }, false, null);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_all_done');
  });
});
