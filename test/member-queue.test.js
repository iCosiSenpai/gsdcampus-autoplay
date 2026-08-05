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

  it('un indice che contraddice il CF attivo non comanda', () => {
    // La configurazione vera di questo Mac il 5 agosto 2026: indice 0, attiva la seconda
    // persona. Con l'indice al comando il «prossimo» era la persona gia' attiva, quindi a
    // fine corsi la coda avanzava su se stessa e il collega in prima posizione non veniva
    // mai servito.
    const cfg = {
      memberQueue: ['CSOLSS95L23D862R', 'GGLNNA78E61E506A'],
      memberQueueIndex: 0,
      codice_fiscale: 'GGLNNA78E61E506A',
    };
    assert.equal(currentIndex(cfg), 1);
    assert.equal(peekNextCf(cfg), 'CSOLSS95L23D862R');
  });

  it('senza CF attivo l indice dichiarato resta la verita', () => {
    const cfg = { memberQueue: ['AAA', 'BBB'], memberQueueIndex: 1 };
    assert.equal(currentIndex(cfg), 1);
    assert.equal(peekNextCf(cfg), 'AAA');
  });

  it('con due CF uguali in coda l indice distingue l occorrenza', () => {
    // È il caso per cui l'indice dichiarato esiste: concorda con l'attivo, e dice quale
    // delle due occorrenze si sta servendo.
    const cfg = { memberQueue: ['AAA', 'BBB', 'AAA'], memberQueueIndex: 2, codice_fiscale: 'AAA' };
    assert.equal(currentIndex(cfg), 2);
    assert.equal(peekNextCf(cfg), 'AAA');
  });

  it('un CF attivo fuori dalla coda non inventa una posizione', () => {
    const cfg = { memberQueue: ['AAA', 'BBB'], memberQueueIndex: 1, codice_fiscale: 'ZZZ' };
    assert.equal(currentIndex(cfg), 1);
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
