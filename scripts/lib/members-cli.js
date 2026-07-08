#!/usr/bin/env node
/**
 * members-cli.js — gestione del database membri (data/members.db) per setup.sh
 * e per il supervisore AI.
 *
 * Comandi:
 *   node scripts/lib/members-cli.js search <query>
 *       Lista numerata di membri che corrispondono (nome/cognome/CF). Salva
 *       l'indice numerato in data/.members_last_list.json per il `select`.
 *   node scripts/lib/members-cli.js list
 *       Lista numerata di tutti i membri (salva l'indice come sopra).
 *   node scripts/lib/members-cli.js select <N>
 *       Dato il numero di una riga di search/list, stampa il JSON del membro.
 *   node scripts/lib/members-cli.js active
 *       Mostra il membro attivo (da config.json).
 *   node scripts/lib/members-cli.js set-active <CF>
 *       Imposta il membro attivo in config.json (codice_fiscale + memberName +
 *       autologinUrl) PRESERVANDO baseUrl/courseUrls/workSchedule.
 *   node scripts/lib/members-cli.js stats
 *       Totale membri e quanti hanno già uno stato per-account.
 *   node scripts/lib/members-cli.js migrate-legacy
 *       Sposta i file di stato legacy (data/*.json personali) nella cartella
 *       data/accounts/<CF>/ del membro attivo. Idempotente, non sovrascrive.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const CONFIG = path.join(ROOT, 'config.json');
const LAST_LIST = path.join(DATA, '.members_last_list.json');

const db = require(path.join(ROOT, 'src', 'lib', 'db'));
const importCsv = require(path.join(ROOT, 'src', 'lib', 'import-csv'));
const account = require(path.join(ROOT, 'src', 'lib', 'account'));
const { writeJsonAtomic, readJsonSafe } = require(path.join(__dirname, 'write-json'));

const CF_FROM_URL_RE = /\/autologin\/([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])\//;

function readJson(p, fallback) {
  // readJsonSafe emette warning su file corrotto (non silenzioso) a differenza
  // del vecchio catch vuoto.
  return readJsonSafe(p, fallback, { warn: false });
}
function writeJson(p, obj) {
  // Scrittura atomica (tmp+rename): config.json e .members_last_list.json non
  // rischiano più di restare troncati se il CLI viene interrotto a metà.
  writeJsonAtomic(p, obj);
}

function readConfig() { return readJson(CONFIG, {}); }
function writeConfig(cfg) { writeJson(CONFIG, cfg); }

function activeCodiceFiscale() {
  // Delega al risolutore centrale per coerenza: URL vince su config.codice_fiscale.
  return account.activeCodiceFiscale(ROOT);
}

function saveListIndex(members) {
  try { fs.mkdirSync(DATA, { recursive: true }); } catch (e) { /* ok */ }
  writeJson(LAST_LIST, members);
}

function loadListIndex() {
  return readJson(LAST_LIST, []);
}

function printNumberedList(members) {
  members.forEach((m, i) => {
    const name = [m.cognome, m.nome].filter(Boolean).join(' ').trim() || '(senza nome)';
    console.log(`${String(i + 1).padStart(4)}) ${m.codice_fiscale} — ${name}`);
  });
  console.log(`\n${members.length} membro/i.`);
}

const cmd = process.argv[2] || 'stats';

