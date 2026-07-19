/**
 * issue-receiver.js — Cloudflare Worker per gsdcampus-autoplay.
 *
 * Route:
 *   POST /  o  POST /report  → apre issue GitHub (segnalazione bug AI)
 *   POST /answers            → merge additivo di risposte quiz su
 *                              data/known_answers_public.json (Contents API)
 *
 * PAT in secret ISSUE_TOKEN (e opz. ANSWERS_TOKEN). Scope necessari:
 *   Issues: Read and write
 *   Contents: Read and write
 * solo su iCosiSenpai/gsdcampus-autoplay.
 *
 * KEY in wrangler.toml [vars] — non-segreta, allineata a receiver-config.js.
 * Deploy: vedi ./README.md
 */

const REPO = 'iCosiSenpai/gsdcampus-autoplay';
const LABEL = 'auto-report';
const MAX_TITLE = 256;
const MAX_BODY = 65536;
const BANK_PATH = 'data/known_answers_public.json';
const BRANCH = 'main';

// Limiti answers (keep in sync con scripts/lib/answers-share.js)
const MAX_ENTRIES = 50;
const MAX_Q = 800;
const MAX_A = 500;

// --- Redazione PII (mirror client) -----------------------------------------
const RE_AUTOLOGIN = /https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+/g;
const RE_CF = /[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/g;
const RE_GH_PAT = /github_pat_[A-Za-z0-9_]+/g;
const RE_GH_TOK = /gh[oaprsu]_[A-Za-z0-9]+/g;

const RE_AUTOLOGIN_TEST = /https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+/i;
const RE_CF_TEST = /\b[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\b/;
const RE_GH_PAT_TEST = /github_pat_[A-Za-z0-9_]+/;
const RE_GH_TOK_TEST = /\bgh[oaprsu]_[A-Za-z0-9]+/;

function redactText(s) {
  if (s == null) return '';
  return String(s)
    .replace(RE_AUTOLOGIN, '[REDACTED-AUTOLOGIN]')
    .replace(RE_GH_PAT, '[REDACTED-TOKEN]')
    .replace(RE_GH_TOK, '[REDACTED-TOKEN]')
    .replace(RE_CF, '[REDACTED-CF]');
}

function looksLikePii(s) {
  const t = String(s || '');
  return RE_AUTOLOGIN_TEST.test(t) || RE_CF_TEST.test(t) || RE_GH_PAT_TEST.test(t) || RE_GH_TOK_TEST.test(t);
}

function jsonResp(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'gsdcampus-autoplay-issue-receiver'
  };
}

function tokenFor(env) {
  return env.ANSWERS_TOKEN || env.ISSUE_TOKEN || '';
}

function checkKey(data, env) {
  const key = typeof data.key === 'string' ? data.key : '';
  const expectedKey = typeof env.KEY === 'string' ? env.KEY : '';
  return expectedKey && key === expectedKey;
}

// --- Issues ----------------------------------------------------------------

async function createIssue(env, title, body, withLabel) {
  const payload = { title, body };
  if (withLabel) payload.labels = [LABEL];
  return fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: ghHeaders(env.ISSUE_TOKEN),
    body: JSON.stringify(payload)
  });
}

async function handleIssue(data, env) {
  if (!checkKey(data, env)) {
    return jsonResp(401, { ok: false, error: 'bad_key' });
  }

  const title = redactText(String(data.title || '')).slice(0, MAX_TITLE);
  const body = redactText(String(data.body || '')).slice(0, MAX_BODY);
  if (!title) return jsonResp(400, { ok: false, error: 'missing_title' });
  if (!body) return jsonResp(400, { ok: false, error: 'missing_body' });

  if (!env.ISSUE_TOKEN) {
    return jsonResp(500, { ok: false, error: 'receiver_not_configured' });
  }

  let res = await createIssue(env, title, body, true);
  if (res.status === 422) {
    res = await createIssue(env, title, body, false);
  }

  if (res.status === 401 || res.status === 403) {
    return jsonResp(502, { ok: false, error: 'github_token' });
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    return jsonResp(502, { ok: false, error: 'github_' + res.status, detail: t.slice(0, 200) });
  }

  const issue = await res.json();
  return jsonResp(200, { ok: true, url: issue.html_url });
}

// --- Answers bank ----------------------------------------------------------

