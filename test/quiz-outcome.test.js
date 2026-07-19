'use strict';
/**
 * Parsing esito quiz: punteggio e superato/non superato.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { extractScore, detectOutcomeFromText, scoreLooksPassing } = require('../src/lib/quiz');

describe('extractScore', () => {
  it('legge "Punteggio: 24/30"', () => {
    const s = extractScore('Questionario. Punteggio: 24/30. Fine.');
    assert.ok(s);
    assert.equal(s.got, 24);
    assert.equal(s.total, 30);
    assert.equal(s.pct, 80);
    assert.equal(s.type, 'frac');
  });

  it('legge forma italiana "24 su 30"', () => {
    const s = extractScore('Hai ottenuto 24 su 30 punti');
    assert.ok(s);
    assert.equal(s.got, 24);
    assert.equal(s.total, 30);
  });

  it('legge percentuale esplicita', () => {
    const s = extractScore('Avanzamento 85% del questionario');
    assert.ok(s);
    assert.equal(s.type, 'pct');
    assert.equal(s.pct, 85);
  });

  it('preferisce frazione vicino a "punteggio" rispetto a numeri del sillabo', () => {
    // Senza contesto "punteggio", "4.3 38-39" non deve confondere se c'è un vero score.
    const s = extractScore('4.3 38-39 del sillabo. Voto finale: 30/30. Ok.');
    assert.ok(s);
    assert.equal(s.got, 30);
    assert.equal(s.total, 30);
  });

  it('ritorna null su testo senza punteggio', () => {
    assert.equal(extractScore('Nessun risultato disponibile'), null);
    assert.equal(extractScore(''), null);
    assert.equal(extractScore(null), null);
  });
});

describe('scoreLooksPassing', () => {
  it('true se pct >= 80', () => {
    assert.equal(scoreLooksPassing({ pct: 80 }), true);
    assert.equal(scoreLooksPassing({ pct: 100 }), true);
  });
  it('falsey sotto 80 o score nullo', () => {
    // scoreLooksPassing usa `score && …`: con score null ritorna null (falsey), non false.
    assert.equal(scoreLooksPassing({ pct: 79.9 }), false);
    assert.ok(!scoreLooksPassing(null));
    assert.ok(!scoreLooksPassing({ pct: NaN }));
  });
});

describe('detectOutcomeFromText', () => {
  it('riconosce superato esplicito', () => {
    const o = detectOutcomeFromText('Questionario superato! Complimenti.');
    assert.equal(o.passed, true);
    assert.equal(o.failed, false);
  });

  it('riconosce non superato', () => {
    const o = detectOutcomeFromText('Questionario non superato. Da ripetere.');
    assert.equal(o.failed, true);
    // passed può essere null (false || null da scoreLooksPassing) — conta come non passed
    assert.ok(!o.passed);
  });

  it('riconosce "non hai superato"', () => {
    const o = detectOutcomeFromText('Purtroppo non hai superato il questionario.');
    assert.equal(o.failed, true);
    assert.ok(!o.passed);
  });


  it('score >= 80% conta come passed anche senza testo chiaro', () => {
    const o = detectOutcomeFromText('Punteggio: 24/30');
    assert.equal(o.passed, true);
    assert.ok(o.score);
    assert.equal(o.score.got, 24);
  });

  it('score basso senza testo superato → non passed', () => {
    const o = detectOutcomeFromText('Punteggio: 10/30');
    assert.equal(o.passed, false);
  });
});
