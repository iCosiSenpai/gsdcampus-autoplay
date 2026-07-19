/**
 * dashboard.js — stato aggregato cross-utente.
 *
 * Legge i course_state.json di ogni account in data/accounts/<CF>/ e produce
 * un riepilogo (quanti membri done / in_progress / need_help / not_started)
 * scritto in data/dashboard.json. Leggibile dal supervisore AI e da
 * scripts/lib/dashboard-cli.js.
 */

const fs = require('fs');
const path = require('path');
const courseState = require('./course-state');
const db = require('./db');
const { writeJsonAtomic } = require('./io');

function accountsDir(root) {
  return path.join(root, 'data', 'accounts');
}

function listAccountCfs(root) {
  const dir = accountsDir(root);
  try {
    return fs.readdirSync(dir).filter(f =>
      fs.statSync(path.join(dir, f)).isDirectory());
  } catch (e) {
    return [];
  }
}

/**
 * Status derivato dal summarize di un singolo account.
 * - not_started: nessun course_state.json o zero corsi
 * - done: tutti i corsi done
 * - need_help: almeno un need_help
 * - in_progress: corsi presenti, non tutti done, nessun need_help
 */
function statusFromSummary(sum) {
  if (!sum || sum.total === 0) return 'not_started';
  if (sum.needHelp > 0) return 'need_help';
  if (sum.done === sum.total) return 'done';
  return 'in_progress';
}

/**
 * Età in minuti di un file (mtime), o null se assente.
 */
function fileAgeMinutes(filePath) {
  try {
    const st = fs.statSync(filePath);
    return Math.max(0, Math.round((Date.now() - st.mtimeMs) / 60000));
  } catch (_) {
    return null;
  }
}

/**
 * Ultimo updatedAt tra i corsi nello state (ISO), o null.
 */
function lastCourseActivity(state) {
  let best = null;
  for (const c of Object.values(state || {})) {
    if (c && c.updatedAt) {
      if (!best || String(c.updatedAt) > best) best = String(c.updatedAt);
    }
  }
  return best;
}

function collectAccountStates(root) {
  const cfs = listAccountCfs(root);
  const out = [];
  // Status runtime del membro attivo (logs/status.json): se il CF coincide, arricchiamo.
  let liveStatus = null;
  try {
    liveStatus = JSON.parse(fs.readFileSync(path.join(root, 'logs', 'status.json'), 'utf8'));
  } catch (_) { liveStatus = null; }
  let activeCf = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    activeCf = cfg.codice_fiscale ? String(cfg.codice_fiscale).toUpperCase() : null;
  } catch (_) {}

  for (const cf of cfs) {
    const member = db.getMember(root, cf);
    // course-state legge già dal path per-account del CF attivo; per leggere
    // un CF arbitrario ricostruiamo il path direttamente.
    const statePath = path.join(accountsDir(root), cf, 'course_state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { state = {}; }
    const summary = courseState.summarize(state);
    const lastActivity = lastCourseActivity(state);
    const stateAgeMin = fileAgeMinutes(statePath);
    const row = {
      codice_fiscale: cf,
      name: member ? [member.cognome, member.nome].filter(Boolean).join(' ') : null,
      status: statusFromSummary(summary),
      summary,
      needHelp: summary.needHelp || 0,
      lastActivity,
      stateAgeMin,
      lastPhase: null,
      lastUpdate: null,
      running: false,
    };
    if (activeCf && cf.toUpperCase() === activeCf && liveStatus) {
      row.lastPhase = liveStatus.phase || null;
      row.lastUpdate = liveStatus.lastUpdate || null;
      row.running = !!liveStatus.running;
      if (liveStatus.lastUpdate) {
        const t = Date.parse(liveStatus.lastUpdate);
        if (Number.isFinite(t)) {
          row.statusAgeMin = Math.max(0, Math.round((Date.now() - t) / 60000));
        }
      }
    }
    out.push(row);
  }
  return out;
}

function buildDashboard(root) {
  const per = collectAccountStates(root);
  const counts = { done: 0, in_progress: 0, need_help: 0, not_started: 0 };
  for (const m of per) counts[m.status]++;
  return {
    total: per.length,
    ...counts,
    perMember: per,
    updatedAt: new Date().toISOString()
  };
}

function writeDashboard(root) {
  const dash = buildDashboard(root);
  const out = path.join(root, 'data', 'dashboard.json');
  try {
    // Scrittura atomica (tmp + rename).
    writeJsonAtomic(out, dash);
  } catch (e) { /* best-effort */ }
  return dash;
}

/**
 * Export CSV per referente (no autologin, no cookie). Pure string.
 */
function dashboardToCsv(dash) {
  const header = [
    'codice_fiscale', 'name', 'status', 'done', 'need_help', 'in_progress', 'total',
    'last_activity', 'state_age_min', 'last_phase', 'last_update', 'running',
  ];
  const lines = [header.join(',')];
  const esc = (v) => {
    if (v == null || v === '') return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  for (const m of (dash && dash.perMember) || []) {
    const s = m.summary || {};
    lines.push([
      esc(m.codice_fiscale),
      esc(m.name),
      esc(m.status),
      s.done != null ? s.done : '',
      s.needHelp != null ? s.needHelp : (m.needHelp != null ? m.needHelp : ''),
      s.inProgress != null ? s.inProgress : '',
      s.total != null ? s.total : '',
      esc(m.lastActivity),
      m.stateAgeMin != null ? m.stateAgeMin : '',
      esc(m.lastPhase),
      esc(m.lastUpdate),
      m.running ? '1' : '0',
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  accountsDir,
  listAccountCfs,
  collectAccountStates,
  statusFromSummary,
  buildDashboard,
  writeDashboard,
  dashboardToCsv,
  fileAgeMinutes,
  lastCourseActivity,
};