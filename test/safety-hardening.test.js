'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs } = require('../scripts/harvest-answers');
const { auditBank, normalizeBank, compareBanks, upsertBankEntry } = require('../src/lib/bank-audit');
const { buildSchedulerStatus } = require('../src/lib/scheduler-status');
const { ownerMatches, acquireLock, promoteLock, lockOwnedBy, cleanStaleLock } = require('../src/lib/runtime-lock');
const { reopenCourse } = require('../src/lib/course-state');
const { listCourseStateBackups, restoreCourseStateBackup } = require('../src/lib/state-backup');

function tempRoot(prefix = 'gsd-safety-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return root;
}

describe('harvest CLI safety', () => {
  it('--help non implica alcuna modalità operativa', () => {
    const out = parseArgs(['node', 'harvest', '--help']);
    assert.equal(out.help, true);
    assert.equal(out.all, false);
    assert.equal(out.reset, false);
  });

  it('rifiuta flag sconosciuti e reset senza --yes', () => {
    assert.throws(() => parseArgs(['node', 'harvest', '--wat']), /Opzione sconosciuta/);
    assert.throws(() => parseArgs(['node', 'harvest', '--reconcile', '--reset']), /richiede --yes/);
    const ok = parseArgs(['node', 'harvest', '--reconcile', '--reset', '--yes']);
    assert.equal(ok.reset, true);
  });
});

describe('bank canonical audit', () => {
  it('deduplica una chiave corrotta solo quando la risposta coincide', () => {
    const bank = {
      'Qual è l’attività corretta?': 'Risposta A',
      'Qual è l’attivit�� corretta?': 'Risposta A',
    };
    const before = auditBank(bank);
    assert.equal(before.duplicates.length, 1);
    const fixed = normalizeBank(bank);
    assert.equal(fixed.removed, 1);
    assert.equal(fixed.conflicts.length, 0);
    assert.equal(Object.keys(fixed.bank).length, 1);
    assert.ok(Object.keys(fixed.bank)[0].includes('attività'));
  });

  it('non nasconde due risposte diverse per la stessa domanda', () => {
    const bank = { '1. Domanda?': 'A', 'Domanda?': 'B' };
    assert.equal(auditBank(bank).conflicts.length, 1);
  });

  it('upsert canonico sostituisce i duplicati e compare rileva divergenze', () => {
    const upsert = upsertBankEntry({ '1. Domanda?': 'A', 'Domanda?': 'A' }, 'Domanda?', 'B');
    assert.deepEqual(upsert.bank, { 'Domanda?': 'B' });
    assert.equal(compareBanks(upsert.bank, { 'Domanda?': 'A' }).conflicts.length, 1);
  });
});

describe('scheduler status', () => {
  it('off_hours archivia l’errore precedente e rinnova heartbeat', () => {
    const now = new Date('2026-07-21T14:00:00.000Z');
    const out = buildSchedulerStatus({ phase: 'error', lastError: 'old', lastUpdate: 'old-ts' }, 'off_hours', { nextStart: 'next' }, now);
    assert.equal(out.phase, 'off_hours');
    assert.equal(out.lastError, null);
    assert.equal(out.previousRun.lastError, 'old');
    assert.equal(out.schedulerHeartbeat, now.toISOString());
    assert.equal(out.nextStart, 'next');
  });
});

describe('runtime identity lock', () => {
  it('richiede comando e token, non soltanto un PID vivo', () => {
    const owner = { schemaVersion: 1, pid: 123, token: 'a'.repeat(36), kind: 'scheduler' };
    assert.equal(ownerMatches(owner, { pidAlive: () => true, commandForPid: () => '/bin/zsh scheduler.sh --lock-token ' + owner.token }), true);
    assert.equal(ownerMatches(owner, { pidAlive: () => true, commandForPid: () => '/usr/bin/other-process' }), false);
    assert.equal(ownerMatches(owner, { pidAlive: () => true, commandForPid: () => '/bin/zsh scheduler.sh --lock-token wrong' }), false);
  });

  it('acquire/promote lega il lock a token e PID', () => {
    const root = tempRoot('gsd-lock-');
    const token = 'b'.repeat(36);
    assert.equal(acquireLock(root, { pid: process.pid, token }).ok, true);
    assert.equal(promoteLock(root, token, process.pid).ok, true);
    assert.equal(lockOwnedBy(root, token, process.pid), true);
    // Il processo test non è scheduler.sh: il cleanup lo riconosce come stale.
    assert.equal(cleanStaleLock(root).removed, true);
  });
});

describe('course-state recovery', () => {
  it('reopen crea un backup verificato e ripristinabile per lo stesso account', () => {
    const root = tempRoot('gsd-backup-');
    const cf = 'AAAAAA00A00A000A';
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ codice_fiscale: cf }));
    const accountDir = path.join(root, 'data', 'accounts', cf);
    fs.mkdirSync(accountDir, { recursive: true });
    const original = { 42: { status: 'need_help', quizAttempts: 2, completedLessons: ['L1'] } };
    fs.writeFileSync(path.join(accountDir, 'course_state.json'), JSON.stringify(original));
    const state = JSON.parse(JSON.stringify(original));
    reopenCourse(root, state, 'https://x/corso/show/42');
    const backups = listCourseStateBackups(root);
    assert.equal(backups.length, 1);
    assert.equal(backups[0].valid, true);
    assert.equal(state[42].status, 'in_progress');
    restoreCourseStateBackup(root, backups[0].name);
    const restored = JSON.parse(fs.readFileSync(path.join(accountDir, 'course_state.json'), 'utf8'));
    assert.deepEqual(restored, original);
  });
});
