/**
 * bank-sync.js — pull banca pubblica (raw GitHub) → merge in trusted locale.
 * Throttle + best-effort: non blocca l'autoplay se offline.
 *
 * Usato da start.sh / CLI. Pure helpers testabili separatamente.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { writeJsonAtomic, readJsonSafe } = require('./io');
const { auditBank, compareBanks, mergeMissingByCanonical } = require('./bank-audit');

const DEFAULT_PUBLIC_URL =
  'https://raw.githubusercontent.com/iCosiSenpai/gsdcampus-autoplay/main/data/known_answers_public.json';
const THROTTLE_MS = 6 * 60 * 60 * 1000; // 6h
const TIMEOUT_MS = 12000;

/**
 * Merge remote into local: remote keys first, local wins on conflict.
 * @param {object} local
 * @param {object} remote
 * @returns {{ merged: object, added: number }}
 */
function mergeBanks(local, remote) {
  const loc = local && typeof local === 'object' ? local : {};
  const rem = remote && typeof remote === 'object' ? remote : {};
  const remoteIntoLocal = mergeMissingByCanonical(loc, rem);
  return {
    merged: remoteIntoLocal.bank,
    added: remoteIntoLocal.added.length,
    conflicts: remoteIntoLocal.conflicts,
  };
}

function throttlePath(root) {
  return path.join(root, 'logs', '.bank_sync_at');
}

/**
 * @param {string} root
 * @param {number} [throttleMs]
 * @returns {boolean}
 */
function shouldSync(root, throttleMs = THROTTLE_MS) {
  try {
    const st = fs.statSync(throttlePath(root));
    if (Date.now() - st.mtimeMs < throttleMs) return false;
  } catch (_) { /* ok */ }
  return true;
}

function markSynced(root) {
  try {
    fs.mkdirSync(path.join(root, 'logs'), { recursive: true });
    fs.writeFileSync(throttlePath(root), new Date().toISOString());
  } catch (_) {}
}

/**
 * HTTP(S) GET JSON body.
 * @param {string} url
 * @returns {Promise<object>}
 */
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) {
      reject(e);
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(url, { timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`http_${res.statusCode}`));
        res.resume();
        return;
      }
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * Pull public bank and merge into data/known_answers.json.
 * @param {string} root
 * @param {{ force?: boolean, url?: string, log?: function }} [opts]
 * @returns {Promise<{ ok: boolean, skipped?: boolean, reason?: string, added?: number, error?: string }>}
 */
async function syncPublicBank(root, opts = {}) {
  const log = opts.log || (() => {});
  if (!opts.force && !shouldSync(root)) {
    return { ok: true, skipped: true, reason: 'throttled' };
  }
  const url = opts.url || DEFAULT_PUBLIC_URL;
  let remote;
  try {
    remote = await fetchJson(url);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  const remoteAudit = auditBank(remote);
  if (!remoteAudit.ok) {
    return {
      ok: false,
      error: 'remote_bank_invalid',
      invalid: remoteAudit.invalid.length,
      conflicts: remoteAudit.conflicts.length,
      remoteHash: remoteAudit.sha256,
    };
  }
  const knownPath = path.join(root, 'data', 'known_answers.json');
  const local = readJsonSafe(knownPath, {});
  const publicFile = readJsonSafe(path.join(root, 'data', 'known_answers_public.json'), {});
  const publicComparison = compareBanks(publicFile, remote);
  const { merged, added, conflicts } = mergeBanks(local, remote);
  if (conflicts.length > 0) {
    return { ok: false, error: 'trusted_public_conflict', conflicts: conflicts.length, remoteHash: remoteAudit.sha256 };
  }
  if (added > 0) {
    try {
      writeJsonAtomic(knownPath, merged);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  markSynced(root);
  if (added > 0) log(`Banca: +${added} risposte dalla public (merge locale).`);
  return {
    ok: true,
    added,
    skipped: false,
    remoteHash: remoteAudit.sha256,
    publicFileHash: publicComparison.leftHash,
    publicMatchesRemote: publicComparison.equal,
  };
}

async function verifyRemotePublicBank(root, opts = {}) {
  const url = opts.url || DEFAULT_PUBLIC_URL;
  let remote;
  try { remote = await fetchJson(url); } catch (e) { return { ok: false, error: e.message || String(e) }; }
  const remoteAudit = auditBank(remote);
  const localPublic = readJsonSafe(path.join(root, 'data', 'known_answers_public.json'), {});
  const localAudit = auditBank(localPublic);
  const comparison = compareBanks(localPublic, remote);
  return {
    ok: remoteAudit.ok && localAudit.ok && comparison.equal,
    remoteAudit,
    localAudit,
    comparison,
  };
}

/**
 * Conta lag trusted vs public file locale (non remote).
 * @param {string} root
 */
function bankLag(root) {
  const known = readJsonSafe(path.join(root, 'data', 'known_answers.json'), {});
  const pub = readJsonSafe(path.join(root, 'data', 'known_answers_public.json'), {});
  const cmp = compareBanks(known, pub);
  const knownAudit = auditBank(known);
  const publicAudit = auditBank(pub);
  return {
    trusted: knownAudit.canonicalEntries,
    publicFile: publicAudit.canonicalEntries,
    onlyLocal: cmp.onlyLeft.length,
    onlyPublic: cmp.onlyRight.length,
    conflicts: cmp.conflicts.length + knownAudit.conflicts.length + publicAudit.conflicts.length,
    trustedHash: knownAudit.sha256,
    publicHash: publicAudit.sha256,
  };
}

module.exports = {
  mergeBanks,
  shouldSync,
  syncPublicBank,
  bankLag,
  verifyRemotePublicBank,
  fetchJson,
  DEFAULT_PUBLIC_URL,
  THROTTLE_MS,
};
