/**
 * issue-receiver.js — Cloudflare Worker per gsdcampus-autoplay.
 *
 * Route:
 *   POST /  o  POST /report  → apre issue GitHub (segnalazione bug AI)
 *   POST /answers            → merge additivo di risposte quiz su
 *                              data/known_answers_public.json (Contents API)
 *   POST /metrics            → batch phase-only (privacy-safe, no CF); ack only
 *   POST /diag               → ping diagnostico (versione + errorClass, no PII);
 *                              solo console.log, nessuna issue/persistenza
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

const ISSUE_FINGERPRINT_RE = /^[a-f0-9]{64}$/;
const ISSUE_MARKER_PREFIX = '<!-- gsd-auto-fingerprint:';
const ISSUE_PAGE_SIZE = 100;
const MAX_ISSUE_PAGES = 10;
const RECONCILE_DELAYS_MS = [250, 750, 1500];

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(String(text));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function issueMarker(fingerprint) {
  return `${ISSUE_MARKER_PREFIX}${fingerprint} -->`;
}

function occurrenceMarker(count) {
  return `<!-- gsd-auto-occurrences:${count} -->`;
}

function decoratedIssueBody(body, fingerprint, count) {
  const clean = String(body || '')
    .replace(/\n*<!-- gsd-auto-fingerprint:[a-f0-9]{64} -->/g, '')
    .replace(/\n*<!-- gsd-auto-occurrences:\d+ -->/g, '')
    .trimEnd();
  return `${clean}\n\n${issueMarker(fingerprint)}\n${occurrenceMarker(count)}`.slice(0, MAX_BODY);
}

function occurrenceIn(body) {
  const match = String(body || '').match(/<!-- gsd-auto-occurrences:(\d+) -->/);
  return match ? Math.max(1, Number(match[1]) || 1) : 1;
}

async function githubIssues(env, fingerprint) {
  const marker = issueMarker(fingerprint);
  const issues = [];
  for (let page = 1; page <= MAX_ISSUE_PAGES; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${REPO}/issues?state=open&per_page=${ISSUE_PAGE_SIZE}&page=${page}&sort=created&direction=asc`,
      { headers: ghHeaders(env.ISSUE_TOKEN) }
    );
    if (response.status === 401 || response.status === 403) return { error: 'github_token' };
    if (!response.ok) return { error: `github_lookup_${response.status}` };
    const batch = await response.json();
    if (!Array.isArray(batch)) return { error: 'github_lookup_invalid' };
    issues.push(...batch.filter(
      (issue) => !issue.pull_request && String(issue.body || '').includes(marker)
    ));
    if (batch.length < ISSUE_PAGE_SIZE) {
      return { issues: issues.sort((a, b) => a.number - b.number) };
    }
  }
  // Fallire chiusi è meglio che creare un duplicato quando l'indice è incompleto.
  return { error: 'github_lookup_truncated' };
}

async function githubIssue(env, number) {
  const response = await fetch(`https://api.github.com/repos/${REPO}/issues/${number}`, {
    headers: ghHeaders(env.ISSUE_TOKEN),
  });
  if (response.status === 401 || response.status === 403) return { error: 'github_token' };
  if (!response.ok) return { error: `github_issue_${response.status}` };
  return { issue: await response.json() };
}

async function patchIssue(env, number, changes) {
  return fetch(`https://api.github.com/repos/${REPO}/issues/${number}`, {
    method: 'PATCH',
    headers: ghHeaders(env.ISSUE_TOKEN),
    body: JSON.stringify(changes),
  });
}

async function createIssue(env, title, body, withLabel) {
  const payload = { title, body };
  if (withLabel) payload.labels = [LABEL];
  return fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: ghHeaders(env.ISSUE_TOKEN),
    body: JSON.stringify(payload),
  });
}

function githubFailure(response) {
  if (response.status === 401 || response.status === 403) return 'github_token';
  return `github_${response.status}`;
}

async function canonicalizeIssues(env, issues) {
  if (issues.length === 0) return { error: 'github_reconcile_missing' };
  const ordered = [...issues].sort((a, b) => a.number - b.number);
  const canonical = ordered[0];
  for (const duplicate of ordered.slice(1)) {
    const closed = await patchIssue(env, duplicate.number, {
      state: 'closed',
      state_reason: 'duplicate',
    });
    if (!closed.ok) {
      const detail = await closed.text().catch(() => '');
      return {
        error: githubFailure(closed),
        detail: `chiusura duplicato #${duplicate.number}: ${detail.slice(0, 160)}`,
      };
    }
  }
  return { issue: canonical };
}

async function waitForCanonicalIssue(env, fingerprint, createdNumber) {
  let lastError = null;
  const marker = issueMarker(fingerprint);
  for (const delay of RECONCILE_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    const lookup = await githubIssues(env, fingerprint);
    if (lookup.error) {
      lastError = lookup.error;
      continue;
    }

    // Non si ACKa finché il create di *questa* richiesta non è contabilizzato:
    // deve essere visibile fra le open oppure già chiuso come duplicato da un
    // concorrente. Altrimenti una issue ancora fuori dall'indice potrebbe apparire
    // dopo che entrambi i client hanno cancellato la propria outbox.
    const createdOpen = lookup.issues.some((issue) => issue.number === createdNumber);
    let createdClosedAsDuplicate = false;
    if (!createdOpen) {
      const direct = await githubIssue(env, createdNumber);
      if (direct.error) {
        lastError = direct.error;
        continue;
      }
      createdClosedAsDuplicate = direct.issue.state === 'closed'
        && String(direct.issue.body || '').includes(marker);
      if (!createdClosedAsDuplicate) continue;
    }

    if (lookup.issues.length === 0) continue;
    const reconciled = await canonicalizeIssues(env, lookup.issues);
    if (reconciled.error) return reconciled;

    // Una seconda lettura verifica che le PATCH siano effettive e che durante la
    // riconciliazione non sia comparso un altro create concorrente.
    const verify = await githubIssues(env, fingerprint);
    if (verify.error) return { error: verify.error };
    if (verify.issues.length === 1) {
      if (verify.issues[0].number === createdNumber || createdClosedAsDuplicate) {
        return { issue: verify.issues[0] };
      }
      const direct = await githubIssue(env, createdNumber);
      if (!direct.error && direct.issue.state === 'closed'
          && String(direct.issue.body || '').includes(marker)) {
        return { issue: verify.issues[0] };
      }
      continue;
    }
    if (verify.issues.length > 1) {
      const secondPass = await canonicalizeIssues(env, verify.issues);
      if (secondPass.error) return secondPass;
      continue;
    }
  }
  return { error: lastError || 'github_reconcile_incomplete' };
}

async function handleIssue(data, env) {
  if (!checkKey(data, env)) {
    return jsonResp(401, { ok: false, error: 'bad_key' });
  }

  const title = redactText(String(data.title || '')).slice(0, MAX_TITLE);
  const rawBody = redactText(String(data.body || '')).slice(0, MAX_BODY - 160);
  const phase = redactText(String(data.phase || '')).replace(/[^a-zA-Z0-9_:-]/g, '').slice(0, 80);
  if (!title) return jsonResp(400, { ok: false, error: 'missing_title' });
  if (!rawBody) return jsonResp(400, { ok: false, error: 'missing_body' });

  if (!env.ISSUE_TOKEN) {
    return jsonResp(500, { ok: false, error: 'receiver_not_configured' });
  }

  // I client nuovi inviano una fingerprint opaca. Per i client vecchi la si deriva
  // da titolo+fase: non è precisa quanto quella del client, ma impedisce che un ACK
  // perso riapra la stessa segnalazione a ogni avvio.
  const supplied = String(data.fingerprint || '').toLowerCase();
  const fingerprint = ISSUE_FINGERPRINT_RE.test(supplied)
    ? supplied
    : await sha256Hex(`issue-legacy-v1|${title}|${phase}`);

  const lookup = await githubIssues(env, fingerprint);
  if (lookup.error) return jsonResp(502, { ok: false, error: lookup.error });
  if (lookup.issues.length > 0) {
    // KEY è deliberatamente pubblica: prova compatibilità col client, non identità.
    // Perciò un match è soltanto un ACK idempotente. Titolo, corpo e contatore della
    // issue canonica non vengono mai riscritti con dati controllati dal chiamante.
    const reconciled = await canonicalizeIssues(env, lookup.issues);
    if (reconciled.error) {
      return jsonResp(502, { ok: false, error: reconciled.error, detail: reconciled.detail });
    }
    return jsonResp(200, {
      ok: true,
      url: reconciled.issue.html_url,
      deduplicated: true,
      occurrenceCount: occurrenceIn(reconciled.issue.body),
    });
  }

  // Il marker di conteggio nasce dal server. Il numero dichiarato dal client non è
  // autorità: con una chiave pubblica potrebbe essere gonfiato per bloccare aggiornamenti.
  const body = decoratedIssueBody(rawBody, fingerprint, 1);
  let response = await createIssue(env, title, body, true);
  if (response.status === 422) response = await createIssue(env, title, body, false);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    return jsonResp(502, {
      ok: false,
      error: githubFailure(response),
      detail: detail.slice(0, 200),
    });
  }
  const created = await response.json();

  // GitHub è anche l'indice idempotente. Dopo un create si attende la consistenza
  // del listing, si sceglie sempre il numero più basso e si verifica ogni chiusura.
  // Finché la riconciliazione non è provata si restituisce errore: il client conserva
  // l'outbox e il retry ritrova la issue già creata invece di inventare successo.
  const canonical = await waitForCanonicalIssue(env, fingerprint, created.number);
  if (canonical.error) {
    return jsonResp(502, {
      ok: false,
      error: canonical.error,
      detail: canonical.detail,
    });
  }
  return jsonResp(200, {
    ok: true,
    url: canonical.issue.html_url,
    deduplicated: canonical.issue.number !== created.number,
    occurrenceCount: occurrenceIn(canonical.issue.body),
  });
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

// --- Metrics (privacy-safe aggregates only) --------------------------------

function sanitizeMetricsPayload(data) {
  if (!data || typeof data !== 'object') return null;
  const byPhase = {};
  const src = data.byPhase && typeof data.byPhase === 'object' ? data.byPhase : {};
  let total = 0;
  for (const [k, v] of Object.entries(src)) {
    const phase = String(k).slice(0, 64).replace(/[^a-zA-Z0-9_:-]/g, '');
    const n = Math.max(0, Math.min(100000, Math.floor(Number(v) || 0)));
    if (!phase || n === 0) continue;
    // Scarta se sembra PII (CF ecc.)
    if (looksLikePii(phase)) continue;
    byPhase[phase] = n;
    total += n;
  }
  if (total === 0 && !(data.total > 0)) return null;
  const storeTag = data.storeTag
    ? String(data.storeTag).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
    : null;
  return {
    event: 'metrics_batch',
    hours: Math.max(1, Math.min(720, Math.floor(Number(data.hours) || 168))),
    total: Math.max(total, Math.floor(Number(data.total) || 0)),
    byPhase,
    storeTag,
  };
}

async function handleMetrics(data, env) {
  if (!checkKey(data, env)) {
    return jsonResp(401, { ok: false, error: 'bad_key' });
  }
  const clean = sanitizeMetricsPayload(data);
  if (!clean) {
    return jsonResp(400, { ok: false, error: 'no_valid_metrics' });
  }
  // Nessuna persistenza GitHub: solo ack. Eventuale analytics lato CF Logs.
  // Non loggare storeTag se assente; mai body grezzo con possibili leak.
  return jsonResp(200, {
    ok: true,
    accepted: true,
    total: clean.total,
    phases: Object.keys(clean.byPhase).length,
  });
}

// --- Diagnostica (privacy-safe: solo versione + errorClass, MAI PII) --------
// Canale silenzioso per la salute della flotta: NON apre issue, NON persiste.
// Fa solo un console.log compatto (visibile con `wrangler tail` / dashboard CF).
// Serve a sapere quale VERSIONE gira su ogni store e quali errorClass capitano.

function diagSlug(value, max) {
  return String(value == null ? '' : value).replace(/[^a-zA-Z0-9_.:+-]/g, '').slice(0, max);
}

function handleDiag(data, env) {
  if (!checkKey(data, env)) {
    return jsonResp(401, { ok: false, error: 'bad_key' });
  }
  // Difesa extra: se un campo somiglia a PII (CF/autologin/token) lo azzera.
  const safe = (v) => (looksLikePii(v) ? '' : v);
  const line = {
    t: 'diag',
    event: diagSlug(data.event, 32) || 'diag',
    version: safe(diagSlug(data.version, 40)),
    errorClass: safe(diagSlug(data.errorClass, 64)),
    store: safe(diagSlug(data.storeTag, 32)),
    phase: safe(diagSlug(data.phase, 48)),
    at: new Date().toISOString(),
  };
  // Solo log: niente persistenza GitHub, niente issue. Il maintainer legge i
  // log del Worker (wrangler tail / dashboard). Zero rumore.
  console.log('[diag] ' + JSON.stringify(line));
  return jsonResp(200, { ok: true, accepted: true });
}

// --- Rate limit (in-memory per isolate; best-effort) -------------------------
// Target: ~10/min /answers, ~5/min /report, ~20/min /metrics.
// Su CF multi-isolate non è globale: affiancare WAF rules in dashboard (8.5).
const _rateBuckets = new Map();

function rateLimitOk(route, maxPerMin) {
  const now = Date.now();
  const windowMs = 60 * 1000;
  let b = _rateBuckets.get(route);
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 };
    _rateBuckets.set(route, b);
  }
  b.n += 1;
  return b.n <= maxPerMin;
}

// --- Router ----------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (request.method === 'POST' && (path === '/answers')) {
      if (!rateLimitOk('answers', 10)) {
        return jsonResp(429, { ok: false, error: 'rate_limited' });
      }
      let data;
      try { data = await request.json(); }
      catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }
      return handleAnswers(data, env);
    }

    if (request.method === 'POST' && (path === '/metrics')) {
      if (!rateLimitOk('metrics', 20)) {
        return jsonResp(429, { ok: false, error: 'rate_limited' });
      }
      let data;
      try { data = await request.json(); }
      catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }
      return handleMetrics(data, env);
    }

    if (request.method === 'POST' && (path === '/diag')) {
      if (!rateLimitOk('diag', 30)) {
        return jsonResp(429, { ok: false, error: 'rate_limited' });
      }
      let data;
      try { data = await request.json(); }
      catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }
      return handleDiag(data, env);
    }

    if (request.method === 'POST' && (path === '/' || path === '/report')) {
      if (!rateLimitOk('report', 5)) {
        return jsonResp(429, { ok: false, error: 'rate_limited' });
      }
      let data;
      try { data = await request.json(); }
      catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }
      return handleIssue(data, env);
    }

    if (request.method === 'GET' && path === '/') {
      return jsonResp(200, {
        ok: true,
        service: 'gsdcampus-autoplay-receiver',
        routes: ['POST /report', 'POST /answers', 'POST /metrics', 'POST /diag'],
      });
    }

    return jsonResp(405, { ok: false, error: 'method_not_allowed' });
  }
};
