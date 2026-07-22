#!/usr/bin/env node

/**
 * Proxy loopback con budget per Ollama locale/Cloud.
 * - Claude Code usa un token casuale valido solo per questa sessione;
 * - il daemon Ollama locale gestisce il login Cloud effettuato con `ollama signin`;
 * - limite rolling 7 giorni/24 ore/minuto e una richiesta generativa alla volta;
 * - `/v1/messages/count_tokens` non consuma budget;
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
  ['POST /v1/messages', true],
  ['POST /v1/messages/count_tokens', false],
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
  const endpoint = new URL(value || 'http://127.0.0.1:11434');
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || pathname !== '') {
    throw new Error('ollamaLocalEndpoint deve essere http://127.0.0.1:<porta>');
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

function normalizeNativeToolCalls(message) {
  if (!message || typeof message !== 'object' || !Array.isArray(message.tool_calls)) return message;
  return {
    ...message,
    tool_calls: message.tool_calls.map((call) => {
      if (!call || typeof call !== 'object' || !call.function || typeof call.function !== 'object') return call;
      const fn = { ...call.function };
      if (typeof fn.arguments === 'string') {
        const raw = fn.arguments.trim();
        if (!raw) {
          fn.arguments = {};
        } else {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fn.arguments = parsed;
          } catch (_) { /* lascia l'errore al daemon se gli argomenti sono davvero malformati */ }
        }
      }
      return { ...call, function: fn };
    }),
  };
}

function createGenerationQueue(minIntervalMs) {
  let lastStartedAt = 0;
  let tail = Promise.resolve();
  return async () => {
    let releaseTail;
    const previous = tail;
    tail = new Promise((resolve) => { releaseTail = resolve; });
    await previous;
    const intervalLeft = minIntervalMs - (Date.now() - lastStartedAt);
    if (intervalLeft > 0) await new Promise((resolve) => setTimeout(resolve, intervalLeft));
    lastStartedAt = Date.now();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTail();
    };
  };
}

function nativeChatBody(input) {
  const source = input && typeof input === 'object' ? input : {};
  const body = { ...source };
  if (Array.isArray(source.messages)) body.messages = source.messages.map(normalizeNativeToolCalls);
  const options = { ...(source.options && typeof source.options === 'object' ? source.options : {}) };
  const optionMap = {
    max_tokens: 'num_predict',
    max_completion_tokens: 'num_predict',
    temperature: 'temperature',
    top_p: 'top_p',
    top_k: 'top_k',
    stop: 'stop',
    seed: 'seed',
    repeat_penalty: 'repeat_penalty',
  };
  for (const [from, to] of Object.entries(optionMap)) {
    if (source[from] !== undefined && options[to] === undefined) options[to] = source[from];
    delete body[from];
  }
  delete body.tool_choice;
  delete body.parallel_tool_calls;
  delete body.stream_options;
  delete body.response_format;
  if (Object.keys(options).length) body.options = options;
  return body;
}

function openAiId() {
  return `chatcmpl-gsd-${crypto.randomBytes(8).toString('hex')}`;
}

