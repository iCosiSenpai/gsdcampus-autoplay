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
const updateState = require('../../src/lib/update-state');

const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const REFRESH_MS = 2500;   // rilettura dei file di stato
const ANIM_MS = 250;       // ridisegno per le animazioni (usa i dati in cache)
const EVENT_PATTERN = /Inizio corso|Controllo corso|Apertura:|Video finito|non risulta completata|Rilevato questionario|Quiz finale|superato|non superato|AI_QUIZ_REQUEST|quiz_needs_answers|SESSIONE PERSA|AUTOLOGIN NON VALIDO|session_unstable|need_help|frozen detected|Video element scomparso|Error/i;

// LaunchAgent che rimette in piedi lo scheduler se muore (scripts/lib/install-scheduler-agent.sh).
const KEEPALIVE_LABEL = 'com.gsdcampus.autoplay.keepalive';

// ── Tema (UTF vs ASCII, come scripts/lib/ui.sh) ───────────────────────────
const IS_UTF = /(utf-?8)/i.test(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
const GLYPH = IS_UTF
  ? {
    ok: '✓', warn: '⚠', err: '✗', dot: '●', arrow: '▸', h: '─', bar: '█', barOff: '░', bul: '·',
    // Tema Pac-Man: bocca spalancata → media → chiusa (ciclo di 4 frame, come
    // l'originale) + labirinto, pastiglie e fantasmi.
    pacWide: '◖', pacOpen: 'ᗧ', pacClosed: '●', ghost: 'ᗣ',
    pellet: '•', power: '◉', track: '·', eaten: '─',
    wall: '═', capL: '▕', capR: '▏', pause: '❙❙',
  }
  : {
    ok: '+', warn: '!', err: 'x', dot: '*', arrow: '>', h: '-', bar: '#', barOff: '.', bul: '-',
    pacWide: 'C', pacOpen: 'c', pacClosed: 'o', ghost: 'M',
    pellet: 'o', power: '0', track: '.', eaten: '-',
    wall: '=', capL: '[', capR: ']', pause: '||',
  };
// Ciclo bocca a due battute: aperto → chiuso. Prima c'era anche `◖` (mezzo
// disco pieno), che in gran parte dei font monospace ha peso e larghezza
// diversi da `ᗧ`: il risultato era un Pac-Man che sobbalzava invece di
// masticare. Due glifi della stessa famiglia si leggono come un morso.
const PAC_FRAMES = [GLYPH.pacOpen, GLYPH.pacOpen, GLYPH.pacClosed, GLYPH.pacClosed];
const SPIN = IS_UTF ? ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] : ['-', '\\', '|', '/'];

const ANSI = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m',
  // Palette 256 colori del gioco: giallo Pac-Man, pastiglie bianche, corridoio
  // e labirinto blu. Sui terminali a 8 colori i codici 256 degradano da soli.
  pac: '\x1b[1;38;5;226m',
  pellet: '\x1b[38;5;231m',
  power: '\x1b[1;38;5;229m',
  track: '\x1b[38;5;240m',
  eaten: '\x1b[38;5;237m',
  maze: '\x1b[38;5;33m',
  cherry: '\x1b[38;5;196m',
  // Blu del fantasma spaventato, come nel gioco dopo la power pellet.
  scared: '\x1b[1;38;5;27m',
};
// I quattro fantasmi originali: Blinky (rosso), Pinky (rosa), Inky (ciano), Clyde (arancio).
const GHOST_COLORS = ['\x1b[38;5;203m', '\x1b[38;5;213m', '\x1b[38;5;87m', '\x1b[38;5;214m'];

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

/**
 * Corridoio Pac-Man come sequenza di celle tipizzate: Pac-Man mangia le
 * pastiglie man mano che l'avanzamento cresce, e i fantasmi lo aspettano in
 * fondo. Pura e testabile; il colore lo mette chi disegna (vedi paintPacman).
 * @param {number} pct 0..100
 * @param {number} width celle
 * @param {number} frame contatore di animazione (ciclo bocca a 4 frame)
 * @param {{ ghosts?: number, glyph?: object }} [opts] ghosts = quanti fantasmi in coda
 * @returns {Array<{ ch: string, kind: 'eaten'|'pac'|'pellet'|'power'|'track'|'ghost', ghost?: number }>}
 */
function pacmanSegments(pct, width, frame = 0, opts = {}) {
  const glyph = opts.glyph || GLYPH;
  const frames = glyph === GLYPH
    ? PAC_FRAMES
    : [glyph.pacWide, glyph.pacOpen, glyph.pacClosed, glyph.pacOpen];
  const cells = Math.max(8, Number(width) || 12);
  const ghosts = Math.max(0, Math.min(4, Math.floor(Number(opts.ghosts) || 0)));
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const pos = Math.round((p / 100) * (cells - 1));
  const mouth = frames[Math.abs(Math.floor(frame)) % frames.length];
  const out = [];
  for (let i = 0; i < cells; i += 1) {
    const fromEnd = cells - 1 - i;
    if (i < pos) {
      out.push({ ch: glyph.eaten, kind: 'eaten' });            // corridoio già ripulito
    } else if (i === pos) {
      out.push({ ch: mouth, kind: 'pac' });                    // Pac-Man che mastica
    } else if (ghosts > 0 && fromEnd < ghosts) {
      // Come nel gioco: quando Pac-Man e' addosso ai fantasmi questi diventano
      // spaventati (blu). Qui vuol dire "ci sei quasi, i corsi bloccati stanno
      // per cadere" — l'informazione e' la stessa, ma si vede a colpo d'occhio.
      const scared = (cells - 1 - pos) <= ghosts + 1;
      out.push({ ch: glyph.ghost, kind: scared ? 'ghostScared' : 'ghost', ghost: fromEnd });
    } else if (fromEnd === 0) {
      out.push({ ch: glyph.power, kind: 'power' });            // pastiglia grande in fondo
    } else if ((i - pos) % 4 === 0) {
      out.push({ ch: glyph.pellet, kind: 'pellet' });
    } else {
      out.push({ ch: glyph.track, kind: 'track' });
    }
  }
  return out;
}

