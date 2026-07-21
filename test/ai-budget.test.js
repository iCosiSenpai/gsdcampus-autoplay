const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const {
  completeRequest,
  reserveRequest,
  usageSummary,
} = require('../src/lib/ai-budget');
const { directCloudModel, createOpenCodeConfig } = require('../scripts/lib/opencode-config');
const { migrate } = require('../scripts/lib/migrate-claude-settings');
const {
  authorized,
  nativeChatBody,
  nativeToOpenAiChunk,
  nativeToOpenAiResponse,
  validatedEndpoint,
} = require('../scripts/lib/ollama-cloud-proxy');

function fixtureRoot(config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ai-budget-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    aiWeeklyRequestLimit: 2,
    aiDailyRequestLimit: 2,
    aiPerMinuteRequestLimit: 8,
    aiMinRequestIntervalMs: 1500,
    aiMaxConcurrentRequests: 1,
    ollamaModel: 'gemma4:31b-cloud',
    ...config,
  }));
  return root;
}

test('budget rolling conta richieste senza salvare payload', () => {
  const root = fixtureRoot();
  const now = Date.parse('2026-07-21T10:00:00.000Z');
  const first = reserveRequest(root, { path: '/v1/chat/completions', model: 'gemma4:31b', prompt: 'NON SALVARE' }, now);
  assert.equal(first.ok, true);
  completeRequest(root, first.id, 200);
  const second = reserveRequest(root, { path: '/v1/chat/completions', model: 'gemma4:31b' }, now + 2_000);
  assert.equal(second.ok, true);
  const blocked = reserveRequest(root, { path: '/v1/chat/completions', model: 'gemma4:31b' }, now + 4_000);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'daily');

  const state = JSON.parse(fs.readFileSync(path.join(root, 'data', 'ai_usage.json')));
  assert.equal(state.events.length, 2);
  assert.equal(Object.hasOwn(state.events[0], 'prompt'), false);
  assert.equal(Object.hasOwn(state.events[0], 'response'), false);
  assert.equal(usageSummary(root, now + 4_000).used.weekly, 2);
});

test('budget elimina eventi oltre la finestra rolling', () => {
  const root = fixtureRoot({ aiWeeklyRequestLimit: 1, aiDailyRequestLimit: 1 });
  const old = Date.parse('2026-07-10T10:00:00.000Z');
  const now = Date.parse('2026-07-21T10:00:00.000Z');
  const first = reserveRequest(root, {}, old);
  assert.equal(first.ok, true);
  const next = reserveRequest(root, {}, now);
  assert.equal(next.ok, true);
  assert.equal(usageSummary(root, now).used.weekly, 1);
});

test('OpenCode usa il nome diretto senza suffisso cloud', () => {
  assert.equal(directCloudModel('gemma4:31b-cloud'), 'gemma4:31b');
  assert.equal(directCloudModel('gpt-oss:120b'), 'gpt-oss:120b');
  const root = fixtureRoot();
  const cfg = createOpenCodeConfig(root);
  assert.equal(cfg.model, 'ollama-cloud/gemma4:31b');
  assert.equal(cfg.provider['ollama-cloud'].options.baseURL, 'http://127.0.0.1:11435/v1');
  assert.equal(cfg.permission.edit, 'deny');
  assert.equal(cfg.permission.task, 'deny');
});

test('proxy accetta solo endpoint Ollama e token locale esatto', () => {
  assert.equal(validatedEndpoint('https://ollama.com').origin, 'https://ollama.com');
  assert.throws(() => validatedEndpoint('https://example.com/v1'));
  assert.equal(authorized({ headers: { authorization: 'Bearer abc123' } }, 'abc123'), true);
  assert.equal(authorized({ headers: { authorization: 'Bearer wrong' } }, 'abc123'), false);
});

test('proxy traduce OpenAI chat nel formato nativo Ollama Cloud', () => {
  const body = nativeChatBody({
    model: 'gemma4:31b',
    messages: [{ role: 'user', content: 'ciao' }],
    max_tokens: 123,
    temperature: 0.2,
    stream: true,
  });
  assert.equal(body.options.num_predict, 123);
  assert.equal(body.options.temperature, 0.2);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.messages[0].content, 'ciao');
  const chunk = JSON.parse(nativeToOpenAiChunk({ message: { role: 'assistant', content: 'ok' } }, 'id', body.model).slice(6).trim());
  assert.equal(chunk.choices[0].delta.content, 'ok');
  const response = nativeToOpenAiResponse({ message: { role: 'assistant', content: 'ok' }, done_reason: 'stop' }, body.model);
  assert.equal(response.choices[0].message.content, 'ok');
});

test('migrazione Claude rimuove solo override Ollama riconoscibili', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-project-'));
  fs.mkdirSync(path.join(home, '.claude'));
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434/v1',
      ANTHROPIC_API_KEY: 'ollama-secret',
      MY_PERSONAL_SETTING: 'keep',
    },
    theme: 'dark',
  }));
  const result = migrate({ home, project });
  assert.equal(result.changed, 1);
  const cleaned = JSON.parse(fs.readFileSync(settings));
  assert.equal(cleaned.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(cleaned.env.MY_PERSONAL_SETTING, 'keep');
  assert.equal(cleaned.theme, 'dark');
});
