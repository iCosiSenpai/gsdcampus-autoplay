// @ts-check
/**
 * update-state.js — memoria dell'ultimo controllo di auto-aggiornamento.
 *
 * `scripts/auto-update.sh` gira da launchd ogni ~10 min e, quando non c'è niente
 * di nuovo, esce in silenzio senza scrivere log: dal Mac non si capiva se
 * l'aggiornamento automatico stesse davvero funzionando o fosse fermo da giorni.
 * Qui teniamo un piccolo stato (`logs/auto-update-state.json`) che l'auto-update
 * aggiorna a OGNI giro — anche quando non fa nulla — e che la plancia
 * (`panel-cli.js`) e `status.sh` mostrano come "controllato N minuti fa".
 *
 * Nessun dato personale: solo timestamp, esito e SHA brevi.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require('./io');

const STATE_REL = path.join('logs', 'auto-update-state.json');
const SCHEMA_VERSION = 1;

// Esiti possibili dell'ultimo giro di auto-update.
const RESULTS = [
  'up_to_date',     // niente di nuovo su origin/main (caso normale)
  'updated',        // aggiornato con successo
  'rollback',       // nuova versione difettosa: tornati alla precedente
  'postponed',      // rimandato: quiz/setup in corso, non si interrompe
  'deps_required',  // codice aggiornato ma servono dipendenze: serve il curl
  'update_failed',  // git/merge non riuscito, resta la versione precedente
  'offline',        // niente rete (o GitHub non raggiungibile)
  'disabled',       // autoUpdate:false in config.json
];

// Oltre questa età consideriamo l'auto-aggiornamento "non più vivo": l'agent
// launchd gira ogni 10 min, quindi 35 min senza un solo controllo = anomalia.
const STALE_MS = 35 * 60 * 1000;

function statePath(root) {
  return path.join(root, STATE_REL);
}

/**
 * @param {string} root
 * @returns {object|null}
 */
function readUpdateState(root) {
  const s = readJsonSafe(statePath(root), null, { warn: false });
  return s && typeof s === 'object' ? s : null;
}

/**
 * Registra l'esito di un giro di auto-update. Preserva le informazioni
 * sull'ultimo aggiornamento REALMENTE applicato (updatedAt/updatedTo), che non
 * vanno perse dai giri successivi in cui non c'è niente di nuovo.
 * @param {string} root
 * @param {{ result: string, detail?: string, localVersion?: string, remoteVersion?: string, updatedTo?: string, now?: number }} patch
 * @returns {object} lo stato scritto
 */
function markUpdateState(root, patch = /** @type any */ ({})) {
  const prev = readUpdateState(root) || {};
  const now = Number.isFinite(patch.now) ? Number(patch.now) : Date.now();
  const result = RESULTS.includes(String(patch.result)) ? String(patch.result) : 'up_to_date';
  const state = {
    schemaVersion: SCHEMA_VERSION,
    lastCheckAt: new Date(now).toISOString(),
    result,
    detail: patch.detail ? String(patch.detail).slice(0, 200) : undefined,
    localVersion: patch.localVersion ? String(patch.localVersion).slice(0, 12) : (prev.localVersion || undefined),
    remoteVersion: patch.remoteVersion ? String(patch.remoteVersion).slice(0, 12) : undefined,
    // Ultimo aggiornamento andato a buon fine (persiste tra i controlli).
    updatedAt: result === 'updated' ? new Date(now).toISOString() : (prev.updatedAt || undefined),
    updatedTo: result === 'updated'
      ? String(patch.updatedTo || patch.remoteVersion || '').slice(0, 12) || undefined
      : (prev.updatedTo || undefined),
  };
  try {
    fs.mkdirSync(path.dirname(statePath(root)), { recursive: true });
    writeJsonAtomic(statePath(root), state);
  } catch (_) { /* mai bloccante: è solo informativo */ }
  return state;
}

/**
 * Età leggibile: "adesso", "4m", "3h 20m", "2g".
/**
 * Età leggibile: "adesso", "4m", "3h 20m", "2g".
 * @param {number} ms
 */
