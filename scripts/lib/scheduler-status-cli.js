#!/usr/bin/env node
const path = require('path');
const { writeSchedulerStatus, stopSchedulerStatus } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'scheduler-status'));

const cmd = process.argv[2];
const root = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));
if (cmd === 'mark') {
  const phase = process.argv[4];
  if (!phase) { process.stderr.write('phase mancante\n'); process.exit(2); }
  const status = writeSchedulerStatus(root, phase, {
    nextStart: process.argv[5] || null,
    note: process.argv[6] || null,
    error: process.argv[7] || null,
  });
  process.stdout.write(JSON.stringify({ phase: status.phase, lastUpdate: status.lastUpdate }) + '\n');
  process.exit(0);
}
if (cmd === 'stop') {
  const status = stopSchedulerStatus(root);
  process.stdout.write(JSON.stringify({ phase: status.phase, lastUpdate: status.lastUpdate }) + '\n');
  process.exit(0);
}
process.stderr.write('Uso: scheduler-status-cli.js mark <root> <phase> [nextStart] [note] [error] | stop <root>\n');
process.exit(2);
