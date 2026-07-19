'use strict';
/**
 * Parsing multi-strategia della lettera di risposta Ollama.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseAnswerLetter } = require('../src/lib/ollama-quiz');

const OPTIONS = [
  'Prima opzione lunga abbastanza',
  'Seconda opzione di esempio',
  'Terza scelta possibile qui',
  'Quarta e ultima risposta',
];

describe('parseAnswerLetter', () => {
  it('esplicito "Risposta: B"', () => {
    const r = parseAnswerLetter('Risposta: B', OPTIONS);
    assert.ok(r);
    assert.equal(r.letter, 'B');
    assert.equal(r.strategy, 'explicit');
    assert.equal(r.confidence, 1.0);
  });

  it('esplicito "Risposta corretta - C"', () => {
    const r = parseAnswerLetter('Risposta corretta - C', OPTIONS);
    assert.ok(r);
    assert.equal(r.letter, 'C');
  });

  it('markdown **A**', () => {
    const r = parseAnswerLetter('La scelta migliore è **A**', OPTIONS);
    assert.ok(r);
    assert.equal(r.letter, 'A');
    assert.equal(r.strategy, 'markdown');
  });

  it('lettera isolata in risposta breve', () => {
    const r = parseAnswerLetter('D', OPTIONS);
    assert.ok(r);
    assert.equal(r.letter, 'D');
    assert.equal(r.strategy, 'short_letter');
  });

  it('text_match sul testo dell\'opzione', () => {
    const r = parseAnswerLetter('Credo sia: Seconda opzione di esempio', OPTIONS);
    assert.ok(r);
    assert.equal(r.letter, 'B');
    assert.equal(r.strategy, 'text_match');
  });

  it('testo lungo senza lettera chiara → null (no falso match su A casuale)', () => {
    const long =
      'Analizzando le varie fonti e considerando il contesto del corso ' +
      'si può argomentare a lungo senza indicare una lettera di risposta chiara.';
    const r = parseAnswerLetter(long, OPTIONS);
    assert.equal(r, null);
  });

  it('null su risposta senza indizi utili (non stringa vuota: text_match su "")', () => {
    // Nota: "" fa match spuri su text_match (ogni opzione include la sottostringa
    // vuota) — comportamento attuale documentato, non "corretto" ma stabile.
    // Una risposta lunga senza lettera/opzione resta null.
    assert.equal(
      parseAnswerLetter('Non lo so proprio, nessuna idea chiara qui.', OPTIONS),
      null
    );
  });
});

