#!/usr/bin/env node
/**
 * Plancia interattiva (cockpit) del supervisore GSD Campus.
 *
 * Pensata per il collega non tecnico: dopo l'avvio mostra a colpo d'occhio cosa
 * sta succedendo e si aggiorna da sola, con azioni a tasto singolo. NON esegue
 * browser ne chiamate AI: legge soltanto file di stato locali
 * (status.json, course_census.json, ai_todo.json, ai_usage.json, config.json,
 * i pid del batch Claude e la coda di autoplay.log). NON tiene in vita nulla:
 * lo scheduler gira in background a parte, quindi chiudere la finestra (Q) non
 * ferma i corsi.
 *
 * Modalita:
 *   (interattiva)      loop live con tasti da /dev/tty
 *   --once             stampa un solo frame ed esce (per test / ambienti headless)
 *   --root <dir>       radice progetto alternativa (test)
 *   --no-color         disabilita i colori ANSI
 */

const fs = require('fs');
const path = require('path');
const tty = require('tty');
const { spawnSync } = require('child_process');
const { readJsonSafe } = require('../../src/lib/io');
const { redactSensitiveText } = require('../../src/lib/logger');
const budget = require('../../src/lib/ai-budget');
const schedule = require('../../src/lib/schedule');

const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const REFRESH_MS = 2500;
const EVENT_PATTERN = /Inizio corso|Controllo corso|Apertura:|Video finito|non risulta completata|Rilevato questionario|Quiz finale|superato|non superato|AI_QUIZ_REQUEST|quiz_needs_answers|SESSIONE PERSA|AUTOLOGIN NON VALIDO|session_unstable|need_help|frozen detected|Video element scomparso|Error/i;

// ── Tema (UTF vs ASCII, come scripts/lib/ui.sh) ───────────────────────────
const IS_UTF = /(utf-?8)/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const GLYPH = IS_UTF
  ? { ok: '✓', warn: '⚠', err: '✗', dot: '●', arrow: '▸', h: '─', bar: '█', barOff: '░', bul: '·' }
  : { ok: '+', warn: '!', err: 'x', dot: '*', arrow: '>', h: '-', bar: '#', barOff: '.', bul: '-' };
const SPIN = IS_UTF ? ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] : ['-', '\\', '|', '/'];

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m',
};

// ── Helper puri ───────────────────────────────────────────────────────────
function stripAnsi(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, ''); }
function visLen(s) { return stripAnsi(s).length; }

function parseClockSeconds(str) {
  const m = String(str || '').trim().match(/^(\d+):(\d{1,2})(?::(\d{1,2}))?$/);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]); const c = m[3] != null ? Number(m[3]) : null;
  return c != null ? a * 3600 + b * 60 + c : a * 60 + b;
}

// videoProgress e' del tipo "0:59 / 16:00" -> percentuale intera o null.
function videoPercent(videoProgress) {
  const parts = String(videoProgress || '').split('/');
  if (parts.length !== 2) return null;
  const cur = parseClockSeconds(parts[0]);
  const tot = parseClockSeconds(parts[1]);
  if (cur == null || tot == null || tot <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((cur / tot) * 100)));
}

function progressBar(pct, width, glyph = GLYPH) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * width);
  return glyph.bar.repeat(filled) + glyph.barOff.repeat(Math.max(0, width - filled));
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

function relativeTime(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  return `${formatDuration(Math.max(0, now - t))} fa`;
}

// Quando riprende: "alle 07:00", "domani alle 07:00", "gio alle 07:00".
function formatWhen(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return null;
  const d = new Date(t); const n = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const dayDiff = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000);
  let abs;
  if (dayDiff <= 0) abs = `alle ${time}`;
  else if (dayDiff === 1) abs = `domani alle ${time}`;
  else abs = `${WEEKDAYS[d.getDay()]} alle ${time}`;
  return { abs, rel: formatDuration(Math.max(0, t - now)) };
}

function courseIdFromUrl(url) {
  const m = String(url || '').match(/show\/(\d+)/);
  return m ? m[1] : null;
}

