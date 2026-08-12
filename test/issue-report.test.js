'use strict';
/**
 * Segnalazione issue: diagnostica, fingerprint e redazione senza rete reale.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  redactText,
  collapseProgress,
  storeTagOf,
  accountTagOf,
  memberTag,
  fileAge,
  inferStartPhase,
  normalizeFingerprintText,
  deriveFingerprint,
  buildDraft,
  transportBody,
  canonicalIssueURL,
} = require('../scripts/lib/issue-report');

describe('collapseProgress', () => {
  const progress = (time) => `19:23:06 | Video: ${time} / 18:57`;

  it('comprime una sequenza e tiene il conteggio', () => {
    const out = collapseProgress([
      '19:23:01 | Apertura: https://x/lezione/show/1',
      progress('0:30'), progress('1:00'), progress('1:30'),
      '19:40:06 | Video finito.',
    ]);
    assert.deepEqual(out, [
      '19:23:01 | Apertura: https://x/lezione/show/1',
      '   … 3 righe di avanzamento video omesse',
      '19:40:06 | Video finito.',
    ]);
  });

  it('una riga isolata resta com\'è', () => {
    assert.deepEqual(collapseProgress(['a', progress('0:30'), 'b']), ['a', progress('0:30'), 'b']);
  });

  it('non tocca le righe che contano', () => {
    const errors = [
      '09:01:24 | Errore durante autologin (tentativo 1): page.goto: Target page closed',
      '17:23:51 | Verifico quiz finale...',
      '12:16:24 | MONITOR ERROR outer: page.waitForTimeout: Target page closed',
    ];
    assert.deepEqual(collapseProgress(errors), errors);
  });

  it('comprime anche una sequenza in coda al file', () => {
    assert.deepEqual(
      collapseProgress(['a', progress('0:30'), progress('1:00')]),
      ['a', '   … 2 righe di avanzamento video omesse']
    );
  });

  it('lista vuota → lista vuota', () => {
    assert.deepEqual(collapseProgress([]), []);
  });
});

describe('attribuzione store', () => {
  it('storeTag esplicito vince e viene ripulito', () => {
    assert.equal(
      storeTagOf({ storeTag: 'Store Roma #1!!', codice_fiscale: 'AAABBB00A00A000A' }),
      'StoreRoma1'
    );
  });

  it('senza storeTag ripiega su un ID opaco derivato dal CF', () => {
    assert.match(storeTagOf({ codice_fiscale: 'AAABBB00A00A000A' }), /^mac-[0-9a-f]{6}$/);
  });

  it('lo stesso CF dà sempre lo stesso ID, CF diversi ID diversi', () => {
    assert.equal(memberTag('AAABBB00A00A000A'), memberTag('aaabbb00a00a000a'));
    assert.notEqual(memberTag('AAABBB00A00A000A'), memberTag('CCCDDD00A00A000A'));
  });

  it('l\'ID non contiene il CF e sopravvive alla redazione', () => {
    const cf = 'AAABBB00A00A000A';
    const tag = memberTag(cf);
    assert.ok(!tag.includes(cf));
    assert.equal(redactText(tag), tag);
  });

  it('senza CF né storeTag resta vuoto', () => {
    assert.equal(storeTagOf({}), '');
    assert.equal(memberTag(''), '');
    assert.equal(accountTagOf({}), '');
  });

  it('account diversi restano distinti anche sullo stesso store', () => {
    const first = accountTagOf({ storeTag: 'negozio-1', codice_fiscale: 'AAABBB00A00A000A' });
    const second = accountTagOf({ storeTag: 'negozio-1', codice_fiscale: 'CCCDDD00A00A000A' });
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
  });
});

describe('fileAge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-age-'));
  const write = (name, ageMin) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'x');
    const time = new Date(Date.now() - ageMin * 60000);
    fs.utimesSync(file, time, time);
    return file;
  };

  it('file mancante → assente, mai un errore', () => {
    assert.equal(fileAge(path.join(dir, 'non-esiste.log')), 'assente');
  });

  it('appena scritto → adesso', () => {
    assert.equal(fileAge(write('ora.log', 0)), 'adesso');
  });

  it('minuti, ore e giorni', () => {
    assert.equal(fileAge(write('min.log', 42)), '42 min fa');
    assert.equal(fileAge(write('ore.log', 5 * 60)), '5h fa');
    assert.equal(fileAge(write('giorni.log', 6 * 24 * 60)), '6 giorni fa');
  });
});

describe('diagnostica scheduler_start_failed', () => {
  it('riconosce la vera sottofase dalla coda finale, non dal preambolo', () => {
    const transcript = [
      'verify: banca valida',
      'Verifica requisiti',
      'Banca risposte ancora incoerente dopo il riallineamento: mi fermo',
    ].join('\n');
    assert.equal(inferStartPhase(transcript), 'answer_bank_verify');
  });

  it('il draft contiene comando, exit code, sottofase e persistenza', () => {
    const draft = buildDraft({
      phase: 'scheduler_start_failed',
      reason: 'start.sh ha fallito',
      storeTag: 'mac-abc123',
      execution: { command: './start.sh', exitCode: 17, startPhase: 'answer_bank_verify' },
      logSections: ['### logs/start.log\n```\nerrore finale\n```'],
      summary: { total: 9, done: 7, needHelp: 1, inProgress: 1 },
      lastQuiz: null,
      head: 'abc',
      osPlatform: 'darwin',
      nodeVersion: 'v22',
    }, { occurrenceCount: 3 });
    assert.match(draft.body, /## Esecuzione/);
    assert.match(draft.body, /exit code: `17`/);
    assert.match(draft.body, /answer_bank_verify/);
    assert.match(draft.body, /Occorrenze osservate su questo Mac: \*\*3\*\*/);
    assert.match(draft.body, /errore finale/);
  });
});

