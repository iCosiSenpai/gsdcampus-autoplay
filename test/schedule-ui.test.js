'use strict';
/**
 * Orario del negozio → turni, e anteprima settimanale.
 *
 * Il setup non chiede più "turni" ma "a che ora apre e chiude": qui verifichiamo
 * la traduzione (con e senza pausa pranzo), i rifiuti sensati e il disegno della
 * settimana mostrato prima di salvare.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildShiftsFromStoreHours,
  describeShiftsHuman,
  describeDaysHuman,
  renderWeekPreview,
  formatMinutes,
  toHm,
} = require('../src/lib/schedule-ui');

const hm = (h, m = 0) => ({ hour: h, min: m });

describe('buildShiftsFromStoreHours', () => {
  it('con pausa pranzo genera due fasce', () => {
    const res = buildShiftsFromStoreHours({ open: hm(9), close: hm(20), pause: { start: hm(13), end: hm(16) } });
    assert.equal(res.ok, true);
    assert.deepEqual(res.shifts, [
      { startHour: 9, startMin: 0, endHour: 13, endMin: 0 },
      { startHour: 16, startMin: 0, endHour: 20, endMin: 0 },
    ]);
  });

  it('senza pausa genera una fascia continuata', () => {
    const res = buildShiftsFromStoreHours({ open: hm(9, 30), close: hm(18) });
    assert.equal(res.shifts.length, 1);
    assert.equal(describeShiftsHuman(res.shifts), '09:30-18:00');
  });

  it('rifiuta la chiusura prima dell\'apertura', () => {
    const res = buildShiftsFromStoreHours({ open: hm(18), close: hm(9) });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'chiusura_prima_apertura');
  });

  it('rifiuta una pausa fuori dall\'orario di apertura', () => {
    const res = buildShiftsFromStoreHours({ open: hm(9), close: hm(13), pause: { start: hm(14), end: hm(16) } });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'pausa_fuori_orario');
  });

  it('rifiuta una pausa invertita', () => {
    const res = buildShiftsFromStoreHours({ open: hm(9), close: hm(20), pause: { start: hm(16), end: hm(13) } });
    assert.equal(res.reason, 'pausa_invertita');
  });

  it('accetta i minuti come numero puro', () => {
    const res = buildShiftsFromStoreHours({ open: 9 * 60 + 15, close: 13 * 60 });
    assert.equal(describeShiftsHuman(res.shifts), '09:15-13:00');
  });
});

describe('frasi in italiano', () => {
  it('elenca i turni con "e" prima dell\'ultimo', () => {
    assert.equal(describeShiftsHuman([
      { startHour: 9, startMin: 0, endHour: 13, endMin: 0 },
      { startHour: 16, startMin: 0, endHour: 20, endMin: 0 },
    ]), '09:00-13:00 e 16:00-20:00');
  });

  it('i giorni sono parole, non numeri', () => {
    assert.equal(describeDaysHuman([1, 2, 3, 4, 5]), 'lunedì, martedì, mercoledì, giovedì e venerdì');
    assert.equal(describeDaysHuman([0, 1, 2, 3, 4, 5, 6]), 'tutti i giorni');
    assert.equal(describeDaysHuman([6]), 'sabato');
    assert.equal(describeDaysHuman([]), 'nessun giorno');
  });

  it('la settimana parte da lunedì anche con la domenica dentro', () => {
    assert.equal(describeDaysHuman([0, 5]), 'venerdì e domenica');
  });

  it('formatMinutes e toHm sono coerenti', () => {
    assert.equal(formatMinutes(9 * 60 + 5), '09:05');
    assert.deepEqual(toHm(13 * 60 + 30), { hour: 13, min: 30 });
  });
});

describe('renderWeekPreview', () => {
  const shifts = [
    { startHour: 9, startMin: 0, endHour: 13, endMin: 0 },
    { startHour: 16, startMin: 0, endHour: 20, endMin: 0 },
  ];

  it('una riga per giorno, lunedì in cima, più il righello delle ore', () => {
    const lines = renderWeekPreview({ days: [1, 2, 3, 4, 5], shifts });
    assert.equal(lines.length, 8); // righello + 7 giorni
    assert.match(lines[1], /^ {2}lun/);
    assert.match(lines[7], /^ {2}dom/);
  });

  it('i giorni non lavorativi dicono "chiuso"', () => {
    const lines = renderWeekPreview({ days: [1], shifts });
    assert.match(lines.find((l) => l.includes('sab')), /chiuso/);
    assert.equal(/chiuso/.test(lines.find((l) => l.includes('lun'))), false);
  });

  it('le celle piene coprono solo le ore di lavoro', () => {
    const [, lun] = renderWeekPreview({ days: [1], shifts, from: 8, to: 21 });
    const row = lun.slice(8);              // salta etichetta e spazi
    assert.equal(row.length, 26);           // 13 ore × mezz'ora
    assert.equal(row.slice(0, 2), '··');    // 08:00-09:00 chiuso
    assert.equal(row.slice(2, 10), '████████'); // 09:00-13:00 aperto
    assert.equal(row.slice(10, 16), '······');   // pausa 13:00-16:00
    assert.equal(row.slice(16, 24), '████████'); // 16:00-20:00 aperto
  });

  it('senza turni non explode e mostra tutto chiuso', () => {
    const lines = renderWeekPreview({ days: [], shifts: [] });
    assert.equal(lines.length, 8);
    assert.equal(lines.filter((l) => l.includes('chiuso')).length, 7);
  });
});
