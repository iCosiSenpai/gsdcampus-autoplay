'use strict';
/**
 * redactUrl: i token di autologin non devono mai finire in chiaro nei log.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { redactUrl, redactSensitiveText } = require('../src/lib/logger');

describe('redactUrl', () => {
  it('redige il token in /autologin/<CF>/<token>', () => {
    const u = 'https://tecsial.gsdcampus.it/autologin/CSOLSS95L23D862R/supersecrettoken123';
    const out = redactUrl(u);
    assert.match(out, /\/autologin\/CSOLSS95L23D862R\/\[REDATTO\]/);
    assert.ok(!out.includes('supersecrettoken123'));
  });

  it('redige anche con path/query dopo il token', () => {
    const u = 'https://host/autologin/ABCDEF12G34H567I/tokentoken/extra?x=1';
    const out = redactUrl(u);
    assert.ok(!out.includes('tokentoken'));
    assert.match(out, /\[REDATTO\]/);
  });

  it('redige query token= key= auth*=', () => {
    assert.equal(
      redactUrl('https://x.test/p?token=abc123&keep=1'),
      'https://x.test/p?token=[REDATTO]&keep=1'
    );
    assert.equal(
      redactUrl('https://x.test/p?key=zzz'),
      'https://x.test/p?key=[REDATTO]'
    );
    assert.equal(
      redactUrl('https://x.test/p?authorization=Bearer%20x'),
      'https://x.test/p?authorization=[REDATTO]'
    );
  });

  it('lascia intatti URL senza credenziali', () => {
    const u = 'https://tecsial.gsdcampus.it/corso/listAllByUser';
    assert.equal(redactUrl(u), u);
  });

  it('è infallibile su input strani', () => {
    assert.equal(redactUrl(null), 'null');
    assert.equal(redactUrl(42), '42');
  });

  it('redige token su URL video/get', () => {
    const u = 'https://tecsial.gsdcampus.it/video/get/8404.mp4?token=secrettok123';
    const out = redactUrl(u);
    assert.ok(!out.includes('secrettok123'));
    assert.match(out, /token=\[REDATTO\]/);
    assert.match(out, /\/video\/get\/8404\.mp4/);
  });
});

describe('redactSensitiveText (HTML dump)', () => {
  it('redige token dentro HTML video src', () => {
    const html = '<video src="https://tecsial.gsdcampus.it/video/get/1.mp4?token=abcSECRET" class="vjs-tech"></video>';
    const out = redactSensitiveText(html);
    assert.ok(!out.includes('abcSECRET'));
    assert.match(out, /token=\[REDATTO\]/);
    assert.match(out, /vjs-tech/);
  });

  it('redige più token nella stessa stringa', () => {
    const html = 'a?token=one&x=1 b?token=two';
    const out = redactSensitiveText(html);
    assert.ok(!out.includes('one'));
    assert.ok(!out.includes('two'));
  });

  it('è lo stesso di redactUrl', () => {
    const u = 'https://x/autologin/CF1234567890123A/tok';
    assert.equal(redactSensitiveText(u), redactUrl(u));
  });
});
