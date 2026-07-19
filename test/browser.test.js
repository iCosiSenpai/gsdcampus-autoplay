'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  isChromeMissingError,
  resolveLaunchPlan,
  DEFAULT_LAUNCH_ARGS,
} = require('../src/lib/browser');

describe('isChromeMissingError', () => {
  it('riconosce il messaggio Playwright tipico', () => {
    assert.equal(
      isChromeMissingError(new Error("browserType.launch: Chromium distribution 'chrome' is not found at /Applications/Google Chrome.app")),
      true
    );
  });
  it('riconosce Executable doesn\'t exist', () => {
    assert.equal(isChromeMissingError({ message: "Executable doesn't exist at ..." }), true);
  });
  it('non marca errori generici', () => {
    assert.equal(isChromeMissingError(new Error('Timeout 30000ms exceeded')), false);
    assert.equal(isChromeMissingError(null), false);
  });
});

describe('resolveLaunchPlan', () => {
  it('auto: chrome poi chromium', () => {
    const p = resolveLaunchPlan({});
    assert.equal(p.mode, 'auto');
    assert.deepEqual(p.attempts.map(a => a.backend), ['chrome', 'chromium']);
    assert.equal(p.attempts[0].channel, 'chrome');
    assert.equal(p.attempts[1].channel, undefined);
  });
  it('fixed chrome', () => {
    const p = resolveLaunchPlan({ browserChannel: 'chrome' });
    assert.equal(p.mode, 'fixed');
    assert.equal(p.attempts.length, 1);
    assert.equal(p.attempts[0].backend, 'chrome');
  });
  it('fixed chromium', () => {
    const p = resolveLaunchPlan({ browserChannel: 'chromium' });
    assert.equal(p.mode, 'fixed');
    assert.equal(p.attempts[0].backend, 'chromium');
  });
  it('msedge fixed', () => {
    const p = resolveLaunchPlan({ browserChannel: 'msedge' });
    assert.equal(p.attempts[0].channel, 'msedge');
  });
});

describe('DEFAULT_LAUNCH_ARGS', () => {
  it('include anti-automation e sandbox flags', () => {
    assert.ok(DEFAULT_LAUNCH_ARGS.some(a => /AutomationControlled/.test(a)));
    assert.ok(DEFAULT_LAUNCH_ARGS.includes('--no-sandbox'));
  });
});
