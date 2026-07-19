/**
 * metrics-share.js — POST aggregati phase-only al Worker (opt-in).
 * Nessun CF, token, URL. Usato da metrics-cli share se config.shareMetrics.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { DEFAULT_ENDPOINT, DEFAULT_KEY } = require('./receiver-config');
const { summarizeMetrics, buildMetricsSharePayload } = require('../../src/lib/metrics');

const ROOT = path.join(__dirname, '..', '..');
const TIMEOUT_MS = 20000;

function getEndpoint(config) {
  return (config && config.metricsEndpoint)
    || (config && config.issueEndpoint)
    || process.env.GSD_METRICS_ENDPOINT
    || `${DEFAULT_ENDPOINT.replace(/\/$/, '')}/metrics`;
}

function getKey(config) {
  return (config && config.metricsKey)
    || (config && config.issueKey)
    || process.env.GSD_METRICS_KEY
    || DEFAULT_KEY;
}

function postJson(urlStr, body) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) {
      resolve({ ok: false, error: 'bad_url', detail: e.message });
      return;
    }
    const lib = u.protocol === 'http:' ? http : https;
    const data = JSON.stringify(body);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'gsdcampus-autoplay-metrics',
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(raw); } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
          resolve({ ok: true, ...parsed, status: res.statusCode });
        } else {
          resolve({
            ok: false,
            error: parsed.error || `http_${res.statusCode}`,
            detail: parsed.detail || raw.slice(0, 200),
            status: res.statusCode,
          });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'network', detail: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * Condivide metriche se config.shareMetrics === true.
 * @returns {{ ok: boolean, skipped?: boolean, reason?: string, ... }}
 */
async function shareMetrics(opts = {}) {
  const config = opts.config || loadConfig();
  if (!config.shareMetrics && !opts.force) {
    return { ok: false, skipped: true, reason: 'shareMetrics_disabled' };
  }
  const hours = opts.hours != null ? Number(opts.hours) : 168;
  const summary = summarizeMetrics(ROOT, { hours });
  if (!summary.total) {
    return { ok: false, skipped: true, reason: 'no_events' };
  }
  const payload = buildMetricsSharePayload(summary, {
    storeTag: config.storeTag || opts.storeTag,
  });
  const endpoint = getEndpoint(config);
  const key = getKey(config);
  if (!key) return { ok: false, error: 'no_key' };
  return postJson(endpoint, { key, ...payload });
}

module.exports = {
  shareMetrics,
  getEndpoint,
  getKey,
  buildMetricsSharePayload,
};