function nativeToOpenAiChunk(item, id, model) {
  const message = item && item.message && typeof item.message === 'object' ? item.message : {};
  const delta = {};
  if (message.role) delta.role = message.role;
  if (message.content) delta.content = message.content;
  if (Array.isArray(message.tool_calls)) {
    delta.tool_calls = message.tool_calls.map((call, index) => ({
      index,
      id: call.id || `call_${index}`,
      type: 'function',
      function: {
        name: call.function && call.function.name ? call.function.name : '',
        arguments: typeof (call.function && call.function.arguments) === 'string'
          ? call.function.arguments
          : JSON.stringify((call.function && call.function.arguments) || {}),
      },
    }));
  }
  const finishReason = item && item.done ? (item.done_reason || 'stop') : null;
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function nativeToOpenAiResponse(item, model) {
  const message = item && item.message && typeof item.message === 'object' ? item.message : { role: 'assistant', content: '' };
  const finishReason = item && item.done_reason ? item.done_reason : 'stop';
  const usage = item && (item.prompt_eval_count !== undefined || item.eval_count !== undefined)
    ? {
      prompt_tokens: Number(item.prompt_eval_count || 0),
      completion_tokens: Number(item.eval_count || 0),
      total_tokens: Number(item.prompt_eval_count || 0) + Number(item.eval_count || 0),
    }
    : undefined;
  return {
    id: openAiId(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

async function writeNativeChat(upstream, res, model, stream, headerBag) {
  if (!stream) {
    const raw = Buffer.from(await upstream.arrayBuffer()).toString('utf8');
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = { message: { role: 'assistant', content: raw } }; }
    const body = Buffer.from(JSON.stringify(nativeToOpenAiResponse(parsed, model)));
    res.writeHead(upstream.status, { ...headerBag, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
    return { body, cacheable: body.length <= CACHE_MAX_BYTES };
  }

  const id = openAiId();
  const captured = [];
  let capturedBytes = 0;
  let pending = '';
  res.writeHead(upstream.status, { ...headerBag, 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
  const emit = (value) => {
    const bytes = Buffer.from(value);
    res.write(bytes);
    capturedBytes += bytes.length;
    if (capturedBytes <= CACHE_MAX_BYTES) captured.push(bytes);
  };
  const decoder = new TextDecoder();
  if (upstream.body) {
    for await (const chunk of upstream.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { emit(nativeToOpenAiChunk(JSON.parse(trimmed), id, model)); } catch (_) { /* ignora righe non JSON */ }
      }
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    try { emit(nativeToOpenAiChunk(JSON.parse(pending.trim()), id, model)); } catch (_) { /* ignora riga parziale */ }
  }
  emit('data: [DONE]\n\n');
  res.end();
  return { body: Buffer.concat(captured), cacheable: capturedBytes <= CACHE_MAX_BYTES };
}

function pruneCache(cache, now = Date.now()) {
  for (const [key, item] of cache) {
    if (item.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > CACHE_MAX_ITEMS) cache.delete(cache.keys().next().value);
}

function tokenMatches(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function authorized(req, expected) {
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const apiKey = String(req.headers['x-api-key'] || '');
  return tokenMatches(bearer, expected) || tokenMatches(apiKey, expected);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = readConfig(args.root);
  const port = Math.max(1024, Math.min(65535, args.port || Number(cfg.aiCloudProxyPort) || 11435));
  const endpoint = validatedEndpoint(cfg.ollamaLocalEndpoint);
  const localToken = process.env.GSD_AI_PROXY_TOKEN;
  if (!localToken) throw new Error('GSD_AI_PROXY_TOKEN non presente nell’ambiente');

  const limits = readLimits(args.root);
  const cache = new Map();

  // Claude Code puo eseguire piu turni nella stessa sessione one-shot quando
  // usa WebSearch/WebFetch. Il budget consente una sola generazione per volta:
  // le richieste vengono accodate invece di produrre retry/429 ravvicinati.
  const acquireGenerationTurn = createGenerationQueue(limits.minIntervalMs);

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
    let parsedBody = null;
    if (body.length) {
      try {
        parsedBody = JSON.parse(body.toString('utf8'));
        model = String(parsedBody.model || '');
      } catch (_) {
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
    let releaseGeneration = null;
    if (generation) {
      releaseGeneration = await acquireGenerationTurn();
      // Limite hard di sicurezza: la configurazione puo soltanto abbassare il
      // tetto documentato di 8 generazioni per batch, mai aumentarlo.
      const batchLimit = Math.max(1, Math.min(8, Number(cfg.aiClaudeMaxRequestsPerBatch) || 8));
      const batchUsed = Number(server.generationRequests || 0);
      if (batchUsed >= batchLimit) {
        releaseGeneration();
        releaseGeneration = null;
        return json(res, 429, {
          error: 'ai_batch_request_limit',
          limit: batchLimit,
          retryAfterSeconds: 1800,
        }, { 'retry-after': '1800' });
      }
      reservation = reserveRequest(args.root, { path: requestUrl.pathname, model });
      if (!reservation.ok) {
        releaseGeneration();
        releaseGeneration = null;
        const seconds = Math.max(1, Math.ceil(reservation.retryAfterMs / 1000));
        return json(res, 429, {
          error: 'ai_budget_exhausted',
          window: reservation.reason,
          retryAfterSeconds: seconds,
          usage: reservation.summary,
        }, { 'retry-after': String(seconds) });
      }
      server.generationRequests = batchUsed + 1;
    }

    const abort = new AbortController();
    req.on('aborted', () => abort.abort());
    try {
      const nativeChat = route === 'POST /v1/chat/completions';
      const targetPath = nativeChat ? '/api/chat' : requestUrl.pathname;
      const bodyForUpstream = nativeChat ? Buffer.from(JSON.stringify(nativeChatBody(parsedBody))) : body;
      const target = new URL(targetPath + requestUrl.search, endpoint.origin);
      const upstream = await fetch(target, {
        method: req.method,
        headers: {
          accept: req.headers.accept || 'application/json',
          'content-type': req.headers['content-type'] || 'application/json',
          'user-agent': 'gsdcampus-autoplay-budget-proxy/1',
          ...(req.headers['anthropic-version'] ? { 'anthropic-version': req.headers['anthropic-version'] } : {}),
          ...(req.headers['anthropic-beta'] ? { 'anthropic-beta': req.headers['anthropic-beta'] } : {}),
        },
        body: req.method === 'POST' ? bodyForUpstream : undefined,
        signal: abort.signal,
      });

      const headers = responseHeaders(upstream);
      let captured = null;
      let cacheable = generation && upstream.ok;
      if (nativeChat && upstream.ok) {
        const transformed = await writeNativeChat(upstream, res, model, parsedBody.stream !== false, { ...headers, 'x-gsdcampus-ai-cache': 'miss' });
        captured = transformed.body;
        if (!transformed.cacheable) cacheable = false;
      } else {
        res.writeHead(upstream.status, { ...headers, 'x-gsdcampus-ai-cache': 'miss' });
        const chunks = [];
        let capturedBytes = 0;
        if (upstream.body) {
          for await (const chunk of upstream.body) {
            const bytes = Buffer.from(chunk);
            res.write(bytes);
            if (cacheable) {
              capturedBytes += bytes.length;
              if (capturedBytes <= CACHE_MAX_BYTES) chunks.push(bytes);
              else cacheable = false;
            }
          }
        }
        res.end();
        captured = Buffer.concat(chunks);
      }
      if (cacheKey && cacheable) {
        cache.set(cacheKey, {
          status: upstream.status,
          headers: nativeChat ? { ...headers, 'content-type': parsedBody.stream === false ? 'application/json; charset=utf-8' : 'text/event-stream; charset=utf-8', 'x-gsdcampus-ai-cache': 'miss' } : { ...headers, 'x-gsdcampus-ai-cache': 'miss' },
          body: captured,
          expiresAt: Date.now() + CACHE_TTL_MS,
        });
        pruneCache(cache);
      }
      if (reservation && reservation.id) completeRequest(args.root, reservation.id, upstream.status);
      process.stdout.write(`[ai-proxy] ${requestUrl.pathname} -> ${upstream.status}\n`);
    } catch (_) {
      if (!res.headersSent) json(res, 502, { error: 'ollama_local_unreachable' });
      else res.end();
      if (reservation && reservation.id) completeRequest(args.root, reservation.id, 502, { error: true });
      process.stderr.write('[ai-proxy] daemon Ollama locale non raggiungibile\n');
    } finally {
      if (releaseGeneration) releaseGeneration();
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

module.exports = {
  ALLOWED,
  authorized,
  createGenerationQueue,
  nativeChatBody,
  nativeToOpenAiChunk,
  nativeToOpenAiResponse,
  parseArgs,
  validatedEndpoint,
};
