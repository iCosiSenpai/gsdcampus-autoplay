#!/usr/bin/env node
/**
 * whoareyou-cli.js — schermata interattiva "CHI SEI?" per setup.sh.
 *
 * Ritorna un JSON su stdout:
 *   { action: "select", codice_fiscale, autologinUrl, memberName }
 *   { action: "manual", codice_fiscale, autologinUrl, memberName: "(configurazione manuale)" }
 *   { action: "keep" }
 *   { action: "cancel" }
 *
 * Supporta due modalità:
 *   - TTY: menu navigabile con frecce ↑/↓ e Invio, come una app nel terminale.
 *   - non-TTY: menu numerico classico, per compatibilità con pipe/redirezioni.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'config.json');
const DATA = path.join(ROOT, 'data');
const MEMBERS_CLI = path.join(ROOT, 'scripts', 'lib', 'members-cli.js');
const IMPORT_MEMBERS = path.join(ROOT, 'scripts', 'import-members.js');

const CF_FROM_URL_RE = /\/autologin\/([A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z])\//;

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

function readConfig() { return readJson(CONFIG, {}); }

function validAutologin(url) {
  return /^https:\/\/tecsial\.gsdcampus\.it\/autologin\/[A-Z]{6}[0-9]{2}[A-Z][0-9]{2}[A-Z][0-9]{3}[A-Z]\/[A-Za-z0-9]+$/.test(url);
}

function cfFromUrl(url) {
  const m = String(url).match(CF_FROM_URL_RE);
  return m ? m[1] : '';
}

function maskUrl(url) {
  return String(url).replace(/\/([^/]+)$/, '/•••••');
}

function execMembersCli(args) {
  const { execFileSync } = require('child_process');
  try {
    return execFileSync(process.execPath, [MEMBERS_CLI, ...args], { encoding: 'utf8', cwd: ROOT }).trim();
  } catch (e) {
    return '';
  }
}

function execMembersCliJson(args) {
  const out = execMembersCli(args);
  if (!out) return null;
  try { return JSON.parse(out); } catch (e) { return null; }
}

function countMembers() {
  const out = execMembersCli(['stats']);
  const m = out && out.match(/Membri nel database\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}

function importMembersCsv() {
  const { execFileSync } = require('child_process');
  const defCsv = path.join(process.env.HOME || '/tmp', 'Downloads', 'elenco utenti FNC.csv');
  return new Promise((resolve) => {
    readLine(`Percorso del CSV [${defCsv}]: `).then((answer) => {
      const csvPath = answer.trim() || defCsv;
      try {
        execFileSync(process.execPath, [IMPORT_MEMBERS, csvPath], { cwd: ROOT, stdio: 'inherit' });
        const n = countMembers();
        if (n > 0) {
          console.error(`Database membri popolato (${n} membri).`);
          resolve(true);
        } else {
          console.error('Import non riuscito o CSV vuoto.');
          resolve(false);
        }
      } catch (e) {
        console.error(`Import non riuscito: ${e.message}`);
        resolve(false);
      }
    });
  });
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) {
    console.error(`Errore scrittura config.json: ${e.message}`);
    return false;
  }
}

function updateConfigForAccount(result) {
  if (result.action !== 'select' && result.action !== 'manual') return true;
  const cfg = readConfig();
  cfg.autologinUrl = result.autologinUrl;
  cfg.codice_fiscale = result.codice_fiscale;
  cfg.memberName = result.memberName;
  if (!cfg.baseUrl) cfg.baseUrl = 'https://tecsial.gsdcampus.it/';
  if (!Array.isArray(cfg.courseUrls)) cfg.courseUrls = [];
  if (!cfg.ollamaModel) cfg.ollamaModel = 'gemma4:cloud';
  return writeConfig(cfg);
}

function clearScreen() {
  // Usa ANSI clear; se non supportato, stampa solo a capo.
  process.stdout.write('\x1b[2J\x1b[H');
}

function printBox(title, lines) {
  console.log('============================================');
  console.log(title);
  console.log('============================================');
  lines.forEach(l => console.log(l));
}

// ────────────────────────────────────────────────────────────────
// Menu interattivo TTY (frecce + invio)
// ────────────────────────────────────────────────────────────────
function ttyMenu(items, title, subtitle) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let selected = 0;

    function draw() {
      clearScreen();
      printBox(title, []);
      if (subtitle) console.log(subtitle);
      console.log('');
      items.forEach((it, i) => {
        const cursor = i === selected ? '▶ ' : '  ';
        const label = typeof it === 'string' ? it : it.label;
        console.log(`${cursor}${label}`);
      });
      console.log('');
      console.log('↑/↓: muovi  •  Invio: seleziona  •  q: annulla');
    }

    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);

    function cleanup() {
      process.stdin.removeAllListeners('keypress');
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      rl.close();
    }

    function onKeypress(str, key) {
      if (!key) return;
      if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
        cleanup();
        resolve(null);
        return;
      }
      if (key.name === 'up' && selected > 0) {
        selected--;
        draw();
      } else if (key.name === 'down' && selected < items.length - 1) {
        selected++;
        draw();
      } else if (key.name === 'return') {
        cleanup();
        resolve(items[selected]);
      }
    }

    process.stdin.on('keypress', onKeypress);
    draw();
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
  initLineReader();
  if (!process.stdin.isTTY) {
    process.stdout.write(question);
  } else {
    // Su TTY lasciamo che readline gestisca il cursore, se serve
    // (qui usato solo da numericMenu/promptText in fallback)
    process.stdout.write(question);
  }
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

// ────────────────────────────────────────────────────────────────
// Flussi di ricerca e selezione membri
// ────────────────────────────────────────────────────────────────
async function promptText(question) {
  return readLine(question);
}

async function searchAndSelectMember(mode) {
  while (true) {
    let q;
    if (mode === 'cf') {
      q = await promptText('Codice fiscale: ');
    } else {
      q = await promptText('Nome e cognome: ');
    }
    if (!q) {
      console.log('Ricerca vuota, annullo.');
      return null;
    }

    const listOut = execMembersCli(['search', q]);
    if (!listOut || /Nessun membro/i.test(listOut)) {
      console.log(`Nessun membro trovato per "${q}".`);
      const retry = await menu([
        { label: 'Riprova', value: 'retry' },
        { label: 'Torna al menu principale', value: 'back' }
      ], 'Nessun risultato', '');
      if (!retry || retry.value === 'back') return null;
      continue;
    }

    console.log('');
    console.log(listOut);
    const num = await promptText('Numero del membro (0 per annullare): ');
    const n = parseInt(num, 10);
    if (num === '0' || Number.isNaN(n)) return null;

    const json = execMembersCliJson(['select', String(n)]);
    if (!json) {
      console.log('Selezione non valida.');
      continue;
    }

    if (validAutologin(json.autologin_url) && json.codice_fiscale) {
      return {
        action: 'select',
        codice_fiscale: json.codice_fiscale,
        autologinUrl: json.autologin_url,
        memberName: [json.nome, json.cognome].filter(Boolean).join(' ').trim()
      };
    }
    console.log('Link del membro non valido. Riprova.');
  }
}

async function listAndSelectMember() {
  while (true) {
    const listOut = execMembersCli(['list']);
    if (!listOut || /Nessun membro/i.test(listOut)) {
      console.log('Nessun membro nel database.');
      return null;
    }

    console.log('');
    console.log(listOut);
    const num = await promptText('Numero del membro (0 per annullare): ');
    const n = parseInt(num, 10);
    if (num === '0' || Number.isNaN(n)) return null;

    const json = execMembersCliJson(['select', String(n)]);
    if (!json) {
      console.log('Selezione non valida.');
      continue;
    }

    if (validAutologin(json.autologin_url) && json.codice_fiscale) {
      return {
        action: 'select',
        codice_fiscale: json.codice_fiscale,
        autologinUrl: json.autologin_url,
        memberName: [json.nome, json.cognome].filter(Boolean).join(' ').trim()
      };
    }
    console.log('Link del membro non valido. Riprova.');
  }
}

async function manualAutologin() {
  while (true) {
    const url = await promptText('Link autologin: ');
    if (!url) {
      console.log('Link vuoto, annullo.');
      return null;
    }
    if (!validAutologin(url)) {
      console.log('Link non valido. Formato atteso: https://tecsial.gsdcampus.it/autologin/CODICEFISCALE/TOKEN');
      const retry = await menu([
        { label: 'Riprova', value: 'retry' },
        { label: 'Torna al menu principale', value: 'back' }
      ], 'Link non valido', '');
      if (!retry || retry.value === 'back') return null;
      continue;
    }
    return {
      action: 'manual',
      codice_fiscale: cfFromUrl(url),
      autologinUrl: url,
      memberName: '(configurazione manuale)'
    };
  }
}

// ────────────────────────────────────────────────────────────────
// Schermata principale "CHI SEI?"
// ────────────────────────────────────────────────────────────────
async function main() {
  const cfg = readConfig();
  const currentUrl = cfg.autologinUrl || '';
  const currentCf = cfg.codice_fiscale || '';
  const currentName = cfg.memberName || '';

  let subtitle = '';
  if (currentName && currentCf) {
    subtitle = `Account attuale: ${currentName} (CF: ${currentCf})`;
  } else if (currentUrl && validAutologin(currentUrl)) {
    subtitle = `Account attuale: ${maskUrl(currentUrl)}`;
  } else {
    subtitle = 'Nessun account configurato.';
  }

  // Se --yes è attivo via env, mantieni l'account attuale se valido
  if (process.env.AUTO_YES === 'true') {
    if (currentUrl && validAutologin(currentUrl)) {
      console.error(`Modalità automatica: account attuale confermato (${currentName || maskUrl(currentUrl)}).`);
      return { action: 'keep' };
    }
    return { action: 'cancel', reason: 'AUTO_YES senza account valido' };
  }

  const dbCount = countMembers();

  const items = [
    { label: 'Cerca per codice fiscale', value: 'cf' },
    { label: 'Cerca per nome e cognome', value: 'name' },
    { label: 'Mostra lista completa membri', value: 'list' }
  ];

  if (dbCount === 0) {
    items.push({ label: 'Importa elenco membri (CSV)', value: 'import' });
  }

  items.push(
    { label: 'Inserisci autologin manualmente', value: 'manual' }
  );

  if (currentUrl && validAutologin(currentUrl)) {
    items.push({ label: 'Mantieni account attuale', value: 'keep' });
  }
  items.push({ label: 'Annulla', value: 'cancel' });

  const choice = await menu(items, 'CHI SEI?', subtitle);
  if (!choice) return { action: 'cancel' };

  if (choice.value === 'import') {
    const ok = await importMembersCsv();
    if (!ok) return { action: 'cancel', reason: 'Import CSV fallito' };
    // Dopo import, riavvia il menu principale
    return main();
  }

  let result;
  switch (choice.value) {
    case 'cf': result = await searchAndSelectMember('cf'); break;
    case 'name': result = await searchAndSelectMember('name'); break;
    case 'list': result = await listAndSelectMember(); break;
    case 'manual': result = await manualAutologin(); break;
    case 'keep': result = { action: 'keep' }; break;
    default: result = { action: 'cancel' };
  }

  if (result && (result.action === 'select' || result.action === 'manual')) {
    if (!updateConfigForAccount(result)) {
      return { action: 'cancel', reason: 'Impossibile salvare config.json' };
    }
    console.error(`Account selezionato: ${result.memberName} (CF: ${result.codice_fiscale})`);
  } else if (result && result.action === 'keep') {
    console.error('Account attuale confermato.');
  }

  return result;
}

main()
  .then(result => {
    const out = JSON.stringify(result);
    const outFile = process.argv[2];
    if (outFile) {
      try { fs.writeFileSync(outFile, out); } catch (e) { /* ignored */ }
    }
    console.log(out);
    closeLineReader();
    process.exit(0);
  })
  .catch(err => {
    const out = JSON.stringify({ action: 'cancel', reason: err.message });
    const outFile = process.argv[2];
    if (outFile) {
      try { fs.writeFileSync(outFile, out); } catch (e) { /* ignored */ }
    }
    console.error(out);
    closeLineReader();
    process.exit(1);
  });
