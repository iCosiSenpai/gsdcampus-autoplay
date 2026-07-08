/**
 * issue-receiver.js — receiver server-side per la segnalazione issue di
 * gsdcampus-autoplay (Cloudflare Worker).
 *
 * PROBLEMA: per rendere la segnalazione ATTIVA PER TUTTI gli utenti che
 * installano via curl — senza che il maintainer distribuisca un token a ogni
 * collega — il token GitHub (PAT issues:write) dovrebbe viaggiare nel pacchetto
 * pubblico. MA GitHub push-protection blocca il push di un PAT in una repo
 * pubblica E lo auto-revoca (secret scanning) in pochi minuti → inutilizzabile.
 *
 * SOLUZIONE: il PAT resta SEGRETO lato server (env.ISSUE_TOKEN, impostato con
 * `wrangler secret put ISSUE_TOKEN` — MAI nel repo). Il pacchetto pubblico
 * contiene solo:
 *   • l'endpoint URL di questo Worker (DEFAULT_ISSUE_ENDPOINT in issue-report.js)
 *   • una chiave NON-segreta (env.KEY) che filtra solo i bot più trivial
 * L'AI di ogni collega HTTP-POSTa il draft già redatto; il Worker re-redae
 * (defense-in-depth) e apre l'issue via GitHub REST API. Nessun token sui Mac
 * dei colleghi, nessun account GitHub richiesto, attivo di default per tutti.
 *
 * Sicurezza/abuso: endpoint e KEY sono pubblici (chiunque legga la repo può
 * POSTare). Il volume è naturalmente basso (l'AI mostra il draft e chiede
 * conferma umana prima di spedire). Per blindare ulteriormente lo spam, attiva
 * una Cloudflare Rate Limiting Rule sulla route /report (dashboard → Security →
 * WAF → Rate limiting rules), es. max 5 richieste/minuto per IP.
 *
 * Deploy: vedi ./README.md in questa cartella.
 */

const REPO = 'iCosiSenpai/gsdcampus-autoplay';
const LABEL = 'auto-report';
const MAX_TITLE = 256;
const MAX_BODY = 65536;

// --- Redazione PII (mirror di scripts/lib/issue-report.js) ------------------
// Defense-in-depth: il client redae già, ma re-reghiamo server-side per coprire
// eventuali draft manomessi o client non aggiornati.
const RE_AUTOLOGIN = /https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+/g;
const RE_CF = /[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/g;
const RE_GH_PAT = /github_pat_[A-Za-z0-9_]+/g;
const RE_GH_TOK = /gh[oaprsu]_[A-Za-z0-9]+/g;

function redactText(s) {
  if (s == null) return '';
  return String(s)
    .replace(RE_AUTOLOGIN, '[REDACTED-AUTOLOGIN]')
    .replace(RE_GH_PAT, '[REDACTED-TOKEN]')
    .replace(RE_GH_TOK, '[REDACTED-TOKEN]')
    .replace(RE_CF, '[REDACTED-CF]');
}

function jsonResp(status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function createIssue(env, title, body, withLabel) {
  const payload = { title, body };
  if (withLabel) payload.labels = [LABEL];
  return fetch(`https://api.github.com/repos/${REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.ISSUE_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'gsdcampus-autoplay-issue-receiver'
    },
    body: JSON.stringify(payload)
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return jsonResp(405, { ok: false, error: 'method_not_allowed' });
    }

    let data;
    try { data = await request.json(); }
    catch { return jsonResp(400, { ok: false, error: 'invalid_json' }); }

    // Chiave non-segreta: filtra solo bot trivial. Pubblica nel pacchetto.
    const key = typeof data.key === 'string' ? data.key : '';
    const expectedKey = typeof env.KEY === 'string' ? env.KEY : '';
    if (!expectedKey || key !== expectedKey) {
      return jsonResp(401, { ok: false, error: 'bad_key' });
    }

    const title = redactText(String(data.title || '')).slice(0, MAX_TITLE);
    const body = redactText(String(data.body || '')).slice(0, MAX_BODY);
    if (!title) return jsonResp(400, { ok: false, error: 'missing_title' });
    if (!body) return jsonResp(400, { ok: false, error: 'missing_body' });

    if (!env.ISSUE_TOKEN) {
      return jsonResp(500, { ok: false, error: 'receiver_not_configured' });
    }

    // 1) con label auto-report
    let res = await createIssue(env, title, body, true);
    // 422 = label inesistente (o altri errori di validazione) → retry senza label
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
};