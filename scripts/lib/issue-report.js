#!/usr/bin/env node
/**
 * Segnalazione automatica al maintainer, con redazione, diagnostica e deduplica.
 *
 * Comandi pubblici:
 *   draft <phase> [reason]                         prepara una bozza manuale
 *   send                                           invia la bozza manuale
 *   auto <phase> [reason] [fingerprint] [command] [exitCode] [startPhase]
 *                                                  raccoglie e invia atomicamente
 *
 * `auto` è il percorso usato da launcher e app: un solo processo tiene il lock,
 * registra ogni occorrenza, conserva gli errori e passa al receiver una fingerprint
 * idempotente. Nessun errore di invio viene trasformato in exit 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const {
  readJsonSafe,
  writeJsonAtomic,
} = require(path.join(__dirname, '..', '..', 'src', 'lib', 'io'));
const account = require(path.join(__dirname, '..', '..', 'src', 'lib', 'account'));
const courseState = require(path.join(__dirname, '..', '..', 'src', 'lib', 'course-state'));

const ROOT = path.join(__dirname, '..', '..');
const REPO = 'iCosiSenpai/gsdcampus-autoplay';
const LABEL = 'auto-report';
const LOG_TAIL_LINES = 40;
const DRAFT_STALE_MS = 10 * 60 * 1000;
const AUTO_QUIET_MS = 6 * 60 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_WAIT_MS = 5000;
const GH_TIMEOUT_MS = 30000;
const MAX_OUTBOX_DRAIN = 50;
const MAX_REMEMBERED_OBSERVATIONS = 2048;
const STATE_FILE = path.join(ROOT, 'logs', 'issue-report-state.json');
const LOCK_DIR = path.join(ROOT, 'logs', '.issue-report.lock');
const START_LOG = path.join(ROOT, 'logs', 'start.log');
const CANONICAL_ISSUE_RE = /^https:\/\/github\.com\/iCosiSenpai\/gsdcampus-autoplay\/issues\/[1-9][0-9]*$/;

const {
  DEFAULT_ENDPOINT: DEFAULT_ISSUE_ENDPOINT,
  DEFAULT_KEY: DEFAULT_ISSUE_KEY,
} = require('./receiver-config');

// --- Redazione -------------------------------------------------------------

const RE_AUTOLOGIN = /https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+/g;
const RE_CF = /[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]/g;
const RE_GH_PAT = /github_pat_[A-Za-z0-9_]+/g;
const RE_GH_TOK = /gh[oaprsu]_[A-Za-z0-9]+/g;
const RE_ANSI = /\x1b\[[0-9;]*m/g;
const RE_HOME_REPO = /\/Users\/[^/]+\/gsdcampus-autoplay/g;
const RE_HOME = /\/Users\/[^/]+\//g;

function redactText(value) {
  if (value == null) return '';
  return String(value)
    .replace(RE_AUTOLOGIN, '[REDACTED-AUTOLOGIN]')
    .replace(RE_GH_PAT, '[REDACTED-TOKEN]')
    .replace(RE_GH_TOK, '[REDACTED-TOKEN]')
    .replace(RE_CF, '[REDACTED-CF]')
    .replace(RE_ANSI, '')
    .replace(RE_HOME_REPO, '~/gsdcampus-autoplay')
    .replace(RE_HOME, '~/');
}

// --- Log e diagnostica -----------------------------------------------------

const RE_VIDEO_PROGRESS = /\|\s*Video:\s*\d+:\d{2}\s*\/\s*\d+:\d{2}\s*$/;

function collapseProgress(lines) {
  const out = [];
  let run = 0;
  let pending = '';
  const flush = () => {
    if (run === 1) out.push(pending);
    else if (run > 1) out.push(`   … ${run} righe di avanzamento video omesse`);
    run = 0;
  };
  for (const line of lines) {
    if (RE_VIDEO_PROGRESS.test(line)) {
      run++;
      pending = line;
      continue;
    }
    flush();
    out.push(line);
  }
  flush();
  return out;
}

function readTail(file, lines) {
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    if (all.at(-1) === '') all.pop();
    return collapseProgress(all).slice(-lines).join('\n');
  } catch (_) {
    return null;
  }
}

function fileAge(file) {
  try {
    const min = Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
    if (min < 1) return 'adesso';
    if (min < 60) return `${min} min fa`;
    const hours = Math.floor(min / 60);
    return hours < 48 ? `${hours}h fa` : `${Math.floor(hours / 24)} giorni fa`;
  } catch (_) {
    return 'assente';
  }
}

function logSection(title, file, lines) {
  const tail = readTail(file, lines);
  if (!tail) return null;
  return [`### ${title}  _(${fileAge(file)})_`, '```', redactText(tail), '```'].join('\n');
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {
    return '(git non disponibile)';
  }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

/** Ricava la sottofase dal testo reale di start.sh, non dal nome generico del reporter. */
function inferStartPhase(text) {
  const clean = redactText(text).toLowerCase();
  const checks = [
    ['answer_bank_verify', /banca risposte|answers-cli|verify|reconcile|audit/],
    ['requirements', /requisiti|check-requirements|setup\.sh/],
    ['previous_instance', /istanza attiva|automazione precedente|pid file|non riesco a fermare/],
    ['lock_acquire', /acquisire il lock|avvio concorrente/],
    ['lock_promote', /lock identità|lock identita/],
    ['scheduler_spawn', /avvio scheduler|scheduler avviato|avvio fallito/],
    ['configuration', /config\.json|configurazione/],
  ];
  // Vince l'ultimo segnale nel trascritto: è la fase raggiunta più tardi.
  let winner = '';
  let position = -1;
  for (const [name, pattern] of checks) {
    const matches = [...clean.matchAll(new RegExp(pattern.source, pattern.flags + (pattern.flags.includes('g') ? '' : 'g')))];
    const at = matches.length ? matches.at(-1).index : -1;
    if (at > position) {
      position = at;
      winner = name;
    }
  }
  return winner || null;
}

