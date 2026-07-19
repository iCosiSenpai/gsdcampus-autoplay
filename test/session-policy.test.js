const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sessionUnstableCooldownMs,
  isOnDashboardUrl,
  DEFAULT_COOLDOWN_MIN,
} = require('../src/lib/session-policy');

describe('sessionUnstableCooldownMs', () => {
  it('default 30 min', () => {
    assert.equal(sessionUnstableCooldownMs({}), DEFAULT_COOLDOWN_MIN * 60 * 1000);
    assert.equal(sessionUnstableCooldownMs(null), DEFAULT_COOLDOWN_MIN * 60 * 1000);
  });

  it('sessionUnstableCooldownMin', () => {
    assert.equal(sessionUnstableCooldownMs({ sessionUnstableCooldownMin: 45 }), 45 * 60 * 1000);
  });

  it('sessionUnstableCooldownMs wins', () => {
    assert.equal(sessionUnstableCooldownMs({
      sessionUnstableCooldownMin: 10,
      sessionUnstableCooldownMs: 120000,
    }), 120000);
  });

  it('clamps min/max', () => {
    assert.ok(sessionUnstableCooldownMs({ sessionUnstableCooldownMs: 100 }) >= 60000);
    assert.ok(sessionUnstableCooldownMs({ sessionUnstableCooldownMin: 9999 }) <= 6 * 60 * 60 * 1000);
  });
});

describe('isOnDashboardUrl', () => {
  it('detects dashboard path', () => {
    assert.equal(isOnDashboardUrl('https://tecsial.gsdcampus.it/corso/listAllByUser'), true);
    assert.equal(isOnDashboardUrl('https://x/corso/show/1'), false);
  });
});
