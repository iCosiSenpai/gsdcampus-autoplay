'use strict';
/**
 * Menu di scelta: il valore restituito e' l'unico canale verso install.sh, e
 * uno 0 significa "annulla". Regressione reale: una variabile non destrutturata
 * lanciava un ReferenceError, il catch lo mappava a 0 e il comando curl
 * rispondeva "Operazione annullata" a chiunque, senza alcuna traccia.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'scripts', 'lib', 'prompt-cli.js');

function run(args, input = '1\n') {
  return execFileSync(process.execPath, [CLI, ...args], {
    input, encoding: 'utf8', timeout: 20000,
  }).trim().split('\n').pop().trim();
}

describe('prompt-cli select', () => {
  it('restituisce la voce scelta', () => {
    assert.equal(run(['select', '--title', 'T', '--', 'Uno', 'Due'], '2\n'), '2');
  });

  it('con --timeout non si rompe e non annulla', () => {
    // Il bug: --timeout faceva lanciare un ReferenceError e tornava 0.
    const out = run(['select', '--title', 'T', '--timeout', '5', '--', 'Uno', 'Due'], '1\n');
    assert.notEqual(out, '0', 'zero significherebbe "annullato"');
    assert.equal(out, '1');
  });

  it('--timeout non numerico viene ignorato invece di rompere', () => {
    const out = run(['select', '--title', 'T', '--timeout', 'abc', '--', 'Uno', 'Due'], '1\n');
    assert.equal(out, '1');
  });

  it('senza voci risponde 0 senza esplodere', () => {
    assert.equal(run(['select', '--title', 'T', '--']), '0');
  });
});
