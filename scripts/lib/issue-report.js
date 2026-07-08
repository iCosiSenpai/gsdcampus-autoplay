#!/usr/bin/env node
/**
 * issue-report.js — segnalazione di bug al maintainer via issue GitHub.
 *
 * Strumento per l'AI supervisore. Quando l'AI NON riesce a risolvere in loco un
 * problema codice/infra (crash_loop, session_unstable, post_login_blocked,
 * autologin_invalid confermato dalla sonda, fatal, o need_help non risolvibile
 * con banca + WebSearch), invece di modificare src/scripts (vietato dal "Limiti"
 * di CLAUDE.md) apre un'issue sulla repo pubblica del maintainer
 * (iCosiSenpai/gsdcampus-autoplay).
 *
 * ATTIVO PER TUTTI GLI UTENTI di default. Il PAT GitHub NON sta nel pacchetto
 * pubblico (GitHub push-protection blocca il push + auto-revoca i PAT leakati):
 * sta in un receiver server-side (Cloudflare Worker, vedi worker/README.md) come
 * secret. Il pacchetto pubblico contiene solo l'endpoint URL + una chiave NON
 * segreta (DEFAULT_ISSUE_ENDPOINT / DEFAULT_ISSUE_KEY). `send` HTTP-POSTa il
 * draft sanitizzato al receiver, che apre l'issue. Nessun token sui Mac dei
 * colleghi, nessun account GitHub richiesto.
 *
 * Fallback (maintainer): se issueEndpoint non è configurato MA config.json ha
 * issueReporterToken (fine-grained PAT issues:write), `send` usa il path locale
 * `GH_TOKEN=<token> gh issue create`. Comodo sul Mac del maintainer se il
 * receiver non è ancora deployato o è down.
 *
 * PRIVACY — la repo è PUBBLICA: il body non deve MAI contenere CF, autologin URL,
 * cookie, token o username Mac. redactText() redae automaticamente; il receiver
 * re-redae (defense-in-depth); l'AI deve però verificare il draft prima di
 * confermare l'invio.
 *
 * Comandi:
 *   node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"]
 *       Raccoglie contesto (logs/status.json + tail logs/autoplay.log + git HEAD),
 *       redae, stampa il draft (title + body) e lo salva in
 *       data/accounts/<CF>/.issue_draft.json. NON spedice. L'AI mostra il draft
 *       all'utente/collega, chiede conferma esplicita, poi chiama `send`.
 *
 *   node scripts/lib/issue-report.js send
 *       Legge .issue_draft.json (rifiuta se mancante o stale >10min, così si
 *       spedisce ESATTAMENTE ciò che è stato revisionato). Gate:
 *       config.json con reportIssues:false → refusa (default attivo). Path
 *       primario: HTTP POST al receiver (issueEndpoint/issueReportKey, o i
 *       DEFAULT_* committati). Fallback: issueReporterToken + `gh` locale.
 *       Stampa l'URL. Refusa senza side-effect se non configurato.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { readJsonSafe } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'io'));
const account = require(path.join(__dirname, '..', '..', 'src', 'lib', 'account'));

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'iCosiSenpai/gsdcampus-autoplay';
const LABEL = 'auto-report';
const LOG_TAIL_LINES = 40;
const DRAFT_STALE_MS = 10 * 60 * 1000; // 10 min

// --- Receiver server-side (attivo per tutti) -------------------------------
// Il PAT GitHub sta nel Worker come secret (env.ISSUE_TOKEN), NON qui. Il
// pacchetto pubblico contiene solo l'endpoint + una chiave non-segreta.
// DEFAULT_ISSUE_ENDPOINT = '' finché il maintainer non deploya il Worker e
// committa l'URL (vedi worker/README.md). Finché è vuoto, i colleghi senza
// issueReporterToken non possono spedire (refusa graceful); il maintainer può
// usare il fallback locale col suo token in config.json.
const DEFAULT_ISSUE_ENDPOINT = ''; // TODO maintainer: incolla l'URL del Worker dopo `wrangler deploy`
const DEFAULT_ISSUE_KEY = 'gsd-autoplay-report-key-2026-7f3a9c'; // non-segreta, allineata a worker/wrangler.toml

// --- Redazione PII ---------------------------------------------------------
// Ordine importante: prima l'URL autologin (contiene CF + token), poi i token
// GitHub, poi il CF (neutralizza anche i path data/accounts/<CF>/...), poi ANSI
// e infine la home dir (username Mac).

const RE_AUTOLOGIN = /https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+/g;
const RE_CF = /[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/g;
const RE_GH_PAT = /github_pat_[A-Za-z0-9_]+/g;
const RE_GH_TOK = /gh[oaprsu]_[A-Za-z0-9]+/g;
const RE_ANSI = /\x1b\[[0-9;]*m/g;
const RE_HOME_REPO = /\/Users\/[^/]+\/gsdcampus-autoplay/g;
const RE_HOME = /\/Users\/[^/]+\//g;

/** Pipeline di redazione. Esportata per test. */
function redactText(s) {
  if (s == null) return '';
  return String(s)
    .replace(RE_AUTOLOGIN, '[REDACTED-AUTOLOGIN]')
    .replace(RE_GH_PAT, '[REDACTED-TOKEN]')
    .replace(RE_GH_TOK, '[REDACTED-TOKEN]')
    .replace(RE_CF, '[REDACTED-CF]')
    .replace(RE_ANSI, '')
    .replace(RE_HOME_REPO, '~/gsdcampus-autoplay')
    .replace(RE_HOME, '~/');
}

