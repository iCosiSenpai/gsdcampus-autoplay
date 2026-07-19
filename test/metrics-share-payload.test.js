const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { buildMetricsSharePayload } = require('../src/lib/metrics');

describe('buildMetricsSharePayload', () => {
  it('only phase counts, strips empty', () => {
    const p = buildMetricsSharePayload({
      hours: 24,
      total: 5,
      byPhase: { video: 3, quiz: 2, '': 9 },
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
    });
    assert.equal(p.event, 'metrics_batch');
    assert.equal(p.total, 5);
    assert.deepEqual(p.byPhase, { video: 3, quiz: 2 });
    assert.equal(p.storeTag, undefined);
  });

  it('sanitizes storeTag', () => {
    const p = buildMetricsSharePayload({ hours: 7, total: 1, byPhase: { done: 1 } }, {
      storeTag: 'Store Roma #1!!',
    });
    assert.equal(p.storeTag, 'StoreRoma1');
  });
});
