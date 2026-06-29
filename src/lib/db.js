/**
 * db.js — database membri del corso (SQLite via node:sqlite, built-in Node 22+).
 *
 * Memorizza l'elenco dei membri (con relativo link di autologin) in data/members.db.
 * Il token di autologin è una credenziale → il file ha permessi 0600 e viene
 * gitignorato. Tutte le funzioni prendono `root` (cartella del progetto) come
 * primo argomento, coerentemente con src/lib/course-state.js.
 */

const fs = require('fs');
const path = require('path');

let DatabaseSync;
try {
  // node:sqlite è built-in da Node 22.5+ (stabile in Node 24+).
  ({ DatabaseSync } = require('node:sqlite'));
} catch (e) {
  throw new Error(
    "node:sqlite non disponibile: aggiorna Node a >=22 (questo progetto usa il database membri SQLite built-in). " +
    "Errore originale: " + e.message
  );
}

const DB_FILE = 'members.db';

function dbPath(root) {
  return path.join(root, 'data', DB_FILE);
}

/**
 * Crea/apre il database e assicura lo schema. Imposta permessi 0600
 * (contiene token di autologin).
 */
function initDb(root) {
  const dir = path.join(root, 'data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* esiste già */ }
  const p = dbPath(root);
  // Apre in lettura/scrittura, creando il file se manca.
  const db = new DatabaseSync(p, { readOnly: false });
  db.exec(`
    CREATE TABLE IF NOT EXISTS members (
      id             INTEGER,
      codice_fiscale TEXT PRIMARY KEY,
      nome           TEXT,
      cognome        TEXT,
      autologin_url  TEXT NOT NULL,
      imported_at    TEXT NOT NULL
    );
  `);
  db.close();
  try { fs.chmodSync(p, 0o600); } catch (e) { /* best-effort */ }
  return p;
}

function openDb(root) {
  initDb(root); // assicura che il file e lo schema esistano prima di aprire
  return new DatabaseSync(dbPath(root), { readOnly: false });
}

/**
 * Inserisce o aggiorna un membro (per codice fiscale). last-write-wins.
 * `m` = { id, codice_fiscale, nome, cognome, autologin_url }.
 */
function upsertMember(root, m) {
  const db = openDb(root);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO members (id, codice_fiscale, nome, cognome, autologin_url, imported_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      m.id == null ? null : Number(m.id),
      String(m.codice_fiscale).toUpperCase(),
      m.nome || '',
      m.cognome || '',
      m.autologin_url,
      new Date().toISOString()
    );
  } finally {
    db.close();
  }
}

function rowToMember(r) {
  if (!r) return null;
  return {
    id: r.id,
    codice_fiscale: r.codice_fiscale,
    nome: r.nome,
    cognome: r.cognome,
    autologin_url: r.autologin_url,
    imported_at: r.imported_at
  };
}

function getMember(root, cf) {
  const db = openDb(root);
  try {
    const r = db.prepare('SELECT * FROM members WHERE codice_fiscale = ?')
      .get(String(cf || '').toUpperCase());
    return rowToMember(r);
  } catch (e) {
    return null;
  } finally {
    db.close();
  }
}

function listMembers(root) {
  const db = openDb(root);
  try {
    const rows = db.prepare('SELECT * FROM members ORDER BY cognome, nome').all();
    return rows.map(rowToMember);
  } catch (e) {
    return [];
  } finally {
    db.close();
  }
}

/**
 * Ricerca per nome, cognome o codice fiscale (LIKE, case-insensitive grazie a COLLATE NOCASE).
 */
function searchMembers(root, query) {
  const db = openDb(root);
  try {
    const q = '%' + String(query || '').trim() + '%';
    const rows = db.prepare(`
      SELECT * FROM members
      WHERE codice_fiscale LIKE ? COLLATE NOCASE
         OR nome LIKE ? COLLATE NOCASE
         OR cognome LIKE ? COLLATE NOCASE
         OR (cognome || ' ' || nome) LIKE ? COLLATE NOCASE
         OR (nome || ' ' || cognome) LIKE ? COLLATE NOCASE
      ORDER BY cognome, nome
      LIMIT 100
    `).all(q, q, q, q, q);
    return rows.map(rowToMember);
  } catch (e) {
    return [];
  } finally {
    db.close();
  }
}

function countMembers(root) {
  const db = openDb(root);
  try {
    const r = db.prepare('SELECT COUNT(*) AS n FROM members').get();
    return (r && r.n) || 0;
  } catch (e) {
    return 0;
  } finally {
    db.close();
  }
}

module.exports = {
  dbPath,
  initDb,
  openDb,
  upsertMember,
  getMember,
  listMembers,
  searchMembers,
  countMembers
};