// --- Helper contesto -------------------------------------------------------

function readTail(file, n) {
  try {
    const data = fs.readFileSync(file, 'utf8');
    const lines = data.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).join('\n');
  } catch (e) {
    return null;
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch (e) {
    return '(git non disponibile)';
  }
}

function draftPath() {
  const paths = account.stateFilePaths(ROOT);
  return path.join(paths.accountDir, '.issue_draft.json');
}

function gatherContext(phase, reasonArg) {
  const status = readJsonSafe(path.join(ROOT, 'logs', 'status.json'), {});
  const reason = reasonArg || (status.lastError ? String(status.lastError) : '');
  return {
    phase,
    reason,
    logTail: readTail(path.join(ROOT, 'logs', 'autoplay.log'), LOG_TAIL_LINES) || '(log non disponibile)',
    summary: status.courseStateSummary || null,
    lastQuiz: status.lastQuizResult || null,
    lastUpdate: status.lastUpdate || null,
    head: gitHead(),
    osPlatform: os.platform(),
    nodeVersion: process.version
  };
}

function buildDraft(ctx) {
  const shortReason = redactText(ctx.reason || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const title = `[auto-report] ${ctx.phase}${shortReason ? ': ' + shortReason : ''}`;
  const L = [];
  L.push('## Fase', '`' + ctx.phase + '`', '');
  L.push('## Sintomo', redactText(ctx.reason || '(nessun messaggio di errore)').trim() || '(nessun messaggio)', '');
  L.push('## Stato corsi', ctx.summary ? redactText(JSON.stringify(ctx.summary)) : '(non disponibile)');
  if (ctx.lastQuiz) L.push('', 'Ultimo quiz: ' + redactText(String(ctx.lastQuiz)));
  L.push('', `## Contesto (ultime ${LOG_TAIL_LINES} righe di logs/autoplay.log, redatte)`, '```', redactText(ctx.logTail), '```', '');
  L.push('## Ambiente',
    '- commit: ' + ctx.head,
    '- OS: ' + ctx.osPlatform,
    '- Node: ' + ctx.nodeVersion, '');
  L.push('---');
  L.push("_Issue generata automaticamente dall'AI supervisore di gsdcampus-autoplay. Dati sensibili (CF, token autologin, cookie, username) redatti._");
  return { title, body: L.join('\n') };
}

// --- Comandi ---------------------------------------------------------------

function cmdDraft(phase, reasonArg) {
  if (!phase) {
    console.error('Uso: node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"]');
    process.exit(1);
  }
  const ctx = gatherContext(phase, reasonArg);
  const draft = buildDraft(ctx);
  const file = draftPath();
  const record = { ...draft, phase: ctx.phase, createdAt: ctx.lastUpdate, savedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(record, null, 2));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    console.error(`Impossibile salvare il draft in ${redactText(file)}: ${e.message}`);
    process.exit(1);
  }
  console.log('=== DRAFT ISSUE (NON ancora spedita) ===');
  console.log('Title: ' + draft.title);
  console.log('');
  console.log('--- Body ---');
  console.log(draft.body);
  console.log('--- Fine body ---');
  console.log('');
  console.log('Draft salvato in: ' + redactText(file));
  console.log('Verifica che NON contenga CF / token autologin / cookie, poi conferma e lancia:');
  console.log('  node scripts/lib/issue-report.js send');
}

function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch (e) {
    return false;
  }
}

/** True solo se la label `auto-report` esiste E è leggibile col token. */
function labelExists(token) {
  try {
    execFileSync('gh', ['api', `repos/${REPO}/labels/${LABEL}`], {
      encoding: 'utf8', env: { ...process.env, GH_TOKEN: token }, stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch (e) {
    return false; // 404, permessi insufficienti, offline → skip label (non bloccante)
  }
}

/** Path primario: HTTP POST al receiver server-side. Nessun token, nessun gh. */
async function postToReceiver(endpoint, key, draft) {
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, title: draft.title, body: draft.body, phase: draft.phase || '' })
    });
  } catch (e) {
    return { error: 'receiver non raggiungibile (' + redactText(e.message || String(e)).slice(0, 200) + '). Verifica connessione e che il Worker sia online (worker/README.md).' };
  }
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = null; }
  if (res.status === 401) return { error: 'Chiave non valida (issueReportKey / DEFAULT_ISSUE_KEY non allineata a worker/wrangler.toml KEY).' };
  if (res.status === 429) return { error: 'Rate limit del receiver raggiunto. Riprova più tardi.' };
  if (res.status === 502 && json && json.error === 'github_token') {
    return { error: 'Il PAT del receiver non è valido o senza scope issues:write. Il maintainer deve ruotare ISSUE_TOKEN nel Worker (wrangler secret put ISSUE_TOKEN).' };
  }
  if (!res.ok) {
    const hint = json && json.error ? json.error : ('HTTP ' + res.status);
    return { error: 'receiver: ' + hint + (json && json.detail ? ' — ' + redactText(String(json.detail)).slice(0, 160) : '') };
  }
  if (!json || !json.url) return { error: 'Risposta receiver non valida: ' + redactText(text).slice(0, 200) };
  return { url: json.url };
}

