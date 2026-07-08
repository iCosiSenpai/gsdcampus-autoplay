#!/usr/bin/env node
/**
 * issue-report.js — segnalazione opt-in di bug al maintainer via issue GitHub.
 *
 * Strumento per l'AI supervisore. Quando l'AI NON riesce a risolvere in loco un
 * problema codice/infra (crash_loop, session_unstable, post_login_blocked,
 * autologin_invalid confermato dalla sonda, fatal, o need_help non risolvibile
 * con banca + WebSearch), invece di modificare src/scripts (vietato dal "Limiti"
 * di CLAUDE.md) apre un'issue sulla repo pubblica del maintainer
 * (iCosiSenpai/gsdcampus-autoplay).
 *
 * PRIVACY — la repo è PUBBLICA: il body non deve MAI contenere CF, autologin URL,
 * cookie, token o username Mac. redactText() redae automaticamente; l'AI deve
 * però verificare il draft prima di confermare l'invio.
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
 *       spedisce ESATTAMENTE ciò che è stato revisionato). Gate opt-in:
 *       config.json deve avere reportIssues=true + issueReporterToken (fine-grained
 *       PAT, scope issues:write, solo iCosiSenpai/gsdcampus-autoplay). Apre l'issue
 *       con `GH_TOKEN=<token> gh issue create` (label `auto-report` se esiste,
 *       altrimenti senza). Stampa l'URL. Refusa senza spawnare `gh` se il gate
 *       non è soddisfatto.
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

function cmdSend() {
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
  if (cfg.reportIssues !== true) {
    console.log('Segnalazione non attivata (reportIssues=false in config.json). Per attivarla: ./scripts/setup.sh oppure imposta reportIssues:true + issueReporterToken in config.json.');
    process.exit(0);
  }
  const token = cfg.issueReporterToken ? String(cfg.issueReporterToken).trim() : '';
  if (!token) {
    console.log('Segnalazione attivata ma issueReporterToken mancante in config.json. Genera un fine-grained PAT (Issues: Read and write, solo ' + REPO + ') in UI GitHub e incollalo in config.json.');
    process.exit(0);
  }
  if (!ghAvailable()) {
    console.log('gh non installato. Installalo con: ./scripts/setup.sh (oppure: brew install gh).');
    process.exit(0);
  }

  const tmpDir = os.tmpdir();
  const stamp = `${process.pid}-${Date.now()}`;
  const bodyFile = path.join(tmpDir, `issue-body-${stamp}.md`);
  const titleFile = path.join(tmpDir, `issue-title-${stamp}.txt`);
  try {
    fs.writeFileSync(bodyFile, draft.body);
    fs.writeFileSync(titleFile, draft.title);
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
    try { fs.unlinkSync(titleFile); } catch (_) {}
  }
}

module.exports = { redactText };

if (require.main === module) {
  const cmd = process.argv[2];
  if (cmd === 'draft') {
    cmdDraft(process.argv[3], process.argv[4]);
  } else if (cmd === 'send') {
    cmdSend();
  } else {
    console.error('Uso:\n  node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"]\n  node scripts/lib/issue-report.js send');
    process.exit(1);
  }
}