// ── Raccolta dati (impura) ─────────────────────────────────────────────────
function readPid(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_) { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

function tailLines(file, maxBytes = 65536) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const len = stat.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean);
  } catch (_) { return []; }
}

function recentEvents(root, limit = 3) {
  const lines = tailLines(path.join(root, 'logs', 'autoplay.log'));
  const hits = [];
  for (let i = lines.length - 1; i >= 0 && hits.length < limit; i -= 1) {
    if (EVENT_PATTERN.test(lines[i])) hits.push(redactSensitiveText(lines[i]).slice(0, 120));
  }
  return hits.reverse();
}

function readModel(root, now = Date.now()) {
  const logs = path.join(root, 'logs');
  const status = readJsonSafe(path.join(logs, 'status.json'), {}, { warn: false }) || {};
  const census = readJsonSafe(path.join(logs, 'course_census.json'), null, { warn: false });
  const todo = readJsonSafe(path.join(logs, 'ai_todo.json'), {}, { warn: false }) || {};
  const update = readJsonSafe(path.join(logs, '.update_available'), null, { warn: false });
  const claudeState = readJsonSafe(path.join(logs, 'claude-quiz-state.json'), null, { warn: false });
  const config = readJsonSafe(path.join(root, 'config.json'), {}, { warn: false }) || {};

  let usage = null;
  try { usage = budget.usageSummary(root, now); } catch (_) { usage = null; }

  const schedPid = readPid(path.join(root, '.autoplay_pid'));
  const heartbeatFresh = Number.isFinite(Date.parse(status.schedulerHeartbeat || ''))
    && (now - Date.parse(status.schedulerHeartbeat)) < 90000;
  const schedAlive = pidAlive(schedPid) || heartbeatFresh;

  const claudeWorking = pidAlive(readPid(path.join(root, '.claude_batch_pid')))
    || pidAlive(readPid(path.join(root, '.claude_runner_pid')));

  let workNow = false; let nextStart = null;
  try { workNow = schedule.isWorkTime(new Date(now)); } catch (_) {}
  try { const s = schedule.nextWorkStart(new Date(now)); nextStart = s ? s.toISOString() : null; } catch (_) {}
  let scheduleDesc = '';
  try { scheduleDesc = schedule.describeSchedule(); } catch (_) { scheduleDesc = ''; }

  let courseTitle = null;
  const courseId = courseIdFromUrl(status.courseUrl);
  if (census && Array.isArray(census.courses) && courseId) {
    const hit = census.courses.find((c) => courseIdFromUrl(c.url) === courseId);
    if (hit && hit.title) courseTitle = String(hit.title).slice(0, 46);
  }

  return {
    now,
    member: config.memberName || config.codice_fiscale || 'account attivo',
    status,
    summary: status.courseStateSummary || null,
    census,
    todo,
    update,
    usage,
    claudeState,
    claudeWorking,
    schedAlive,
    workNow,
    nextStart,
    scheduleDesc,
    courseTitle,
    videoPct: videoPercent(status.videoProgress),
    openQuiz: Number(todo.openQuizRequests || 0),
    events: recentEvents(root),
    stale: !!todo.statusStale,
  };
}