function safeCommand(value) {
  const command = String(value || '').trim();
  return /^\.\/start\.sh(?: --ignore-hours)?$/.test(command) ? command : '';
}

function safeExitCode(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255 ? parsed : null;
}

function currentCourseSummary(status) {
  try {
    const state = courseState.readState(ROOT);
    if (state && Object.keys(state).length > 0) return courseState.summarize(state);
  } catch (_) {
    // Lo stato live è preferibile; il fossile status resta un fallback esplicito.
  }
  return status.courseStateSummary || null;
}

function draftPath() {
  return path.join(account.stateFilePaths(ROOT).accountDir, '.issue_draft.json');
}

function autoOutboxDir() {
  return path.join(account.stateFilePaths(ROOT).accountDir, '.issue_outbox');
}

function allAutoOutboxDirs() {
  const dirs = new Set([autoOutboxDir()]);
  const accountsRoot = path.join(ROOT, 'data', 'accounts');
  try {
    for (const entry of fs.readdirSync(accountsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(accountsRoot, entry.name, '.issue_outbox');
      if (fs.existsSync(candidate)) dirs.add(candidate);
    }
  } catch (_) {}
  return [...dirs].sort();
}

function autoDraftPath(fingerprint, observationId, outboxDir = autoOutboxDir()) {
  return path.join(outboxDir, `${fingerprint}.${observationId}.json`);
}

function memberTag(cf) {
  const clean = String(cf || '').trim().toUpperCase();
  if (!clean) return '';
  return 'mac-' + crypto.createHash('sha256').update(clean).digest('hex').slice(0, 6);
}

function accountTagOf(cfg) {
  const cf = cfg && (cfg.codice_fiscale || cfg.codiceFiscale);
  const clean = String(cf || '').trim().toUpperCase();
  if (!clean) return '';
  return crypto.createHash('sha256').update(`account-v1|${clean}`).digest('hex');
}

function storeTagOf(cfg) {
  const explicit = String((cfg && cfg.storeTag) || '')
    .replace(/[^a-zA-Z0-9_.:+-]/g, '')
    .slice(0, 32);
  return explicit || memberTag(cfg && (cfg.codice_fiscale || cfg.codiceFiscale));
}

function gatherContext(phase, reasonArg, executionArg = {}) {
  const status = readJsonSafe(path.join(ROOT, 'logs', 'status.json'), {});
  const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {}, { warn: false }) || {};
  const isStartFailure = phase === 'scheduler_start_failed';
  const startTranscript = isStartFailure ? readText(START_LOG) : '';
  const reason = reasonArg || (status.lastError ? String(status.lastError) : '');
  const execution = isStartFailure ? {
    command: safeCommand(executionArg.command),
    exitCode: safeExitCode(executionArg.exitCode),
    startPhase: String(executionArg.startPhase || '').trim()
      || inferStartPhase(startTranscript),
  } : {
    command: '',
    exitCode: null,
    startPhase: '',
  };
  return {
    phase,
    reason,
    storeTag: storeTagOf(cfg),
    // Solo materiale per la fingerprint: non viene mai mostrato nel draft.
    // `storeTag` identifica il Mac/negozio e non basta a separare due membri.
    accountTag: accountTagOf(cfg),
    execution,
    logSections: [
      isStartFailure
        ? logSection('logs/start.log — trascritto completo dell’avvio', START_LOG, 60)
        : null,
      logSection(`logs/autoplay.log — ultime ${LOG_TAIL_LINES} righe`, path.join(ROOT, 'logs', 'autoplay.log'), LOG_TAIL_LINES),
      logSection('logs/autoplay.out — output del processo scheduler', path.join(ROOT, 'logs', 'autoplay.out'), 25),
      logSection('logs/scheduler.log — decisioni dello scheduler', path.join(ROOT, 'logs', 'scheduler.log'), 15),
    ].filter(Boolean),
    summary: currentCourseSummary(status),
    lastQuiz: status.lastQuizResult || null,
    lastUpdate: status.lastUpdate || null,
    head: gitHead(),
    osPlatform: os.platform(),
    nodeVersion: process.version,
  };
}

