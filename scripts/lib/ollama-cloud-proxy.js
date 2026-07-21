#!/usr/bin/env node

/**
 * Proxy loopback per Ollama Cloud.
 * - la API key arriva solo dall'ambiente del processo;
 * - limite rolling 7 giorni/24 ore/minuto e una richiesta alla volta;
 * - cache RAM breve per retry byte-identici, mai persistita;
 * - nessun log di prompt, risposta o credenziale.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const {
  completeRequest,
  readLimits,
  reserveRequest,
  usageSummary,
} = require('../../src/lib/ai-budget');

const ALLOWED = new Map([
  ['GET /v1/models', false],
  ['POST /v1/chat/completions', true],
  ['POST /v1/responses', true],
]);
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const CACHE_MAX_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ITEMS = 8;

function parseArgs(argv) {
  const result = { root: path.resolve(__dirname, '..', '..'), port: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) result.root = path.resolve(argv[++i]);
    else if (argv[i] === '--port' && argv[i + 1]) result.port = Number(argv[++i]);
  }
  return result;
}

function readConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); } catch (_) { return {}; }
}

function validatedEndpoint(value) {
  const endpoint = new URL(value || 'https://ollama.com/v1');
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== 'ollama.com' || endpoint.pathname !== '/v1') {
    throw new Error('aiCloudEndpoint deve essere https://ollama.com/v1');
  }
  return endpoint;
}

function json(res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    ...headers,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request_too_large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function responseHeaders(upstream) {
  const headers = {};
  const skipped = new Set(['connection', 'content-encoding', 'content-length', 'keep-alive', 'transfer-encoding']);
  upstream.headers.forEach((value, name) => {
    if (!skipped.has(name.toLowerCase())) headers[name] = value;
  });
  return headers;
}

function pruneCache(cache, now = Date.now()) {
  for (const [key, item] of cache) {
    if (item.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ITEMS) cache.delete(cache.keys().next().value);
}

function authorized(req, expected) {
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readConfig(args.root);
  const port = Math.max(1024, Math.min(65535, args.port || Number(cfg.aiCloudProxyPort) || 11435));
  const endpoint = validatedEndpoint(cfg.aiCloudEndpoint);
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) throw new Error('OLLAMA_API_KEY non presente nell’ambiente');
  const localToken = process.env.GSD_AI_PROXY_TOKEN;
  if (!localToken) throw new Error('GSD_AI_PROXY_TOKEN non presente nell’ambiente');

  const limits = readLimits(args.root);
  const cache = new Map();
  let inFlight = 0;
  let lastStartedAt = 0;

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      return json(res, 200, { ok: true, upstream: endpoint.origin, limits, usage: usageSummary(args.root) });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/budget') {
      return json(res, 200, usageSummary(args.root));
    }

    const route = `${req.method} ${requestUrl.pathname}`;
    if (!ALLOWED.has(route)) return json(res, 404, { error: 'endpoint_not_allowed' });
    if (!authorized(req, localToken)) return json(res, 401, { error: 'local_proxy_unauthorized' });
    const generation = ALLOWED.get(route);

    let body = Buffer.alloc(0);
    try {
      if (req.method === 'POST') body = await readBody(req);
    } catch (error) {
      return json(res, error.status || 400, { error: error.message === 'request_too_large' ? error.message : 'invalid_request' });
    }

    let model = '';
    if (body.length) {
      try { model = String(JSON.parse(body.toString('utf8')).model || ''); } catch (_) {
        return json(res, 400, { error: 'invalid_json' });
      }
    }

    const cacheKey = generation
      ? crypto.createHash('sha256').update(route).update('\0').update(body).digest('hex')
      : null;
    pruneCache(cache);
    if (cacheKey && cache.has(cacheKey)) {
      const hit = cache.get(cacheKey);
      res.writeHead(hit.status, { ...hit.headers, 'x-gsdcampus-ai-cache': 'hit' });
      return res.end(hit.body);
    }

    let reservation = null;
    if (generation) {
      if (inFlight >= limits.maxConcurrent) {
        return json(res, 429, { error: 'ai_concurrency_limit', retryAfterSeconds: 2 }, { 'retry-after': '2' });
      }
      const intervalLeft = limits.minIntervalMs - (Date.now() - lastStartedAt);
      if (intervalLeft > 0) {
        const seconds = Math.max(1, Math.ceil(intervalLeft / 1000));
        return json(res, 429, { error: 'ai_rate_limit', retryAfterSeconds: seconds }, { 'retry-after': String(seconds) });
      }
      reservation = reserveRequest(args.root, { path: requestUrl.pathname, model });
      if (!reservation.ok) {
        const seconds = Math.max(1, Math.ceil(reservation.retryAfterMs / 1000));
        return json(res, 429, {
          error: 'ai_budget_exhausted',
          window: reservation.reason,
          retryAfterSeconds: seconds,
          usage: reservation.summary,
        }, { 'retry-after': String(seconds) });
      }
      inFlight += 1;
      lastStartedAt = Date.now();
    }

    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    try {
      const target = new URL(requestUrl.pathname + requestUrl.search, endpoint.origin);
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          accept: req.headers.accept || 'application/json',
          'content-type': req.headers['content-type'] || 'application/json',
          authorization: `Bearer ${apiKey}`,
          'user-agent': 'gsdcampus-autoplay-budget-proxy/1',
        },
        body: req.method === 'POST' ? body : undefined,
        signal: abort.signal,
      });

      const headers = responseHeaders(upstream);
      res.writeHead(upstream.status, { ...headers, 'x-gsdcampus-ai-cache': 'miss' });
      const captured = [];
      let capturedBytes = 0;
      let cacheable = generation && upstream.ok;
      if (upstream.body) {
        for await (const chunk of upstream.body) {
          const bytes = Buffer.from(chunk);
          res.write(bytes);
          if (cacheable) {
            capturedBytes += bytes.length;
            if (capturedBytes <= CACHE_MAX_BYTES) captured.push(bytes);
            else cacheable = false;
          }
        }
      }
      res.end();
      if (cacheKey && cacheable) {
        cache.set(cacheKey, {
          status: upstream.status,
          headers,
          body: Buffer.concat(captured),
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        pruneCache(cache);
      }
      if (reservation && reservation.id) completeRequest(args.root, reservation.id, upstream.status);
      process.stdout.write(`[ai-proxy] ${requestUrl.pathname} -> ${upstream.status}\n`);
    } catch (_) {
      if (!res.headersSent) json(res, 502, { error: 'ollama_cloud_unreachable' });
      else res.end();
      if (reservation && reservation.id) completeRequest(args.root, reservation.id, 502, { error: true });
      process.stderr.write('[ai-proxy] upstream non raggiungibile\n');
    } finally {
      if (generation) inFlight = Math.max(0, inFlight - 1);
    }
  });

  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`[ai-proxy] pronto su 127.0.0.1:${port}; budget ${limits.weekly}/7g, ${limits.daily}/24h, ${limits.perMinute}/min\n`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[ai-proxy] avvio fallito: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { ALLOWED, authorized, parseArgs, validatedEndpoint };
