'use strict';
/**
 * Ricostruzione delle date dal log e marcatura delle esecuzioni.
 * Il log porta solo HH:MM:SS: senza questa logica un errore di ieri sera
 * appariva nella plancia come se fosse appena successo.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLogTimeline, formatEventStamp } = require('../scripts/lib/panel-cli');

// Ancora: 22 luglio 2026, 20:15:47 (ora locale) — l'ultima riga del log.
const ANCHOR = new Date(2026, 6, 22, 20, 15, 47).getTime();

describe('parseLogTimeline', () => {
  it('ancora l ultima riga all mtime del file', () => {
    const t = parseLogTimeline(['20:15:47 | Uscita per fine turno lavorativo.'], ANCHOR);
    assert.equal(t.length, 1);
    assert.equal(new Date(t[0].at).getDate(), 22);
    assert.equal(new Date(t[0].at).getHours(), 20);
    assert.equal(t[0].text, 'Uscita per fine turno lavorativo.');
  });

  it('scala un giorno quando si scavalca la mezzanotte all indietro', () => {
    const t = parseLogTimeline([
      '23:58:00 | riga della sera prima',
      '00:03:00 | riga dopo mezzanotte',
      '20:15:47 | ultima riga',
    ], ANCHOR);
    assert.equal(new Date(t[2].at).getDate(), 22, 'ultima riga = giorno dell ancora');
    assert.equal(new Date(t[1].at).getDate(), 22, '00:03 e ancora il 22');
    assert.equal(new Date(t[0].at).getDate(), 21, '23:58 e il giorno prima');
  });

  it('le date crescono monotonamente', () => {
    const t = parseLogTimeline([
      '22:00:00 | a', '23:30:00 | b', '01:00:00 | c', '09:00:00 | d', '20:15:47 | e',
    ], ANCHOR);
    for (let i = 1; i < t.length; i += 1) {
      assert.ok(t[i].at > t[i - 1].at, `evento ${i} deve venire dopo il precedente`);
    }
  });

  it('numera le esecuzioni: 0 = la piu recente', () => {
    const t = parseLogTimeline([
      '09:00:00 | Avvio GSD Campus autoplay',
      '09:05:00 | Video finito.',
      '18:44:08 | Avvio GSD Campus autoplay',
      '18:50:00 | Video finito.',
      '20:15:47 | Uscita per fine turno lavorativo.',
    ], ANCHOR);
    assert.deepEqual(t.map((e) => e.run), [1, 1, 0, 0, 0]);
    assert.deepEqual(t.filter((e) => e.runStart).map((e) => e.run), [1, 0]);
  });

  it('senza marcatori di avvio tutto e run 0', () => {
    const t = parseLogTimeline(['10:00:00 | a', '20:15:47 | b'], ANCHOR);
    assert.deepEqual(t.map((e) => e.run), [0, 0]);
  });

  it('ignora le righe senza timestamp, senza rompersi', () => {
    const t = parseLogTimeline(['spazzatura', '20:15:47 | buona', ''], ANCHOR);
    assert.equal(t.length, 1);
    assert.equal(t[0].text, 'buona');
  });

  it('log vuoto → nessun evento', () => {
    assert.deepEqual(parseLogTimeline([], ANCHOR), []);
  });
});

describe('formatEventStamp', () => {
  const now = new Date(2026, 6, 29, 12, 0, 0).getTime();
  const at = (dd, hh, mm) => new Date(2026, 6, dd, hh, mm, 0).getTime();

  it('oggi → solo orario', () => {
    assert.equal(formatEventStamp(at(29, 9, 5), now), '09:05');
  });

  it('ieri → lo dice', () => {
    assert.equal(formatEventStamp(at(28, 16, 28), now), 'ieri 16:28');
  });

  it('entro la settimana → giorno abbreviato', () => {
    assert.equal(formatEventStamp(at(25, 16, 28), now), 'sab 16:28');
  });

  it('piu vecchio → data esplicita', () => {
    assert.equal(formatEventStamp(at(20, 16, 28), now), '20/7 16:28');
  });
});
