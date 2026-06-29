/**
 * import-csv.js — importazione elenco membri da CSV nel database SQLite.
 *
 * Zero dipendenze esterne: parser CSV minimale. Il CSV esportato da Numbers
 * è delimitato da ';' (Excel italiano) e ha una prima riga di titolo
 * (es. "Tabella 1") seguita dalla riga di header. Le colonne vengono
 * individuate PER NOME header (non per posizione), per essere robusti a
 * riordinamenti. Le righe con codice fiscale o link non validi vengono
 * saltate e raccolte in `errors`.
 */

const fs = require('fs');
const db = require('./db');

// Regex riportata da scripts/setup.sh (validazione link autologin GSD Campus).
const CF_RE = /^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$/;
const CF_IN_URL_RE = /\/autologin\/([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])\//;

const AUTOLOGIN_RE =
  /^https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+$/;

const HEADERS = {
  id: ['id'],
  codice_fiscale: ['codice fiscale', 'codicefiscale', 'cf', 'fiscal code'],
  nome: ['nome', 'name', 'first name'],
  cognome: ['cognome', 'surname', 'last name'],
  link: ['link di accesso', 'link', 'autologin', 'url', 'link accesso']
};

function validateCodiceFiscale(cf) {
  return CF_RE.test(String(cf || '').toUpperCase().trim());
}

function validateAutologinUrl(url) {
  return AUTOLOGIN_RE.test(String(url || '').trim());
}

/**
 * Individua il delimitatore contando ';' vs ',' nella riga di header.
 */
function detectDelimiter(headerLine) {
  const semi = (headerLine.match(/;/g) || []).length;
  const comma = (headerLine.match(/,/g) || []).length;
  return semi >= comma ? ';' : ',';
}

/**
 * Split di una riga CSV rispettando i campi tra doppi apici.
 */
function parseCsvLine(line, delim) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function normHeader(h) {
  return String(h || '').trim().toLowerCase();
}

function buildHeaderIndex(headers, delim) {
  const cols = parseCsvLine(headers, delim).map(normHeader);
  const idx = {};
  for (const [field, aliases] of Object.entries(HEADERS)) {
    const pos = cols.findIndex(c => aliases.includes(c));
    if (pos >= 0) idx[field] = pos;
  }
  return idx;
}

/**
 * Importa il CSV in members.db. Upsert idempotente per codice fiscale.
 * Ritorna { imported, skipped, errors }.
 */
function importCsv(root, csvPath, log) {
  log = log || console;
  const result = { imported: 0, skipped: 0, errors: [] };

  if (!fs.existsSync(csvPath)) {
    result.errors.push(`File non trovato: ${csvPath}`);
    return result;
  }

  const raw = fs.readFileSync(csvPath, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) {
    result.errors.push('CSV vuoto.');
    return result;
  }

  // Trova la riga di header: la prima che contiene un alias di "codice fiscale".
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (/codice\s*fiscale|codicefiscale|\bcf\b/i.test(lines[i])) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) {
    result.errors.push('Riga di header non trovata (manca "Codice fiscale").');
    return result;
  }

  const delim = detectDelimiter(lines[headerIdx]);
  const idx = buildHeaderIndex(lines[headerIdx], delim);
  if (idx.codice_fiscale == null || idx.link == null) {
    result.errors.push('Colonne obbligatorie mancanti nell\'header (serve "Codice fiscale" e "Link di accesso").');
    return result;
  }

  db.initDb(root);

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i], delim);
    const cf = String(cols[idx.codice_fiscale] || '').toUpperCase().trim();
    const url = String(cols[idx.link] || '').trim();

    if (!cf && !url) { result.skipped++; continue; } // riga vuota

    if (!validateCodiceFiscale(cf)) {
      result.errors.push(`Riga ${i + 1}: codice fiscale non valido "${cf}"`);
      result.skipped++;
      continue;
    }
    if (!validateAutologinUrl(url)) {
      result.errors.push(`Riga ${i + 1}: link di accesso non valido per CF ${cf}`);
      result.skipped++;
      continue;
    }

    // Cross-validazione: il CF nel path dell'URL deve coincidere con la colonna CF.
    const urlCf = (url.match(CF_IN_URL_RE) || [])[1];
    if (urlCf !== cf) {
      result.errors.push(`Riga ${i + 1}: CF nella colonna (${cf}) non coincide con quello nell'URL (${urlCf || '?'})`);
      result.skipped++;
      continue;
    }

    db.upsertMember(root, {
      id: idx.id != null ? cols[idx.id] : null,
      codice_fiscale: cf,
      nome: idx.nome != null ? (cols[idx.nome] || '') : '',
      cognome: idx.cognome != null ? (cols[idx.cognome] || '') : '',
      autologin_url: url
    });
    result.imported++;
  }

  // Re-imposta permessi dopo l'import.
  try { fs.chmodSync(db.dbPath(root), 0o600); } catch (e) { /* best-effort */ }

  return result;
}

module.exports = {
  importCsv,
  parseCsvLine,
  detectDelimiter,
  validateCodiceFiscale,
  validateAutologinUrl
};