'use strict';
/**
 * Perché una pagina corso non contiene lezioni.
 *
 * Il caso che ha generato questi test è reale: su /corso/show/17162 la
 * piattaforma serviva l'informativa (privacy + piano formativo + scheda
 * tecnica) senza redirect, il runner non la riconosceva (guardava solo l'URL) e
 * il log diceva soltanto "No lesson/quiz links found" salvando come dump la
 * pagina di informativa.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { diagnoseEmptyCoursePage } = require('../src/lib/course-page-diag');
const { SELECTORS, probeHtml } = require('../src/lib/selectors');

const FIXTURES = path.join(__dirname, 'fixtures', 'selectors');
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

test('informativa: si riprova accettandola, senza gridare all\'errore', () => {
  const d = diagnoseEmptyCoursePage({ hasInformativaForm: true, anchorCount: 40 });
  assert.strictEqual(d.reason, 'informativa');
  assert.strictEqual(d.retryInformativa, true);
  assert.strictEqual(d.recordError, false);
  assert.match(d.message, /informativa/i);
});

test('corso concluso con attestato: nessun errore, nessun dump', () => {
  const d = diagnoseEmptyCoursePage({ hasCertificate: true, anchorCount: 30 });
  assert.strictEqual(d.reason, 'attestato');
  assert.strictEqual(d.recordError, false);
});

test('login page: colpa della sessione, non del corso', () => {
  const d = diagnoseEmptyCoursePage({ isLoginPage: true, hasInformativaForm: true });
  assert.strictEqual(d.reason, 'login');
  assert.strictEqual(d.retryInformativa, false);
});

test('gate "completa l\'attività corrente": si riprende, non è un guasto', () => {
  const d = diagnoseEmptyCoursePage({ hasGateNotice: true, anchorCount: 25 });
  assert.strictEqual(d.reason, 'gate');
  assert.strictEqual(d.recordError, false);
});

test('solo PDF: corso senza video né quiz', () => {
  const d = diagnoseEmptyCoursePage({ hasPdf: true, anchorCount: 20 });
  assert.strictEqual(d.reason, 'pdf');
  assert.strictEqual(d.recordError, false);
});

test('pagina vuota o causa ignota: dump per analisi', () => {
  const vuota = diagnoseEmptyCoursePage({ anchorCount: 2 });
  assert.strictEqual(vuota.reason, 'vuota');
  assert.strictEqual(vuota.recordError, true);

  const ignota = diagnoseEmptyCoursePage({ anchorCount: 42 });
  assert.strictEqual(ignota.reason, 'sconosciuto');
  assert.strictEqual(ignota.recordError, true);
});

test('nessun flag: non inventa diagnosi', () => {
  const d = diagnoseEmptyCoursePage();
  assert.strictEqual(d.reason, 'vuota');
  assert.ok(typeof d.message === 'string' && d.message.length > 10);
});

test('il selettore informativa matcha il form reale della piattaforma', () => {
  const html = read('informativa.snippet.html');
  // Il form si riconosce per id oppure per action: entrambi i rami del selettore
  // sono presenti nella pagina reale.
  assert.ok(SELECTORS.informativa.courseForm.includes('informativa_form'));
  assert.ok(/id="informativa_form"/.test(html));
  assert.ok(/action="[^"]*acceptInformativa"/.test(html));
  assert.ok(/class="form-check-input accept"/.test(html));
  // Il bottone Prosegui nasce disabilitato: il runner deve abilitarlo.
  assert.ok(/<button type="submit"[^>]*disabled/.test(html));
  const r = probeHtml(html, 'informativa');
  assert.strictEqual(r.ok, true, `marker informativa mancanti: ${r.missing.join(', ')}`);
});

test('la pagina corso di riferimento include una lezione asincrona', () => {
  const html = read('course.snippet.html');
  assert.ok(/lezioneAsincrona\/show\/\d+/.test(html));
  const r = probeHtml(html, 'course');
  assert.strictEqual(r.ok, true, `marker corso mancanti: ${r.missing.join(', ')}`);
});
