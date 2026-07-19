#!/usr/bin/env node
/**
 * weekly-report-cli.js — report locale privacy-safe per referente.
 *
 *   node scripts/lib/weekly-report-cli.js           # testo stdout (168h metrics)
 *   node scripts/lib/weekly-report-cli.js --save    # + logs/weekly-report-YYYY-MM-DD.txt
 *   node scripts/lib/weekly-report-cli.js --hours 24
 *
 * Dati: data/dashboard.json (rigenerato) + logs/metrics.jsonl.
 * Locale: può mostrare CF; non invia nulla in rete.
 */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const dash = require(path.join(ROOT, 'src', 'lib', 'dashboard'));
const { summarizeMetrics } = require(path.join(ROOT, 'src', 'lib', 'metrics'));

function parseArgs(argv) {
  let hours = 168;
  let save = false;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--save') save = true;
    else if (argv[i] === '--hours' && argv[i + 1]) {
      hours = Number(argv[++i]) || 168;
    }
  }
  return { hours, save };
}

/**
 * Pure: costruisce testo report.
 * @param {object} d dashboard
 * @param {object} m metrics summary
 * @returns {string}
 */
function formatWeeklyReport(d, m) {
  const lines = [];
  const now = new Date().toISOString();
  lines.push(`GSD Campus — report locale (${now})`);
  lines.push(`Metriche ultime ${m.hours}h: ${m.total} eventi phase`);
  lines.push('');
  lines.push('=== Membri ===');
  lines.push(
    `Totale ${d.total}: done=${d.done} in_progress=${d.in_progress} need_help=${d.need_help} not_started=${d.not_started}`
  );
  for (const mem of d.perMember || []) {
    const s = mem.summary || {};
    const bits = [
      mem.codice_fiscale,
      mem.name || '?',
      mem.status,
      `${s.done || 0}/${s.total || 0}`,
      (s.needHelp || 0) > 0 ? `need_help=${s.needHelp}` : null,
      mem.lastPhase ? `phase=${mem.lastPhase}` : null,
      mem.running ? 'RUNNING' : null,
    ].filter(Boolean);
    lines.push('  ' + bits.join(' — '));
  }
  lines.push('');
  lines.push('=== Phase (metrics) ===');
  const entries = Object.entries(m.byPhase || {}).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    lines.push('  (nessun evento)');
  } else {
    for (const [phase, n] of entries) {
      lines.push(`  ${phase}: ${n}`);
    }
  }
  lines.push('');
  lines.push('Generato da scripts/lib/weekly-report-cli.js (solo locale).');
  return lines.join('\n') + '\n';
}

function main() {
  const { hours, save } = parseArgs(process.argv);
  const d = dash.writeDashboard(ROOT);
  const m = summarizeMetrics(ROOT, { hours });
  const text = formatWeeklyReport(d, m);
  process.stdout.write(text);
  if (save) {
    const day = new Date().toISOString().slice(0, 10);
    const out = path.join(ROOT, 'logs', `weekly-report-${day}.txt`);
    try {
      fs.mkdirSync(path.join(ROOT, 'logs'), { recursive: true });
      fs.writeFileSync(out, text, 'utf8');
      console.error(`Salvato: ${out}`);
    } catch (e) {
      console.error('Impossibile salvare:', e.message);
      process.exit(1);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = { formatWeeklyReport };
