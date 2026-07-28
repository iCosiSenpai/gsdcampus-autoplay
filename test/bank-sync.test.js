const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mergeBanks, bankLag, syncPublicBank } = require('../src/lib/bank-sync');
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

describe('conflitti fra banca locale e condivisa', () => {
  const { reconcileConflicts } = require('../src/lib/bank-audit');

  it('sul disaccordo vince la risposta condivisa', () => {
    const trusted = { 'Domanda A?': 'risposta locale', 'Domanda B?': 'uguale' };
    const shared = { 'domanda a?': 'risposta condivisa', 'Domanda B?': 'uguale' };
    const { bank, replaced } = reconcileConflicts(trusted, shared);
    assert.equal(bank['Domanda A?'], 'risposta condivisa');
    assert.equal(replaced.length, 1);
    assert.equal(replaced[0].local, 'risposta locale');
    assert.equal(replaced[0].shared, 'risposta condivisa');
  });

  it('non tocca le risposte che esistono solo in locale', () => {
    const { bank, replaced } = reconcileConflicts({ 'Solo qui?': 'mia' }, { 'Altra?': 'x' });
    assert.equal(bank['Solo qui?'], 'mia');
    assert.equal(replaced.length, 0);
  });

  it('conserva le chiavi di servizio (README)', () => {
    const { bank } = reconcileConflicts({ README: 'nota', 'Q?': 'a' }, { 'Q?': 'a' });
    assert.equal(bank.README, 'nota');
  });

  it('un conflitto non impedisce più di ricevere le risposte nuove', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bank-conflict-'));
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'known_answers.json'), JSON.stringify({ 'Q1?': 'locale' }));
    fs.writeFileSync(path.join(root, 'data', 'known_answers_public.json'), JSON.stringify({ 'Q1?': 'condivisa', 'Q2?': 'nuova' }));
    const res = await syncPublicBank(root, { url: 'http://127.0.0.1:1/none' });
    const merged = JSON.parse(fs.readFileSync(path.join(root, 'data', 'known_answers.json'), 'utf8'));
    assert.equal(merged['Q2?'], 'nuova');          // la risposta nuova è arrivata
    assert.equal(merged['Q1?'], 'locale');          // il conflitto NON viene sovrascritto qui
    assert.equal(res.conflicts >= 1, true);         // ma viene segnalato
    fs.rmSync(root, { recursive: true, force: true });
  });
});