/** Barra Pac-Man in testo semplice (senza colori). */
function pacmanBar(pct, width, frame = 0, opts = {}) {
  const o = { ...opts };
  if (o.ghost && !o.ghosts) o.ghosts = 1;   // compat: ghost:true = un fantasma
  return pacmanSegments(pct, width, frame, o).map((c) => c.ch).join('');
}

/** Colore ANSI per tipo di cella del corridoio. */
function pacmanCellColor(cell) {
  switch (cell.kind) {
    case 'pac': return ANSI.pac;
    case 'ghost': return GHOST_COLORS[(cell.ghost || 0) % GHOST_COLORS.length];
    case 'ghostScared': return ANSI.scared;
    case 'pellet': return ANSI.pellet;
    case 'power': return ANSI.power;
    case 'eaten': return ANSI.eaten;
    default: return ANSI.track;
  }
}

/**
 * Dipinge il corridoio: giallo Pac-Man, pastiglie bianche, fantasmi coi colori
 * dei quattro originali. Le celle consecutive dello stesso tipo condividono una
 * sola sequenza di colore (meno byte per frame: si ridisegna 4 volte al secondo).
 */
function paintPacman(segments, color) {
  if (!color) return segments.map((c) => c.ch).join('');
  let out = '';
  let runColor = null;
  let run = '';
  const flush = () => {
    if (run) out += `${runColor}${run}${ANSI.reset}`;
    run = '';
  };
  for (const cell of segments) {
    const col = pacmanCellColor(cell);
    if (col !== runColor) {
      flush();
      runColor = col;
    }
    run += cell.ch;
  }
  flush();
  return out;
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60); const rem = m % 60;
  // Oltre le 48 ore "159h 10m" non dice piu niente a nessuno: si passa ai giorni.
  if (h >= 48) {
    const d = Math.floor(h / 24); const hr = h % 24;
    return hr ? `${d} giorni ${hr}h` : `${d} giorni`;
  }
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

// Quando è successo: "16:28", "ieri 16:28", "mar 22 16:28". Il giorno va detto
// SEMPRE se non è oggi — è esattamente l'informazione che mancava e che faceva
// scambiare un errore della sera prima per uno appena avvenuto.
function formatEventStamp(at, now) {
  const d = new Date(at); const n = new Date(now);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;
  const days = Math.round(
    (new Date(n.getFullYear(), n.getMonth(), n.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000
  );
  if (days <= 0) return time;
  if (days === 1) return `ieri ${time}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${time}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${time}`;
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

// Versione release per l'header. Letta UNA volta per processo: la plancia
// ridisegna 4 volte al secondo e non deve lanciare git a ogni frame.
// I cloni dei colleghi sono `--depth 1` e NON hanno i tag: lì `describe`
// restituisce solo lo sha, quindi ripieghiamo su package.json + sha
// ("v1.1.0 · 42a07aa") invece di mostrare un esadecimale nudo.
// Cache con scadenza, NON per sempre. Prima il valore veniva calcolato al primo
// frame e non cambiava mai piu': su una plancia lasciata aperta, dopo un
// aggiornamento continuava a mostrare la versione con cui era partita — che e'
// esattamente il momento in cui uno guarda la versione per capire se e'
// aggiornato. 30s bastano: `git describe` costa pochi millisecondi.
let _versionCache;
let _versionCachedAt = 0;
const VERSION_TTL_MS = 30000;

// Data del commit su cui gira questo codice. La versione da sola ("v1.1.0-81")
// non dice a nessuno SE l'aggiornamento e' andato a buon fine: la data si', a
// colpo d'occhio. Stessa cache a scadenza della versione.
let _versionDateCache;
let _versionDateAt = 0;
function readVersionDate(root) {
  if (_versionDateCache !== undefined && Date.now() - _versionDateAt < VERSION_TTL_MS) {
    return _versionDateCache;
  }
  _versionDateAt = Date.now();
  let iso = '';
  try {
    iso = String(spawnSync('git', ['log', '-1', '--format=%cI'], {
      cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).stdout || '').trim();
  } catch (_) { iso = ''; }
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) { _versionDateCache = null; return null; }
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, '0');
  _versionDateCache = `${p2(d.getDate())}/${p2(d.getMonth() + 1)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return _versionDateCache;
}

function readVersion(root) {
  if (_versionCache !== undefined && Date.now() - _versionCachedAt < VERSION_TTL_MS) {
    return _versionCache;
  }
  _versionCachedAt = Date.now();
  let describe = '';
  try {
    describe = String(spawnSync('git', ['describe', '--tags', '--always'], {
      cwd: root, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).stdout || '').trim();
  } catch (_) { describe = ''; }
  // "v1.1.0-62-g964824c" → "v1.1.0-62" (lo sha completo è già nella riga Aggiorn.)
  const tag = describe.match(/^(v?\d+\.\d+\.\d+(?:-\d+)?)/);
  if (tag) {
    _versionCache = tag[1];
    return _versionCache;
  }
  let pkg = '';
  try { pkg = String(require(path.join(root, 'package.json')).version || ''); } catch (_) { pkg = ''; }
  _versionCache = pkg ? `v${pkg}${describe ? ` · ${describe}` : ''}` : (describe || null);
  return _versionCache;
}

// Il "guardiano" (keepalive) riavvia lo scheduler se muore: se non è installato,
// chiudere la scheda del Terminale può davvero fermare tutto.
function keepAliveInstalled(home = process.env.HOME || '') {
  try { return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${KEEPALIVE_LABEL}.plist`)); } catch (_) { return false; }
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

// Il log porta solo HH:MM:SS, senza data. Finché mostravamo la riga così com'era,
// un errore di ieri sera sembrava appena successo: bastava un riavvio e i vecchi
// eventi restavano lì a spaventare. Qui ricostruiamo la data assoluta ancorando
// l'ULTIMA riga all'mtime del file e camminando all'indietro: quando l'orario di
// una riga è maggiore di quella successiva abbiamo scavalcato la mezzanotte, e
// scaliamo un giorno.
const LOG_TS_RE = /^(\d{2}):(\d{2}):(\d{2})\s*\|\s*([\s\S]*)$/;
const RUN_START_RE = /Avvio GSD Campus autoplay/;

/**
 * @param {string[]} lines righe grezze del log, in ordine cronologico
 * @param {number} anchorMs epoch dell'ultima riga (tipicamente l'mtime del file)
 * @returns {{at:number,text:string,raw:string,runStart:boolean,run:number}[]}
 *   `run` = 0 per l'esecuzione più recente, 1 per la precedente, e così via.
 *   Pura: niente I/O, così è testabile.
 */
