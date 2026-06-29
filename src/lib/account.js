/**
 * account.js — risolutore centrale per lo stato per-account.
 *
 * Ogni membro attivo (codice fiscale) ha la propria cartella di stato sotto
 * data/accounts/<CF>/. Questo modulo nasconde la risoluzione dei path a
 * course-state.js, quiz.js e autoplay.js, con fallback back-compat ai vecchi
 * file flat in data/ quando non è possibile determinare il CF.
 *
 * known_answers.json e course_map.json restano CONDIVISI in data/ (non per-account).
 */

const fs = require('fs');
const path = require('path');

const CF_FROM_URL_RE = /\/autologin\/([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])\//;

// Cache per-processo della config letta.
let _cfgCache = null;
let _cfgPath = null;

function readConfig(root) {
  const p = path.join(root, 'config.json');
  if (_cfgPath !== p || _cfgCache === null) {
    try { _cfgCache = JSON.parse(fs.readFileSync(p, 'utf8')); _cfgPath = p; }
    catch (e) { _cfgCache = {}; _cfgPath = p; }
  }
  return _cfgCache;
}

/** Invalida la cache (utile dopo scritture di config.json da parte di un'altra lib). */
function invalidateConfigCache() { _cfgCache = null; }

/**
 * Codice fiscale dell'account attivo: da config.codice_fiscale, oppure derivato
 * dall'URL di autologin (back-compat). null se non determinabile.
 */
function activeCodiceFiscale(root) {
  const cfg = readConfig(root);
  if (cfg.codice_fiscale) return String(cfg.codice_fiscale).toUpperCase();
  if (cfg.autologinUrl) {
    const m = String(cfg.autologinUrl).match(CF_FROM_URL_RE);
    if (m) return m[1];
  }
  return null;
}

function accountsDir(root) {
  return path.join(root, 'data', 'accounts');
}

/**
 * Cartella dati dell'account. Hard check: non restituisce mai la radice
 * accounts/ senza un CF valido (anti-leak di cookie tra account).
 */
function accountDataDir(root, cf) {
  const c = String(cf || '').toUpperCase();
  if (!c || !/^[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]$/.test(c)) {
    throw new Error('Codice fiscale non valido per accountDataDir: ' + cf);
  }
  const dir = path.join(accountsDir(root), c);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* esiste già */ }
  return dir;
}

function accountFile(root, cf, name) {
  return path.join(accountDataDir(root, cf), name);
}

/**
 * Path dei file di stato per l'account ATTIVO. Se il CF non è determinabile
 * (config legacy senza autologinUrl), tutti i path ricadono sui vecchi file
 * flat in data/ → back-compat.
 */
function stateFilePaths(root) {
  const cf = activeCodiceFiscale(root);
  if (cf) {
    const base = accountDataDir(root, cf);
    return {
      codiceFiscale: cf,
      accountDir: base,
      courseState: path.join(base, 'course_state.json'),
      storageState: path.join(base, 'storage_state.json'),
      pending: path.join(base, 'pending_quiz_answers.json'),
      needAnswer: path.join(base, 'need_answer.json')
    };
  }
  // Fallback legacy: file flat in data/
  const data = path.join(root, 'data');
  return {
    codiceFiscale: null,
    accountDir: data,
    courseState: path.join(data, 'course_state.json'),
    storageState: path.join(data, 'storage_state.json'),
    pending: path.join(data, 'pending_quiz_answers.json'),
    needAnswer: path.join(data, 'need_answer.json')
  };
}

module.exports = {
  readConfig,
  invalidateConfigCache,
  activeCodiceFiscale,
  accountsDir,
  accountDataDir,
  accountFile,
  stateFilePaths
};