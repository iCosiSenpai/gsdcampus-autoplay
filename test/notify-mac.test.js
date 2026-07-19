const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  courseIdFromUrl,
  msgCourseDone,
  msgQuizSospeso,
} = require('../src/lib/notify-mac');

describe('notify-mac helpers', () => {
  it('courseIdFromUrl', () => {
    assert.equal(courseIdFromUrl('https://tecsial.gsdcampus.it/corso/show/18387'), '18387');
    assert.equal(courseIdFromUrl(null), null);
  });

  it('msgCourseDone', () => {
    assert.match(msgCourseDone('18387'), /#18387/);
    assert.match(msgCourseDone(null), /completato/i);
  });

  it('msgQuizSospeso', () => {
    assert.match(msgQuizSospeso('99'), /#99/);
    assert.match(msgQuizSospeso('1', 'sospeso: 3 domande'), /tentativo protetto/i);
  });
});