function formatAge(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return 'adesso';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`;
  const d = Math.round(h / 24);
  return `${d}g`;
}

/**
 * Età come testo relativo: "adesso" oppure "4m fa".
 * @param {number} ms
 */
function ageText(ms) {
  const a = formatAge(ms);
  return a === 'adesso' ? 'adesso' : `${a} fa`;
}

/**
 * Frase pronta per plancia e status.sh.
 * @param {object|null} state stato letto da readUpdateState
 * @param {number} [now]
 * @param {{ agentInstalled?: boolean }} [opts]
 * @returns {{ text: string, level: 'ok'|'warn'|'unknown', stale: boolean, ageMs: number|null }}
 */
function describeUpdateState(state, now = Date.now(), opts = {}) {
  // Opt-out esplicito del collega/maintainer: non è un problema da segnalare.
  if (opts.disabled) {
    return {
      text: 'disattivato in config.json (autoUpdate: false)',
      level: 'unknown',
      stale: false,
      ageMs: null,
    };
  }
  const agentKnown = opts.agentInstalled !== undefined;
  if (agentKnown && opts.agentInstalled === false) {
    return {
      text: 'non attivo su questo Mac — rilancia il comando curl per riattivarlo',
      level: 'warn',
      stale: true,
      ageMs: null,
    };
  }
  if (!state || !state.lastCheckAt) {
    return {
      text: 'mai controllato — il primo controllo parte entro 10 minuti',
      level: 'unknown',
      stale: false,
      ageMs: null,
    };
  }
  const t = Date.parse(state.lastCheckAt);
  if (!Number.isFinite(t)) {
    return { text: 'stato non leggibile', level: 'warn', stale: true, ageMs: null };
  }
  const ageMs = Math.max(0, now - t);
  const age = ageText(ageMs);
  const stale = ageMs > STALE_MS;
  const ver = state.localVersion ? ` (${state.localVersion})` : '';

  let text;
  let level = 'ok';
  switch (state.result) {
    case 'updated': {
      const to = state.updatedTo ? ` a ${state.updatedTo}` : '';
      text = `aggiornato${to} ${age}`;
      break;
    }
    case 'up_to_date':
      text = `controllato ${age} · già all'ultima versione${ver}`;
      break;
    case 'postponed':
      text = `controllato ${age} · aggiornamento rimandato (lavoro delicato in corso)`;
      break;
    case 'offline':
      text = `controllato ${age} · senza rete, riprovo al prossimo giro`;
      level = 'warn';
      break;
    case 'deps_required':
      text = `controllato ${age} · serve il comando curl per completare l'aggiornamento`;
      level = 'warn';
      break;
    case 'rollback':
      text = `controllato ${age} · versione difettosa annullata (segnalata al referente)`;
      level = 'warn';
      break;
    case 'update_failed':
      text = `controllato ${age} · aggiornamento non riuscito, resto sulla versione attuale`;
      level = 'warn';
      break;
    case 'disabled':
      text = 'disattivato in config.json (autoUpdate: false)';
      return { text, level: 'unknown', stale: false, ageMs };
    default:
      text = `controllato ${age}`;
  }

  if (stale) {
    level = 'warn';
    text += ' — nessun controllo recente';
  }
  // Se l'ultimo aggiornamento vero è noto, ricordalo (utile dopo giorni di
  // "già all'ultima versione").
  if (state.result !== 'updated' && state.updatedAt) {
    const ut = Date.parse(state.updatedAt);
    if (Number.isFinite(ut)) {
      text += ` · ultimo aggiornamento ${ageText(Math.max(0, now - ut))}`;
    }
  }
  return { text, level, stale, ageMs };
}

/**
 * SHA breve del commit attualmente sul disco, letto SENZA lanciare git (la
 * plancia ridisegna ogni pochi secondi). Serve a capire se il codice è cambiato
 * sotto i piedi di una finestra rimasta aperta: l'auto-update aggiorna i file,
 * ma il processo già avviato continua a girare con la versione vecchia.
 * @param {string} root
 * @returns {string|null} sha breve (7) oppure null
 */
function readHeadSha(root) {
  const gitDir = path.join(root, '.git');
  const short = (sha) => (/^[0-9a-f]{40}$/i.test(String(sha).trim()) ? String(sha).trim().slice(0, 7) : null);
  let head;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch (_) { return null; }
  if (!head.startsWith('ref:')) return short(head);
  const ref = head.replace(/^ref:\s*/, '').trim();
  try {
    return short(fs.readFileSync(path.join(gitDir, ref), 'utf8'));
  } catch (_) { /* ref non loose: cerco in packed-refs */ }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (line.startsWith('#')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref) return short(sha);
    }
  } catch (_) { /* niente packed-refs */ }
  return null;
}

// Label del LaunchAgent installato da scripts/lib/install-launchd.sh: se il
// plist non c'è, l'auto-aggiornamento non è attivo su questo Mac (è il caso in
// cui "non si aggiorna e non si capisce perché").
const AGENT_LABEL = 'com.gsdcampus.autoplay.autoupdate';

function agentPlistPath(home = process.env.HOME || '') {
  return path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

/**
 * True se l'auto-update è disattivato in config.json (`autoUpdate: false`).
 * In quel caso "agent assente" è voluto, non un guasto da segnalare.
 */
function isAutoUpdateDisabled(root) {
  const cfg = readJsonSafe(path.join(root, 'config.json'), {}, { warn: false }) || {};
  return cfg.autoUpdate === false;
}

/**
 * True se il LaunchAgent dell'auto-update risulta installato (plist presente).
 * Controllo volutamente leggero (nessun launchctl): la plancia lo rilegge ogni
 * pochi secondi.
 */
function isAgentInstalled(home = process.env.HOME || '') {
  try { return fs.existsSync(agentPlistPath(home)); } catch (_) { return false; }
}

module.exports = {
  STATE_REL,
  STALE_MS,
  RESULTS,
  AGENT_LABEL,
  statePath,
  agentPlistPath,
  isAgentInstalled,
  isAutoUpdateDisabled,
  readHeadSha,
  readUpdateState,
  markUpdateState,
  formatAge,
  ageText,
  describeUpdateState,
};
