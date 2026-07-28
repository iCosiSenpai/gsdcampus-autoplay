'use strict';
/**
 * ZIP del "Modo A": il .command dentro l'archivio deve conservare il permesso
 * di esecuzione (755), altrimenti dopo il download il doppio clic risponde
 * "could not be executed because you do not have appropriate access privileges".
 */
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

let buildStoredZip;
let crc32;

before(async () => {
  // Il Worker è ESM: import dinamico dal test CJS.
  ({ buildStoredZip, crc32 } = await import('../worker-install/zip-store.js'));
});

const u16 = (buf, off) => buf[off] | (buf[off + 1] << 8);
const u32 = (buf, off) => (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16)) + (buf[off + 3] * 0x1000000);

describe('crc32', () => {
  it('valore noto per "hello"', () => {
    assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
  });

  it('stringa vuota → 0', () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
  });
});

describe('buildStoredZip', () => {
  const NAME = 'GSD Avvia.command';
  const BODY = '#!/bin/bash\necho ciao\n';
  let zip;

  before(() => {
    zip = buildStoredZip([{ name: NAME, data: BODY, mode: 0o100755 }]);
  });

  it('firme ZIP valide (local header e end of central directory)', () => {
    assert.equal(u32(zip, 0), 0x04034b50);
    const eocd = zip.length - 22;
    assert.equal(u32(zip, eocd), 0x06054b50);
    assert.equal(u16(zip, eocd + 10), 1); // una sola voce
  });

  it('metodo STORED e dimensioni coerenti', () => {
    const body = new TextEncoder().encode(BODY);
    assert.equal(u16(zip, 8), 0);                 // method 0 = stored
    assert.equal(u32(zip, 18), body.length);      // compressed
    assert.equal(u32(zip, 22), body.length);      // uncompressed
    assert.equal(u32(zip, 14), crc32(body));      // crc
  });

  it('nome file e contenuto presenti in chiaro (stored)', () => {
    const raw = Buffer.from(zip).toString('latin1');
    assert.ok(raw.includes(NAME));
    assert.ok(raw.includes('echo ciao'));
  });

  it('i permessi Unix 755 finiscono negli attributi esterni', () => {
    const eocd = zip.length - 22;
    const centralOffset = u32(zip, eocd + 16);
    assert.equal(u32(zip, centralOffset), 0x02014b50);
    assert.equal(u16(zip, centralOffset + 4) >> 8, 3);            // version made by: UNIX
    const external = u32(zip, centralOffset + 38);
    assert.equal(Math.floor(external / 0x10000), 0o100755);       // mode nei 16 bit alti
  });

  it('senza mode esplicito resta un file normale (644)', () => {
    const plain = buildStoredZip([{ name: 'note.txt', data: 'x' }]);
    const eocd = plain.length - 22;
    const centralOffset = u32(plain, eocd + 16);
    assert.equal(Math.floor(u32(plain, centralOffset + 38) / 0x10000), 0o100644);
  });
});
