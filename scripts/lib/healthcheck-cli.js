#!/usr/bin/env node
/**
 * Helper CLI per la sonda LIVE dell'autologin.
 *
 * Uso:
 *   node scripts/lib/healthcheck-cli.js          → output leggibile + exit code
 *   node scripts/lib/healthcheck-cli.js --json    → output JSON (per altri script)
 *
 * Exit code: 0 = autologin valido, 1 = non valido/errore. Così gli script shell
 * possono usarlo direttamente in un `if`.
 */

const path = require('path');
const { checkAutologin } = require('../../src/lib/healthcheck');

const ROOT = path.join(__dirname, '..', '..');
const asJson = process.argv.includes('--json');

(async () => {
  const r = await checkAutologin(ROOT, { timeoutMs: 60000 });
  if (asJson) {
    console.log(JSON.stringify(r, null, 2));
  } else if (r.ok) {
    console.log(`OK — ${r.reason} (${(r.durationMs / 1000).toFixed(1)}s)`);
  } else {
    console.log(`KO — ${r.reason} (${(r.durationMs / 1000).toFixed(1)}s)`);
    if (r.finalUrl) console.log(`URL finale: ${r.finalUrl}`);
  }
  process.exit(r.ok ? 0 : 1);
})().catch((e) => {
  console.error('Errore healthcheck:', e.message);
  process.exit(1);
});
