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

// Cache per-processo della config letta, con invalidazione su mtime: se
// config.json cambia (es. AI/utente cambiano account o orari durante un run),
// la prossima readConfig rilegge invece di restituire la copia stantia.
let _cfgCache = null;
let _cfgPath = null;
let _cfgMtime = 0;

function readConfig(root) {
  const p = path.join(root, 'config.json');
  try {
    const st = fs.statSync(p);
    if (_cfgPath === p && _cfgCache !== null && st.mtimeMs === _cfgMtime) {
      return _cfgCache;
    }
    _cfgCache = JSON.parse(fs.readFileSync(p, 'utf8'));
    _cfgPath = p;
    _cfgMtime = st.mtimeMs;
  } catch (e) {
    _cfgCache = {};
    _cfgPath = p;
    _cfgMtime = 0;
  }
  return _cfgCache;
}

/** Invalida la cache (utile dopo scritture di config.json da parte di un'altra lib). */
function invalidateConfigCache() { _cfgCache = null; }

/**
 * Codice fiscale dell'account attivo: derivato PRIMARIAMENTE dall'URL di
 * autologin (fonte di verità), con fallback a config.codice_fiscale per
 * backward-compat. Se i due valori divergono, logga un warning e usa quello
 * dell'URL per evitare che cookie/corsi finiscano nella cartella sbagliata.
 */
function activeCodiceFiscale(root, log) {
  const cfg = readConfig(root);
  const urlCf = cfg.autologinUrl
    ? (String(cfg.autologinUrl).match(CF_FROM_URL_RE) || [])[1]
    : null;
  const cfgCf = cfg.codice_fiscale
    ? String(cfg.codice_fiscale).toUpperCase()
    : null;

  if (urlCf) {
    if (cfgCf && cfgCf !== urlCf) {
      (log || console.warn)(`Attenzione: config.codice_fiscale (${cfgCf}) diverso da quello nell'autologinUrl (${urlCf}). Uso ${urlCf}.`);
    }
    return urlCf;
  }

  if (cfgCf) return cfgCf;
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
 * Path dei file di stato per l'account indicato, oppure per l'account ATTIVO.
 * Se nessun CF e determinabile, ricade sui vecchi file flat in data/.
 */
function stateFilePaths(root, cfOverride = null) {
  const cf = cfOverride ? String(cfOverride).toUpperCase() : activeCodiceFiscale(root, null);
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

/**
 * Migrazione automatica dei file di stato legacy (data/*.json personali) nella
 * cartella per-account dell'utente attivo. Idempotente: non sovrascrive file
 * già esistenti nell'account dir. Da chiamare all'avvio di autoplay.
 */
function migrateLegacyState(root, log) {
  const cf = activeCodiceFiscale(root, log || console);
  if (!cf) return { moved: 0, reason: 'CF non determinabile' };
  const dest = accountDataDir(root, cf);
  const data = path.join(root, 'data');
  const files = ['course_state.json', 'storage_state.json', 'pending_quiz_answers.json', 'need_answer.json'];
  let moved = 0;
  for (const f of files) {
    const src = path.join(data, f);
    const dst = path.join(dest, f);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.renameSync(src, dst);
        moved++;
      } catch (e) {
        (log || console.warn)(`migrateLegacyState: impossibile spostare ${f}: ${e.message}`);
      }
    }
  }
  return { moved, dest };
}

module.exports = {
  readConfig,
  invalidateConfigCache,
  activeCodiceFiscale,
  accountsDir,
  accountDataDir,
  accountFile,
  stateFilePaths,
  migrateLegacyState
};