function parseLogTimeline(lines, anchorMs) {
  const out = [];
  const anchor = new Date(anchorMs);
  // Data di lavoro: parte dal giorno dell'ancora e arretra sui salti di mezzanotte.
  let y = anchor.getFullYear();
  let mo = anchor.getMonth();
  let d = anchor.getDate();
  let prevSecs = null; // orario della riga successiva (più recente)

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = LOG_TS_RE.exec(lines[i]);
    if (!m) continue;
    const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
    if (prevSecs != null && secs > prevSecs) {
      // Andando indietro l'orario è aumentato: abbiamo superato la mezzanotte.
      const back = new Date(y, mo, d);
      back.setDate(back.getDate() - 1);
      y = back.getFullYear(); mo = back.getMonth(); d = back.getDate();
    }
    prevSecs = secs;
    out.push({
      at: new Date(y, mo, d, Number(m[1]), Number(m[2]), Number(m[3])).getTime(),
      text: m[4],
      raw: lines[i],
      runStart: RUN_START_RE.test(lines[i]),
      run: 0,
    });
  }
  out.reverse();
  // Numera le esecuzioni all'indietro: 0 = quella in corso / più recente.
  let run = 0;
  for (let i = out.length - 1; i >= 0; i -= 1) {
    out[i].run = run;
    if (out[i].runStart) run += 1;
  }
  return out;
}

function readTimeline(root) {
  const file = path.join(root, 'logs', 'autoplay.log');
  let anchor = Date.now();
  try { anchor = fs.statSync(file).mtimeMs; } catch (_) { /* file assente: resta ora */ }
  return parseLogTimeline(tailLines(file), anchor);
}

