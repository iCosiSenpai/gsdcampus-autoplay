/**
 * receiver-config.js — endpoint + chiave del Cloudflare Worker condivisi da
 * issue-report.js (segnalazione bug) e answers-share.js (banca risposte).
 *
 * Il PAT GitHub NON sta qui: è secret lato Worker (ISSUE_TOKEN).
 * KEY è non-segreta (filtra bot trivial); allineata a worker/wrangler.toml.
 */

module.exports = {
  // Worker deployato dal maintainer (vedi worker/README.md).
  DEFAULT_ENDPOINT: 'https://gsd-issue-report.lookatale95.workers.dev',
  // Non-segreta; deve coincidere con [vars].KEY in worker/wrangler.toml.
  DEFAULT_KEY: 'gsd-autoplay-report-key-2026-7f3a9c',
};