function sanitizeIncoming(answers) {
  const clean = {};
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    return clean;
  }
  let n = 0;
  for (const [rawQ, rawA] of Object.entries(answers)) {
    if (n >= MAX_ENTRIES) break;
    const q = String(rawQ || '').trim();
    const a = String(rawA || '').trim();
    if (!q || !a) continue;
    if (q.startsWith('README')) continue;
    if (q.length > MAX_Q || a.length > MAX_A) continue;
    if (looksLikePii(q) || looksLikePii(a)) continue;
    clean[q] = a;
    n++;
  }
  return clean;
}

async function getBankFile(token) {
  const url = `https://api.github.com/repos/${REPO}/contents/${BANK_PATH}?ref=${BRANCH}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  return res;
}

async function putBankFile(token, contentStr, sha, addedCount) {
  const body = {
    message: `banca risposte: +${addedCount} da collega (auto)`,
    content: btoa(unescape(encodeURIComponent(contentStr))),
    sha,
    branch: BRANCH,
  };
  return fetch(`https://api.github.com/repos/${REPO}/contents/${BANK_PATH}`, {
    method: 'PUT',
    headers: {
      ...ghHeaders(token),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function handleAnswers(data, env) {
  if (!checkKey(data, env)) {
    return jsonResp(401, { ok: false, error: 'bad_key' });
  }

  const token = tokenFor(env);
  if (!token) {
    return jsonResp(500, { ok: false, error: 'receiver_not_configured' });
  }

  const incoming = sanitizeIncoming(data.answers);
  if (Object.keys(incoming).length === 0) {
    return jsonResp(400, { ok: false, error: 'no_valid_answers' });
  }

  // Retry su 409 (race tra due share concorrenti).
  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await getBankFile(token);
    if (getRes.status === 401 || getRes.status === 403) {
      return jsonResp(502, { ok: false, error: 'github_token' });
    }
    if (!getRes.ok) {
      const t = await getRes.text().catch(() => '');
      return jsonResp(502, { ok: false, error: 'github_' + getRes.status, detail: t.slice(0, 200) });
    }

    const file = await getRes.json();
    const sha = file.sha;
    let bank = {};
    try {
      // content is base64; Workers have atob
      const raw = decodeURIComponent(escape(atob(file.content.replace(/\n/g, ''))));
      bank = JSON.parse(raw);
      if (!bank || typeof bank !== 'object') bank = {};
    } catch {
      return jsonResp(502, { ok: false, error: 'bank_parse_failed' });
    }

    let added = 0;
    for (const [q, a] of Object.entries(incoming)) {
      if (!bank[q]) {
        bank[q] = a;
        added++;
      }
    }

    if (added === 0) {
      return jsonResp(200, {
        ok: true,
        added: 0,
        total: Object.keys(bank).filter((k) => k !== 'README').length,
        message: 'noop',
      });
    }

    const contentStr = JSON.stringify(bank, null, 2) + '\n';
    const putRes = await putBankFile(token, contentStr, sha, added);

    if (putRes.status === 409) {
      continue; // retry
    }
    if (putRes.status === 401 || putRes.status === 403) {
      return jsonResp(502, { ok: false, error: 'github_token' });
    }
    if (!putRes.ok) {
      const t = await putRes.text().catch(() => '');
      return jsonResp(502, { ok: false, error: 'github_' + putRes.status, detail: t.slice(0, 200) });
    }

    const putJson = await putRes.json().catch(() => ({}));
    return jsonResp(200, {
      ok: true,
      added,
      total: Object.keys(bank).filter((k) => k !== 'README').length,
      commit: putJson.commit && putJson.commit.sha ? putJson.commit.sha : null,
    });
  }

  return jsonResp(502, { ok: false, error: 'conflict_retries_exhausted' });
}

// --- Router ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.method === 'POST' && (path === '/answers')) {
      let data;
      try { data = await request.json(); }
      catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }
      return handleAnswers(data, env);
    }

    if (request.method === 'POST' && (path === '/' || path === '/report')) {
      let data;
      try { data = await request.json(); }
      catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }
      return handleIssue(data, env);
    }

    if (request.method === 'GET' && path === '/') {
      return jsonResp(200, {
        ok: true,
        service: 'gsdcampus-autoplay-receiver',
        routes: ['POST /report', 'POST /answers'],
      });
    }

    return jsonResp(405, { ok: false, error: 'method_not_allowed' });
  }
};
