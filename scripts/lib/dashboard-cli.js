#!/usr/bin/env node
/**
 * dashboard-cli.js — stato aggregato cross-utente.
 *
 * Comandi:
 *   node scripts/lib/dashboard-cli.js summary   (default)
 *       Una riga: Totale N: X done, Y in_progress, Z need_help, W not_started
 *   node scripts/lib/dashboard-cli.js list
 *       Una riga per membro: CF — Nome — stato — done/total
 *   node scripts/lib/dashboard-cli.js json
 *       Stampa data/dashboard.json (lo rigenera prima).
 */

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const dash = require(path.join(ROOT, 'src', 'lib', 'dashboard'));

const cmd = process.argv[2] || 'summary';

if (cmd === 'json') {
  const d = dash.writeDashboard(ROOT);
  console.log(JSON.stringify(d, null, 2));
} else if (cmd === 'list') {
  const d = dash.buildDashboard(ROOT);
  if (d.perMember.length === 0) {
    console.log('Nessun account con stato. Avvia almeno una volta autoplay per un membro.');
    process.exit(0);
  }
  for (const m of d.perMember) {
    const name = m.name || '(non in DB)';
    const s = m.summary;
    console.log(`${m.codice_fiscale} — ${name} — ${m.status} — ${s.done}/${s.total} corsi`);
  }
  console.log(`\nTotale: ${d.total} — done: ${d.done}, in_progress: ${d.in_progress}, need_help: ${d.need_help}, not_started: ${d.not_started}`);
} else if (cmd === 'summary') {
  const d = dash.buildDashboard(ROOT);
  console.log(`Totale ${d.total}: ${d.done} done, ${d.in_progress} in_progress, ${d.need_help} need_help, ${d.not_started} not_started`);
} else {
  console.error(`Comando sconosciuto: ${cmd}\nComandi: summary | list | json`);
  process.exit(1);
}