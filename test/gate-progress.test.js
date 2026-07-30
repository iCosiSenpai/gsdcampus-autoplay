'use strict';

const assert = require('node:assert');
const { describe, it } = require('node:test');

const { requestedLessonAdvanced } = require('../src/lib/course-runner');

// La piattaforma, aprendo una lezione, può dirottare su un'altra: «completa prima
// questa attività». Il runner segue il cancello, guarda quel video, e poi deve
// decidere se insistere sulla lezione che aveva chiesto o arrendersi.
//
// Prima decideva contando i reindirizzamenti: tre e via. Il difetto è che verificava
// il progresso della lezione DEL CANCELLO — già al 100% per definizione — e mai di
// quella che doveva avanzare. Sul corso 19568 la lezione chiesta è passata da 0% a
// 96,04% e proprio in quel momento è stata marcata bloccata.
describe('la lezione chiesta è avanzata dopo il cancello?', () => {
  it('da 0% a 96,04% è progresso: il caso reale che veniva abbandonato', () => {
    assert.equal(requestedLessonAdvanced(0, 96.04), true);
  });

  it('ferma sullo stesso valore non è progresso', () => {
    assert.equal(requestedLessonAdvanced(96.04, 96.04), false);
  });

  it('un movimento di decimali non conta come progresso', () => {
    // La piattaforma persiste percentuali con i decimali e un ricalcolo può muoverle
    // di un nulla: prenderlo per progresso farebbe insistere all'infinito.
    assert.equal(requestedLessonAdvanced(96.04, 96.3), false);
    assert.equal(requestedLessonAdvanced(96.04, 96.04001), false);
  });

  it('una crescita oltre la tolleranza conta', () => {
    assert.equal(requestedLessonAdvanced(96.04, 97), true);
  });

  it('un arretramento non è progresso', () => {
    assert.equal(requestedLessonAdvanced(50, 40), false);
  });

  it('senza un termine di paragone non si inventa un progresso', () => {
    // Se la percentuale non è leggibile, insistere sarebbe una scommessa: meglio
    // lasciare che il contatore dei tentativi faccia il suo lavoro.
    assert.equal(requestedLessonAdvanced(null, 96.04), false);
    assert.equal(requestedLessonAdvanced(0, null), false);
    assert.equal(requestedLessonAdvanced(undefined, undefined), false);
    assert.equal(requestedLessonAdvanced(NaN, 50), false);
    assert.equal(requestedLessonAdvanced(0, NaN), false);
  });

  it('la tolleranza è regolabile', () => {
    assert.equal(requestedLessonAdvanced(50, 51, 2), false);
    assert.equal(requestedLessonAdvanced(50, 53, 2), true);
  });
});
