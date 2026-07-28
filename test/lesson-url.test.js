'use strict';
/**
 * Identità delle lezioni: le "lezioniAsincrone" devono essere riconosciute come
 * lezioni (il selettore storico non le vedeva) e il confronto fra l'URL su cui
 * si finisce e quello chiesto deve funzionare a prescindere da host/query.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { lessonKey, isLessonUrl, sameLesson, lessonId } = require('../src/lib/lesson-url');
const { SELECTORS } = require('../src/lib/selectors');

const BASE = 'https://tecsial.gsdcampus.it';

describe('lessonKey / isLessonUrl', () => {
  it('riconosce la lezione classica', () => {
    assert.equal(lessonKey(`${BASE}/lezione/show/14065`), 'lezione:14065');
    assert.equal(isLessonUrl(`${BASE}/lezione/show/14065`), true);
  });

  it('riconosce la lezione asincrona (il caso che bloccava i corsi)', () => {
    assert.equal(lessonKey(`${BASE}/lezioneAsincrona/show/14062`), 'lezioneasincrona:14062');
    assert.equal(isLessonUrl(`${BASE}/lezioneAsincrona/show/14062`), true);
  });

  it('ignora query e hash', () => {
    assert.equal(lessonKey(`${BASE}/lezione/show/14065?from=corso#top`), 'lezione:14065');
  });

  it('non confonde corsi e questionari con le lezioni', () => {
    assert.equal(isLessonUrl(`${BASE}/corso/show/17162`), false);
    assert.equal(isLessonUrl(`${BASE}/questionario/show/900`), false);
    assert.equal(lessonKey(''), null);
    assert.equal(lessonKey(null), null);
  });

  it('lessonId estrae il numero', () => {
    assert.equal(lessonId(`${BASE}/lezioneAsincrona/show/14062`), '14062');
    assert.equal(lessonId(`${BASE}/corso/show/1`), null);
  });
});

describe('sameLesson', () => {
  it('vero solo per la stessa lezione, anche con host/query diversi', () => {
    assert.equal(sameLesson(`${BASE}/lezione/show/14065`, '/lezione/show/14065?x=1'), true);
    assert.equal(sameLesson(`${BASE}/lezione/show/14065`, `${BASE}/lezione/show/14066`), false);
  });

  it('lezione classica e asincrona con lo stesso numero NON sono la stessa', () => {
    assert.equal(sameLesson(`${BASE}/lezione/show/14062`, `${BASE}/lezioneAsincrona/show/14062`), false);
  });

  it('URL non-lezione non combaciano mai (nemmeno fra loro)', () => {
    assert.equal(sameLesson(`${BASE}/corso/show/1`, `${BASE}/corso/show/1`), false);
  });
});

describe('selettore link lezione', () => {
  it('copre entrambe le rotte', () => {
    assert.match(SELECTORS.course.lessonLinks, /\/lezione\/show\//);
    assert.match(SELECTORS.course.lessonLinks, /\/lezioneAsincrona\/show\//);
  });
});
