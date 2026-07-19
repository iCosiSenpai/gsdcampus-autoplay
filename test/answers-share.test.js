'use strict';
/**
 * Validazione payload e merge additivo per lo share remoto (no rete).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateAnswersPayload,
  mergeAnswersAdditive,
  chunkEntries,
  MAX_ENTRIES,
} = require('../scripts/lib/answers-share');

describe('validateAnswersPayload', () => {
  it('accetta coppie domanda/risposta normali', () => {
    const { ok, skipped } = validateAnswersPayload({
      'Qual è il rischio del phishing?': 'Furto di credenziali',
    });
    assert.equal(Object.keys(ok).length, 1);
    assert.equal(skipped, 0);
    assert.equal(ok['Qual è il rischio del phishing?'], 'Furto di credenziali');
  });

  it('scarta README, vuoti, troppo lunghi', () => {
    const longQ = 'x'.repeat(900);
    const { ok, skipped } = validateAnswersPayload({
      README: 'nota',
      '': 'a',
      'Domanda ok': '',
      [longQ]: 'risposta',
      'Q valida': 'A valida',
    });
    assert.equal(Object.keys(ok).length, 1);
    assert.ok(skipped >= 3);
    assert.equal(ok['Q valida'], 'A valida');
  });

  it('scarta PII (CF, autologin, PAT)', () => {
    const { ok, skipped } = validateAnswersPayload({
      'Domanda con CSOLSS95L23D862R nel testo': 'Risposta',
      'Domanda pulita': 'https://tecsial.gsdcampus.it/autologin/CSOLSS95L23D862R/secrettoken',
      'Ok domanda': 'Ok risposta',
    });
    assert.equal(Object.keys(ok).length, 1);
    assert.equal(ok['Ok domanda'], 'Ok risposta');
    assert.ok(skipped >= 2);
  });

  it('rifiuta non-object', () => {
    const r = validateAnswersPayload(null);
    assert.equal(Object.keys(r.ok).length, 0);
    assert.ok(r.errors.length > 0);
  });

  it('tronca oltre MAX_ENTRIES', () => {
    const big = {};
    for (let i = 0; i < MAX_ENTRIES + 10; i++) big['Domanda numero ' + i + ' abbastanza lunga'] = 'Risposta ' + i;
    const { ok, errors } = validateAnswersPayload(big);
    assert.equal(Object.keys(ok).length, MAX_ENTRIES);
    assert.ok(errors.some(e => /too many/i.test(e)));
  });
});

describe('chunkEntries', () => {
  it('spezza in chunk da N', () => {
    const obj = {};
    for (let i = 0; i < 120; i++) obj['q' + i] = 'a' + i;
    const chunks = chunkEntries(obj, 50);
    assert.equal(chunks.length, 3);
    assert.equal(Object.keys(chunks[0]).length, 50);
    assert.equal(Object.keys(chunks[1]).length, 50);
    assert.equal(Object.keys(chunks[2]).length, 20);
  });
  it('oggetto vuoto → un chunk vuoto', () => {
    assert.deepEqual(chunkEntries({}, 50), [{}]);
  });
});

describe('mergeAnswersAdditive', () => {
  it('aggiunge solo chiavi nuove', () => {
    const { bank, added } = mergeAnswersAdditive(
      { a: '1', b: '2' },
      { b: 'SHOULD_NOT', c: '3' }
    );
    assert.equal(bank.b, '2');
    assert.equal(bank.c, '3');
    assert.deepEqual(added, ['c']);
  });

  it('bank vuoto / null', () => {
    const { bank, added } = mergeAnswersAdditive(null, { x: 'y' });
    assert.equal(bank.x, 'y');
    assert.deepEqual(added, ['x']);
  });

  it('noop se tutto già presente', () => {
    const { added } = mergeAnswersAdditive({ a: '1' }, { a: '2' });
    assert.deepEqual(added, []);
  });
});
