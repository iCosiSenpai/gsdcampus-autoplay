'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTime,
  parsePlayerPctText,
  isVideoNearEnd,
  isDomPctComplete,
  shouldFinishVideo,
  videoPollMs,
  POLL_MS,
  POLL_NEAR_END_MS,
} = require('../src/lib/video');

describe('formatTime', () => {
  it('formatta mm:ss', () => {
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(65), '1:05');
    assert.equal(formatTime(1000), '16:40');
  });
  it('NaN → --:--', () => {
    assert.equal(formatTime(NaN), '--:--');
  });
});

describe('parsePlayerPctText', () => {
  it('parse % corte', () => {
    assert.equal(parsePlayerPctText('47%'), 47);
    assert.equal(parsePlayerPctText('100.0 %'), 100);
  });
  it('rifiuta testo lungo (paragrafi)', () => {
    assert.equal(parsePlayerPctText('a'.repeat(30) + ' 50%'), null);
  });
});

describe('isVideoNearEnd', () => {
  it('true entro 1.5s dalla fine', () => {
    assert.equal(isVideoNearEnd(998.6, 1000), true);
    assert.equal(isVideoNearEnd(998.4, 1000), false);
  });
  it('false se duration invalida', () => {
    assert.equal(isVideoNearEnd(10, NaN), false);
    assert.equal(isVideoNearEnd(10, 0), false);
  });
});

describe('isDomPctComplete / shouldFinishVideo', () => {
  it('dom >= 99', () => {
    assert.equal(isDomPctComplete(99), true);
    assert.equal(isDomPctComplete(98), false);
    assert.equal(isDomPctComplete(null), false);
  });
  it('finish su ended, nearEnd o dom', () => {
    assert.equal(shouldFinishVideo({ ended: true }), true);
    assert.equal(shouldFinishVideo({ nearEnd: true }), true);
    assert.equal(shouldFinishVideo({ domComplete: true }), true);
    assert.equal(shouldFinishVideo({}), false);
  });
});

describe('videoPollMs', () => {
  it('poll lungo a metà video', () => {
    assert.equal(videoPollMs(100, 1000), POLL_MS);
  });
  it('poll corto negli ultimi 10s', () => {
    assert.equal(videoPollMs(995, 1000), POLL_NEAR_END_MS);
  });
});
