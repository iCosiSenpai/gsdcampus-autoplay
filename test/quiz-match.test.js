'use strict';
/**
 * Regressioni sul matching della banca trusted (quiz.js).
 * Bug storici codificati qui: hijack sottostringa corta, prefisso "1. ", soglia Jaccard.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { findKnownAnswer, normKey, similarity } = require('../src/lib/quiz-match');

const opts = (texts) => texts.map((text, index) => ({ text, index }));

describe('normKey', () => {
  it('rimuove prefisso numerico e normalizza', () => {
    assert.equal(normKey('1. Ciao Mondo!'), normKey('Ciao Mondo'));
    assert.equal(normKey('12. Domanda X'), normKey('Domanda X'));
  });

  it('è case-insensitive e toglie punteggiatura', () => {
    assert.equal(normKey('Hello, World?'), normKey('hello world'));
  });
});

describe('similarity (Jaccard)', () => {
  it('è 1 su stringhe equivalenti (stop-word rimosse)', () => {
    const s = similarity('la privacy dei dati', 'privacy dati');
    assert.ok(s > 0.9, `atteso ~1, got ${s}`);
  });

  it('è bassa su domande diverse', () => {
    const s = similarity('motore di ricerca Startpage', 'modelli teorici comunicazione');
    assert.ok(s < 0.3, `atteso bassa, got ${s}`);
  });
});

describe('findKnownAnswer', () => {
  const bank = {
    'Secondo le fonti, in che modo il motore di ricerca Startpage protegge la privacy?':
      'Non memorizza l\'indirizzo IP',
    'Qual è il rischio principale del phishing?': 'Furto di credenziali',
  };

  const startpageOpts = opts([
    'Memorizza tutto lo storico',
    'Non memorizza l\'indirizzo IP',
    'Vende i cookie a terzi',
    'Nessuna delle precedenti',
  ]);

  it('match esatto sulla domanda', () => {
    const m = findKnownAnswer(
      'Secondo le fonti, in che modo il motore di ricerca Startpage protegge la privacy?',
      startpageOpts,
      bank
    );
    assert.ok(m);
    assert.equal(m.optionIndex, 1);
    assert.equal(m.score, 1);
  });

  it('match nonostante prefisso numerico randomizzato "1. "', () => {
    const m = findKnownAnswer(
      '1. Secondo le fonti, in che modo il motore di ricerca Startpage protegge la privacy?',
      startpageOpts,
      bank
    );
    assert.ok(m);
    assert.equal(m.optionIndex, 1);
  });

  it('rifiuta sottostringa corta che hijackerebbe una domanda lunga (coverage < 80%)', () => {
    // Bug storico: una entry corta "privacy" matchava qualsiasi domanda lunga che la conteneva.
    const shortBank = { privacy: 'Non memorizza l\'indirizzo IP' };
    const longQ =
      'Secondo le fonti, in che modo il motore di ricerca Startpage protegge la privacy degli utenti online?';
    const m = findKnownAnswer(longQ, startpageOpts, shortBank);
    assert.equal(m, null);
  });

  it('accetta sottostringa se la domanda corta copre ≥80% dei token della lunga', () => {
    // tokenize filtra token len≤2 e stop-word IT. Con 4 token in common e 5 totali
    // sulla lunga: coverage = 4/5 = 0.8 → gate superato.
    // corta: rischio principale phishing credenziali  (4 token significativi)
    // lunga: + "online" (1 extra) → 5 token, coverage 0.8
    const shortBank = {
      'rischio principale phishing credenziali': 'Furto di credenziali',
    };
    const long = 'rischio principale phishing credenziali online';
    const o = opts(['Furto di credenziali', 'Perdita di batteria', 'Latenza rete', 'Altro']);
    const m = findKnownAnswer(long, o, shortBank);
    assert.ok(m, 'atteso match per coverage alta');
    assert.equal(m.optionIndex, 0);
    assert.ok(m.score >= 0.9);
  });


  it('ritorna null se nessuna voce supera la soglia 0.75', () => {
    const m = findKnownAnswer(
      'Argomento totalmente differente sulla cucina molecolare',
      startpageOpts,
      bank
    );
    assert.equal(m, null);
  });

  it('mappa la risposta nota all\'opzione corretta anche con testo leggermente diverso', () => {
    const m = findKnownAnswer(
      'Qual è il rischio principale del phishing?',
      opts(['Furto di credenziali personali', 'Crash del browser', 'Aggiornamento OS', 'Niente']),
      bank
    );
    assert.ok(m);
    assert.equal(m.optionIndex, 0);
  });
});
