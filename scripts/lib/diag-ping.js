#!/usr/bin/env node
/**
 * diag-ping.js — ping diagnostico privacy-safe verso il Cloudflare Worker.
 *
 * Manda SOLO: versione (git short sha), event, errorClass, storeTag.
 * MAI: codice fiscale, autologin, token, cookie, URL, contenuti. Il Worker fa
 * un semplice console.log (visibile con `wrangler tail` / dashboard): niente
 * issue GitHub, niente persistenza. Serve a sapere quale versione gira su ogni
 * store e quali errorClass capitano, senza rumore.
 *
 * Uso: node scripts/lib/diag-ping.js <event> [errorClass]
 *   es.  node scripts/lib/diag-ping.js start
 *        node scripts/lib/diag-ping.js error crash_loop
 *
 * Best-effort assoluto: non blocca, non stampa nulla di sensibile, esce SEMPRE
 * con codice 0 (i chiamanti lo lanciano in background con `|| true`).
 * Opt-out: "diagnostics": false in config.json.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { readJsonSafe } = require('../../src/lib/io');
const receiver = require('./receiver-config');

const ROOT = path.resolve(__dirname, '..', '..');

// Solo caratteri innocui: uno slug non può veicolare PII strutturata.
function slug(value, max) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_.:+-]/g, '').slice(0, max);
}

async function main() {
  const event = slug(process.argv[2], 32) || 'start';
  const errorClass = slug(process.argv[3], 64);

  const config = readJsonSafe(path.join(ROOT, 'config.json'), {}, { warn: false }) || {};
  if (config.diagnostics === false) return; // opt-out esplicito

  const endpoint = String(config.issueEndpoint || receiver.DEFAULT_ENDPOINT || '').replace(/\/+$/, '');
  const key = config.issueReportKey || receiver.DEFAULT_KEY || '';
  if (!endpoint || !key) return;

  let version = '';
  try {
    version = String(execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }) || '').trim();
  } catch (_) { version = ''; }

  const body = JSON.stringify({
    key,
    event,
    errorClass,
    version: slug(version, 40),
    storeTag: slug(config.storeTag, 32),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    await fetch(endpoint + '/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
  } catch (_) {
    // Offline, timeout, worker giù: è telemetria, si ignora in silenzio.
  } finally {
    clearTimeout(timer);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