/** Fallback maintainer: `gh issue create` con GH_TOKEN=<issueReporterToken>. */
function sendViaGh(token, draft, file) {
  if (!ghAvailable()) {
    console.log('gh non installato. Installalo con: brew install gh (oppure ./scripts/setup.sh).');
    process.exit(0);
  }
  const tmpDir = os.tmpdir();
  const stamp = `${process.pid}-${Date.now()}`;
  const bodyFile = path.join(tmpDir, `issue-body-${stamp}.md`);
  try {
    fs.writeFileSync(bodyFile, draft.body);
    const args = ['issue', 'create', '--repo', REPO, '--title', draft.title, '--body-file', bodyFile];
    if (labelExists(token)) args.push('--label', LABEL);
    let out;
    try {
      out = execFileSync('gh', args, {
        encoding: 'utf8',
        env: { ...process.env, GH_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe']
      }).trim();
    } catch (e) {
      const msg = (e.message || '') + '\n' + (e.stderr ? e.stderr.toString() : '');
      if (/\b401\b|\b403\b|FORBIDDEN|UNAUTHORIZED|bad credentials/i.test(msg)) {
        console.log('Token issue-reporter non valido o senza scope issues:write. Ruotalo in UI GitHub (Settings → Developer settings → Fine-grained personal access tokens) e aggiorna issueReporterToken in config.json.');
        process.exit(0);
      }
      console.error('Creazione issue fallita:\n' + redactText(msg));
      process.exit(0);
    }
    try { fs.unlinkSync(file); } catch (_) {}
    console.log('Issue creata: ' + out);
  } finally {
    try { fs.unlinkSync(bodyFile); } catch (_) {}
  }
}

async function cmdSend() {
  const file = draftPath();
  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.log('Nessun draft trovato. Genera prima: node scripts/lib/issue-report.js draft "<phase>"');
    process.exit(0);
  }
  if (!draft || !draft.title || !draft.body) {
    console.log('Draft non valido. Rigenera con: node scripts/lib/issue-report.js draft "<phase>"');
    process.exit(0);
  }
  if (typeof draft.savedAt !== 'number' || Date.now() - draft.savedAt > DRAFT_STALE_MS) {
    console.log('Draft troppo vecchio (>10 min) o senza timestamp. Rigenera con: node scripts/lib/issue-report.js draft "<phase>"');
    process.exit(0);
  }

  const cfg = account.readConfig(ROOT);
  if (cfg.reportIssues === false) {
    console.log('Segnalazione disattivata (reportIssues=false in config.json). Rimuovi/quella chiave o impostala a true per riattivarla.');
    process.exit(0);
  }

  // Path primario: receiver server-side (attivo per tutti, no token per-user).
  const endpoint = String(cfg.issueEndpoint || DEFAULT_ISSUE_ENDPOINT || '').trim();
  const key = String(cfg.issueReportKey || DEFAULT_ISSUE_KEY || '').trim();
  if (endpoint) {
    const r = await postToReceiver(endpoint, key, draft);
    if (r.error) { console.log('Invio issue fallito: ' + r.error); process.exit(0); }
    try { fs.unlinkSync(file); } catch (_) {}
    console.log('Issue creata: ' + r.url);
    process.exit(0);
  }

  // Fallback: token locale + gh (maintainer). I colleghi di solito non ce l'hanno.
  const token = cfg.issueReporterToken ? String(cfg.issueReporterToken).trim() : '';
  if (!token) {
    console.log('Segnalazione non configurata su questo Mac: nessun receiver (issueEndpoint vuoto — il maintainer deve deployare il Worker, vedi worker/README.md) né issueReporterToken in config.json.');
    process.exit(0);
  }
  sendViaGh(token, draft, file);
}

module.exports = { redactText };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'draft') {
    cmdDraft(process.argv[3], process.argv[4]);
  } else if (cmd === 'send') {
    cmdSend().catch(e => { console.error('Errore inatteso in send: ' + redactText(e && e.message ? e.message : String(e))); process.exit(0); });
  } else {
    console.error('Uso:\n  node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"]\n  node scripts/lib/issue-report.js send');
    process.exit(1);
  }
}