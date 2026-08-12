'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CF_A = 'AAABBB00A00A000A';
const CF_B = 'CCCDDD00A00A000A';

function makeFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-issue-cli-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.cpSync(path.join(REPO, 'scripts', 'lib'), path.join(root, 'scripts', 'lib'), {
    recursive: true,
  });
  fs.cpSync(path.join(REPO, 'src', 'lib'), path.join(root, 'src', 'lib'), {
    recursive: true,
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeConfig(root, cf) {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    codice_fiscale: cf,
    autologinUrl: `https://tecsial.gsdcampus.it/autologin/${cf}/fixture`,
    reportIssues: false,
  }));
}

function runCli(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(root, 'scripts', 'lib', 'issue-report.js'), ...args],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function outboxFiles(root, cf) {
  const dir = path.join(root, 'data', 'accounts', cf, '.issue_outbox');
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
}

describe('issue-report CLI durable outbox', () => {
  it('due osservazioni concorrenti uguali hanno file distinti e conteggio 2', async (t) => {
    const root = makeFixture(t);
    writeConfig(root, CF_A);

    const [first, second] = await Promise.all([
      runCli(root, ['auto', 'lezioni_bloccate', 'stessa causa', 'corso:1']),
      runCli(root, ['auto', 'lezioni_bloccate', 'stessa causa', 'corso:1']),
    ]);

    // reportIssues=false impedisce qualsiasi rete, ma il payload deve restare durevole.
    assert.equal(first.code, 2, first.stderr);
    assert.equal(second.code, 2, second.stderr);
    const files = outboxFiles(root, CF_A);
    assert.equal(files.length, 2);
    assert.notEqual(files[0], files[1]);

    const state = JSON.parse(fs.readFileSync(
      path.join(root, 'logs', 'issue-report-state.json'), 'utf8'
    ));
    const reports = Object.values(state.reports);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].occurrenceCount, 2);

    const retried = await runCli(root, ['flush']);
    assert.equal(retried.code, 2, retried.stderr);
    const afterRetry = JSON.parse(fs.readFileSync(
      path.join(root, 'logs', 'issue-report-state.json'), 'utf8'
    ));
    assert.equal(Object.values(afterRetry.reports)[0].occurrenceCount, 2);
  });

  it('flush visita le outbox di tutti gli account, non solo quello attivo', async (t) => {
    const root = makeFixture(t);
    writeConfig(root, CF_A);
    assert.equal((await runCli(root, ['auto', 'errore_a', 'A', 'problema:a'])).code, 2);
    writeConfig(root, CF_B);
    assert.equal((await runCli(root, ['auto', 'errore_b', 'B', 'problema:b'])).code, 2);

    const records = [];
    for (const cf of [CF_A, CF_B]) {
      const dir = path.join(root, 'data', 'accounts', cf, '.issue_outbox');
      const file = path.join(dir, outboxFiles(root, cf)[0]);
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      record.pendingOccurrences = 1;
      fs.writeFileSync(file, JSON.stringify(record));
      records.push(record);
    }
    assert.notEqual(records[0].fingerprint, records[1].fingerprint);

    // Ricostruisce il ledger soltanto dal drain. L'account attivo torna A, ma B
    // deve essere comunque visitato e comparire nello stato globale account-scoped.
    fs.rmSync(path.join(root, 'logs', 'issue-report-state.json'));
    writeConfig(root, CF_A);
    const flushed = await runCli(root, ['flush']);
    assert.equal(flushed.code, 2, flushed.stderr);

    const state = JSON.parse(fs.readFileSync(
      path.join(root, 'logs', 'issue-report-state.json'), 'utf8'
    ));
    assert.deepEqual(
      new Set(Object.keys(state.reports)),
      new Set(records.map((record) => record.fingerprint))
    );
    assert.equal(outboxFiles(root, CF_A).length, 1);
    assert.equal(outboxFiles(root, CF_B).length, 1);
  });
});
