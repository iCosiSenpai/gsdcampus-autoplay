const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { formatWeeklyReport } = require('../scripts/lib/weekly-report-cli');

describe('formatWeeklyReport', () => {
  it('includes member and phase lines', () => {
    const text = formatWeeklyReport(
      {
        total: 1,
        done: 0,
        in_progress: 1,
        need_help: 0,
        not_started: 0,
        perMember: [{
          codice_fiscale: 'CSOLSS95L23D862R',
          name: 'COSI ALESSIO',
          status: 'in_progress',
          summary: { done: 4, total: 5, needHelp: 0 },
          lastPhase: 'video',
          running: true,
        }],
      },
      { hours: 168, total: 10, byPhase: { video: 7, quiz: 3 } }
    );
    assert.match(text, /CSOLSS95L23D862R/);
    assert.match(text, /video: 7/);
    assert.match(text, /RUNNING/);
  });
});
