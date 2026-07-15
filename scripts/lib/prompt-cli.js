#!/usr/bin/env node
/**
 * prompt-cli.js — helper TUI condiviso: menu a frecce + lettura riga + read-timer.
 *
 * Estratto da whoareyou-cli.js così gli script shell (setup.sh, install.sh) possono
 * riutilizzare lo stesso menu a frecce via un piccolo wrapper CLI (vedi `main()`
 * in fondo): `node prompt-cli.js select --title T -- A B C` stampa su stdout
 * l'indice 1-based della voce scelta (0 = annulla), exit code sempre 0. Così i
 * menu numerati di setup/install diventano menu a frecce OVUNQUE.
 *
 * Esporta anche le funzioni per chi lo require (whoareyou-cli.js): ttyMenu,
 * numericMenu, menu, readLine, readLineTTY, closeLineReader, clearScreen, printBox.
 */

const readline = require('readline');
const fs = require('fs');

function clearScreen() {
  // Usa ANSI clear; se non supportato, stampa solo a capo.
  process.stdout.write('\x1b[2J\x1b[H');
}

// Stile allineato a scripts/lib/ui.sh: box arrotondato + accent, testo
// secondario DIM. I codici sono no-op visivi accettabili anche su terminali
// poveri; il menu gira sempre su /dev/tty (TTY reale), quindi niente guard.
const UI = {
  accent: '\x1b[38;5;45m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

function printBox(title, lines) {
  const width = 42;
  const pad = (s) => {
    const len = [...String(s)].length;           // caratteri, non byte
    return String(s) + ' '.repeat(Math.max(0, width - 2 - len));
  };
  console.log(`${UI.accent}╭${'─'.repeat(width)}╮${UI.reset}`);
  console.log(`${UI.accent}│${UI.reset}  ${UI.bold}${pad(title)}${UI.reset}${UI.accent}│${UI.reset}`);
  console.log(`${UI.accent}╰${'─'.repeat(width)}╯${UI.reset}`);
  lines.forEach(l => console.log(l));
}

// ────────────────────────────────────────────────────────────────
// Menu interattivo TTY (frecce + invio)
// ────────────────────────────────────────────────────────────────
// Drena l'input già bufferizzato su stdin. I tasti premuti "al buio" durante i
// passi lunghi (brew, ollama pull, git clone) restano in coda e finivano dritti
// nel primo menu/prompt: Invii fantasma che selezionavano voci mai scelte (il
// famigerato "premi Invio una seconda volta" al contrario). Va chiamato UNA
// volta, all'apertura di menu/prompt, prima di registrare il listener keypress.
function drainPendingStdin() {
  try { while (process.stdin.read() !== null) { /* scarta */ } } catch (_) { /* ignora */ }
}

// Menu a frecce basato SOLO su keypress in raw mode (niente readline.Interface).
// startIdx (0-based) posiziona il cursore iniziale (es. per --default N).
function ttyMenu(items, title, subtitle, startIdx = 0) {
  return new Promise((resolve) => {
    let selected = (Number.isInteger(startIdx) && startIdx >= 0 && startIdx < items.length) ? startIdx : 0;
    // Doppia protezione contro l'input fantasma: drain del buffer node +
    // finestra di grazia sui primi ms (i tasti pendenti nel buffer del kernel
    // vengono consegnati subito dopo resume(), prima che un umano possa
    // reagire al menu appena disegnato).
    const openedAt = Date.now();
    const GRACE_MS = 150;
    drainPendingStdin();

    function draw() {
      clearScreen();
      printBox(title, []);
      if (subtitle) console.log(subtitle);
      console.log('');
      items.forEach((it, i) => {
        const label = typeof it === 'string' ? it : it.label;
        if (i === selected) {
          console.log(` ${UI.accent}▸${UI.reset} ${UI.bold}${label}${UI.reset}`);
        } else {
          console.log(`   ${UI.dim}${label}${UI.reset}`);
        }
      });
      console.log('');
      console.log(`${UI.dim}↑/↓ muovi · Invio seleziona · q annulla${UI.reset}`);
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    }

    function onKeypress(str, key) {
      if (!key) return;
      // Finestra di grazia: ignora i tasti consegnati nei primissimi ms (input
      // residuo dei passi precedenti, non una scelta dell'utente). Eccezione:
      // Ctrl-C passa sempre.
      if (Date.now() - openedAt < GRACE_MS && !(key.ctrl && key.name === 'c')) return;
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up') {
        selected = (selected - 1 + items.length) % items.length;
        draw();
      } else if (key.name === 'down') {
        selected = (selected + 1) % items.length;
        draw();
      } else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(items[selected]);
      }
    }

    process.stdin.on('keypress', onKeypress);
    draw();
  });
}

