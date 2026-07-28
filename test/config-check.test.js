'use strict';
/**
 * Completezza di config.json: distinguere una configurazione valida da una
 * prima configurazione interrotta a metà (account scelto, orari mai salvati).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkConfig } = require('../src/lib/config-check');

const VALID_URL = 'https://tecsial.gsdcampus.it/autologin/RSSMRA80A01H501U/TOKEN123abc';
const SHIFTS = [{ startHour: 9, startMin: 0, endHour: 13, endMin: 0 }];

let root;

function writeConfig(cfg) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-config-check-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('checkConfig', () => {
  it('config.json assente → missing_file', () => {
    const res = checkConfig(root);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'missing_file');
    assert.equal(res.interrupted, false);
  });

  it('JSON corrotto (setup interrotto durante la scrittura) → bad_json', () => {
    fs.writeFileSync(path.join(root, 'config.json'), '{ "autologinUrl": ');
    assert.equal(checkConfig(root).reason, 'bad_json');
  });

  it('account scelto ma orari mancanti → missing_schedule e interrupted', () => {
    writeConfig({ autologinUrl: VALID_URL, codice_fiscale: 'RSSMRA80A01H501U' });
    const res = checkConfig(root);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'missing_schedule');
    assert.equal(res.hasAccount, true);
    assert.equal(res.interrupted, true);
  });

  it('turni presenti ma non validi → missing_schedule', () => {
    writeConfig({
      autologinUrl: VALID_URL,
      workSchedule: { days: [1, 2], shifts: [{ startHour: 13, startMin: 0, endHour: 9, endMin: 0 }] },
    });
    assert.equal(checkConfig(root).reason, 'missing_schedule');
  });

  it('giorni vuoti → missing_schedule (non ripiega sui default)', () => {
    writeConfig({ autologinUrl: VALID_URL, workSchedule: { days: [], shifts: SHIFTS } });
    assert.equal(checkConfig(root).reason, 'missing_schedule');
  });

  it('placeholder di config.json.example → missing_autologin', () => {
    writeConfig({
      autologinUrl: 'https://tecsial.gsdcampus.it/autologin/CODICEFISCALE/TOKEN',
      workSchedule: { days: [1], shifts: SHIFTS },
    });
    assert.equal(checkConfig(root).reason, 'missing_autologin');
  });

  it('account + giorni + turni validi → ok', () => {
    writeConfig({ autologinUrl: VALID_URL, workSchedule: { days: [1, 2, 3, 4, 5], shifts: SHIFTS } });
    const res = checkConfig(root);
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'ok');
  });

  it('domenica (giorno 0) è un giorno valido', () => {
    writeConfig({ autologinUrl: VALID_URL, workSchedule: { days: [0], shifts: SHIFTS } });
    assert.equal(checkConfig(root).ok, true);
  });
});
