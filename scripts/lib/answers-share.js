/**
 * answers-share.js — invio risposte verificate al receiver (Cloudflare Worker)
 * senza bisogno di git push. Il Worker fa merge additivo su
 * data/known_answers_public.json via GitHub Contents API.
 *
 * Usato da: answers-cli share, publish-answers.sh
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEFAULT_ENDPOINT, DEFAULT_KEY } = require('./receiver-config');

const ROOT = path.join(__dirname, '..', '..');
const MAX_ENTRIES = 50;
const MAX_Q = 800;
const MAX_A = 500;
const TIMEOUT_MS = 30000;

// Stesse classi di PII del issue-report (scarta, non inviare).
const RE_AUTOLOGIN = /https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+/i;
const RE_CF = /\b[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\b/;
const RE_GH_PAT = /github_pat_[A-Za-z0-9_]+/;
const RE_GH_TOK = /\bgh[oaprsu]_[A-Za-z0-9]+/;

function looksLikePii(s) {
  const t = String(s || '');
  return RE_AUTOLOGIN.test(t) || RE_CF.test(t) || RE_GH_PAT.test(t) || RE_GH_TOK.test(t);
}

/**
 * Filtra e valida un oggetto domanda→risposta.
 * Ritorna { ok: {q:a,...}, skipped: n, errors: string[] }.
 * Pure: usata dai test e dal client prima del POST.
 */
function validateAnswersPayload(answers) {
  const ok = {};
  const errors = [];
  let skipped = 0;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return { ok: {}, skipped: 0, errors: ['answers must be a plain object'] };
  }
  const entries = Object.entries(answers);
  if (entries.length > MAX_ENTRIES) {
    errors.push(`too many entries (${entries.length} > ${MAX_ENTRIES}); truncating`);
  }
  for (const [rawQ, rawA] of entries.slice(0, MAX_ENTRIES)) {
    const q = String(rawQ || '').trim();
    const a = String(rawA || '').trim();
    if (!q || !a) { skipped++; continue; }
    if (q.startsWith('README')) { skipped++; continue; }
    if (q.length > MAX_Q || a.length > MAX_A) { skipped++; continue; }
    if (looksLikePii(q) || looksLikePii(a)) { skipped++; continue; }
    ok[q] = a;
  }
  return { ok, skipped, errors };
}

/**
 * Merge additivo: aggiunge a `bank` solo chiavi assenti. Non sovrascrive.
 * Pure. Ritorna { bank, added: string[] }.
 */
function mergeAnswersAdditive(bank, incoming) {
  const out = { ...(bank && typeof bank === 'object' ? bank : {}) };
  const added = [];
  for (const [q, a] of Object.entries(incoming || {})) {
    if (!out[q]) {
      out[q] = a;
      added.push(q);
    }
  }
  return { bank: out, added };
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

function getShareEndpoint() {
  const cfg = readConfig();
  const base = String(cfg.issueEndpoint || cfg.answersEndpoint || DEFAULT_ENDPOINT || '').trim().replace(/\/$/, '');
  if (!base) return '';
  return base + '/answers';
}

function getShareKey() {
  const cfg = readConfig();
  return String(cfg.issueReportKey || cfg.answersShareKey || DEFAULT_KEY || '').trim();
}

function postJson(urlStr, bodyObj) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) {
      resolve({ ok: false, error: 'bad_url', detail: String(e.message || e) });
      return;
    }
    const payload = JSON.stringify(bodyObj);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': 'gsdcampus-autoplay-answers-share',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) { json = null; }
        if (res.statusCode >= 200 && res.statusCode < 300 && json && json.ok) {
          resolve({
            ok: true,
            added: json.added != null ? json.added : 0,
            total: json.total,
            message: json.message || null,
          });
        } else {
          resolve({
            ok: false,
            error: (json && json.error) || ('http_' + res.statusCode),
            detail: (json && json.detail) || data.slice(0, 200),
          });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'network', detail: e.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.write(payload);
    req.end();
  });
}

/**
 * Invia answersObj al Worker. Valida prima; non lancia.
 * @returns {Promise<{ok, added?, skipped?, error?, detail?}>}
 */
async function shareAnswersToRemote(answersObj) {
  const endpoint = getShareEndpoint();
  if (!endpoint) {
    return { ok: false, error: 'no_endpoint' };
  }
  const key = getShareKey();
  if (!key) {
    return { ok: false, error: 'no_key' };
  }
  const { ok: clean, skipped, errors } = validateAnswersPayload(answersObj);
  const n = Object.keys(clean).length;
  if (n === 0) {
    return { ok: false, error: 'no_valid_answers', skipped, detail: errors.join('; ') || undefined };
  }
  const res = await postJson(endpoint, { key, answers: clean });
  if (res.ok) {
    return { ...res, skipped, localValid: n };
  }
  return { ...res, skipped, localValid: n };
}

module.exports = {
  validateAnswersPayload,
  mergeAnswersAdditive,
  shareAnswersToRemote,
  getShareEndpoint,
  getShareKey,
  MAX_ENTRIES,
  MAX_Q,
  MAX_A,
};