// Lettura di una riga su TTY basata su keypress (stessa "modalità" del menu, così
// non c'è conflitto di consumer su stdin). Gestisce echo, backspace, Ctrl-C e
// ignora un eventuale Invio "residuo" subito dopo la selezione del menu.
function readLineTTY(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let buf = '';
    const startedAt = Date.now();
    // Scarta l'input residuo dei passi precedenti (v. drainPendingStdin).
    drainPendingStdin();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function done(val) {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdout.write('\n');
      resolve(val);
    }

    function onKey(str, key) {
      if (!key) return;
      if (key.ctrl && key.name === 'c') {
        // FIX M3: ripristina raw mode PRIMA di uscire, altrimenti il terminale
        // resta in raw mode (nessun echo, Ctrl-C non funziona più) dopo l'exit.
        if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch (_) {} }
        process.stdout.write('\n');
        process.exit(1);
      }
      if (key.name === 'return' || key.name === 'enter') {
        // Scarta un Invio vuoto immediato (< 120ms): è quasi certamente quello
        // con cui l'utente ha appena confermato la voce di menu, non una riga vuota.
        if (buf.length === 0 && Date.now() - startedAt < 120) return;
        done(buf.trim());
        return;
      }
      if (key.name === 'backspace') {
        if (buf.length > 0) {
          buf = buf.slice(0, -1);
          process.stdout.write('\b \b');
        }
        return;
      }
      // Carattere stampabile (ignora tasti di controllo come frecce, tab, ecc.)
      if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') {
        buf += str;
        process.stdout.write(str);
      }
    }

    process.stdin.on('keypress', onKey);
  });
}

// Reader di linee robusto per stdin pipe/TTY. Legge linee complete, bufferizza
// l'input residuo e risolve ogni Promise in ordine.
let inputBuffer = '';
let lineQueue = [];
let lineResolvers = [];
let lineReaderInitialized = false;

function initLineReader() {
  if (lineReaderInitialized) return;
  lineReaderInitialized = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    inputBuffer += chunk;
    let idx;
    while ((idx = inputBuffer.indexOf('\n')) !== -1) {
      const line = inputBuffer.slice(0, idx).trim();
      inputBuffer = inputBuffer.slice(idx + 1);
      if (lineResolvers.length > 0) {
        lineResolvers.shift()(line);
      } else {
        lineQueue.push(line);
      }
    }
  });
  process.stdin.on('end', () => {
    if (inputBuffer.length > 0) {
      const line = inputBuffer.trim();
      inputBuffer = '';
      if (lineResolvers.length > 0) {
        lineResolvers.shift()(line);
      } else {
        lineQueue.push(line);
      }
    }
    while (lineResolvers.length > 0) {
      lineResolvers.shift()('');
    }
  });
}

async function readLine(question) {
  // Su TTY usiamo il lettore basato su keypress (coerente con il menu a frecce);
  // su input reindirizzato (pipe) usiamo il lettore a buffer di righe.
  if (process.stdin.isTTY) {
    return readLineTTY(question);
  }
  initLineReader();
  process.stdout.write(question);
  if (lineQueue.length > 0) {
    return Promise.resolve(lineQueue.shift());
  }
  return new Promise((resolve) => {
    lineResolvers.push(resolve);
  });
}

function closeLineReader() {
  // non chiude stdin per non interferire con altri processi in pipe
  lineResolvers = [];
  lineQueue = [];
}

// ────────────────────────────────────────────────────────────────
// Menu numerico fallback per non-TTY
// ────────────────────────────────────────────────────────────────
function numericMenu(items, title, subtitle) {
  return new Promise((resolve) => {
    function draw() {
      console.log('');
      printBox(title, []);
      if (subtitle) console.log(subtitle);
      console.log('');
      items.forEach((it, i) => {
        const label = typeof it === 'string' ? it : it.label;
        console.log(`  [${i + 1}] ${label}`);
      });
      console.log('  [0] Annulla');
    }

    draw();
    readLine('\nScelta: ').then((answer) => {
      const n = parseInt(answer, 10);
      if (answer === '0' || Number.isNaN(n)) {
        resolve(null);
        return;
      }
      if (n >= 1 && n <= items.length) {
        resolve(items[n - 1]);
      } else {
        resolve(null);
      }
    });
  });
}

