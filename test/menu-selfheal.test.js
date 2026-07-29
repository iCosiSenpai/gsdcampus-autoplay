'use strict';
/**
 * Il menu del comando curl viene scaricato FRESCO da GitHub ed eseguito da una
 * copia temporanea, perche' una copia locale rotta impediva al collega di
 * ricevere la propria correzione (il menu bloccava il proprio aggiornamento).
 * Il trucco regge solo finche' prompt-cli.js resta autosufficiente.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'lib', 'prompt-cli.js');
const INSTALL = path.join(ROOT, 'install.sh');

describe('menu autoriparante', () => {
  it('prompt-cli.js richiede SOLO moduli built-in di Node', () => {
    // Se qualcuno aggiunge un require relativo, la copia in /tmp non trova piu
    // il file e il menu esplode proprio nel momento del recupero.
    const src = fs.readFileSync(CLI, 'utf8');
    const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    const relativi = requires.filter((r) => r.startsWith('.') || r.startsWith('/'));
    assert.deepEqual(relativi, [], `require non built-in: ${relativi.join(', ')}`);
  });

  it('install.sh scarica il renderer fresco e lo valida prima di usarlo', () => {
    const src = fs.readFileSync(INSTALL, 'utf8');
    assert.match(src, /raw\.githubusercontent\.com[^\n]*prompt-cli\.js/, 'scarica il renderer');
    assert.match(src, /node --check "\$FRESH_MENU"/, 'lo valida prima di fidarsi');
    assert.match(src, /node "\$MENU_CLI" select/, 'usa la copia scelta');
  });

  it('non decide piu in base alla presenza di drawMenuScreen', () => {
    // Era il criterio sbagliato: sui Mac gia aggiornati quella funzione c'e,
    // quindi il refresh non scattava mai e restavano col menu rotto.
    const src = fs.readFileSync(INSTALL, 'utf8');
    assert.equal(/grep -q "drawMenuScreen"/.test(src), false);
  });
});
