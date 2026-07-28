/**
 * zip-store.js — mini scrittore ZIP (solo metodo STORED) per il Worker.
 *
 * Perché serve: il file "GSD Avvia.command" scaricato dal browser arriva SEMPRE
 * senza permesso di esecuzione (HTTP non trasporta i permessi: il browser lo
 * salva 644). Con il doppio clic macOS risponde
 *   "…could not be executed because you do not have appropriate access privileges"
 * e il Modo A non parte. Un archivio ZIP invece PORTA i permessi Unix nei
 * "external file attributes": Safari lo espande da solo e il .command estratto
 * resta eseguibile (755), quindi il doppio clic funziona.
 *
 * Nessuna dipendenza (gira su Workers e su Node), niente compressione: il file
 * è di poche righe, STORED basta e rende l'output deterministico.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC32 (polinomio 0xEDB88320, lo stesso di zip/gzip).
 * @param {Uint8Array} bytes
 * @returns {number} intero senza segno
 */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  return new TextEncoder().encode(String(data));
}

// Data/ora DOS fisse (2026-01-01 00:00): output deterministico → la cache del
// browser e del Worker non cambia a ogni richiesta.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

/**
 * Costruisce un archivio ZIP con i file dati, conservando i permessi Unix.
 * @param {Array<{ name: string, data: string|Uint8Array, mode?: number }>} entries
 * @returns {Uint8Array}
 */
export function buildStoredZip(entries) {
  const encoder = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const data = toBytes(entry.data);
    const crc = crc32(data);
    const mode = entry.mode != null ? entry.mode : 0o100644;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // firma local file header
    local.setUint16(4, 20, true);           // versione minima
    local.setUint16(6, 0, true);            // flag
    local.setUint16(8, 0, true);            // metodo: 0 = stored
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // dimensione compressa
    local.setUint32(22, data.length, true); // dimensione originale
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);           // extra field
    locals.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true); // firma central directory
    central.setUint16(4, 0x031E, true);     // "version made by": 3 = UNIX
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);         // extra
    central.setUint16(32, 0, true);         // commento
    central.setUint16(34, 0, true);         // disco iniziale
    central.setUint16(36, 0, true);         // attributi interni
    // Attributi esterni: i permessi Unix stanno nei 16 bit alti. È QUESTO il
    // campo che fa restare eseguibile il .command dopo l'estrazione.
    central.setUint32(38, (mode & 0xFFFF) * 0x10000, true);
    central.setUint32(42, offset, true);    // offset del local header
    centrals.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = centrals.reduce((n, part) => n + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // firma end of central directory
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  end.setUint16(20, 0, true);               // commento archivio

  const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}
