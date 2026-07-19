'use strict';
/**
 * Parsing e normalizzazione orari lavorativi (senza leggere config.json).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTime,
  isValidShift,
  normalizeShifts,
  normalizeDays,
  formatTime,
} = require('../src/lib/schedule');

describe('parseTime', () => {
  it('accetta ora piena "9" e "16"', () => {
    assert.deepEqual(parseTime('9'), { hour: 9, min: 0 });
    assert.deepEqual(parseTime('16'), { hour: 16, min: 0 });
  });

  it('accetta H:MM e HH:MM', () => {
    assert.deepEqual(parseTime('9:30'), { hour: 9, min: 30 });
    assert.deepEqual(parseTime('09:30'), { hour: 9, min: 30 });
  });

  it('accetta H.MM e HH.MM', () => {
    assert.deepEqual(parseTime('9.30'), { hour: 9, min: 30 });
    assert.deepEqual(parseTime('09.30'), { hour: 9, min: 30 });
  });

  it('accetta HMM e HHMM', () => {
    assert.deepEqual(parseTime('930'), { hour: 9, min: 30 });
    assert.deepEqual(parseTime('0930'), { hour: 9, min: 30 });
    assert.deepEqual(parseTime('1630'), { hour: 16, min: 30 });
  });

  it('rifiuta input non validi', () => {
    assert.equal(parseTime(''), null);
    assert.equal(parseTime('25'), null);
    assert.equal(parseTime('9:99'), null);
    assert.equal(parseTime('abc'), null);
    assert.equal(parseTime(null), null);
  });
});

describe('formatTime', () => {
  it('padding a 2 cifre', () => {
    assert.equal(formatTime(9, 5), '09:05');
    assert.equal(formatTime(16, 30), '16:30');
  });
});

describe('isValidShift', () => {
  it('accetta turno con start < end', () => {
    assert.equal(
      isValidShift({ startHour: 9, startMin: 0, endHour: 13, endMin: 0 }),
      true
    );
  });
  it('rifiuta start >= end o fuori range', () => {
    assert.equal(
      isValidShift({ startHour: 13, startMin: 0, endHour: 9, endMin: 0 }),
      false
    );
    assert.equal(
      isValidShift({ startHour: 25, startMin: 0, endHour: 26, endMin: 0 }),
      false
    );
    assert.equal(isValidShift(null), false);
  });
});

describe('normalizeShifts', () => {
  it('ordina i turni per orario di inizio', () => {
    const out = normalizeShifts([
      { startHour: 16, startMin: 0, endHour: 20, endMin: 0 },
      { startHour: 9, startMin: 0, endHour: 13, endMin: 0 },
    ]);
    assert.equal(out.length, 2);
    assert.equal(out[0].startHour, 9);
    assert.equal(out[1].startHour, 16);
  });

  it('scarta turni invalidi', () => {
    const out = normalizeShifts([
      { startHour: 9, startMin: 0, endHour: 13, endMin: 0 },
      { startHour: 20, startMin: 0, endHour: 10, endMin: 0 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].startHour, 9);
  });

  it('taglia i turni successivi in caso di sovrapposizione', () => {
    const out = normalizeShifts([
      { startHour: 9, startMin: 0, endHour: 14, endMin: 0 },
      { startHour: 13, startMin: 0, endHour: 18, endMin: 0 },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0].endHour, 14);
  });

  it('array vuoto o non-array → []', () => {
    assert.deepEqual(normalizeShifts([]), []);
    assert.deepEqual(normalizeShifts(null), []);
  });
});

describe('normalizeDays', () => {
  it('dedup e ordina', () => {
    assert.deepEqual(normalizeDays([5, 1, 1, 3]), [1, 3, 5]);
  });
  it('fallback default lun-ven se vuoto/invalido', () => {
    assert.deepEqual(normalizeDays([]), [1, 2, 3, 4, 5]);
    assert.deepEqual(normalizeDays([99, -1]), [1, 2, 3, 4, 5]);
  });
});
