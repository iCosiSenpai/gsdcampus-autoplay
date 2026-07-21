#!/usr/bin/env node

const path = require('path');
const { usageSummary } = require('../../src/lib/ai-budget');

const root = path.resolve(__dirname, '..', '..');
const asJson = process.argv.includes('--json');
const summary = usageSummary(root);

if (asJson) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  console.log(`AI cloud — 7 giorni: ${summary.used.weekly}/${summary.limits.weekly} (restano ${summary.remaining.weekly})`);
  console.log(`AI cloud — 24 ore: ${summary.used.daily}/${summary.limits.daily} (restano ${summary.remaining.daily})`);
  console.log(`AI cloud — 1 minuto: ${summary.used.perMinute}/${summary.limits.perMinute} (restano ${summary.remaining.perMinute})`);
}