describe('fingerprint idempotente', () => {
  const context = (reason, phase = 'answer_bank_verify', accountTag = 'a'.repeat(64)) => ({
    phase: 'scheduler_start_failed',
    reason,
    storeTag: 'negozio-condiviso',
    accountTag,
    execution: { command: './start.sh', exitCode: 1, startPhase: phase },
  });

  it('timestamp e PID diversi non cambiano la fingerprint', () => {
    const one = deriveFingerprint(context('Fallito alle 10:12:13 PID 1234'));
    const two = deriveFingerprint(context('Fallito alle 11:59:58 PID 9999'));
    assert.equal(one, two);
  });

  it('una sottofase diversa resta un problema diverso', () => {
    assert.notEqual(
      deriveFingerprint(context('Fallito', 'answer_bank_verify')),
      deriveFingerprint(context('Fallito', 'lock_acquire'))
    );
  });

  it('la chiave esplicita resta opaca e account-scoped anche sullo stesso store', () => {
    const first = deriveFingerprint(
      context('testo variabile', 'answer_bank_verify', 'a'.repeat(64)),
      'corso:8341|lezioni_bloccate'
    );
    const second = deriveFingerprint(
      context('altro testo', 'answer_bank_verify', 'b'.repeat(64)),
      'corso:8341|lezioni_bloccate'
    );
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.notEqual(first, second);
    assert.ok(!first.includes('8341'));
  });

  it('normalizza il contenuto volatile', () => {
    assert.equal(
      normalizeFingerprintText('Errore 2026-08-12T10:11:12.123Z PID=123'),
      'errore <time> pid:<n>'
    );
  });

  it('il payload trasportato porta marker e contatore', () => {
    const fingerprint = 'a'.repeat(64);
    const body = transportBody({ body: 'diagnostica', fingerprint, occurrenceCount: 7 });
    assert.match(body, new RegExp(`gsd-auto-fingerprint:${fingerprint}`));
    assert.match(body, /gsd-auto-occurrences:7/);
  });
});


describe('ACK GitHub canonico', () => {
  it('accetta soltanto issue della repository prevista', () => {
    assert.equal(
      canonicalIssueURL('https://github.com/iCosiSenpai/gsdcampus-autoplay/issues/123'),
      'https://github.com/iCosiSenpai/gsdcampus-autoplay/issues/123'
    );
    assert.equal(canonicalIssueURL('https://github.com/login'), null);
    assert.equal(canonicalIssueURL('https://github.com/altro/repo/issues/123'), null);
    assert.equal(canonicalIssueURL('https://github.com/iCosiSenpai/gsdcampus-autoplay/issues/0'), null);
  });
});