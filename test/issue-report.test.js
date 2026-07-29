'use strict';
/**
 * Segnalazione issue: attribuzione dello store e compressione del log.
 * Solo helper puri (niente disco, niente rete, niente config reale).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  redactText,
  collapseProgress,
  storeTagOf,
  memberTag,
  fileAge,
} = require('../scripts/lib/issue-report');

describe('collapseProgress', () => {
  const prog = (t) => `19:23:06 | Video: ${t} / 18:57`;

  it('comprime una sequenza e tiene il conteggio', () => {
    const out = collapseProgress([
      '19:23:01 | Apertura: https://x/lezione/show/1',
      prog('0:30'), prog('1:00'), prog('1:30'),
      '19:40:06 | Video finito.',
    ]);
    assert.deepEqual(out, [
      '19:23:01 | Apertura: https://x/lezione/show/1',
      '   … 3 righe di avanzamento video omesse',
      '19:40:06 | Video finito.',
    ]);
  });

  it('una riga isolata resta com\'è', () => {
    const out = collapseProgress(['a', prog('0:30'), 'b']);
    assert.deepEqual(out, ['a', prog('0:30'), 'b']);
  });

  it('non tocca le righe che contano', () => {
    const errori = [
      '09:01:24 | Errore durante autologin (tentativo 1): page.goto: Target page, context or browser has been closed',
      '17:23:51 | Verifico quiz finale...',
      '12:16:24 | MONITOR ERROR outer: page.waitForTimeout: Target page closed',
    ];
    assert.deepEqual(collapseProgress(errori), errori);
  });

  it('comprime anche una sequenza in coda al file', () => {
    const out = collapseProgress(['a', prog('0:30'), prog('1:00')]);
    assert.deepEqual(out, ['a', '   … 2 righe di avanzamento video omesse']);
  });

  it('lista vuota → lista vuota', () => {
    assert.deepEqual(collapseProgress([]), []);
  });
});

describe('attribuzione store', () => {
  it('storeTag esplicito vince e viene ripulito', () => {
    assert.equal(
      storeTagOf({ storeTag: 'Store Roma #1!!', codice_fiscale: 'AAABBB00A00A000A' }),
      'StoreRoma1'
    );
  });

  it('senza storeTag ripiega su un ID opaco derivato dal CF', () => {
    const tag = storeTagOf({ codice_fiscale: 'AAABBB00A00A000A' });
    assert.match(tag, /^mac-[0-9a-f]{6}$/);
  });

  it('lo stesso CF dà sempre lo stesso ID, CF diversi ID diversi', () => {
    assert.equal(memberTag('AAABBB00A00A000A'), memberTag('aaabbb00a00a000a'));
    assert.notEqual(memberTag('AAABBB00A00A000A'), memberTag('CCCDDD00A00A000A'));
  });

  it('l\'ID non contiene il CF e sopravvive alla redazione', () => {
    const cf = 'AAABBB00A00A000A';
    const tag = memberTag(cf);
    assert.ok(!tag.includes(cf));
    assert.equal(redactText(tag), tag);
  });

  it('senza CF né storeTag resta vuoto', () => {
    assert.equal(storeTagOf({}), '');
    assert.equal(memberTag(''), '');
  });
});

// Regressione: nelle issue #25-27 la coda di log allegata era vecchia di 5 ore
// e sembrava il contesto dell'errore appena segnalato. L'età va mostrata.
describe('fileAge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-age-'));
  const write = (name, ageMin) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    const t = new Date(Date.now() - ageMin * 60000);
    fs.utimesSync(f, t, t);
    return f;
  };

  it('file mancante → assente, mai un errore', () => {
    assert.equal(fileAge(path.join(dir, 'non-esiste.log')), 'assente');
  });

  it('appena scritto → adesso', () => {
    assert.equal(fileAge(write('ora.log', 0)), 'adesso');
  });

  it('minuti, ore e giorni', () => {
    assert.equal(fileAge(write('min.log', 42)), '42 min fa');
    assert.equal(fileAge(write('ore.log', 5 * 60)), '5h fa');
    assert.equal(fileAge(write('giorni.log', 6 * 24 * 60)), '6 giorni fa');
  });
});