// Stato principale in una frase onesta in italiano.
function computeHeadline(m) {
  const phase = m.status.phase || '';
  if (phase === 'autologin_invalid' || phase === 'session_lost') {
    return { level: 'attention', text: 'Il link di accesso sembra non valido — potrebbe servire rinnovarlo.', hint: 'Premi  C  per cambiare collega / riselezionare l’account.' };
  }
  if (m.claudeWorking) {
    const n = (m.claudeState && Number.isFinite(m.claudeState.remaining)) ? m.claudeState.remaining : (m.openQuiz || null);
    return { level: 'work', text: n ? `Claude sta risolvendo ${n} domanda/e di quiz…` : 'Claude sta risolvendo un quiz…' };
  }
  if (!m.schedAlive) {
    return { level: 'attention', text: 'Il sistema non risulta in esecuzione.', hint: 'Rilancia il comando curl e scegli “Aggiorna e avvia”.' };
  }
  if (!m.workNow) {
    const when = formatWhen(m.nextStart, m.now);
    return { level: 'paused', text: when ? `In pausa fuori orario — riprendo ${when.abs} (tra ${when.rel}).` : 'In pausa fuori orario — riprende al prossimo turno.' };
  }
  if (m.courseTitle || m.videoPct != null) {
    const vp = m.videoPct != null ? ` · video ${m.videoPct}%` : '';
    return { level: 'ok', text: `Sto seguendo: ${m.courseTitle || 'un corso'}${vp}` };
  }
  const s = m.summary;
  if (s && s.total > 0 && s.done > 0 && s.needHelp === 0 && s.done >= s.total) {
    return { level: 'ok', text: 'Tutti i corsi sono completati.' };
  }
  return { level: 'ok', text: 'Al lavoro sui corsi…' };
}

// ── Rendering (puro) ────────────────────────────────────────────────────────
function renderFrame(model, opts = {}) {
  const color = !!opts.color;
  const width = Math.max(48, Math.min(96, opts.width || 72));
  const spinIndex = opts.spinIndex || 0;
  const c = (code, s) => (color ? `${code}${s}${ANSI.reset}` : String(s));
  const rule = ' ' + GLYPH.h.repeat(width);
  const L = [];
  const head = computeHeadline(model);

  // Header
  const badge = model.schedAlive
    ? (model.workNow ? c(ANSI.green, `${GLYPH.dot} attivo`) : c(ANSI.yellow, `${GLYPH.dot} in pausa`))
    : c(ANSI.red, `${GLYPH.dot} fermo`);
  const title = `${c(ANSI.bold, 'GSD Campus')} ${c(ANSI.dim, GLYPH.bul)} ${model.member}`;
  const pad = Math.max(1, width - visLen(title) - visLen(badge));
  L.push(` ${title}${' '.repeat(pad)}${badge}`);
  L.push(rule);
  L.push('');

  // Headline
  const headColor = head.level === 'attention' ? ANSI.red : head.level === 'paused' ? ANSI.yellow : head.level === 'work' ? ANSI.cyan : ANSI.green;
  const headMark = head.level === 'attention' ? GLYPH.warn : head.level === 'work' ? SPIN[spinIndex % SPIN.length] : GLYPH.dot;
  L.push(`  ${c(headColor, headMark)} ${c(ANSI.bold, head.text)}`);
  if (head.hint) L.push(`     ${c(ANSI.dim, head.hint)}`);
  L.push('');

  const row = (label, value) => L.push(`   ${c(ANSI.dim, label.padEnd(10))} ${c(ANSI.gray, GLYPH.arrow)} ${value}`);

  // Corsi + avanzamento totale
  const s = model.summary;
  if (s) {
    const attesa = s.needHelp ? ` ${GLYPH.bul} ${c(ANSI.yellow, `${s.needHelp} in attesa`)}` : '';
    row('Corsi', `${s.total} totali ${GLYPH.bul} ${s.done} fatti${attesa}${s.inProgress ? ` ${GLYPH.bul} ${s.inProgress} in corso` : ''}`);
  } else if (model.census) {
    row('Corsi', `${model.census.total} totali ${GLYPH.bul} ${model.census.at100} al 100% ${GLYPH.bul} ${model.census.partial} parziali`);
  }
  if (model.census && Array.isArray(model.census.courses) && model.census.courses.length) {
    const pcts = model.census.courses.map((x) => (Number.isFinite(x.pct) ? x.pct : 0));
    const avg = Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length);
    row('Avanzam.', `${progressBar(avg, 18)} ${String(avg).padStart(3)}%`);
  }

  // Quiz
  row('Quiz', model.openQuiz > 0 ? c(ANSI.yellow, `${model.openQuiz} da risolvere`) : 'nessuno in attesa');

  // Claude
  if (model.claudeWorking) row('Claude', c(ANSI.cyan, `${SPIN[spinIndex % SPIN.length]} al lavoro su un quiz…`));
  else row('Claude', c(ANSI.dim, 'inattivo — entra da solo solo se serve'));

  // Budget
  if (model.usage && model.usage.used && model.usage.limits) {
    const u = model.usage.used; const lim = model.usage.limits;
    row('Budget', `oggi ${u.daily}/${lim.daily} ${GLYPH.bul} settimana ${u.weekly}/${lim.weekly}`);
  }

  // Turni
  if (model.scheduleDesc) {
    const state = model.workNow ? c(ANSI.green, 'in orario') : c(ANSI.yellow, 'in pausa');
    row('Turni', `${model.scheduleDesc}  ${GLYPH.bul} ${state}`);
  }

  // Attention: corsi in need_help (ma non blocco totale) + aggiornamento
  if (s && s.needHelp > 0 && head.level !== 'attention') {
    L.push('');
    L.push(`  ${c(ANSI.yellow, GLYPH.warn)} ${s.needHelp} corso/i in attesa di risposte quiz — se ne occupa l’AI/il referente.`);
  }
  if (model.update && model.update.remoteVersion) {
    L.push(`  ${c(ANSI.cyan, '↑')} Aggiornamento disponibile (${model.update.remoteVersion}) — rilancia il comando curl per riceverlo.`);
  }

  // Eventi recenti
  if (model.events && model.events.length) {
    L.push('');
    L.push(`   ${c(ANSI.dim, 'Ultimi eventi')}`);
    for (const ev of model.events) L.push(`     ${c(ANSI.gray, GLYPH.bul)} ${c(ANSI.dim, ev)}`);
  }

  // Footer azioni
  L.push('');
  L.push(rule);
  const key = (k, label) => `${c(ANSI.bold, k)} ${label}`;
  const actions = [key('L', 'guarda dal vivo'), key('F', 'ferma'), key('R', 'aggiorna'), key('Q', 'chiudi')];
  if (head.level === 'attention' && head.hint && head.hint.includes('C ')) actions.splice(3, 0, key('C', 'cambia collega'));
  L.push('  ' + actions.join(`   `));
  L.push(` ${c(ANSI.dim, 'si aggiorna da solo ' + GLYPH.bul + ' chiudere la finestra non ferma nulla')}`);
  return L.join('\n');
}

