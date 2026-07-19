#!/usr/bin/env node
/**
 * status-cli.js — helper status runtime.
 *
 *   node scripts/lib/status-cli.js reconcile [--force-stopped]
 *       Allinea logs/status.json ai processi vivi (running orfano → false).
 *   node scripts/lib/status-cli.js show
 *       Stampa lo status (delega a status-print.js).
 */
const path = require('path');
const { reconcileStatusFile } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'status-reconcile'));

const ROOT = path.join(__dirname, '..', '..');
const cmd = process.argv[2] || 'reconcile';
const forceStopped = process.argv.includes('--force-stopped');

if (cmd === 'reconcile') {
  const out = reconcileStatusFile(ROOT, { forceStopped });
  if (out.changed) {
    console.log(`status riconciliato (${out.reason || 'ok'}): running=${out.status && out.status.running} phase=${out.status && out.status.phase}`);
  } else {
    console.log('status già coerente con i processi.');
  }
  process.exit(0);
}

if (cmd === 'show') {
  require(path.join(__dirname, 'status-print.js'));
  process.exit(0);
}

console.error('Uso: node scripts/lib/status-cli.js reconcile|show [--force-stopped]');
process.exit(1);
