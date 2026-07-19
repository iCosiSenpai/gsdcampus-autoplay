#!/usr/bin/env node
/**
 * selector-probe.js — verifica che i marker DOM critici siano ancora presenti
 * nelle fixture HTML di test (regressione layout piattaforma).
 *
 * Uso: node scripts/lib/selector-probe.js
 * Exit 0 = tutti i required ok; 1 = missing.
 */
const path = require('path');
const { probeFixtures, SELECTORS } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'selectors'));

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'selectors');

// Catalogo non vuoto (sanity).
if (!SELECTORS.dashboard || !SELECTORS.quiz) {
  console.error('selectors.js: catalogo incompleto');
  process.exit(1);
}

const report = probeFixtures(FIXTURES);
for (const p of report.pages) {
  const status = p.ok ? 'ok' : 'FAIL';
  const miss = p.missing && p.missing.length ? ` missing=[${p.missing.join(', ')}]` : '';
  console.log(`  [${status}] ${p.page}${miss}`);
}

if (report.ok) {
  console.log('Selector probe: tutti i marker required presenti nelle fixture.');
  process.exit(0);
}

console.error('Selector probe: marker mancanti: ' + report.missing.join(', '));
console.error('La piattaforma potrebbe aver cambiato layout — aggiorna il progetto o apri issue.');
process.exit(1);