function renderLogView(root, opts = {}) {
  const color = !!opts.color;
  const width = Math.max(48, Math.min(120, opts.width || 100));
  const c = (code, s) => (color ? `${code}${s}${ANSI.reset}` : String(s));
  const lines = tailLines(path.join(root, 'logs', 'autoplay.log')).slice(-18).map((l) => redactSensitiveText(l).slice(0, width));
  const out = [` ${c(ANSI.bold, 'Log dal vivo')} ${c(ANSI.dim, '(autoplay.log)')}`, ' ' + GLYPH.h.repeat(width)];
  if (!lines.length) out.push(c(ANSI.dim, '   (nessun log ancora)'));
  else for (const l of lines) out.push('  ' + c(ANSI.dim, l));
  out.push(' ' + GLYPH.h.repeat(width));
  out.push(`  ${c(ANSI.bold, 'Q')} torna alla plancia ${GLYPH.bul} si aggiorna da solo`);
  return out.join('\n');
}

// ── Loop interattivo ────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { root: path.resolve(__dirname, '..', '..'), once: false, color: undefined, interval: REFRESH_MS };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) a.root = path.resolve(argv[++i]);
    else if (argv[i] === '--once') a.once = true;
    else if (argv[i] === '--no-color') a.color = false;
    else if (argv[i] === '--color') a.color = true;
    else if (argv[i] === '--interval' && argv[i + 1]) a.interval = Math.max(500, Number(argv[++i]) || REFRESH_MS);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const colorDefault = process.stdout.isTTY && !process.env.NO_COLOR;
  const color = args.color != null ? args.color : colorDefault;
  const width = (process.stdout.columns || 74) - 2;

  // Fallback non-interattivo: un frame e via (headless, pipe, --once).
  let ttyFd = null;
  if (!args.once) {
    try { ttyFd = fs.openSync('/dev/tty', 'r'); } catch (_) { ttyFd = null; }
  }
  if (args.once || !process.stdout.isTTY || ttyFd == null) {
    process.stdout.write(renderFrame(readModel(args.root), { color, width }) + '\n');
    if (ttyFd != null) { try { fs.closeSync(ttyFd); } catch (_) {} }
    return 0;
  }

  const input = new tty.ReadStream(ttyFd);
  let spinIndex = 0;
  let view = 'panel'; // 'panel' | 'log'
  let confirmStop = false;
  let timer = null;
  let closed = false;

  const draw = () => {
    const frame = view === 'log'
      ? renderLogView(args.root, { color, width })
      : renderFrame(readModel(args.root), { color, width, spinIndex });
    const extra = (view === 'panel' && confirmStop)
      ? `\n  ${color ? ANSI.red : ''}Premere di nuovo F per fermare tutto, un altro tasto per annullare.${color ? ANSI.reset : ''}`
      : '';
    process.stdout.write('\x1b[H\x1b[2J' + frame + extra + '\n');
  };

  const teardown = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try { input.setRawMode(false); } catch (_) {}
    try { input.pause(); input.destroy(); } catch (_) {}
    try { fs.closeSync(ttyFd); } catch (_) {}
    process.stdout.write('\x1b[?25h\x1b[0m\n'); // mostra cursore, reset colore
  };

  const quit = (msg) => {
    teardown();
    if (msg) process.stdout.write(msg + '\n');
    process.exit(0);
  };

  const doStop = () => {
    teardown();
    process.stdout.write('\nFermo il sistema…\n');
    const stop = path.join(args.root, 'stop.sh');
    try { spawnSync(stop, [], { stdio: 'inherit' }); } catch (_) {}
    process.exit(0);
  };

  const onKey = (key) => {
    const k = String(key);
    if (k === '\u0003') return quit('Chiuso. Il sistema continua a lavorare in background.'); // Ctrl-C
    if (view === 'log') { if (/^[qQ\r\n\u001b]$/.test(k)) { view = 'panel'; draw(); } return; }
    if (confirmStop) {
      confirmStop = false;
      if (k === 'f' || k === 'F') return doStop();
      draw();
      return;
    }
    switch (k) {
      case 'q': case 'Q': case '\u001b':
        return quit('Chiuso. Il sistema continua a lavorare in background: puoi chiudere la finestra.');
      case 'f': case 'F': confirmStop = true; draw(); break;
      case 'l': case 'L': view = 'log'; draw(); break;
      case 'r': case 'R': draw(); break;
      default: break;
    }
  };

  try { input.setRawMode(true); } catch (_) {
    // Nessun raw mode disponibile: ripiega su singolo frame.
    process.stdout.write(renderFrame(readModel(args.root), { color, width }) + '\n');
    teardown();
    return 0;
  }
  input.resume();
  input.setEncoding('utf8');
  input.on('data', onKey);
  process.on('SIGINT', () => quit('')); // teardown pulito
  process.on('SIGTERM', () => quit(''));
  // Reti di sicurezza: qualunque uscita imprevista non deve lasciare il
  // terminale in raw mode o senza cursore.
  process.on('exit', () => { try { process.stdout.write('\x1b[?25h'); } catch (_) {} });
  process.on('uncaughtException', (e) => { teardown(); process.stderr.write(`[panel] ${e && e.message}\n`); process.exit(1); });
  process.stdout.write('\x1b[?25l'); // nascondi cursore
  draw();
  timer = setInterval(() => { spinIndex += 1; draw(); }, args.interval);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`[panel] ${e && e.message}\n`); process.exitCode = 1; }
}

module.exports = {
  parseClockSeconds, videoPercent, progressBar, formatDuration, relativeTime, formatWhen,
  courseIdFromUrl, computeHeadline, readModel, renderFrame, renderLogView, stripAnsi, visLen,
};
