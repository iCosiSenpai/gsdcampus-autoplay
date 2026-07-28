'use strict';
/**
 * Widget del setup guidato: orologio a frecce, lista da spuntare, ricerca
 * incrementale. Qui testiamo la logica pura (niente terminale): è quella che
 * garantisce che l'utente non possa inserire un orario impossibile né dover
 * digitare numeri di giorni.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  stepMinutes, formatMinutes, parseTimeToMinutes,
  toggleSelection, filterItems, normalizeForFilter, TIME_STEP_MIN,
} = require('../scripts/lib/prompt-cli');

describe('orologio a frecce', () => {
  it('il passo è di 15 minuti', () => {
    assert.equal(TIME_STEP_MIN, 15);
    assert.equal(formatMinutes(stepMinutes(9 * 60, TIME_STEP_MIN)), '09:15');
    assert.equal(formatMinutes(stepMinutes(9 * 60, -TIME_STEP_MIN)), '08:45');
  });

  it('le frecce su/giù spostano di un\'ora', () => {
    assert.equal(formatMinutes(stepMinutes(9 * 60, 60)), '10:00');
    assert.equal(formatMinutes(stepMinutes(9 * 60, -60)), '08:00');
  });

  it('gira intorno alla mezzanotte invece di uscire dal giorno', () => {
    assert.equal(formatMinutes(stepMinutes(23 * 60 + 45, 15)), '00:00');
    assert.equal(formatMinutes(stepMinutes(0, -15)), '23:45');
  });

  it('accetta anche gli orari scritti a mano (fallback non interattivo)', () => {
    assert.equal(parseTimeToMinutes('9'), 540);
    assert.equal(parseTimeToMinutes('9:30'), 570);
    assert.equal(parseTimeToMinutes('09.30'), 570);
    assert.equal(parseTimeToMinutes('1630'), 990);
    assert.equal(parseTimeToMinutes('930'), 570);
  });

  it('rifiuta quello che non è un orario', () => {
    assert.equal(parseTimeToMinutes('25:00'), null);
    assert.equal(parseTimeToMinutes('9:70'), null);
    assert.equal(parseTimeToMinutes('mattina'), null);
    assert.equal(parseTimeToMinutes(''), null);
  });
});

describe('lista da spuntare', () => {
  it('spunta e togli mantenendo l\'ordine', () => {
    let sel = [0, 1, 2, 3, 4];
    sel = toggleSelection(sel, 5);
    assert.deepEqual(sel, [0, 1, 2, 3, 4, 5]);
    sel = toggleSelection(sel, 0);
    assert.deepEqual(sel, [1, 2, 3, 4, 5]);
  });
});

describe('ricerca incrementale', () => {
  const items = [
    { label: 'MARIO ROSSI', value: 1 },
    { label: 'STEFANO GRECO', value: 2 },
    { label: 'GIUSEPPÈ VERDI', value: 3 },
    { label: 'ROSSANA BIANCHI', value: 4 },
  ];

  it('senza testo mostra tutti', () => {
    assert.equal(filterItems(items, '').length, 4);
  });

  it('filtra per pezzi di cognome, senza badare a maiuscole', () => {
    assert.deepEqual(filterItems(items, 'ross').map((i) => i.value), [1, 4]);
    assert.deepEqual(filterItems(items, 'GRE').map((i) => i.value), [2]);
  });

  it('le parole possono essere in qualsiasi ordine', () => {
    assert.deepEqual(filterItems(items, 'rossi mar').map((i) => i.value), [1]);
  });

  it('ignora gli accenti', () => {
    assert.deepEqual(filterItems(items, 'giuseppe').map((i) => i.value), [3]);
    assert.equal(normalizeForFilter('GIUSEPPÈ  VERDI'), 'giuseppe verdi');
  });

  it('nessuna corrispondenza torna lista vuota (non un errore)', () => {
    assert.deepEqual(filterItems(items, 'zzz'), []);
  });
});
