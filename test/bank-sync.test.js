const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeBanks, bankLag } = require('../src/lib/bank-sync');
const path = require('path');
const fs = require('fs');
const os = require('os');

describe('mergeBanks', () => {
  it('remote fills gaps; local wins conflicts', () => {
    const { merged, added } = mergeBanks(
      { Q1: 'local', Q2: 'only-local' },
      { Q1: 'remote', Q3: 'from-public' }
    );
    assert.equal(merged.Q1, 'local');
    assert.equal(merged.Q2, 'only-local');
    assert.equal(merged.Q3, 'from-public');
    assert.equal(added, 1);
  });

  it('empty remote', () => {
    const { merged, added } = mergeBanks({ A: '1' }, {});
    assert.equal(merged.A, '1');
    assert.equal(added, 0);
  });
});

describe('bankLag', () => {
  it('counts onlyLocal / onlyPublic', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bank-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'known_answers.json'), JSON.stringify({ L: '1', S: '2' }));
    fs.writeFileSync(path.join(dir, 'data', 'known_answers_public.json'), JSON.stringify({ S: '2', P: '3' }));
    const lag = bankLag(dir);
    assert.equal(lag.trusted, 2);
    assert.equal(lag.publicFile, 2);
    assert.equal(lag.onlyLocal, 1);
    assert.equal(lag.onlyPublic, 1);
  });
});
