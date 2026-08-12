'use strict';

const { describe, it, before, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ENV = { KEY: 'test-key', ISSUE_TOKEN: 'test-token' };
const FINGERPRINT = 'a'.repeat(64);
const ORIGINAL_FETCH = global.fetch;
let worker;

before(async () => {
  ({ default: worker } = await import('../worker/issue-receiver.js'));
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
});

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function reportRequest(fingerprint = FINGERPRINT) {
  return new Request('https://worker.test/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      key: ENV.KEY,
      title: 'Titolo client',
      body: 'Corpo client',
      phase: 'need_help',
      fingerprint,
      occurrenceCount: 999,
    }),
  });
}

function issue(number, fingerprint = FINGERPRINT, state = 'open') {
  return {
    number,
    state,
    title: `Issue ${number}`,
    body: `Diagnostica server\n\n<!-- gsd-auto-fingerprint:${fingerprint} -->\n<!-- gsd-auto-occurrences:1 -->`,
    html_url: `https://github.com/iCosiSenpai/gsdcampus-autoplay/issues/${number}`,
  };
}

describe('issue receiver idempotente', () => {
  it('una fingerprint esistente è solo ACK: non riscrive dati con la chiave pubblica', async () => {
    const canonical = issue(40);
    const calls = [];
    global.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
      return json([canonical]);
    };

    const response = await worker.fetch(reportRequest(), ENV);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.url, canonical.html_url);
    assert.equal(body.deduplicated, true);
    assert.deepEqual(calls.map((call) => call.method), ['GET']);
  });

  it('due create concorrenti convergono sulla più vecchia e chiudono il duplicato', async () => {
    const issues = new Map();
    let nextNumber = 41;
    let initialLookups = 0;
    let releaseInitialLookups;
    const bothInitialLookups = new Promise((resolve) => { releaseInitialLookups = resolve; });

    global.fetch = async (rawUrl, init = {}) => {
      const url = String(rawUrl);
      const method = init.method || 'GET';
      const direct = url.match(/\/issues\/(\d+)$/);

      if (method === 'GET' && url.includes('/issues?')) {
        if (initialLookups < 2) {
          initialLookups += 1;
          if (initialLookups === 2) releaseInitialLookups();
          await bothInitialLookups;
          return json([]);
        }
        return json([...issues.values()].filter((item) => item.state === 'open'));
      }
      if (method === 'POST' && url.endsWith('/issues')) {
        const created = issue(nextNumber++);
        issues.set(created.number, created);
        return json(created, 201);
      }
      if (method === 'PATCH' && direct) {
        const number = Number(direct[1]);
        const current = issues.get(number);
        const changes = JSON.parse(init.body);
        issues.set(number, { ...current, ...changes });
        return json(issues.get(number));
      }
      if (method === 'GET' && direct) {
        return json(issues.get(Number(direct[1])));
      }
      throw new Error(`Chiamata GitHub inattesa: ${method} ${url}`);
    };

    const [first, second] = await Promise.all([
      worker.fetch(reportRequest(), ENV),
      worker.fetch(reportRequest(), ENV),
    ]);
    const [firstBody, secondBody] = await Promise.all([first.json(), second.json()]);

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(firstBody.url, issue(41).html_url);
    assert.equal(secondBody.url, issue(41).html_url);
    assert.equal(issues.get(41).state, 'open');
    assert.equal(issues.get(42).state, 'closed');
  });

  it('non ACKa il create finché non è visibile o chiuso come duplicato', async () => {
    let created = false;
    const fresh = issue(43);
    global.fetch = async (rawUrl, init = {}) => {
      const url = String(rawUrl);
      const method = init.method || 'GET';
      if (method === 'GET' && url.includes('/issues?')) return json([]);
      if (method === 'POST' && url.endsWith('/issues')) {
        created = true;
        return json(fresh, 201);
      }
      if (method === 'GET' && url.endsWith('/issues/43')) return json(fresh);
      throw new Error(`Chiamata GitHub inattesa: ${method} ${url}`);
    };

    const response = await worker.fetch(reportRequest('b'.repeat(64)), ENV);
    const body = await response.json();
    assert.equal(created, true);
    assert.equal(response.status, 502);
    assert.equal(body.error, 'github_reconcile_incomplete');
  });
});
