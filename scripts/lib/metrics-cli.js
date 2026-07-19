#!/usr/bin/env node
/**
 * metrics-cli.js — riepilogo eventi da logs/metrics.jsonl (privacy-safe).
 *
 *   node scripts/lib/metrics-cli.js summary [ore]   # default 24
 *   node scripts/lib/metrics-cli.js tail [n]        # ultime N righe (default 20)
 *   node scripts/lib/metrics-cli.js share [ore]     # POST batch se shareMetrics:true (default 168h)
 */
const path = require('path');
const { summarizeMetrics, readMetricsTail } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'metrics'));

const ROOT = path.join(__dirname, '..', '..');
const cmd = process.argv[2] || 'summary';

if (cmd === 'summary') {
  const hours = process.argv[3] ? Number(process.argv[3]) : 24;
  const s = summarizeMetrics(ROOT, { hours: Number.isFinite(hours) ? hours : 24 });
  console.log(`Metriche ultime ${s.hours}h (${s.total} eventi phase)`);
  if (s.total === 0) {
    console.log('  (nessun evento — l\'autoplay non ha ancora cambiato fase, o il file manca)');
    process.exit(0);
  }
  const entries = Object.entries(s.byPhase).sort((a, b) => b[1] - a[1]);
  for (const [phase, n] of entries) {
    console.log(`  ${phase}: ${n}`);
  }
} else if (cmd === 'tail') {
  const n = process.argv[3] ? parseInt(process.argv[3], 10) : 20;
  const rows = readMetricsTail(ROOT, Number.isFinite(n) ? n : 20);
  if (rows.length === 0) {
    console.log('(vuoto)');
    process.exit(0);
  }
  for (const r of rows) {
    const bits = [r.ts, r.phase || '-', r.courseId ? `corso=${r.courseId}` : null, r.quiz ? `quiz=${r.quiz}` : null]
      .filter(Boolean);
    console.log(bits.join('  '));
  }
} else if (cmd === 'share') {
  const hours = process.argv[3] ? Number(process.argv[3]) : 168;
  const force = process.argv.includes('--force');
  const { shareMetrics } = require('./metrics-share');
  shareMetrics({ hours: Number.isFinite(hours) ? hours : 168, force }).then((res) => {
    if (res.skipped) {
      console.log(`Share saltato: ${res.reason} (abilita shareMetrics:true in config.json o usa --force).`);
      process.exit(0);
    }
    if (res.ok) {
      console.log(`Metriche inviate (total=${res.total != null ? res.total : '?'}, phases=${res.phases != null ? res.phases : '?'}).`);
      process.exit(0);
    }
    console.error('Share fallito:', res.error || res.reason, res.detail || '');
    process.exit(1);
  }).catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
} else {
  console.error('Uso: node scripts/lib/metrics-cli.js summary|tail|share [n]');
  process.exit(1);
}
