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
const { spawnSync } = require('child_process');

function clearScreen() {
  // Usa ANSI clear; se non supportato, stampa solo a capo.
  process.stdout.write('\x1b[2J\x1b[H');
}

// Stile allineato a scripts/lib/ui.sh: box arrotondato + accent, testo
// secondario DIM. I codici sono no-op visivi accettabili anche su terminali
// poveri; il menu gira sempre su /dev/tty (TTY reale), quindi niente guard.
const UI = {
  accent: '\x1b[38;5;45m',
  accentSoft: '\x1b[38;5;117m',
  green: '\x1b[38;5;84m',
  red: '\x1b[38;5;203m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

const ANSI_RE = /\x1b\[[0-9;]*m/g;

function visibleLength(value) {
  return [...String(value).replace(ANSI_RE, '')].length;
}

function getTerminalSize() {
  const fallback = {
    columns: Number(process.stdout.columns) || Number(process.env.COLUMNS) || 100,
    rows: Number(process.stdout.rows) || Number(process.env.LINES) || 40,
  };
  let ttyFd = null;
  try {
    ttyFd = fs.openSync('/dev/tty', 'r');
    const result = spawnSync('stty', ['size'], {
      encoding: 'utf8',
      stdio: [ttyFd, 'pipe', 'ignore'],
    });
    const [rows, columns] = String(result.stdout || '').trim().split(/\s+/).map(Number);
    if (Number.isInteger(columns) && columns >= 40) fallback.columns = columns;
    if (Number.isInteger(rows) && rows >= 15) fallback.rows = rows;
  } catch (_) {
    // Un contesto senza /dev/tty usa semplicemente le dimensioni di fallback.
  } finally {
    if (ttyFd !== null) {
      try { fs.closeSync(ttyFd); } catch (_) { /* già chiuso */ }
    }
  }
  return fallback;
}

function wrapText(value, width) {
  const lines = [];
  String(value || '').split('\n').forEach((paragraph) => {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      return;
    }
    let line = '';
    words.forEach((word) => {
      if (!line) {
        line = word;
      } else if ([...`${line} ${word}`].length <= width) {
        line += ` ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
    });
    if (line) lines.push(line);
  });
  return lines;
}

function menuLayout(itemCount = 0, branded = false) {
  const size = getTerminalSize();
  const inner = Math.min(72, Math.max(50, size.columns - 6));
  const indent = ' '.repeat(Math.max(1, Math.floor((size.columns - inner - 2) / 2)));
  const estimatedRows = (branded ? 9 : 5) + (itemCount * 2) + 4;
  const top = Math.max(0, Math.min(3, Math.floor((size.rows - estimatedRows) / 4)));
  return { ...size, inner, indent, top };
}

function framedLine(layout, content = '') {
  const pad = ' '.repeat(Math.max(0, layout.inner - visibleLength(content)));
  console.log(`${layout.indent}${UI.accent}│${UI.reset}${content}${pad}${UI.accent}│${UI.reset}`);
}

function panelTop(layout) {
  console.log(`${layout.indent}${UI.accent}╭${'─'.repeat(layout.inner)}╮${UI.reset}`);
}

function panelBottom(layout) {
  console.log(`${layout.indent}${UI.accent}╰${'─'.repeat(layout.inner)}╯${UI.reset}`);
}

function printBrandHero(layout) {
  panelTop(layout);
  framedLine(layout);
  if (layout.inner >= 62) {
    framedLine(layout, `       ${UI.accentSoft}╭─────╮${UI.reset}      ${UI.bold}GSD CAMPUS${UI.reset}`);
    framedLine(layout, `       ${UI.accentSoft}│ ◉ ◉ │${UI.reset}      ${UI.bold}AUTOPILOT${UI.reset}`);
    framedLine(layout, `       ${UI.accentSoft}│  ▾  │${UI.reset}      ${UI.accentSoft}Ciao collega!${UI.reset}`);
    framedLine(layout, `       ${UI.accentSoft}╰─────╯${UI.reset}      ${UI.dim}aggiorna · configura · avvia${UI.reset}`);
  } else {
    framedLine(layout, `    ${UI.accentSoft}╭───╮${UI.reset}    ${UI.bold}GSD CAMPUS${UI.reset}`);
    framedLine(layout, `    ${UI.accentSoft}│◉◉ │${UI.reset}    ${UI.bold}AUTOPILOT${UI.reset}`);
    framedLine(layout, `    ${UI.accentSoft}╰─▾─╯${UI.reset}    ${UI.accentSoft}Ciao collega!${UI.reset}`);
  }
  framedLine(layout);
  panelBottom(layout);
}

function printMenuHeading(layout, title, subtitle, branded) {
  if (!branded) {
    panelTop(layout);
    framedLine(layout, `  ${UI.bold}${title}${UI.reset}`);
    wrapText(subtitle, layout.inner - 4).forEach((line) => {
      if (line) framedLine(layout, `  ${UI.dim}${line}${UI.reset}`);
    });
    panelBottom(layout);
    return;
  }

  console.log(`${layout.indent}${UI.accent}${UI.bold}${String(title || 'Cosa vuoi fare?').toUpperCase()}${UI.reset}`);
  wrapText(subtitle, layout.inner).forEach((line) => {
    if (line) console.log(`${layout.indent}${UI.dim}${line}${UI.reset}`);
  });
  console.log(`${layout.indent}${UI.dim}${'─'.repeat(layout.inner)}${UI.reset}`);
}

function describeItem(item) {
  const raw = typeof item === 'string' ? item : String(item.label || '');
  const separator = raw.indexOf(' — ');
  const label = separator >= 0 ? raw.slice(0, separator) : raw;
  let description = separator >= 0 ? raw.slice(separator + 3) : '';
  const recommended = /\(consigliato\)/i.test(description);
  description = description.replace(/\s*\(consigliato\)\s*/i, '').trim();
  return { label, description, recommended };
}

function printMenuItems(layout, items, selected) {
  const descriptionWidth = Math.max(28, layout.inner - 9);
  items.forEach((item, index) => {
    const { label, description, recommended } = describeItem(item);
    const number = String(index + 1).padStart(2, '0');
    const active = index === selected;
    const marker = active ? `${UI.accent}▌${UI.reset}` : ' ';
    const labelColor = /^Disinstalla/i.test(label) ? UI.red : (active ? UI.bold : '');
    const badge = recommended ? `  ${UI.green}${UI.bold}CONSIGLIATO${UI.reset}` : '';
    console.log(`${layout.indent}${marker}  ${UI.dim}${number}${UI.reset}  ${labelColor}${label}${UI.reset}${badge}`);

    const descriptionLines = wrapText(description, descriptionWidth).filter((line) => line !== '');
    if (descriptionLines.length > 0) {
      descriptionLines.forEach((line) => {
        const style = active ? UI.accentSoft : UI.dim;
        console.log(`${layout.indent}      ${style}${line}${UI.reset}`);
      });
    }
  });
}

function printMenuFooter(layout) {
  console.log(`${layout.indent}${UI.dim}${'─'.repeat(layout.inner)}${UI.reset}`);
  console.log(`${layout.indent}${UI.accent}↑↓${UI.reset} ${UI.dim}naviga${UI.reset}   ${UI.accent}INVIO${UI.reset} ${UI.dim}conferma${UI.reset}   ${UI.accent}Q${UI.reset} ${UI.dim}esci senza modifiche${UI.reset}`);
}

function drawMenuScreen(items, title, subtitle, selected, options = {}) {
  const branded = Boolean(options.brand);
  const preambleLines = options.preamble ? String(options.preamble).split('\n') : [];
  const layout = menuLayout(items.length + preambleLines.length, branded);
  clearScreen();
  for (let i = 0; i < layout.top; i++) console.log('');
  if (branded) {
    printBrandHero(layout);
    console.log('');
  }
  printMenuHeading(layout, title, subtitle, branded);
  // Preambolo stampato VERBATIM (nessun word-wrap): serve per blocchi allineati
  // come l'anteprima della settimana. Prima veniva stampato prima del menu e il
  // clear-screen del menu lo cancellava un attimo dopo.
  if (preambleLines.length) {
    console.log('');
    preambleLines.forEach((line) => console.log(`${layout.indent}${line}`));
  }
  console.log('');
  printMenuItems(layout, items, selected);
  console.log('');
  // Conto alla rovescia dell'avvio automatico, se attivo. Va detto a chiare
  // lettere che sta per partire da solo e che basta un tasto per fermarlo:
  // un menu che si muove da sé senza preavviso e' sgradevole.
  if (options.countdown > 0) {
    const s = options.countdown;
    console.log(`${layout.indent}${UI.accent}▸${UI.reset} Parto da solo tra ${UI.bold}${s}${UI.reset} second${s === 1 ? 'o' : 'i'} con la voce evidenziata ${UI.dim}(premi un tasto per scegliere tu)${UI.reset}`);
    console.log('');
  }
  printMenuFooter(layout);
}

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
function ttyMenu(items, title, subtitle, startIdx = 0, options = {}) {
  return new Promise((resolve) => {
    let selected = (Number.isInteger(startIdx) && startIdx >= 0 && startIdx < items.length) ? startIdx : 0;
    // Doppia protezione contro l'input fantasma: drain del buffer node +
    // finestra di grazia sui primi ms (i tasti pendenti nel buffer del kernel
    // vengono consegnati subito dopo resume(), prima che un umano possa
    // reagire al menu appena disegnato).
    const openedAt = Date.now();
    const GRACE_MS = 150;
    drainPendingStdin();

    // Avvio automatico: se nessuno tocca niente, dopo N secondi parte la voce
    // preselezionata. Chi rilancia il comando tutti i giorni vuole quasi sempre
    // la prima voce, e restare a fissare un menu non aggiunge nulla. Il primo
    // tasto — QUALSIASI tasto, anche solo una freccia — annulla il conto alla
    // rovescia per sempre: se hai messo le mani sulla tastiera stai scegliendo.
    let restanti = Number(options.timeoutSec) > 0 ? Math.floor(options.timeoutSec) : 0;
    let tick = null;
    const stopTimer = () => {
      if (tick) { clearInterval(tick); tick = null; }
      restanti = 0;
      options.countdown = null;
    };

    function draw() {
      drawMenuScreen(items, title, subtitle, selected, options);
    }

    if (restanti > 0) {
      options.countdown = restanti;
      tick = setInterval(() => {
        restanti -= 1;
        if (restanti <= 0) {
          stopTimer();
          cleanup();
          resolve(items[selected]);
          return;
        }
        options.countdown = restanti;
        draw();
      }, 1000);
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();

    function cleanup() {
      if (tick) { clearInterval(tick); tick = null; }
      process.stdin.removeListener('keypress', onKeypress);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    }

    function onKeypress(str, key) {
      if (!key) return;
      // Qualunque tasto (dopo la finestra di grazia) toglie di mezzo il conto
      // alla rovescia: da quel momento decide la persona, non il timer.
      if (restanti > 0 && Date.now() - openedAt >= GRACE_MS) { stopTimer(); draw(); }
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

// ────────────────────────────────────────────────────────────────
// Orologio a frecce: nessun orario da digitare
// ────────────────────────────────────────────────────────────────
// Prima gli orari si scrivevano a mano e in caso di errore comparivano i
// formati accettati del parser ("H, HH, HH:MM, HH.MM, HHMM"): documentazione
// tecnica al posto di una domanda. Qui l'orario si sposta con le frecce:
// ←/→ 15 minuti, ↑/↓ un'ora. Impossibile scrivere qualcosa di non valido.
const TIME_STEP_MIN = 15;

/** Somma minuti restando dentro la giornata (0:00–23:59, con giro). Pure. */
function stepMinutes(total, delta) {
  const n = Math.round(Number(total) || 0) + Math.round(Number(delta) || 0);
  return ((n % 1440) + 1440) % 1440;
}

/** minuti → "HH:MM". Pure. */
function formatMinutes(total) {
  const t = ((Math.round(Number(total) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** "9", "9:30", "9.30", "0930" → minuti; null se non interpretabile. Pure. */
function parseTimeToMinutes(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  let m = t.match(/^(\d{1,2})[:.](\d{2})$/);
  if (m) {
    const h = Number(m[1]); const mi = Number(m[2]);
    return (h <= 23 && mi <= 59) ? h * 60 + mi : null;
  }
  m = t.match(/^(\d{1,2})$/);
  if (m) return Number(m[1]) <= 23 ? Number(m[1]) * 60 : null;
  m = t.match(/^(\d{3,4})$/);
  if (m) {
    const p = t.padStart(4, '0');
    const h = Number(p.slice(0, 2)); const mi = Number(p.slice(2));
    return (h <= 23 && mi <= 59) ? h * 60 + mi : null;
  }
  return null;
}

function drawTimeScreen(title, subtitle, minutes, hint) {
  const layout = menuLayout(3, false);
  clearScreen();
  for (let i = 0; i < layout.top; i++) console.log('');
  printMenuHeading(layout, title, subtitle, false);
  console.log('');
  const big = `${UI.accent}‹${UI.reset}   ${UI.bold}${formatMinutes(minutes)}${UI.reset}   ${UI.accent}›${UI.reset}`;
  console.log(`${layout.indent}      ${big}`);
  console.log('');
  console.log(`${layout.indent}${UI.dim}${'─'.repeat(layout.inner)}${UI.reset}`);
  console.log(`${layout.indent}${UI.accent}←→${UI.reset} ${UI.dim}${TIME_STEP_MIN} minuti${UI.reset}   ${UI.accent}↑↓${UI.reset} ${UI.dim}un'ora${UI.reset}   ${UI.accent}INVIO${UI.reset} ${UI.dim}confermo${UI.reset}   ${UI.accent}ESC${UI.reset} ${UI.dim}indietro${UI.reset}`);
  if (hint) console.log(`${layout.indent}${UI.dim}${hint}${UI.reset}`);
}

/**
 * Selettore orario. Ritorna i minuti scelti, oppure **null** se si torna
 * indietro (ESC / q / Ctrl-C): così il chiamante può rifare il passo precedente
 * invece di dover confermare per forza.
 */
function timeMenu(title, subtitle, defaultMinutes, hint) {
  const start = Number.isFinite(defaultMinutes) ? stepMinutes(defaultMinutes, 0) : 9 * 60;
  if (!process.stdin.isTTY) {
    return readLine(`${title} [${formatMinutes(start)}] (b = indietro): `).then((answer) => {
      const txt = String(answer || '').trim().toLowerCase();
      if (txt === 'b' || txt === 'back' || txt === 'indietro') return null;
      const parsed = parseTimeToMinutes(answer);
      return parsed == null ? start : parsed;
    });
  }
  return new Promise((resolve) => {
    let value = start;
    const openedAt = Date.now();
    drainPendingStdin();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    };
    function onKey(str, key) {
      if (!key) return;
      if (Date.now() - openedAt < 150 && !(key.ctrl && key.name === 'c')) return;
      if (key.ctrl && key.name === 'c') { cleanup(); resolve(null); return; }
      switch (key.name) {
        case 'right': value = stepMinutes(value, TIME_STEP_MIN); break;
        case 'left': value = stepMinutes(value, -TIME_STEP_MIN); break;
        case 'up': value = stepMinutes(value, 60); break;
        case 'down': value = stepMinutes(value, -60); break;
        case 'return': case 'enter': cleanup(); resolve(value); return;
        case 'q': case 'escape': cleanup(); resolve(null); return;   // indietro
        default: return;
      }
      drawTimeScreen(title, subtitle, value, hint);
    }
    process.stdin.on('keypress', onKey);
    drawTimeScreen(title, subtitle, value, hint);
  });
}

// ────────────────────────────────────────────────────────────────
// Lista da spuntare: i giorni non si scrivono più a numeri
// ────────────────────────────────────────────────────────────────
/** Attiva/disattiva un indice in una selezione. Pure. */
function toggleSelection(selected, index) {
  const set = new Set(selected);
  if (set.has(index)) set.delete(index);
  else set.add(index);
  return [...set].sort((a, b) => a - b);
}

function drawCheckScreen(items, title, subtitle, selected, cursor) {
  const layout = menuLayout(items.length, false);
  clearScreen();
  for (let i = 0; i < layout.top; i++) console.log('');
  printMenuHeading(layout, title, subtitle, false);
  console.log('');
  items.forEach((item, i) => {
    const on = selected.includes(i);
    const active = i === cursor;
    const marker = active ? `${UI.accent}▌${UI.reset}` : ' ';
    const box = on ? `${UI.green}${UI.bold}[x]${UI.reset}` : `${UI.dim}[ ]${UI.reset}`;
    const label = active ? `${UI.bold}${item}${UI.reset}` : (on ? item : `${UI.dim}${item}${UI.reset}`);
    console.log(`${layout.indent}${marker}  ${box}  ${label}`);
  });
  console.log('');
  console.log(`${layout.indent}${UI.dim}${'─'.repeat(layout.inner)}${UI.reset}`);
  console.log(`${layout.indent}${UI.accent}↑↓${UI.reset} ${UI.dim}muovi${UI.reset}   ${UI.accent}SPAZIO${UI.reset} ${UI.dim}spunta${UI.reset}   ${UI.accent}INVIO${UI.reset} ${UI.dim}confermo${UI.reset}   ${UI.accent}ESC${UI.reset} ${UI.dim}indietro${UI.reset}`);
}

/**
 * Lista con caselle da spuntare. Ritorna gli indici selezionati (0-based),
 * oppure **null** se si torna indietro (ESC / q / Ctrl-C). Con Invio e nessuna
 * casella spuntata torna la preselezione (non si resta mai senza risposta).
 */
function checkMenu(items, title, subtitle, preselected = []) {
  const initial = [...new Set(preselected.filter((i) => i >= 0 && i < items.length))].sort((a, b) => a - b);
  if (!process.stdin.isTTY) {
    items.forEach((it, i) => console.log(`  [${i + 1}] ${it}`));
    return readLine('Numeri separati da virgola (Invio = come proposto, b = indietro): ').then((answer) => {
      const txt = String(answer || '').trim().toLowerCase();
      if (txt === 'b' || txt === 'back' || txt === 'indietro') return null;
      const picked = String(answer || '').split(',')
        .map((x) => parseInt(String(x).trim(), 10) - 1)
        .filter((i) => Number.isInteger(i) && i >= 0 && i < items.length);
      return picked.length ? [...new Set(picked)].sort((a, b) => a - b) : initial;
    });
  }
  return new Promise((resolve) => {
    let selected = initial;
    let cursor = initial.length ? initial[0] : 0;
    const openedAt = Date.now();
    drainPendingStdin();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    };
    function onKey(str, key) {
      if (!key) return;
      if (Date.now() - openedAt < 150 && !(key.ctrl && key.name === 'c')) return;
      if (key.ctrl && key.name === 'c') { cleanup(); resolve(null); return; }
      if (key.name === 'up') cursor = (cursor - 1 + items.length) % items.length;
      else if (key.name === 'down') cursor = (cursor + 1) % items.length;
      else if (key.name === 'space') selected = toggleSelection(selected, cursor);
      else if (str === 'a' || str === 'A') selected = items.map((_, i) => i);
      else if (str === 'n' || str === 'N') selected = [];
      else if (key.name === 'return' || key.name === 'enter') {
        cleanup();
        resolve(selected.length ? selected : initial);
        return;
      } else if (key.name === 'q' || key.name === 'escape') { cleanup(); resolve(null); return; }   // indietro
      else return;
      drawCheckScreen(items, title, subtitle, selected, cursor);
    }
    process.stdin.on('keypress', onKey);
    drawCheckScreen(items, title, subtitle, selected, cursor);
  });
}

// ────────────────────────────────────────────────────────────────
// Ricerca incrementale: una schermata sola per trovarsi nell'elenco
// ────────────────────────────────────────────────────────────────
/** Normalizza per confronti tolleranti (accenti, maiuscole, spazi). Pure. */
function normalizeForFilter(text) {
  return String(text == null ? '' : text)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Filtra le voci: tutte le parole digitate devono comparire (in qualsiasi
 * ordine), così "rossi mar" trova "MARIO ROSSI". Pure.
 */
function filterItems(items, query) {
  const words = normalizeForFilter(query).split(' ').filter(Boolean);
  if (words.length === 0) return items.slice();
  return items.filter((it) => {
    const hay = normalizeForFilter(typeof it === 'string' ? it : it.label);
    return words.every((w) => hay.includes(w));
  });
}

function drawFilterScreen(all, title, query, visible, cursor, maxRows) {
  const layout = menuLayout(Math.min(visible.length, maxRows) + 2, false);
  clearScreen();
  for (let i = 0; i < layout.top; i++) console.log('');
  const sub = `Scrivi qualche lettera del tuo cognome · ${visible.length} di ${all.length}`;
  printMenuHeading(layout, title, sub, false);
  console.log('');
  const caret = `${UI.accent}▏${UI.reset}`;
  console.log(`${layout.indent}  ${UI.dim}cerca:${UI.reset} ${UI.bold}${query || ''}${UI.reset}${caret}`);
  console.log('');
  if (visible.length === 0) {
    console.log(`${layout.indent}  ${UI.dim}(nessun nome corrisponde: cancella con il tasto ⌫)${UI.reset}`);
  } else {
    const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), visible.length - maxRows));
    const slice = visible.slice(Math.max(0, start), Math.max(0, start) + maxRows);
    slice.forEach((item, idx) => {
      const i = Math.max(0, start) + idx;
      const active = i === cursor;
      const label = typeof item === 'string' ? item : item.label;
      const marker = active ? `${UI.accent}▌${UI.reset}` : ' ';
      console.log(`${layout.indent}${marker}  ${active ? UI.bold + label + UI.reset : label}`);
    });
    if (visible.length > maxRows) {
      console.log(`${layout.indent}   ${UI.dim}… altri ${visible.length - maxRows} nomi: continua a scrivere${UI.reset}`);
    }
  }
  console.log('');
  console.log(`${layout.indent}${UI.dim}${'─'.repeat(layout.inner)}${UI.reset}`);
  console.log(`${layout.indent}${UI.accent}↑↓${UI.reset} ${UI.dim}muovi${UI.reset}   ${UI.accent}INVIO${UI.reset} ${UI.dim}sono io${UI.reset}   ${UI.accent}⌫${UI.reset} ${UI.dim}cancella${UI.reset}   ${UI.accent}ESC${UI.reset} ${UI.dim}torno indietro${UI.reset}`);
}

/**
 * Elenco con filtro mentre si scrive. Ritorna la voce scelta oppure null.
 * @param {Array<{label:string, value:any}|string>} items
 */
function filterMenu(items, title) {
  if (!process.stdin.isTTY) {
    return numericMenu(items, title, '');
  }
  const maxRows = Math.max(5, Math.min(12, (Number(process.stdout.rows) || 24) - 12));
  return new Promise((resolve) => {
    let query = '';
    let visible = items.slice();
    let cursor = 0;
    const openedAt = Date.now();
    drainPendingStdin();
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.removeListener('keypress', onKey);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
    };
    const redraw = () => drawFilterScreen(items, title, query, visible, cursor, maxRows);
    function onKey(str, key) {
      if (!key) return;
      if (Date.now() - openedAt < 150 && !(key.ctrl && key.name === 'c')) return;
      if (key.ctrl && key.name === 'c') { cleanup(); resolve(null); return; }
      if (key.name === 'escape') { cleanup(); resolve(null); return; }
      if (key.name === 'return' || key.name === 'enter') {
        if (visible.length === 0) return;
        cleanup();
        resolve(visible[Math.max(0, Math.min(cursor, visible.length - 1))]);
        return;
      }
      if (key.name === 'up') cursor = Math.max(0, cursor - 1);
      else if (key.name === 'down') cursor = Math.min(visible.length - 1, cursor + 1);
      else if (key.name === 'backspace') {
        query = query.slice(0, -1);
        visible = filterItems(items, query);
        cursor = 0;
      } else if (str && !key.ctrl && !key.meta && str.length === 1 && str >= ' ') {
        query += str;
        visible = filterItems(items, query);
        cursor = 0;
      } else return;
      redraw();
    }
    process.stdin.on('keypress', onKey);
    redraw();
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
function numericMenu(items, title, subtitle, options = {}) {
  return new Promise((resolve) => {
    function draw() {
      console.log('');
      printBox(title, []);
      if (subtitle) console.log(subtitle);
      if (options.preamble) console.log(String(options.preamble));
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
  // Widget nuovi (setup guidato) + helper puri usati dai test.
  timeMenu, checkMenu, filterMenu,
  stepMinutes, formatMinutes, parseTimeToMinutes, toggleSelection,
  filterItems, normalizeForFilter, TIME_STEP_MIN,
};

// ────────────────────────────────────────────────────────────────
// Wrapper CLI: `node prompt-cli.js select --brand --title T [--subtitle S] [--default N] -- A B C`
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
  let preamble = '';
  let defaultN = 1;
  let timeoutSec = 0;
  let brand = false;
  let items = [];
  let collectingItems = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (collectingItems) { items.push(a); continue; }
    if (a === '--') { collectingItems = true; continue; }
    if (a === '--title') { title = args[++i]; continue; }
    if (a === '--subtitle') { subtitle = args[++i]; continue; }
    if (a === '--preamble') { preamble = args[++i]; continue; }
    if (a === '--default') { defaultN = parseInt(args[++i], 10); continue; }
    if (a === '--timeout') { timeoutSec = parseInt(args[++i], 10); continue; }
    if (a === '--brand') { brand = true; continue; }
  }
  if (Number.isNaN(defaultN) || defaultN < 1) defaultN = 1;
  if (Number.isNaN(timeoutSec) || timeoutSec < 1) timeoutSec = 0;
  return { title, subtitle, preamble, defaultN, brand, items, timeoutSec };
}

// Sottocomandi per gli script shell (setup.sh):
//   time  --title T [--subtitle S] [--default 09:00] [--hint "..."]  -> stdout "HH:MM"
//   check --title T [--subtitle S] [--default 1,2,3] -- voce1 voce2   -> stdout "1,3"
// Entrambi scrivono il MENU su /dev/tty e solo il risultato su stdout, come
// `select`; exit sempre 0 (gli script girano in set -e).
async function cliTime(realStdoutWrite) {
  const { title, subtitle, defaultRaw, hint } = (() => {
    const args = process.argv.slice(3);
    const get = (flag, def = '') => {
      const i = args.indexOf(flag);
      return i > -1 && args[i + 1] ? args[i + 1] : def;
    };
    return {
      title: get('--title', 'Orario'),
      subtitle: get('--subtitle', ''),
      defaultRaw: get('--default', '09:00'),
      hint: get('--hint', ''),
    };
  })();
  const def = parseTimeToMinutes(defaultRaw);
  const value = await timeMenu(title, subtitle, def == null ? 9 * 60 : def, hint);
  // Riga vuota = "torna indietro": lo script chiamante rifà il passo precedente.
  realStdoutWrite(value == null ? '\n' : `${formatMinutes(value)}\n`);
}

async function cliCheck(realStdoutWrite) {
  const args = process.argv.slice(3);
  const get = (flag, def = '') => {
    const i = args.indexOf(flag);
    return i > -1 && args[i + 1] ? args[i + 1] : def;
  };
  const sepIdx = args.indexOf('--');
  const items = sepIdx > -1 ? args.slice(sepIdx + 1) : [];
  const pre = String(get('--default', '')).split(',')
    .map((x) => parseInt(String(x).trim(), 10) - 1)
    .filter((i) => Number.isInteger(i) && i >= 0 && i < items.length);
  if (items.length === 0) {
    realStdoutWrite('\n');
    return;
  }
  const picked = await checkMenu(items, get('--title', 'Scegli'), get('--subtitle', ''), pre);
  realStdoutWrite(picked == null ? '\n' : `${picked.map((i) => i + 1).join(',')}\n`);
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

  const sub = process.argv[2];
  if (sub === 'time' || sub === 'check') {
    try {
      if (sub === 'time') await cliTime(realStdoutWrite);
      else await cliCheck(realStdoutWrite);
    } catch (_) {
      realStdoutWrite('\n');
    }
    closeLineReader();
    process.exit(0);
  }

  const { title, subtitle, preamble, defaultN, brand, items } = parseArgs(process.argv);
  if (!items || items.length === 0) {
    realStdoutWrite('0\n');
    process.exit(0);
  }

  let chosen = null;
  try {
    if (process.stdin.isTTY) {
      chosen = await ttyMenu(items, title, subtitle, (defaultN - 1), { brand, preamble, timeoutSec });
    } else {
      // numericMenu ritorna l'item o null; mappa a indice.
      chosen = await numericMenu(items, title, subtitle, { preamble });
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
