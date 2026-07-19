'use strict';
/**
 * I/O JSON atomico e cache mtime.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { writeJsonAtomic, readJsonSafe, readJsonCached } = require('../src/lib/io');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-io-'));
});

after(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
});

describe('writeJsonAtomic + readJsonSafe', () => {
  it('scrive e rilegge un oggetto', () => {
    const file = path.join(tmpDir, 'state.json');
    writeJsonAtomic(file, { a: 1, b: 'x' });
    assert.deepEqual(readJsonSafe(file), { a: 1, b: 'x' });
    assert.ok(!fs.existsSync(file + '.tmp'));
  });

  it('readJsonSafe su file mancante → fallback', () => {
    const file = path.join(tmpDir, 'missing.json');
    assert.deepEqual(readJsonSafe(file, { def: true }), { def: true });
  });

  it('readJsonSafe su JSON corrotto → fallback', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{not json');
    assert.deepEqual(readJsonSafe(file, { ok: false }, { warn: false }), { ok: false });
  });
});

describe('readJsonCached', () => {
  it('ritorna lo stesso oggetto finché mtime non cambia', () => {
    const file = path.join(tmpDir, 'cached.json');
    writeJsonAtomic(file, { n: 1 });
    const a = readJsonCached(file);
    const b = readJsonCached(file);
    assert.equal(a, b); // stesso riferimento (documentato)
    assert.equal(a.n, 1);
  });

  it('si invalida dopo writeJsonAtomic (rename → mtime nuovo)', () => {
    const file = path.join(tmpDir, 'cached2.json');
    writeJsonAtomic(file, { n: 1 });
    const a = readJsonCached(file);
    assert.equal(a.n, 1);
    // rename atomico: su alcuni FS mtime può coincidere se troppo rapido;
    // forziamo un tick e riscriviamo.
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin breve */ }
    writeJsonAtomic(file, { n: 2 });
    const b = readJsonCached(file);
    assert.equal(b.n, 2);
  });
});