if (cmd === 'search') {
  const q = process.argv[3];
  if (!q) { console.error('Uso: members-cli.js search <query>'); process.exit(1); }
  const members = db.searchMembers(ROOT, q);
  saveListIndex(members);
  if (members.length === 0) { console.log('Nessun membro trovato.'); process.exit(0); }
  printNumberedList(members);

} else if (cmd === 'list') {
  const members = db.listMembers(ROOT);
  saveListIndex(members);
  if (members.length === 0) {
    console.log('Database vuoto. Importa prima un CSV con: node scripts/import-members.js <path>');
    process.exit(1);
  }
  printNumberedList(members);

} else if (cmd === 'select') {
  const n = parseInt(process.argv[3], 10);
  if (!Number.isInteger(n)) { console.error('Uso: members-cli.js select <N>'); process.exit(1); }
  const list = loadListIndex();
  const m = list[n - 1];
  if (!m) {
    console.error(`Numero ${n} non valido. Usa prima search/list, poi select con un numero tra 1 e ${list.length}.`);
    process.exit(1);
  }
  console.log(JSON.stringify({
    codice_fiscale: m.codice_fiscale,
    nome: m.nome,
    cognome: m.cognome,
    autologin_url: m.autologin_url
  }));

} else if (cmd === 'active') {
  const cf = activeCodiceFiscale();
  if (!cf) { console.log('Nessun membro attivo (config.json non configurato).'); process.exit(0); }
  const m = db.getMember(ROOT, cf);
  if (!m) {
    console.log(`Membro attivo: CF=${cf} (non presente nel database membri; probabilmente configurato manualmente).`);
  } else {
    const name = [m.cognome, m.nome].filter(Boolean).join(' ');
    console.log(`Membro attivo: ${name} (CF: ${m.codice_fiscale})`);
    // Maschera il token nell'URL per non esporre credenziali nei log.
    const maskedUrl = String(m.autologin_url).replace(/\/([^/]+)$/, '/•••••');
    console.log(`  autologin: ${maskedUrl}`);
  }

} else if (cmd === 'set-active') {
  const cf = String(process.argv[3] || '').toUpperCase();
  if (!cf) { console.error('Uso: members-cli.js set-active <CF>'); process.exit(1); }
  const m = db.getMember(ROOT, cf);
  if (!m) { console.error(`Nessun membro con codice fiscale ${cf} nel database.`); process.exit(1); }
  const cfg = readConfig();
  cfg.codice_fiscale = m.codice_fiscale;
  cfg.memberName = [m.nome, m.cognome].filter(Boolean).join(' ').trim();
  cfg.autologinUrl = m.autologin_url;
  if (!cfg.baseUrl) cfg.baseUrl = 'https://tecsial.gsdcampus.it/';
  if (!Array.isArray(cfg.courseUrls)) cfg.courseUrls = [];
  if (!cfg.workSchedule) {
    cfg.workSchedule = {
      days: [1, 2, 3, 4, 5],
      shifts: [
        { startHour: 9, startMin: 30, endHour: 13, endMin: 0 },
        { startHour: 16, startMin: 30, endHour: 20, endMin: 0 }
      ]
    };
  }
  writeConfig(cfg);
  const maskedUrl = String(m.autologin_url).replace(/\/([^/]+)$/, '/•••••');
  console.log(`Membro attivo impostato: ${cfg.memberName} (CF: ${m.codice_fiscale})`);
  console.log(`  autologin: ${maskedUrl}`);

} else if (cmd === 'stats') {
  const total = db.countMembers(ROOT);
  const accountsDir = path.join(DATA, 'accounts');
  let accounts = 0;
  try { accounts = fs.readdirSync(accountsDir).filter(f =>
    fs.statSync(path.join(accountsDir, f)).isDirectory()).length; } catch (e) { accounts = 0; }
  console.log(`Membri nel database : ${total}`);
  console.log(`Account con stato   : ${accounts}`);

} else if (cmd === 'migrate-legacy') {
  const cf = activeCodiceFiscale();
  if (!cf) {
    console.error('Nessun membro attivo in config.json: impossibile determinare la cartella account.');
    process.exit(1);
  }
  const mig = account.migrateLegacyState(ROOT, console);
  if (mig.moved === 0) {
    console.log(`Nessun file legacy da migrare per ${cf} (già migrato o assente).`);
  } else {
    console.log(`Migrati ${mig.moved} file in ${mig.dest}`);
  }

} else {
  console.error(`Comando sconosciuto: ${cmd}\nComandi: search | list | select | active | set-active | stats | migrate-legacy`);
  process.exit(1);
}