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
  const merged = { ...rem, ...loc };
  let added = 0;
  for (const k of Object.keys(rem)) {
    if (String(k).startsWith('README')) continue;
    if (!(k in loc)) added++;
  }
  return { merged, added };
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
  const knownPath = path.join(root, 'data', 'known_answers.json');
  const local = readJsonSafe(knownPath, {});
  const { merged, added } = mergeBanks(local, remote);
  if (added > 0) {
    try {
      writeJsonAtomic(knownPath, merged);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  markSynced(root);
  if (added > 0) log(`Banca: +${added} risposte dalla public (merge locale).`);
  return { ok: true, added, skipped: false };
}

/**
 * Conta lag trusted vs public file locale (non remote).
 * @param {string} root
 */
function bankLag(root) {
  const known = readJsonSafe(path.join(root, 'data', 'known_answers.json'), {});
  const pub = readJsonSafe(path.join(root, 'data', 'known_answers_public.json'), {});
  const k = Object.keys(known).filter((x) => !String(x).startsWith('README'));
  const p = Object.keys(pub).filter((x) => !String(x).startsWith('README'));
  const onlyLocal = k.filter((q) => !(q in pub)).length;
  const onlyPublic = p.filter((q) => !(q in known)).length;
  return {
    trusted: k.length,
    publicFile: p.length,
    onlyLocal,
    onlyPublic,
  };
}

module.exports = {
  mergeBanks,
  shouldSync,
  syncPublicBank,
  bankLag,
  DEFAULT_PUBLIC_URL,
  THROTTLE_MS,
};
