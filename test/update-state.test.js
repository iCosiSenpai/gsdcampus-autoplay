'use strict';
/**
 * Stato dell'auto-aggiornamento: frase "controllato N fa" + rilevamento di un
 * auto-update fermo (nessun controllo recente / agent non installato).
 */
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  markUpdateState, readUpdateState, describeUpdateState, formatAge, STALE_MS,
} = require('../src/lib/update-state');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-update-state-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('formatAge', () => {
  it('sotto il minuto dice "adesso"', () => {
    assert.equal(formatAge(5000), 'adesso');
  });
  it('minuti, ore e giorni', () => {
    assert.equal(formatAge(4 * 60 * 1000), '4m');
    assert.equal(formatAge(3 * 3600 * 1000 + 20 * 60 * 1000), '3h 20m');
    assert.equal(formatAge(2 * 86400 * 1000), '2g');
  });
});

describe('markUpdateState', () => {
  it('scrive lastCheckAt e esito', () => {
    const now = Date.now();
    const s = markUpdateState(root, { result: 'up_to_date', localVersion: '964824c', now });
    assert.equal(s.result, 'up_to_date');
    assert.equal(s.localVersion, '964824c');
    assert.equal(readUpdateState(root).lastCheckAt, s.lastCheckAt);
  });

  it('conserva l\'ultimo aggiornamento reale nei giri successivi', () => {
    const t0 = Date.now() - 3600000;
    markUpdateState(root, { result: 'updated', updatedTo: 'aaaaaaa', now: t0 });
    const later = markUpdateState(root, { result: 'up_to_date', localVersion: 'aaaaaaa' });
    assert.equal(later.updatedTo, 'aaaaaaa');
    assert.equal(Date.parse(later.updatedAt), t0);
  });

  it('esito sconosciuto ripiega su up_to_date (mai eccezioni)', () => {
    assert.equal(markUpdateState(root, { result: 'boh' }).result, 'up_to_date');
  });
});

describe('describeUpdateState', () => {
  const now = Date.UTC(2026, 6, 28, 12, 0, 0);
  const at = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();

  it('senza stato invita ad attendere il primo controllo', () => {
    const d = describeUpdateState(null, now);
    assert.equal(d.level, 'unknown');
    assert.match(d.text, /mai controllato/);
  });

  it('agent non installato → avviso, indipendente dallo stato', () => {
    const d = describeUpdateState({ lastCheckAt: at(1), result: 'up_to_date' }, now, { agentInstalled: false });
    assert.equal(d.level, 'warn');
    assert.match(d.text, /non attivo/);
  });

  it('controllo recente senza novità → ok con età e versione', () => {
    const d = describeUpdateState({ lastCheckAt: at(4), result: 'up_to_date', localVersion: '964824c' }, now, { agentInstalled: true });
    assert.equal(d.level, 'ok');
    assert.equal(d.stale, false);
    assert.match(d.text, /controllato 4m fa/);
    assert.match(d.text, /964824c/);
  });

  it('nessun controllo da oltre la soglia → stale e avviso', () => {
    const old = new Date(now - STALE_MS - 60000).toISOString();
    const d = describeUpdateState({ lastCheckAt: old, result: 'up_to_date' }, now, { agentInstalled: true });
    assert.equal(d.stale, true);
    assert.equal(d.level, 'warn');
    assert.match(d.text, /nessun controllo recente/);
  });

  it('aggiornamento appena applicato', () => {
    const d = describeUpdateState({ lastCheckAt: at(2), result: 'updated', updatedTo: 'bbbbbbb' }, now, { agentInstalled: true });
    assert.match(d.text, /aggiornato a bbbbbbb 2m fa/);
  });

  it('opt-out in config.json → informativo, non un avviso', () => {
    const d = describeUpdateState({ lastCheckAt: at(600), result: 'up_to_date' }, now, { agentInstalled: false, disabled: true });
    assert.equal(d.level, 'unknown');
    assert.equal(d.stale, false);
    assert.match(d.text, /disattivato in config\.json/);
  });

  it('offline e dipendenze mancanti sono avvisi', () => {
    assert.equal(describeUpdateState({ lastCheckAt: at(3), result: 'offline' }, now, { agentInstalled: true }).level, 'warn');
    assert.equal(describeUpdateState({ lastCheckAt: at(3), result: 'deps_required' }, now, { agentInstalled: true }).level, 'warn');
  });

  it('ricorda l\'ultimo aggiornamento reale anche quando non c\'è niente di nuovo', () => {
    const d = describeUpdateState({
      lastCheckAt: at(5), result: 'up_to_date', localVersion: '964824c', updatedAt: at(180), updatedTo: '964824c',
    }, now, { agentInstalled: true });
    assert.match(d.text, /ultimo aggiornamento 3h fa/);
  });
});
