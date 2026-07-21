#!/usr/bin/env node
const path = require('path');
const lock = require(path.join(__dirname, '..', '..', 'src', 'lib', 'runtime-lock'));

const cmd = process.argv[2];
const root = path.resolve(process.argv[3] || path.join(__dirname, '..', '..'));

function output(value) { process.stdout.write(JSON.stringify(value) + '\n'); }

if (cmd === 'acquire') {
  const out = lock.acquireLock(root, { pid: Number(process.argv[4]), token: process.argv[5] });
  output(out); process.exit(out.ok ? 0 : (out.reason === 'active' ? 3 : 1));
}
if (cmd === 'promote') {
  const out = lock.promoteLock(root, process.argv[4], Number(process.argv[5]));
  output(out); process.exit(out.ok ? 0 : 1);
}
if (cmd === 'release') {
  const out = lock.releaseLock(root, process.argv[4]);
  output(out); process.exit(out.ok ? 0 : 1);
}
if (cmd === 'owns') {
  const ok = lock.lockOwnedBy(root, process.argv[4], Number(process.argv[5]));
  process.exit(ok ? 0 : 1);
}
if (cmd === 'clean') {
  const out = lock.cleanStaleLock(root);
  output(out); process.exit(out.ok ? 0 : 3);
}
if (cmd === 'status') {
  const out = lock.inspectLock(root);
  output(out); process.exit(out.alive ? 0 : 1);
}
if (cmd === 'pid') {
  const out = lock.inspectLock(root);
  if (out.alive) process.stdout.write(String(out.owner.pid));
  process.exit(out.alive ? 0 : 1);
}

process.stderr.write('Uso: runtime-lock-cli.js acquire|promote|release|owns|clean|status|pid <root> [...]\n');
process.exit(2);
