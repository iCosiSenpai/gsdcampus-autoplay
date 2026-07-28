'use strict';
/**
 * Widget del setup guidato: orologio a frecce, lista da spuntare, ricerca
 * incrementale. Qui testiamo la logica pura (niente terminale): è quella che
 * garantisce che l'utente non possa inserire un orario impossibile né dover
 * digitare numeri di giorni.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { execFileSync } = require('child_process');
const path = require('path');

const {
  stepMinutes, formatMinutes, parseTimeToMinutes,
  toggleSelection, filterItems, normalizeForFilter, TIME_STEP_MIN,
} = require('../scripts/lib/prompt-cli');

const CLI = path.join(__dirname, '..', 'scripts', 'lib', 'prompt-cli.js');
const runCli = (args, input) => execFileSync(process.execPath, [CLI, ...args], {
  input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
}).trim();

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

describe('tornare indietro di una pagina', () => {
  it('l\'orologio risponde vuoto quando si torna indietro', () => {
    assert.equal(runCli(['time', '--title', 'Apertura', '--default', '09:00'], 'b\n'), '');
    assert.equal(runCli(['time', '--title', 'Apertura', '--default', '09:00'], 'indietro\n'), '');
  });

  it('l\'orologio conferma normalmente un orario scritto', () => {
    assert.equal(runCli(['time', '--title', 'Apertura', '--default', '09:00'], '9:45\n'), '09:45');
  });

  it('Invio a vuoto tiene il valore proposto (non è un indietro)', () => {
    assert.equal(runCli(['time', '--title', 'Apertura', '--default', '09:00'], '\n'), '09:00');
  });

  it('la lista da spuntare risponde vuoto quando si torna indietro', () => {
    assert.equal(runCli(['check', '--title', 'Giorni', '--default', '1,2', '--', 'lun', 'mar', 'mer'], 'b\n'), '');
  });

  it('la lista da spuntare conferma la selezione scritta', () => {
    assert.equal(runCli(['check', '--title', 'Giorni', '--default', '1', '--', 'lun', 'mar', 'mer'], '1,3\n'), '1,3');
  });
});