/** Eventi rilevanti, con data assoluta e numero di esecuzione. */
function recentEvents(root, limit = 3) {
  const timeline = readTimeline(root).filter((e) => EVENT_PATTERN.test(e.raw));
  return timeline.slice(-limit).map((e) => ({
    at: e.at,
    run: e.run,
    text: redactSensitiveText(e.text).slice(0, 110),
  }));
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

  // Auto-aggiornamento: "controllato N min fa" + esito. Serve a distinguere un
  // auto-update vivo che non trova novità da uno fermo/disinstallato.
  let autoUpdate = null;
  try {
    autoUpdate = updateState.describeUpdateState(
      updateState.readUpdateState(root),
      now,
      { agentInstalled: updateState.isAgentInstalled(), disabled: updateState.isAutoUpdateDisabled(root) },
    );
  } catch (_) { autoUpdate = null; }

  // Commit attualmente sul disco: confrontato con quello di quando la plancia è
  // partita dice "il codice si è aggiornato mentre questa finestra era aperta".
  let headSha = null;
  try { headSha = updateState.readHeadSha(root); } catch (_) { headSha = null; }

  const schedPid = readPid(path.join(root, '.autoplay_pid'));
  const heartbeatFresh = Number.isFinite(Date.parse(status.schedulerHeartbeat || ''))
    && (now - Date.parse(status.schedulerHeartbeat)) < 90000;
  const schedAlive = pidAlive(schedPid) || heartbeatFresh;
  // Lo status.json può essere di giorni fa (run vecchio): i dati "live" come il
  // progresso video vanno mostrati solo se sono davvero freschi.
  const statusUpdatedAt = Date.parse(status.lastUpdate || '');
  const statusFresh = Number.isFinite(statusUpdatedAt) && (now - statusUpdatedAt) < 5 * 60 * 1000;
  const statusAgeMs = Number.isFinite(statusUpdatedAt) ? Math.max(0, now - statusUpdatedAt) : null;

  const claudeWorking = pidAlive(readPid(path.join(root, '.claude_batch_pid')))
    || pidAlive(readPid(path.join(root, '.claude_runner_pid')));

  let workNow = false; let nextStart = null;
  try { workNow = schedule.isWorkTime(new Date(now)); } catch (_) {}
  try { const s = schedule.nextWorkStart(new Date(now)); nextStart = s ? s.toISOString() : null; } catch (_) {}
  let scheduleDesc = '';
  try { scheduleDesc = schedule.describeSchedule(); } catch (_) { scheduleDesc = ''; }

  let courseTitle = null;
  const cleanTitle = (t) => String(t).replace(/\s+/g, ' ').trim().slice(0, 46);
  if (status.courseTitle) {
    // Fonte preferita: titolo scritto live dall'autoplay (sempre fresco).
    courseTitle = cleanTitle(status.courseTitle);
  } else {
    // Fallback: abbina l'URL corrente al censimento.
    const courseId = courseIdFromUrl(status.courseUrl);
    if (census && Array.isArray(census.courses) && courseId) {
      const hit = census.courses.find((c) => courseIdFromUrl(c.url) === courseId);
      if (hit && hit.title) courseTitle = cleanTitle(hit.title);
    }
  }

  return {
    now,
    member: config.memberName || config.codice_fiscale || 'account attivo',
    version: readVersion(root),
    versionDate: readVersionDate(root),
    devMode: config.devMode === true,
    keepAlive: keepAliveInstalled(),
    status,
    summary: status.courseStateSummary || null,
    census,
    todo,
    update,
    usage,
    autoUpdate,
    headSha,
    claudeState,
    claudeWorking,
    schedAlive,
    statusFresh,
    statusAgeMs,
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
  if (phase === 'autologin_invalid' || phase === 'session_lost' || phase === 'session_unstable') {
    return {
      level: 'attention',
      text: 'Accesso in pausa: il link è stato usato troppo e la piattaforma l’ha messo in timeout temporaneo.',
      hint: 'Non serve cambiare il link: lascialo raffreddare e riprova più tardi o domani.',
      cooldown: true,
    };
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
  const width = Math.max(48, Math.min(110, opts.width || 72));
  const spinIndex = opts.spinIndex || 0;
  const c = (code, s) => (color ? `${code}${s}${ANSI.reset}` : String(s));
  const rule = ' ' + c(ANSI.maze, GLYPH.wall.repeat(width));   // muro del labirinto
  const thin = ' ' + c(ANSI.eaten, GLYPH.h.repeat(width));
  // Corridoio largo: prende tutto lo spazio utile della finestra (prima erano
  // 18 celle fisse e Pac-Man sembrava un puntino).
  const trackWidth = Math.max(24, Math.min(72, width - 12));
  const L = [];
  const head = computeHeadline(model);

  // Header: mascotte animata + nome + versione release, badge di stato a destra.
  // Su una postazione di sviluppo "fermo" e' lo stato giusto, non un guasto: il
  // badge rosso manderebbe a cercare un problema che non c'e'.
  const badge = model.devMode
    ? c(ANSI.maze, `${GLYPH.bul} sviluppo`)
    : model.schedAlive
      ? (model.workNow ? c(ANSI.green, `${GLYPH.dot} attivo`) : c(ANSI.yellow, `${GLYPH.pause} in pausa`))
      : c(ANSI.red, `${GLYPH.dot} fermo`);
  let mascot;
  if (!model.schedAlive) mascot = c(GHOST_COLORS[0], GLYPH.ghost);
  else if (head.level === 'attention') mascot = c(GHOST_COLORS[1], GLYPH.ghost);
  else if (!model.workNow) mascot = c(ANSI.pac, GLYPH.pacClosed);
  else mascot = c(ANSI.pac, PAC_FRAMES[spinIndex % PAC_FRAMES.length]);
  // Versione + data del commit: insieme rispondono a "si e' aggiornato?".
  // Se un aggiornamento e' gia stato scaricato ma non ancora adottato, si dice
  // qui, dove uno guarda -- non solo in fondo al riquadro.
  let version = '';
  if (model.version) {
    const stamp = model.versionDate ? ` ${c(ANSI.dim, model.versionDate)}` : '';
    const pending = model.update && model.update.remoteVersion
      ? ` ${c(ANSI.yellow, '↑ aggiornamento pronto')}`
      : '';
    version = ` ${c(ANSI.dim, GLYPH.bul)} ${c(ANSI.pellet, model.version)}${stamp}${pending}`;
  }
  const title = `${mascot} ${c(ANSI.pac, 'GSD CAMPUS')} ${c(ANSI.maze, GLYPH.bul)} ${c(ANSI.bold, model.member)}${version}`;
  const pad = Math.max(1, width - visLen(title) - visLen(badge));
  L.push(` ${title}${' '.repeat(pad)}${badge}`);
  L.push(rule);
  L.push('');

  // Headline
  const headColor = head.level === 'attention' ? ANSI.red : head.level === 'paused' ? ANSI.yellow : head.level === 'work' ? ANSI.cyan : ANSI.green;
  const headMark = head.level === 'attention' ? GLYPH.warn : head.level === 'work' ? SPIN[spinIndex % SPIN.length] : GLYPH.dot;
  L.push(`  ${c(headColor, headMark)} ${c(ANSI.bold, head.text)}`);
  if (head.hint) L.push(`     ${c(ANSI.dim, head.hint)}`);
  if (head.cooldown) {
    L.push(`     ${c(ANSI.dim, 'Cosa puoi fare:')}`);
    L.push(`       ${c(ANSI.gray, GLYPH.bul)} lascia questa finestra aperta: riprova da sola.`);
    L.push(`       ${c(ANSI.bold, 'ESC')} esci dalla plancia: i corsi continuano e il guardiano riprova da solo.`);
    L.push(`       ${c(ANSI.bold, 'Q')} ferma corsi e scheduler, poi chiude questa scheda.`);
  }
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
    // Un fantasma per corso in attesa di risposte (max 4, come nel gioco).
    const ghosts = s && s.needHelp > 0 ? Math.min(4, s.needHelp) : 0;
    const corridor = paintPacman(pacmanSegments(avg, trackWidth, spinIndex, { ghosts }), color);
    L.push('');
    L.push(`   ${c(ANSI.dim, 'Avanzamento di tutti i corsi')}`);
    L.push(`   ${c(ANSI.maze, GLYPH.capL)}${corridor}${c(ANSI.maze, GLYPH.capR)}  ${c(ANSI.pac, String(avg).padStart(3) + '%')}`);
    L.push('');
  }

  // Video in corso: barra + tempo, con spinner che si muove ad ogni frame.
  // Solo con status fresco: un run di giorni fa lascerebbe una percentuale finta.
  if (model.statusFresh && (model.videoPct != null || model.status.videoProgress)) {
    const vp = model.videoPct != null ? model.videoPct : 0;
    const clock = model.status.videoProgress ? `  ${c(ANSI.dim, model.status.videoProgress)}` : '';
    const live = model.schedAlive && model.workNow ? `${c(ANSI.cyan, SPIN[spinIndex % SPIN.length])} ` : '';
    const vw = Math.max(16, Math.min(40, trackWidth - 8));
    const filled = Math.round((vp / 100) * vw);
    const vbar = c(ANSI.cyan, GLYPH.bar.repeat(filled)) + c(ANSI.eaten, GLYPH.barOff.repeat(Math.max(0, vw - filled)));
    row('Video', `${live}${vbar} ${String(vp).padStart(3)}%${clock}`);
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

  // Auto-aggiornamento: quando è stato l'ultimo controllo e com'è andato.
  if (model.autoUpdate) {
    const col = model.autoUpdate.level === 'warn' ? ANSI.yellow : ANSI.dim;
    row('Aggiorn.', c(col, model.autoUpdate.text));
  }

  // Attention: corsi in need_help (ma non blocco totale) + aggiornamento
  //
  // "in attesa di risposte quiz" va detto SOLO se ci sono davvero domande
  // aperte. Prima la riga si accendeva su qualsiasi need_help, quindi un corso
  // bloccato per altro — o rimasto bloccato per errore, con i questionari già
  // superati — annunciava per giorni un'attesa che non esisteva, e mandava il
  // referente a cercare domande da risolvere che non c'erano.
  if (s && s.needHelp > 0 && head.level !== 'attention') {
    L.push('');
    if (model.openQuiz > 0) {
      L.push(`  ${c(ANSI.yellow, GLYPH.warn)} ${model.openQuiz} domanda/e da risolvere su ${s.needHelp} corso/i — se ne occupa l’AI/il referente.`);
    } else {
      L.push(`  ${c(ANSI.yellow, GLYPH.warn)} ${s.needHelp} corso/i bloccato/i, nessuna domanda aperta.`);
      L.push(`  ${c(ANSI.dim, 'Se i questionari risultano superati il blocco è vecchio: node scripts/harvest-answers.js --reconcile --reset --yes')}`);
    }
  }
  if (model.update && model.update.remoteVersion) {
    L.push(`  ${c(ANSI.cyan, '↑')} Aggiornamento disponibile (${model.update.remoteVersion}) — rilancia il comando curl per riceverlo.`);
  }
  // Il codice è cambiato DOPO l'apertura di questa finestra (auto-update): i dati
  // qui sono freschi, ma la schermata gira ancora sulla versione vecchia. Non
  // chiediamo più all'utente di chiudere e rilanciare: la plancia si riapre da
  // sola (opts.restartIn = secondi al riavvio, o null se rimandato).
  if (opts.bootSha && model.headSha && opts.bootSha !== model.headSha) {
    L.push(`  ${c(ANSI.cyan, '↻')} Si è aggiornato da solo (${opts.bootSha} ${GLYPH.arrow} ${model.headSha}).`);
    if (opts.restartIn != null && opts.restartIn >= 0) {
      L.push(`     ${c(ANSI.dim, `Riapro questa schermata con la versione nuova tra ${opts.restartIn}s (i corsi non si fermano).`)}`);
    } else if (opts.restartHeld) {
      L.push(`     ${c(ANSI.dim, `${opts.restartHeld} — riapro la schermata appena ha finito.`)}`);
    } else {
      L.push(`     ${c(ANSI.dim, 'Questa finestra mostra ancora la versione precedente: chiudila con Q e riapri.')}`);
    }
  }

  // Eventi recenti — con data, e marcati se appartengono a un'esecuzione finita.
  if (model.events && model.events.length) {
    const now = model.now || Date.now();
    // "Vecchio" non significa "di un run precedente": l'ultimo run puo essere
    // finito giorni fa e i suoi eventi restare gli ultimi. Il segnale utile e
    // da quanto NON succede niente — era esattamente il dubbio davanti a un
    // MONITOR ERROR di ieri che sembrava di adesso.
    const newest = model.events[model.events.length - 1];
    const idleMs = newest ? Math.max(0, now - newest.at) : 0;
    const idleNote = idleMs > 15 * 60 * 1000
      ? `  (nessuna attivita da ${formatDuration(idleMs)})`
      : '';
    L.push('');
    L.push(thin);
    L.push(`   ${c(ANSI.dim, 'Ultimi eventi')}${idleNote ? c(ANSI.yellow, idleNote) : ''}`);
    for (const ev of model.events) {
      // Un evento di un run passato non deve avere lo stesso peso visivo di uno
      // appena successo: lo stesso testo, letto senza contesto, faceva pensare
      // a un guasto in corso.
      const old = ev.run > 0;
      const stamp = formatEventStamp(ev.at, now);
      L.push(`     ${c(old ? ANSI.gray : ANSI.maze, GLYPH.bul)} ${c(old ? ANSI.gray : ANSI.dim, stamp.padEnd(11))} ${c(old ? ANSI.gray : ANSI.dim, ev.text)}`);
    }
  }

  // Footer azioni — menu a frecce, niente lettere da ricordare. Le scorciatoie
  // a lettera restano attive nel gestore tasti per chi le conosce, ma non si
  // annunciano più: chi usa la plancia deve solo spostarsi e premere Invio.
  L.push('');
  L.push(rule);
  const menu = Array.isArray(opts.menu) ? opts.menu : [];
  const sel = Number(opts.selected) || 0;
  if (menu.length) {
    const cells = menu.map((item, i) => (i === sel
      // Voce scelta: inversa, così si distingue anche su terminali che
      // schiacciano i colori (e per chi distingue male le sfumature).
      ? `${color ? '\x1b[7;1m' : ''} ${GLYPH.arrow} ${item.label} ${color ? ANSI.reset : ''}`
      : `${c(ANSI.dim, `   ${item.label} `)}`));
    L.push('  ' + cells.join(' '));
    const current = menu[sel];
    if (current && current.help) L.push(`  ${c(ANSI.dim, `${GLYPH.bul} ${current.help}`)}`);
    L.push(`  ${c(ANSI.gray, '← → scegli   Invio conferma   ESC esci lasciando lavorare')}`);
  } else {
    // Modalita non interattiva (--once, pipe): niente menu da evidenziare, ma
    // le azioni vanno comunque elencate.
    L.push('  ' + c(ANSI.dim, 'Guarda dal vivo · Registro attivita · Aggiorna ora · Ferma tutto · Esci'));
    L.push('  ' + c(ANSI.gray, 'Nella plancia interattiva scegli con ← → e conferma con Invio.'));
  }
  if (model.keepAlive) {
    L.push(`  ${c(ANSI.dim, `${GLYPH.bul} Dopo Q l'automazione resta ferma finché non la riavvii tu: il guardiano non la resuscita.`)}`);
  } else {
    L.push(`  ${c(ANSI.yellow, `${GLYPH.warn} Guardiano non attivo: se l'automazione si ferma da sola, rilancia il comando curl per riattivarlo.`)}`);
  }
  const clock = new Date(model.now || Date.now());
  const hhmmss = [clock.getHours(), clock.getMinutes(), clock.getSeconds()]
    .map((n) => String(n).padStart(2, '0')).join(':');
  // Se la schermata si aggiorna ma il CONTENUTO non cambia, il motivo è che lo
  // stato del corso è vecchio (nessun corso in esecuzione adesso): diciamolo,
  // invece di lasciare il dubbio "è bloccata?".
  let ageNote = '';
  if (!model.statusFresh && model.statusAgeMs != null) {
    ageNote = ` ${GLYPH.bul} stato del corso di ${formatDuration(model.statusAgeMs)} fa`;
  }
  L.push(` ${c(ANSI.maze, SPIN[spinIndex % SPIN.length])} ${c(ANSI.dim, `dati aggiornati alle ${hhmmss}${ageNote} ${GLYPH.bul} questa schermata si aggiorna da sola`)}`);
  return L.join('\n');
}

function renderLogView(root, opts = {}) {
  const color = !!opts.color;
  const width = Math.max(48, Math.min(120, opts.width || 100));
  const rows = Math.max(8, opts.rows || 18);
  const spinIndex = opts.spinIndex || 0;
  const now = opts.now || Date.now();
  const c = (code, s2) => (color ? `${code}${s2}${ANSI.reset}` : String(s2));

  // Timeline invece di righe grezze: cosi ogni riga porta la data, e una coda
  // ferma da ieri non si confonde con quello che sta succedendo adesso.
  const all = readTimeline(root);
  const page = all.slice(-rows);
  const last = all.length ? all[all.length - 1] : null;
  const idleMs = last ? Math.max(0, now - last.at) : null;
  // "Dal vivo" solo se il log si sta davvero muovendo: dirlo sempre sarebbe una
  // bugia proprio nel momento in cui uno apre questa finestra per capire se e'
  // fermo.
  const live = idleMs != null && idleMs < 90 * 1000;
  const stato = live
    ? c(ANSI.green, `${GLYPH.dot} dal vivo`)
    : c(ANSI.yellow, `${GLYPH.pause} fermo da ${idleMs == null ? '?' : formatDuration(idleMs)}`);

  const out = [
    ` ${c(ANSI.pac, PAC_FRAMES[spinIndex % PAC_FRAMES.length])} ${c(ANSI.pac, 'LOG')} ${c(ANSI.dim, '(autoplay.log)')}  ${stato}`,
    ' ' + c(ANSI.maze, GLYPH.wall.repeat(width)),
  ];
  if (!page.length) {
    out.push(`  ${c(ANSI.dim, '(nessun log ancora: l\'automazione non ha ancora scritto niente)')}`);
  } else {
    for (const ev of page) {
      const text = redactSensitiveText(ev.text);
      // Colore per significato: gli errori devono saltare all'occhio in un muro
      // di righe tutte uguali.
      let col = ANSI.dim;
      if (/error|errore|SESSIONE PERSA|AUTOLOGIN NON VALIDO|non superato|frozen|scomparso/i.test(text)) col = ANSI.red;
      else if (/superato|completat|finito|verificata/i.test(text)) col = ANSI.green;
      else if (/questionario|quiz|need_help|attesa/i.test(text)) col = ANSI.yellow;
      else if (/^Video: /.test(text)) col = ANSI.eaten;   // battito regolare: sottotono
      const stamp = formatEventStamp(ev.at, now);
      out.push(`  ${c(ANSI.gray, stamp.padEnd(11))} ${c(col, text.slice(0, Math.max(20, width - 16)))}`);
    }
  }
  out.push(' ' + c(ANSI.maze, GLYPH.wall.repeat(width)));
  out.push(`  ${c(ANSI.dim, `${GLYPH.arrow} si aggiorna da solo ${GLYPH.bul} sola lettura: guardare non ferma niente ${GLYPH.bul} Invio o ESC torna alla plancia`)}`);
  return out.join('\n');
}

/**
 * Registro attività: tutti gli eventi con data e ora, dal più recente, divisi
 * per esecuzione. È la risposta a "l'ultimo evento è di ieri ma sembra di
 * adesso": qui il quando è esplicito e si vede dove finisce un'esecuzione e
 * comincia la successiva. Scorribile con le frecce.
 */
function renderRegistryView(root, opts = {}) {
  const color = !!opts.color;
  const width = Math.max(48, Math.min(120, opts.width || 100));
  const rows = Math.max(6, opts.rows || 16);
  const now = opts.now || Date.now();
  const c = (code, s) => (color ? `${code}${s}${ANSI.reset}` : String(s));

  // Dal più recente in cima: si legge come una cronologia, non come un file.
  const items = readTimeline(root).filter((e) => EVENT_PATTERN.test(e.raw)).reverse();
  const maxOffset = Math.max(0, items.length - rows);
  const offset = Math.max(0, Math.min(Number(opts.offset) || 0, maxOffset));
  const page = items.slice(offset, offset + rows);

  const out = [
    ` ${c(ANSI.pac, GLYPH.pacOpen)} ${c(ANSI.pac, 'REGISTRO ATTIVITÀ')} ${c(ANSI.dim, `${items.length} eventi`)}`,
    ' ' + c(ANSI.maze, GLYPH.wall.repeat(width)),
  ];
  if (!page.length) {
    out.push(`  ${c(ANSI.dim, '(nessun evento registrato)')}`);
  } else {
    let prevRun = null;
    for (const ev of page) {
      if (prevRun !== null && ev.run !== prevRun) {
        out.push(`  ${c(ANSI.gray, GLYPH.h.repeat(12) + ' esecuzione precedente ' + GLYPH.h.repeat(Math.max(0, width - 36)))}`);
      }
      prevRun = ev.run;
      const old = ev.run > 0;
      const stamp = formatEventStamp(ev.at, now).padEnd(11);
      const text = redactSensitiveText(ev.text).slice(0, Math.max(20, width - 16));
      out.push(`  ${c(old ? ANSI.gray : ANSI.maze, GLYPH.bul)} ${c(old ? ANSI.gray : ANSI.pellet, stamp)} ${c(old ? ANSI.gray : ANSI.dim, text)}`);
    }
  }
  out.push(' ' + c(ANSI.maze, GLYPH.wall.repeat(width)));
  const pos = items.length > rows
    ? `${offset + 1}-${Math.min(offset + rows, items.length)} di ${items.length}`
    : 'tutti';
  out.push(`  ${c(ANSI.dim, `${GLYPH.arrow} ↑↓ scorri ${GLYPH.bul} ${pos} ${GLYPH.bul} Invio o ESC torna alla plancia`)}`);
  return out.join('\n');
}

// ── Loop interattivo ────────────────────────────────────────────────────────
// Chiude SOLO la scheda/sessione corrente del Terminale al termine di "ferma" o
// di "Q" (best-effort, solo per app note). MAI l'applicazione: sullo stesso Mac
// possono esserci altre finestre/schede che fanno tutt'altro. Terminali non
// riconosciuti (VS Code, Warp, Ghostty…) → no-op: il processo esce e la scheda
// resta aperta, la chiude l'utente.
function terminalCloseScript(termProgram) {
  const t = String(termProgram || '');
  if (/Apple_Terminal/i.test(t)) return 'tell application "Terminal" to close (selected tab of front window)';
  if (/iTerm/i.test(t)) return 'tell application "iTerm2" to tell current window to tell current session to close';
  return null;
}
function closeTerminalTab() {
  const script = terminalCloseScript(process.env.TERM_PROGRAM);
  if (!script) return false;
  try { spawnSync('osascript', ['-e', script], { stdio: 'ignore', timeout: 5000 }); return true; } catch (_) { return false; }
}

/**
 * Decide se la plancia deve riaprirsi con il codice nuovo. Pura (testabile).
 *
 * Il riavvio della PLANCIA non tocca i corsi (è solo una finestra di lettura),
 * ma per non far ballare lo schermo sotto il naso di chi sta guardando aspetta:
 * - che il codice sul disco sia davvero diverso da quello con cui è partita;
 * - che non si stia leggendo il log dal vivo o confermando una fermata;
 * - che non ci sia un quiz in corso o una fase delicata (max `holdMaxMs`, poi
 *   procede comunque: la finestra vecchia non deve restare vecchia per sempre).
 *
 * @returns {{ action: 'none'|'wait'|'restart', seconds?: number, reason?: string }}
 */
function planPanelRestart(state = {}) {
  const {
    bootSha, headSha, now = Date.now(), detectedAt = null,
    noticeMs = 6000, holdMaxMs = 5 * 60 * 1000,
    view = 'panel', confirmStop = false, busy = false, busyLabel = '',
  } = state;
  if (!bootSha || !headSha || bootSha === headSha) return { action: 'none' };
  if (detectedAt == null) return { action: 'wait', seconds: Math.ceil(noticeMs / 1000) };
  const waited = now - detectedAt;
  if (view !== 'panel' || confirmStop) return { action: 'wait', reason: 'schermata occupata' };
  if (busy && waited < holdMaxMs) {
    return { action: 'wait', reason: busyLabel || 'lavoro delicato in corso' };
  }
  const left = Math.ceil((noticeMs - waited) / 1000);
  if (left > 0) return { action: 'wait', seconds: left };
  return { action: 'restart' };
}

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

  // Commit con cui questa finestra è partita: se l'auto-update aggiorna i file
  // mentre la plancia resta aperta, il confronto lo rende visibile al collega.
  let bootSha = null;
  try { bootSha = updateState.readHeadSha(args.root); } catch (_) { bootSha = null; }

  // Fallback non-interattivo: un frame e via (headless, pipe, --once).
  let ttyFd = null;
  if (!args.once) {
    try { ttyFd = fs.openSync('/dev/tty', 'r'); } catch (_) { ttyFd = null; }
  }
  if (args.once || !process.stdout.isTTY || ttyFd == null) {
    process.stdout.write(renderFrame(readModel(args.root), { color, width, bootSha }) + '\n');
    if (ttyFd != null) { try { fs.closeSync(ttyFd); } catch (_) {} }
    return 0;
  }

  const input = new tty.ReadStream(ttyFd);
  let spinIndex = 0;
  let view = 'panel'; // 'panel' | 'log' | 'registro'
  let confirmStop = false;
  // Menu del footer: l'ordine mette per primo ciò che si guarda, per ultimo ciò
  // che ferma. La voce distruttiva non è mai quella selezionata all'apertura.
  const MENU = [
    { id: 'log', label: 'Guarda dal vivo', help: 'Mostra il log mentre scorre. Sola lettura: guardare non ferma niente.' },
    { id: 'registro', label: 'Registro attività', help: 'Cronologia con data e ora, divisa per esecuzione.' },
    { id: 'refresh', label: 'Aggiorna ora', help: 'Rilegge subito lo stato senza aspettare il prossimo giro.' },
    { id: 'stop', label: 'Ferma tutto', help: 'Ferma corsi, scheduler e guardiano, poi chiude la scheda. Chiede conferma.' },
    { id: 'exit', label: 'Esci', help: 'Chiude solo questa scheda: i corsi continuano a lavorare.' },
  ];
  let selected = 0;
  let regOffset = 0;
  let timer = null;
  let closed = false;
  // Dati in cache: la rilettura dei file resta a REFRESH_MS, il ridisegno gira a
  // ANIM_MS così le animazioni (Pac-Man, spinner) sono fluide senza più I/O.
  let model = readModel(args.root);
  let lastRead = Date.now();

  // Riavvio automatico della plancia quando l'auto-update cambia il codice
  // sotto i piedi di questa finestra (prima restava vecchia e bisognava
  // chiuderla a mano). Il contatore GSD_PANEL_RELAUNCH evita catene infinite.
  let codeChangedAt = null;
  let restartPlan = { action: 'none' };
  const relaunchCount = Number(process.env.GSD_PANEL_RELAUNCH || 0);

  const relaunchWithNewCode = () => {
    teardown();
    process.stdout.write('\n Mi riapro con la versione nuova (i corsi continuano)…\n');
    const res = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      env: { ...process.env, GSD_PANEL_RELAUNCH: String(relaunchCount + 1) },
    });
    process.exit(res && res.status != null ? res.status : 0);
  };

  const draw = () => {
    let frame;
    if (view === 'log') {
      frame = renderLogView(args.root, { color, width, spinIndex, rows: Math.max(8, (process.stdout.rows || 24) - 6) });
    } else if (view === 'registro') {
      const rows = Math.max(6, (process.stdout.rows || 24) - 8);
      frame = renderRegistryView(args.root, { color, width, rows, offset: regOffset });
    } else {
      frame = renderFrame(model, {
        color,
        width,
        spinIndex,
        bootSha,
        menu: MENU,
        selected,
        restartIn: restartPlan.action === 'wait' ? restartPlan.seconds : null,
        restartHeld: restartPlan.action === 'wait' ? restartPlan.reason : null,
      });
    }
    const extra = (view === 'panel' && confirmStop)
      ? `\n  ${color ? ANSI.red : ''}Premere di nuovo Q per fermare corsi e scheduler e chiudere la scheda, un altro tasto per annullare.${color ? ANSI.reset : ''}`
      : '';
    // Redraw IN PLACE: cursore a casa, ogni riga pulita fino a fine riga
    // (\x1b[K) e pulizia finale sotto (\x1b[J). Con un clear-screen a 4 fps si
    // vedrebbe sfarfallare.
    const body = (frame + extra).split('\n').join('\x1b[K\n');
    process.stdout.write(`\x1b[H${body}\x1b[K\n\x1b[J`);
  };

  const refreshNow = () => {
    model = readModel(args.root);
    lastRead = Date.now();
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

  const quit = (msg, opts = {}) => {
    teardown();
    if (msg) process.stdout.write(msg + '\n');
    // Q chiude SOLO questa scheda del Terminale (mai l'app: altre finestre
    // possono fare tutt'altro). Ctrl-C/SIGTERM invece lasciano la scheda aperta.
    if (opts.closeTab) closeTerminalTab();
    process.exit(0);
  };

  const doStop = () => {
    teardown();
    process.stdout.write('\nFermo i corsi e chiudo questa scheda…\n');
    const stop = path.join(args.root, 'stop.sh');
    try { spawnSync(stop, [], { stdio: 'inherit' }); } catch (_) {}
    closeTerminalTab();
    process.exit(0);
  };

  const onKey = (key) => {
    const k = String(key);
    // Ctrl-C: esce dalla plancia ma NON chiude la scheda (è la via d'uscita
    // "non distruttiva", utile anche in debug).
    if (k === '\u0003') return quit('Plancia chiusa. I corsi restano come sono.');

    // Le frecce arrivano come sequenza di 3 caratteri in un colpo solo, quindi
    // non si confondono con ESC "nudo" (1 carattere). Vanno però intercettate
    // PRIMA, altrimenti muoversi nel menu chiuderebbe la plancia.
    const UP = k === '\u001b[A';
    const DOWN = k === '\u001b[B';
    const RIGHT = k === '\u001b[C';
    const LEFT = k === '\u001b[D';
    const ENTER = k === '\r' || k === '\n';
    const ESC = k === '\u001b';

    if (view === 'log') { if (ENTER || ESC || /^[qQ]$/.test(k)) { view = 'panel'; draw(); } return; }

    if (view === 'registro') {
      if (UP) { regOffset = Math.max(0, regOffset - 1); draw(); return; }
      if (DOWN) { regOffset += 1; draw(); return; }
      if (k === '\u001b[5~') { regOffset = Math.max(0, regOffset - 10); draw(); return; }
      if (k === '\u001b[6~') { regOffset += 10; draw(); return; }
      if (ENTER || ESC || /^[qQ]$/.test(k)) { view = 'panel'; regOffset = 0; draw(); }
      return;
    }

    if (confirmStop) {
      confirmStop = false;
      // Conferma con Invio (coerente col menu) o con la vecchia scorciatoia Q/F.
      if (ENTER || /^[qQfF]$/.test(k)) return doStop();
      draw();
      return;
    }

    const activate = (id) => {
      switch (id) {
        case 'log': view = 'log'; draw(); return;
        case 'registro': view = 'registro'; regOffset = 0; draw(); return;
        case 'refresh': refreshNow(); draw(); return;
        // Azione pesante su un Mac che sta lavorando: sempre una conferma.
        case 'stop': confirmStop = true; draw(); return;
        case 'exit': {
          const tail = model.keepAlive
            ? 'I corsi continuano e il guardiano li tiene in vita.'
            : 'Attenzione: il guardiano non è attivo — se l\'automazione si ferma, rilancia il comando curl.';
          return quit(`Esco dalla plancia senza fermare nulla. ${tail}`, { closeTab: true });
        }
        default: return;
      }
    };

    // Destra/sinistra scorrono il menu; su/giù fanno lo stesso per chi se lo
    // aspetta verticale. Non si esce mai per sbaglio muovendosi.
    if (RIGHT || DOWN) { selected = (selected + 1) % MENU.length; draw(); return; }
    if (LEFT || UP) { selected = (selected - 1 + MENU.length) % MENU.length; draw(); return; }
    if (ENTER || k === ' ') return activate(MENU[selected].id);
    if (ESC) return activate('exit');

    // Scorciatoie storiche: non più annunciate, ma chi le ha nelle dita le trova.
    if (/^[qQfF]$/.test(k)) return activate('stop');
    if (/^[lL]$/.test(k)) return activate('log');
    if (/^[rR]$/.test(k)) return activate('refresh');
    if (/^[aA]$/.test(k)) return activate('registro');
  };

  try { input.setRawMode(true); } catch (_) {
    // Nessun raw mode disponibile: ripiega su singolo frame.
    process.stdout.write(renderFrame(readModel(args.root), { color, width, bootSha }) + '\n');
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
  process.stdout.write('\x1b[2J');   // una sola pulizia iniziale: poi si ridisegna in place
  draw();
  // Un solo timer a ritmo di animazione: rilegge i file solo ogni `interval`.
  timer = setInterval(() => {
    spinIndex += 1;
    if (Date.now() - lastRead >= args.interval) refreshNow();
    if (bootSha && model.headSha && bootSha !== model.headSha && codeChangedAt == null) {
      codeChangedAt = Date.now();
    }
    const busyPhase = ['quiz', 'quiz_dashboard', 'quiz_needs_answers', 'checking'].includes(model.status.phase);
    restartPlan = planPanelRestart({
      bootSha,
      headSha: model.headSha,
      detectedAt: codeChangedAt,
      view,
      confirmStop,
      busy: model.claudeWorking || busyPhase,
      busyLabel: model.claudeWorking ? 'Claude sta risolvendo un quiz' : 'quiz in corso',
    });
    draw();
    // Max 3 riaperture per sessione: se qualcosa va storto meglio una finestra
    // vecchia che un ciclo di riavvii.
    if (restartPlan.action === 'restart' && relaunchCount < 3) relaunchWithNewCode();
  }, ANIM_MS);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(); }
  catch (e) { process.stderr.write(`[panel] ${e && e.message}\n`); process.exitCode = 1; }
}

module.exports = {
  parseClockSeconds, videoPercent, progressBar, pacmanBar, pacmanSegments, paintPacman, pacmanCellColor,
  PAC_FRAMES, GLYPH,
  formatDuration, relativeTime, formatWhen, formatEventStamp, parseLogTimeline,
  courseIdFromUrl, computeHeadline, readModel, renderFrame, renderLogView, stripAnsi, visLen,
  terminalCloseScript, readVersion, keepAliveInstalled, planPanelRestart,
  renderRegistryView,
};