async function menu(items, title, subtitle) {
  if (process.stdin.isTTY) {
    return ttyMenu(items, title, subtitle);
  }
  return numericMenu(items, title, subtitle);
}

module.exports = {
  clearScreen, printBox,
  ttyMenu, numericMenu, menu,
  readLine, readLineTTY, closeLineReader,
};

// ────────────────────────────────────────────────────────────────
// Wrapper CLI: `node prompt-cli.js select --title T [--subtitle S] [--default N] -- A B C`
// Stampa su stdout l'indice 1-based della voce scelta (0 = annulla/EOF).
// Exit code SEMPRE 0: i top script girano in set -e e catturano l'indice con $();
// un exit non-zero abortirebbe setup/install. Il menu è renderizzato su /dev/tty
// dentro main() (fallback stderr) così i disegni del menu non inquadrano l'indice
// catturato su stdout e non vengono nascosti da `2>/dev/null` ai call site.
// ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2); // tolgo 'node' e lo script
  let title = '';
  let subtitle = '';
  let defaultN = 1;
  let items = [];
  let collectingItems = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (collectingItems) { items.push(a); continue; }
    if (a === '--') { collectingItems = true; continue; }
    if (a === '--title') { title = args[++i]; continue; }
    if (a === '--subtitle') { subtitle = args[++i]; continue; }
    if (a === '--default') { defaultN = parseInt(args[++i], 10); continue; }
  }
  if (Number.isNaN(defaultN) || defaultN < 1) defaultN = 1;
  return { title, subtitle, defaultN, items };
}

async function cliMain() {
  // stdout è catturato da $() negli script shell: deve portare SOLO l'indice
  // finale. Il menu (clearScreen ANSI, cursori ▶, box, voci) va sul terminale
  // REALE dell'utente. Lo scriviamo direttamente su /dev/tty INVECE che su
  // stderr: così i call site che fanno `2>/dev/null` (per silenziare il rumore
  // di node) NON nascondono anche il menu. Bug storico: il menu era su stderr e
  // `2>/dev/null` lo rendeva invisibile (opzioni vuote, solo il cursore ▶).
  // /dev/tty è il terminale dell'utente sia sotto `curl|bash` sia lanciando
  // ./setup.sh direttamente. Se /dev/tty non è apribile (es. non interattivo),
  // fallback su stderr (in modalità non-TTY si usa numericMenu, senza UI).
  const realStdoutWrite = process.stdout.write.bind(process.stdout);
  let menuFd = null;
  try { menuFd = fs.openSync('/dev/tty', 'w'); } catch (_) { menuFd = null; }
  const menuWrite = (chunk) => {
    const s = typeof chunk === 'string' ? chunk : String(chunk);
    if (menuFd !== null) { try { fs.writeSync(menuFd, s); return; } catch (_) {} }
    process.stderr.write(s);
  };
  process.stdout.write = (chunk, ...rest) => { menuWrite(chunk); return true; };
  console.log = (...a) => { menuWrite(a.join(' ') + '\n'); };
  console.error = (...a) => { menuWrite(a.join(' ') + '\n'); };

  // SIGINT inatteso: ripristina raw mode e stampa 0 (cancel) — exit 0.
  process.on('SIGINT', () => {
    if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch (_) {} }
    realStdoutWrite('0\n');
    process.exit(0);
  });

  const { title, subtitle, defaultN, items } = parseArgs(process.argv);
  if (!items || items.length === 0) {
    realStdoutWrite('0\n');
    process.exit(0);
  }

  let chosen = null;
  try {
    if (process.stdin.isTTY) {
      chosen = await ttyMenu(items, title, subtitle, (defaultN - 1));
    } else {
      // numericMenu ritorna l'item o null; mappa a indice.
      chosen = await numericMenu(items, title, subtitle);
    }
  } catch (_) {
    chosen = null;
  }

  let idx = 0;
  if (chosen != null) {
    const i = items.indexOf(chosen);
    if (i >= 0) idx = i + 1;
  }
  realStdoutWrite(`${idx}\n`);
  process.exit(0);
}

if (require.main === module) {
  cliMain().catch(() => { process.stdout.write('0\n'); process.exit(0); });
}