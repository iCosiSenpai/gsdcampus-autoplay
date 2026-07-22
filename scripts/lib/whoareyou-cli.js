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

const ROOT = path.join(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'config.json');
const DATA = path.join(ROOT, 'data');
const MEMBERS_CLI = path.join(ROOT, 'scripts', 'lib', 'members-cli.js');
const IMPORT_MEMBERS = path.join(ROOT, 'scripts', 'import-members.js');
const { writeJsonAtomic } = require(path.join(__dirname, 'write-json'));

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
      if (!fs.existsSync(csvPath)) {
        console.error(`File non trovato: ${csvPath}`);
        console.error('Metti il CSV dell\'elenco utenti (es. in ~/Downloads) e riprova,');
        console.error('oppure scegli "Inserisci autologin manualmente" per incollare il tuo link.');
        resolve(false);
        return;
      }
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
    // Scrittura atomica (tmp+rename): se il setup viene interrotto (Ctrl-C)
    // durante la selezione del membro, config.json non resta troncato a metà.
    writeJsonAtomic(CONFIG, cfg);
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
  if (!cfg.ollamaModel) cfg.ollamaModel = 'gemma4:31b-cloud';
  cfg.aiSupervisorClient = 'claude-on-demand';
  cfg.useOllamaForQuiz = false;
  if (!cfg.ollamaLocalEndpoint) cfg.ollamaLocalEndpoint = 'http://127.0.0.1:11434';
  if (!cfg.aiCloudProxyPort) cfg.aiCloudProxyPort = 11435;
  if (!cfg.aiWeeklyRequestLimit) cfg.aiWeeklyRequestLimit = 400;
  if (!cfg.aiDailyRequestLimit) cfg.aiDailyRequestLimit = 80;
  if (!cfg.aiPerMinuteRequestLimit) cfg.aiPerMinuteRequestLimit = 8;
  if (!cfg.aiMinRequestIntervalMs) cfg.aiMinRequestIntervalMs = 1500;
  if (!cfg.aiMaxConcurrentRequests) cfg.aiMaxConcurrentRequests = 1;
  const configuredBatchLimit = Number(cfg.aiClaudeMaxRequestsPerBatch);
  cfg.aiClaudeMaxRequestsPerBatch = Number.isFinite(configuredBatchLimit)
    ? Math.max(1, Math.min(8, Math.floor(configuredBatchLimit))) : 8;
  if (!cfg.aiClaudeTimeoutMs) cfg.aiClaudeTimeoutMs = 900000;
  return writeConfig(cfg);
}

// TUI helpers (menu a frecce, lettura riga) condivisi con gli script shell via
// wrapper CLI. Estratti in scripts/lib/prompt-cli.js.
const {
  ttyMenu, numericMenu, menu,
  readLine, readLineTTY, closeLineReader,
  clearScreen, printBox,
} = require(path.join(__dirname, 'prompt-cli'));

// ────────────────────────────────────────────────────────────────
// Flussi di ricerca e selezione membri
// ────────────────────────────────────────────────────────────────
async function promptText(question) {
  return readLine(question);
}

// Mostra la lista numerata dei membri (output di `members-cli search/list`) e ne
// permette la selezione con un menu a frecce (su TTY) o numerico (non-TTY).
// Ritorna il numero 1-based scelto, oppure null se annullato o lista vuota.
// Il contratto `members-cli select <n>` resta invariato: qui scegliamo solo il n.
async function pickMemberFromList(listOut, title) {
  if (!listOut) return null;
  const items = listOut
    .split('\n')
    .map(l => {
      const m = l.match(/^\s*(\d+)\)\s*(.+)$/);
      return m ? { label: m[2].trim(), value: parseInt(m[1], 10) } : null;
    })
    .filter(Boolean);
  if (items.length === 0) return null;
  const pick = await menu(items, title, '↑/↓ muovi · Invio seleziona · q annulla');
  if (!pick || pick.value == null) return null;
  return pick.value;
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
    const n = await pickMemberFromList(listOut, 'Seleziona il membro');
    if (n == null) return null;

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
    const n = await pickMemberFromList(listOut, 'Seleziona il membro');
    if (n == null) return null;

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

  // Loop del menu principale: se l'utente esce da un sotto-flusso (ricerca vuota,
  // "torna indietro", selezione annullata) si torna QUI invece di chiudere il setup.
  // Solo "Annulla"/q chiudono davvero.
  while (true) {
    const dbCount = countMembers();

    let items;
    let menuSubtitle = subtitle;

    if (dbCount === 0) {
      // Database membri assente (es. installazione fresca via git clone: members.db
      // è gitignored perché contiene i token di autologin). Le ricerche per
      // nome/CF/lista NON possono funzionare senza DB, quindi NON le offriamo:
      // mostriamo solo le azioni utili e una spiegazione chiara, così il collega
      // non resta in loop "nessun membro trovato / riprova".
      const defCsv = path.join(process.env.HOME || '/tmp', 'Downloads', 'elenco utenti FNC.csv');
      let importLabel = 'Importa elenco membri (CSV)';
      if (fs.existsSync(defCsv)) {
        importLabel = 'Importa elenco membri (CSV trovato in ~/Downloads)';
      }
      menuSubtitle = 'Nessun elenco membri presente su questo Mac.\n' +
        'Per scegliere il tuo account: importa il CSV dell\'elenco (se lo hai), ' +
        'oppure incolla il tuo link di autologin personale.';
      items = [
        { label: importLabel, value: 'import' },
        { label: 'Inserisci autologin manualmente (incolla il tuo link)', value: 'manual' }
      ];
      if (currentUrl && validAutologin(currentUrl)) {
        items.push({ label: 'Mantieni account attuale', value: 'keep' });
      }
      items.push({ label: 'Annulla', value: 'cancel' });
    } else {
      items = [
        { label: 'Cerca per codice fiscale', value: 'cf' },
        { label: 'Cerca per nome e cognome', value: 'name' },
        { label: 'Mostra lista completa membri', value: 'list' },
        { label: 'Inserisci autologin manualmente', value: 'manual' }
      ];
      if (currentUrl && validAutologin(currentUrl)) {
        items.push({ label: 'Mantieni account attuale', value: 'keep' });
      }
      items.push({ label: 'Annulla', value: 'cancel' });
    }

    const choice = await menu(items, 'CHI SEI?', menuSubtitle);
    if (!choice || choice.value === 'cancel') return { action: 'cancel' };

    if (choice.value === 'keep') {
      console.error('Account attuale confermato.');
      return { action: 'keep' };
    }

    if (choice.value === 'import') {
      const ok = await importMembersCsv();
      if (!ok) console.error('Import non riuscito. Torno al menu principale.');
      continue; // ridisegna il menu (dbCount aggiornato dopo l'import)
    }

    let result = null;
    switch (choice.value) {
      case 'cf': result = await searchAndSelectMember('cf'); break;
      case 'name': result = await searchAndSelectMember('name'); break;
      case 'list': result = await listAndSelectMember(); break;
      case 'manual': result = await manualAutologin(); break;
    }

    if (!result) {
      // L'utente è uscito dal sotto-flusso senza scegliere: torna al menu.
      continue;
    }

    if (result.action === 'select' || result.action === 'manual') {
      if (!updateConfigForAccount(result)) {
        return { action: 'cancel', reason: 'Impossibile salvare config.json' };
      }
      console.error(`Account selezionato: ${result.memberName} (CF: ${result.codice_fiscale})`);
    }
    return result;
  }
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