function normalizeFingerprintText(value) {
  return redactText(value)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?z\b/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}\b/g, '<time>')
    .replace(/\bpid\s*[:=#]?\s*\d+\b/g, 'pid:<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

function deriveFingerprint(ctx, supplied = '') {
  const stableCause = supplied || [
    ctx.phase,
    ctx.execution && ctx.execution.startPhase,
    ctx.execution && ctx.execution.command,
    ctx.execution && ctx.execution.exitCode,
    normalizeFingerprintText(ctx.reason),
  ].filter((part) => part !== '' && part != null).join('|');
  const accountScope = ctx.accountTag || ctx.storeTag || 'unknown';
  return crypto.createHash('sha256')
    .update(`issue-v3|${accountScope}|${ctx.phase}|${stableCause}`)
    .digest('hex');
}

function buildDraft(ctx, metadata = {}) {
  const shortReason = redactText(ctx.reason || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const store = redactText(ctx.storeTag || '');
  const title = `[auto-report]${store ? ` [${store}]` : ''} ${ctx.phase}${shortReason ? `: ${shortReason}` : ''}`;
  const lines = [];
  lines.push('## Fase', `\`${ctx.phase}\``, '');
  lines.push('## Sintomo', redactText(ctx.reason || '(nessun messaggio di errore)').trim() || '(nessun messaggio)', '');
  if (ctx.execution && (ctx.execution.command || ctx.execution.exitCode != null || ctx.execution.startPhase)) {
    lines.push('## Esecuzione');
    if (ctx.execution.command) lines.push(`- comando: \`${ctx.execution.command}\``);
    if (ctx.execution.exitCode != null) lines.push(`- exit code: \`${ctx.execution.exitCode}\``);
    if (ctx.execution.startPhase) lines.push(`- sottofase: \`${redactText(ctx.execution.startPhase)}\``);
    lines.push('');
  }
  if (metadata.occurrenceCount) {
    lines.push('## Persistenza', `Occorrenze osservate su questo Mac: **${metadata.occurrenceCount}**.`, '');
  }
  lines.push('## Stato corsi', ctx.summary ? redactText(JSON.stringify(ctx.summary)) : '(non disponibile)');
  if (ctx.lastQuiz) lines.push('', `Ultimo quiz: ${redactText(String(ctx.lastQuiz))}`);
  lines.push('', '## Contesto (log redatti)', '');
  lines.push(ctx.logSections && ctx.logSections.length
    ? ctx.logSections.join('\n\n')
    : '(nessun log disponibile)', '');
  lines.push(
    '## Ambiente',
    '- store: ' + (store || '(ignoto: né storeTag né account configurati)')
      + (store && store.startsWith('mac-')
        ? `  ← risolvi con \`node scripts/lib/members-cli.js whois ${store}\``
        : ''),
    `- commit: ${ctx.head}`,
    `- OS: ${ctx.osPlatform}`,
    `- Node: ${ctx.nodeVersion}`,
    '',
    '---',
    "_Issue generata automaticamente dal supervisore di gsdcampus-autoplay. Dati sensibili (CF, token autologin, cookie, username) redatti._"
  );
  return { title, body: lines.join('\n') };
}

// --- Stato, lock e outbox --------------------------------------------------

function readIssueState() {
  const state = readJsonSafe(STATE_FILE, { version: 1, reports: {} }, { warn: false });
  if (!state || typeof state !== 'object') return { version: 1, reports: {} };
  if (!state.reports || typeof state.reports !== 'object') state.reports = {};
  state.version = 1;
  return state;
}

function writeIssueState(state) {
  try {
    writeJsonAtomic(STATE_FILE, state);
    return null;
  } catch (error) {
    return redactText(error.message || String(error)).slice(0, 300);
  }
}

function saveDraft(file, record) {
  try {
    writeJsonAtomic(file, record);
    return null;
  } catch (error) {
    return redactText(error.message || String(error)).slice(0, 300);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockOwner() {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOCK_DIR, 'owner.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function acquireReportLock() {
  fs.mkdirSync(path.dirname(LOCK_DIR), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(
        path.join(LOCK_DIR, 'owner.json'),
        JSON.stringify({ pid: process.pid, at: Date.now() })
      );
      return () => {
        try {
          const owner = lockOwner();
          if (owner && owner.pid === process.pid) {
            fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          }
        } catch (_) {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = lockOwner();
        const age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
        // Un lock di un processo vivo non si ruba mai. Un proprietario morto si
        // rimuove subito; un lock senza owner soltanto dopo la soglia di sicurezza.
        if ((owner && !processIsAlive(owner.pid)) || (!owner && age > LOCK_STALE_MS)) {
          fs.rmSync(LOCK_DIR, { recursive: true, force: true });
          continue;
        }
      } catch (_) {}
      await sleep(100);
    }
  }
  throw new Error('un altro invio issue tiene il lock; il payload resta nell’outbox');
}

function outboxFiles(outboxDir) {
  try {
    return fs.readdirSync(outboxDir)
      .filter((name) => /^[a-f0-9]{64}(?:\.[a-f0-9-]{36})?\.json$/.test(name))
      .map((name) => path.join(outboxDir, name))
      .sort()
      .slice(0, MAX_OUTBOX_DRAIN);
  } catch (_) {
    return [];
  }
}

function readOutboxRecord(file) {
  try {
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!record || !/^[a-f0-9]{64}$/.test(String(record.fingerprint || ''))) return null;
    if (!record.title || !record.body) return null;
    return record;
  } catch (_) {
    return null;
  }
}

// --- Trasporto -------------------------------------------------------------

function canonicalIssueURL(value) {
  const text = String(value || '').trim();
  return CANONICAL_ISSUE_RE.test(text) ? text : null;
}

function ghAvailable() {
  try {
    execFileSync('gh', ['--version'], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

function labelExists(token) {
  try {
    execFileSync('gh', ['api', `repos/${REPO}/labels/${LABEL}`], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function postToReceiver(endpoint, key, draft) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key,
        title: draft.title,
        body: draft.body,
        phase: draft.phase || '',
        fingerprint: draft.fingerprint || '',
        occurrenceCount: draft.occurrenceCount || 1,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    return { error: `receiver non raggiungibile (${redactText(error.message || String(error)).slice(0, 200)})` };
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  if (response.status === 401) return { error: 'chiave del receiver non valida' };
  if (response.status === 429) return { error: 'rate limit del receiver raggiunto' };
  if (response.status === 502 && json && json.error === 'github_token') {
    return { error: 'PAT del receiver non valido o senza scope issues:write' };
  }
  if (!response.ok) {
    const hint = json && json.error ? json.error : `HTTP ${response.status}`;
    const detail = json && json.detail ? ` — ${redactText(String(json.detail)).slice(0, 160)}` : '';
    return { error: `receiver: ${hint}${detail}` };
  }
  const url = json && json.ok === true ? canonicalIssueURL(json.url) : null;
  if (!url) return { error: `risposta receiver non valida: ${redactText(text).slice(0, 200)}` };
  return { url, deduplicated: json.deduplicated === true };
}

function transportBody(draft) {
  if (!draft.fingerprint) return draft.body;
  const count = Math.max(1, Number(draft.occurrenceCount) || 1);
  return `${draft.body}\n\n<!-- gsd-auto-fingerprint:${draft.fingerprint} -->\n<!-- gsd-auto-occurrences:${count} -->`;
}

function findIssueViaGh(token, fingerprint) {
  if (!fingerprint) return { url: null };
  try {
    const output = execFileSync('gh', [
      'issue', 'list', '--repo', REPO, '--state', 'open', '--limit', '1000',
      '--json', 'url,body',
    ], {
      encoding: 'utf8',
      timeout: GH_TIMEOUT_MS,
      env: { ...process.env, GH_TOKEN: token },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const marker = `<!-- gsd-auto-fingerprint:${fingerprint} -->`;
    const match = JSON.parse(output).find((issue) => String(issue.body || '').includes(marker));
    return { url: match ? canonicalIssueURL(match.url) : null };
  } catch (error) {
    const message = `${error.message || ''}\n${error.stderr ? error.stderr.toString() : ''}`;
    return { error: `riconciliazione issue via gh fallita: ${redactText(message).slice(-500)}` };
  }
}

function sendViaGh(token, draft) {
  if (!ghAvailable()) return { error: 'gh non installato; esegui brew install gh o ./scripts/setup.sh' };

  // Prima di creare si cerca il marker remoto. Copre il caso in cui GitHub abbia
  // creato la issue ma il processo sia morto prima di salvare lo stato locale.
  const existing = findIssueViaGh(token, draft.fingerprint);
  if (existing.error) return existing;
  if (existing.url) return { url: existing.url, deduplicated: true };

  const bodyFile = path.join(os.tmpdir(), `issue-body-${process.pid}-${Date.now()}.md`);
  try {
    fs.writeFileSync(bodyFile, transportBody(draft));
    const args = ['issue', 'create', '--repo', REPO, '--title', draft.title, '--body-file', bodyFile];
    if (labelExists(token)) args.push('--label', LABEL);
    try {
      const rawURL = execFileSync('gh', args, {
        encoding: 'utf8',
        timeout: GH_TIMEOUT_MS,
        env: { ...process.env, GH_TOKEN: token },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      const url = canonicalIssueURL(rawURL);
      if (!url) return { error: `risposta gh non valida: ${redactText(rawURL).slice(0, 200)}` };
      return { url, deduplicated: false };
    } catch (error) {
      const message = `${error.message || ''}\n${error.stderr ? error.stderr.toString() : ''}`;
      if (/\b401\b|\b403\b|forbidden|unauthorized|bad credentials/i.test(message)) {
        return { error: 'token issue-reporter non valido o senza scope issues:write' };
      }
      return { error: `creazione issue via gh fallita: ${redactText(message).slice(-500)}` };
    }
  } finally {
    try { fs.unlinkSync(bodyFile); } catch (_) {}
  }
}

async function sendDraft(draft) {
  const cfg = account.readConfig(ROOT);
  if (cfg.reportIssues === false) return { disabled: true, error: 'segnalazione disattivata (reportIssues=false)' };

  const endpoint = String(cfg.issueEndpoint || DEFAULT_ISSUE_ENDPOINT || '').trim();
  const key = String(cfg.issueReportKey || DEFAULT_ISSUE_KEY || '').trim();
  const token = cfg.issueReporterToken ? String(cfg.issueReporterToken).trim() : '';
  if (endpoint) {
    const receiver = await postToReceiver(endpoint, key, draft);
    if (receiver.url || !token) return receiver;

    // Sul Mac del maintainer il PAT locale è il secondo canale, non una
    // configurazione morta. Il lookup per fingerprint precede sempre il create,
    // quindi anche un ACK perso dal receiver non genera un duplicato nel fallback.
    const fallback = sendViaGh(token, draft);
    if (fallback.url) return fallback;
    return {
      error: `${receiver.error || 'receiver fallito'}; fallback gh: ${fallback.error || 'errore sconosciuto'}`,
    };
  }

  return token
    ? sendViaGh(token, draft)
    : { error: 'nessun receiver e nessun issueReporterToken configurato' };
}

// --- Comandi ---------------------------------------------------------------

function cmdDraft(phase, reasonArg) {
  if (!phase) {
    console.error('Uso: node scripts/lib/issue-report.js draft "<phase>" ["<short-reason>"]');
    return 1;
  }
  const ctx = gatherContext(phase, reasonArg);
  const fingerprint = deriveFingerprint(ctx);
  const draft = buildDraft(ctx, { occurrenceCount: 1 });
  const file = draftPath();
  const record = {
    ...draft,
    phase: ctx.phase,
    fingerprint,
    occurrenceCount: 1,
    createdAt: ctx.lastUpdate,
    savedAt: Date.now(),
  };
  const error = saveDraft(file, record);
  if (error) {
    console.error(`Impossibile salvare il draft in ${redactText(file)}: ${error}`);
    return 1;
  }
  console.log('=== DRAFT ISSUE (NON ancora spedita) ===');
  console.log(`Title: ${draft.title}\n\n--- Body ---\n${draft.body}\n--- Fine body ---`);
  console.log(`\nDraft salvato in: ${redactText(file)}`);
  return 0;
}

async function cmdSend() {
  const file = draftPath();
  let draft;
  try { draft = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) {
    console.error('Nessun draft trovato. Genera prima il comando draft.');
    return 2;
  }
  if (!draft || !draft.title || !draft.body) {
    console.error('Draft non valido. Rigeneralo.');
    return 2;
  }
  if (typeof draft.savedAt !== 'number' || Date.now() - draft.savedAt > DRAFT_STALE_MS) {
    console.error('Draft troppo vecchio (>10 min) o senza timestamp. Rigeneralo.');
    return 2;
  }
  const result = await sendDraft(draft);
  if (!result.url) {
    console.error(`Invio issue fallito: ${result.error || 'errore sconosciuto'}`);
    return result.disabled ? 2 : 3;
  }
  try { fs.unlinkSync(file); } catch (_) {}
  console.log(`${result.deduplicated ? 'Issue già segnalata' : 'Issue creata'}: ${result.url}`);
  return 0;
}

function contextForOutbox(ctx) {
  return {
    ...ctx,
    reason: redactText(ctx.reason),
    logSections: (ctx.logSections || []).map(redactText),
  };
}

function removeOutboxFile(file) {
  try { fs.unlinkSync(file); } catch (_) {}
}

async function drainIssueOutbox(outboxDir, currentObservationId = null, currentFingerprint = null) {
  const files = outboxFiles(outboxDir);
  const state = readIssueState();
  let currentOutcome = null;
  let firstFailure = null;

  for (const file of files) {
    const record = readOutboxRecord(file);
    if (!record) {
      const failure = { code: 3, error: `payload outbox non valido: ${redactText(file)}` };
      if (currentFingerprint && path.basename(file).startsWith(`${currentFingerprint}.`)) {
        currentOutcome = failure;
      }
      firstFailure ||= failure;
      console.error(`Coda issue ancora pendente: ${failure.error}`);
      continue;
    }

    const fingerprint = record.fingerprint;
    const observationID = String(record.observationId || `${fingerprint}:${record.savedAt || 0}`);
    const isCurrent = currentObservationId
      ? observationID === currentObservationId
      : fingerprint === currentFingerprint;
    const previous = state.reports[fingerprint] || {};
    const rememberedObservations = Array.isArray(previous.observationIds)
      ? previous.observationIds.filter((id) => typeof id === 'string').slice(-MAX_REMEMBERED_OBSERVATIONS)
      : (previous.lastObservationId ? [String(previous.lastObservationId)] : []);
    const isNewObservation = !rememberedObservations.includes(observationID);
    const pendingOccurrences = record.pendingOccurrences == null
      ? 1
      : Math.max(0, Number(record.pendingOccurrences) || 0);
    const occurrenceCount = Math.max(0, Number(previous.occurrenceCount) || 0)
      + (isNewObservation ? pendingOccurrences : 0);
    const now = Date.now();
    const observationIds = isNewObservation
      ? [...rememberedObservations, observationID].slice(-MAX_REMEMBERED_OBSERVATIONS)
      : rememberedObservations;
    const entry = {
      ...previous,
      phase: record.phase || previous.phase || '',
      firstSeenAt: previous.firstSeenAt || record.observedAt || new Date(now).toISOString(),
      lastSeenAt: record.observedAt || new Date(now).toISOString(),
      occurrenceCount,
      lastCommit: (record.context && record.context.head) || previous.lastCommit || '',
      lastObservationId: observationID,
      observationIds,
    };
    state.reports[fingerprint] = entry;

    if (record.context) {
      const rebuilt = buildDraft(record.context, { occurrenceCount });
      record.title = rebuilt.title;
      record.body = rebuilt.body;
    }
    record.occurrenceCount = occurrenceCount;
    record.lastPreparedAt = now;

    // L'ACK dell'observationId va su disco prima di azzerare il pending nel
    // record. Se il processo muore fra le due scritture, al retry l'ID è già
    // ricordato e non viene ricontato; nell'ordine inverso l'occorrenza potrebbe
    // sparire per sempre. L'array serve perché più entry della stessa fingerprint
    // possono restare contemporaneamente in outbox dopo un errore di rete.
    const observationStateError = writeIssueState(state);
    if (observationStateError) {
      const failure = {
        code: 3,
        error: `stato osservazione non salvato: ${observationStateError}`,
        stateError: observationStateError,
        occurrenceCount,
      };
      if (isCurrent) currentOutcome = failure;
      firstFailure ||= failure;
      console.error(`Coda issue ancora pendente: ${failure.error}`);
      continue;
    }

    record.pendingOccurrences = 0;
    const outboxError = saveDraft(file, record);
    if (outboxError) {
      entry.lastAttemptAt = new Date(now).toISOString();
      entry.lastSendStatus = 'failed';
      entry.lastSendError = `outbox non aggiornabile: ${outboxError}`;
      writeIssueState(state);
      const failure = { code: 3, error: entry.lastSendError };
      if (isCurrent) currentOutcome = failure;
      firstFailure ||= failure;
      console.error(`Coda issue ancora pendente: ${entry.lastSendError}`);
      continue;
    }

    const previousURL = canonicalIssueURL(previous.issueUrl);
    if (previousURL && previous.lastSentAt
        && now - Date.parse(previous.lastSentAt) < AUTO_QUIET_MS) {
      entry.lastSendStatus = 'deduplicated';
      entry.lastSendError = null;
      const stateError = writeIssueState(state);
      if (!stateError) removeOutboxFile(file);
      const outcome = stateError
        ? { code: 5, url: previousURL, deduplicated: true, stateError, occurrenceCount }
        : { code: 0, url: previousURL, deduplicated: true, occurrenceCount };
      if (isCurrent) currentOutcome = outcome;
      if (stateError) firstFailure ||= outcome;
      continue;
    }

    entry.lastAttemptAt = new Date(now).toISOString();
    writeIssueState(state);
    const result = await sendDraft(record);
    if (!result.url) {
      entry.lastSendStatus = result.disabled ? 'disabled' : 'failed';
      entry.lastSendError = result.error || 'errore sconosciuto';
      const stateError = writeIssueState(state);
      const failure = {
        code: result.disabled ? 2 : 3,
        error: entry.lastSendError,
        stateError,
        occurrenceCount,
      };
      if (isCurrent) currentOutcome = failure;
      firstFailure ||= failure;
      console.error(`Coda issue ancora pendente (${fingerprint.slice(0, 12)}): ${entry.lastSendError}`);
      continue;
    }

    entry.lastSentAt = new Date(now).toISOString();
    entry.lastSendStatus = result.deduplicated ? 'deduplicated' : 'sent';
    entry.lastSendError = null;
    entry.issueUrl = result.url;
    const stateError = writeIssueState(state);
    if (!stateError) removeOutboxFile(file);
    const outcome = stateError
      ? { code: 5, url: result.url, deduplicated: result.deduplicated, stateError, occurrenceCount }
      : { code: 0, url: result.url, deduplicated: result.deduplicated, occurrenceCount };
    if (isCurrent) {
      currentOutcome = outcome;
    } else {
      console.log(`Coda issue consegnata (${fingerprint.slice(0, 12)}): ${result.url}`);
    }
    if (stateError) firstFailure ||= outcome;
  }

  return { currentOutcome, firstFailure };
}

function printAutoOutcome(outcome, fingerprint) {
  if (!outcome) {
    console.error('Invio issue rinviato: il payload corrente non è stato trovato nell’outbox.');
    return 4;
  }
  if (!outcome.url) {
    console.error(`Invio issue fallito: ${outcome.error || 'errore sconosciuto'}`);
    console.error(`Dettagli persistiti in ${redactText(STATE_FILE)}; payload conservato nell'outbox.`);
    if (outcome.stateError) console.error(`ATTENZIONE: stato errore non salvato: ${outcome.stateError}`);
    return outcome.code || 3;
  }

  console.log(`${outcome.deduplicated ? 'Issue già segnalata' : 'Issue creata'}: ${outcome.url}`);
  console.log(`Fingerprint: ${fingerprint} · occorrenza locale ${outcome.occurrenceCount}`);
  if (outcome.stateError) {
    console.error(`ATTENZIONE: issue inviata ma stato deduplica non salvato: ${outcome.stateError}`);
  }
  return outcome.code || 0;
}

async function cmdAuto(phase, reasonArg, suppliedFingerprint, command, exitCode, startPhase) {
  if (!phase) {
    console.error('Uso: node scripts/lib/issue-report.js auto "<phase>" [reason] [fingerprint] [command] [exitCode] [startPhase]');
    return 1;
  }

  // Il payload diventa durevole PRIMA di contendere il lock. Se un altro invio
  // dura più del previsto, questa osservazione resta in coda invece di sparire.
  const ctx = gatherContext(phase, reasonArg, { command, exitCode, startPhase });
  const fingerprint = deriveFingerprint(ctx, suppliedFingerprint);
  const now = Date.now();
  const outboxDir = autoOutboxDir();
  const observationId = crypto.randomUUID();
  const file = autoDraftPath(fingerprint, observationId, outboxDir);
  const draft = buildDraft(ctx, { occurrenceCount: 1 });
  const record = {
    ...draft,
    phase,
    fingerprint,
    occurrenceCount: 1,
    pendingOccurrences: 1,
    observationId,
    observedAt: new Date(now).toISOString(),
    createdAt: ctx.lastUpdate,
    savedAt: now,
    context: contextForOutbox(ctx),
  };
  const draftError = saveDraft(file, record);
  if (draftError) {
    console.error(`Invio issue fallito: outbox non scrivibile: ${draftError}`);
    return 3;
  }

  let release;
  try {
    release = await acquireReportLock();
  } catch (error) {
    console.error(`Invio issue rinviato: ${redactText(error.message || String(error))}`);
    return 4;
  }

  try {
    const drained = await drainIssueOutbox(outboxDir, observationId, fingerprint);
    let outcome = drained.currentOutcome;
    if (!outcome) {
      // Un altro possessore del lock può aver incorporato questa entry mentre
      // aspettavamo. Lo stato remoto/locale della stessa fingerprint è allora
      // l'ACK corretto per questo chiamante, non un falso «payload sparito».
      const entry = readIssueState().reports[fingerprint] || {};
      const url = canonicalIssueURL(entry.issueUrl);
      if (url) {
        outcome = {
          code: 0,
          url,
          deduplicated: true,
          occurrenceCount: Math.max(1, Number(entry.occurrenceCount) || 1),
        };
      }
    }
    return printAutoOutcome(outcome, fingerprint);
  } finally {
    release();
  }
}

async function cmdFlush() {
  const outboxDirs = allAutoOutboxDirs()
    .filter((dir) => outboxFiles(dir).length > 0);
  if (outboxDirs.length === 0) return 0;

  let release;
  try {
    release = await acquireReportLock();
  } catch (error) {
    console.error(`Coda issue non drenata: ${redactText(error.message || String(error))}`);
    return 4;
  }
  try {
    let firstFailure = null;
    for (const outboxDir of outboxDirs) {
      const drained = await drainIssueOutbox(outboxDir);
      firstFailure ||= drained.firstFailure;
    }
    return firstFailure ? firstFailure.code || 3 : 0;
  } finally {
    release();
  }
}

module.exports = {
  redactText,
  collapseProgress,
  storeTagOf,
  accountTagOf,
  memberTag,
  fileAge,
  inferStartPhase,
  normalizeFingerprintText,
  deriveFingerprint,
  buildDraft,
  gatherContext,
  transportBody,
  canonicalIssueURL,
};

async function main(argv) {
  const command = argv[2];
  if (command === 'draft') return cmdDraft(argv[3], argv[4]);
  if (command === 'send') return cmdSend();
  if (command === 'flush') return cmdFlush();
  if (command === 'auto') {
    return cmdAuto(argv[3], argv[4], argv[5], argv[6], argv[7], argv[8]);
  }
  console.error('Uso:\n  node scripts/lib/issue-report.js draft "<phase>" [reason]\n  node scripts/lib/issue-report.js send\n  node scripts/lib/issue-report.js flush\n  node scripts/lib/issue-report.js auto "<phase>" [reason] [fingerprint] [command] [exitCode] [startPhase]');
  return 1;
}

if (require.main === module) {
  main(process.argv)
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`Errore inatteso in issue-report: ${redactText(error && error.message ? error.message : String(error))}`);
      process.exitCode = 70;
    });
}
