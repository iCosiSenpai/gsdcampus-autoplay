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

function collectAccountStates(root) {
  const cfs = listAccountCfs(root);
  const out = [];
  for (const cf of cfs) {
    const member = db.getMember(root, cf);
    // course-state legge già dal path per-account del CF attivo; per leggere
    // un CF arbitrario ricostruiamo il path direttamente.
    const statePath = path.join(accountsDir(root), cf, 'course_state.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (e) { state = {}; }
    const summary = courseState.summarize(state);
    out.push({
      codice_fiscale: cf,
      name: member ? [member.cognome, member.nome].filter(Boolean).join(' ') : null,
      status: statusFromSummary(summary),
      summary
    });
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
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(dash, null, 2));
  } catch (e) { /* best-effort */ }
  return dash;
}

module.exports = {
  accountsDir,
  listAccountCfs,
  collectAccountStates,
  statusFromSummary,
  buildDashboard,
  writeDashboard
};