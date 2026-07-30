'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { parseClockToSeconds, isProgressRegistered } = require('../src/lib/video');

// La piattaforma salva la posizione del video **a intervalli**, non alla fine. Uscire
// appena il video termina lascia registrata la penultima posizione, e la lezione resta
// appena sotto il 100%: il suo cancello non si apre più, e con la piattaforma che svela il
// contenuto a blocchi resta chiuso anche tutto il resto del corso.
//
// Il caso reale: corso 19568, lezione 14241. Video di 15:33 guardato fino a 15:32, «Video
// finito», e sulla pagina corso 96,04% per sempre. Il numero non era casuale — 14:57 su
// 15:33 fa 96,04%: l'ultimo salvataggio, scattato circa mezzo minuto prima della fine.
describe('posizione registrata dalla piattaforma', () => {
  describe('lettura del contatore', () => {
    it('legge il formato hh:mm:ss dell\'indicatore', () => {
      // `span#avanzamento-registrato`, letto sulla pagina vera.
      assert.equal(parseClockToSeconds('00:14:57'), 897);
      assert.equal(parseClockToSeconds('00:15:33'), 933);
      assert.equal(parseClockToSeconds('01:00:00'), 3600);
    });

    it('accetta anche mm:ss', () => {
      assert.equal(parseClockToSeconds('14:57'), 897);
      assert.equal(parseClockToSeconds('0:30'), 30);
    });

    it('tollera gli spazi attorno', () => {
      assert.equal(parseClockToSeconds('  00:14:57 '), 897);
    });

    it('rifiuta ciò che non è un orario invece di indovinare', () => {
      // Un valore inventato qui farebbe credere registrata una fine che non c'è.
      for (const bad of ['', null, undefined, 'n/d', '96%', '14:60', '14:99', 'abc', '1:2:3:4']) {
        assert.equal(parseClockToSeconds(bad), null, `avrebbe dovuto rifiutare: ${bad}`);
      }
    });
  });

  describe('la fine è registrata?', () => {
    it('il caso reale: 14:57 su 15:33 NON è la fine', () => {
      // Esattamente il 96,04% che teneva bloccato il corso.
      assert.equal(isProgressRegistered(897, 933), false);
    });

    it('la fine esatta conta', () => {
      assert.equal(isProgressRegistered(933, 933), true);
    });

    it('una tolleranza di pochi secondi conta', () => {
      // La posizione registrata non arriva al secondo esatto della durata: pretenderlo
      // farebbe aspettare invano ogni volta.
      assert.equal(isProgressRegistered(931, 933), true);
      assert.equal(isProgressRegistered(930, 933), true);
      assert.equal(isProgressRegistered(929, 933), false);
    });

    it('senza durata non si conclude niente', () => {
      // Meglio non attendere che attendere contro un numero inventato.
      assert.equal(isProgressRegistered(897, null), false);
      assert.equal(isProgressRegistered(897, NaN), false);
      assert.equal(isProgressRegistered(897, 0), false);
      assert.equal(isProgressRegistered(null, 933), false);
    });

    it('una posizione oltre la durata conta come fine', () => {
      // Capita: la piattaforma arrotonda per eccesso.
      assert.equal(isProgressRegistered(935, 933), true);
    });

    it('la tolleranza è regolabile', () => {
      assert.equal(isProgressRegistered(920, 933, 20), true);
      assert.equal(isProgressRegistered(920, 933, 5), false);
    });
  });
});
