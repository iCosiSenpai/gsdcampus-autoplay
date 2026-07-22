#!/usr/bin/env node
/**
 * opencode-cleanup.js — rimozione opzionale, una-tantum per macchina, di OpenCode.
 *
 * Contesto: il supervisore e' passato a Claude on-demand; OpenCode non serve piu'
 * al progetto. Questo helper NON tocca mai la cartella del progetto o i dati
 * personali (config.json, data/, banca risposte, cookie): agisce SOLO
 * sull'impronta di OpenCode nella HOME dell'utente.
 *
 * Impronta gestita:
 *   - pacchetti brew: opencode, opencode-desktop
 *   - cartelle: ~/.opencode, ~/.config/opencode
 *   - riga PATH nei profili shell che aggiunge ~/.opencode/bin
 *     (il segmento .opencode/bin viene tolto MA ~/.local/bin, dove vive `claude`,
 *      resta: non spezziamo mai il PATH di Claude)
 *
 * Comandi:
 *   status            stampa "prompt" (c'e' qualcosa e non e' ancora deciso) o "skip"
 *   remove            rimuove OpenCode e registra la decisione
 *   keep              lascia OpenCode e registra la decisione (non richiede piu')
 *   [--home <dir>]    override della HOME (per i test)
 *
 * Il marker vive in ~/.gsdcampus/opencode-cleanup.json (nella HOME, cosi
 * sopravvive a reset/re-clone del progetto). Exit code sempre 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROFILES = ['.zshrc', '.zprofile', '.bash_profile', '.bashrc', '.profile'];
const OC_DIRS = ['.opencode', path.join('.config', 'opencode')];
const BREW_PKGS = ['opencode', 'opencode-desktop'];

function markerPath(home) {
  return path.join(home, '.gsdcampus', 'opencode-cleanup.json');
}

function readDecision(home) {
  try { return JSON.parse(fs.readFileSync(markerPath(home), 'utf8')); } catch (_) { return null; }
}

function writeDecision(home, decision, extra = {}) {
  const p = markerPath(home);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `${JSON.stringify({ decision, at: new Date().toISOString(), ...extra }, null, 2)}\n`);
  } catch (_) { /* non bloccante */ }
}

// Toglie SOLO il segmento .opencode/bin da una riga `export PATH=...`, tenendo
// intatto il resto (in particolare ~/.local/bin). Ritorna la riga ripulita, o
// null se la riga non contiene .opencode/bin o non e' un export PATH gestibile.
function stripOpencodeFromPathLine(line) {
  if (typeof line !== 'string' || !/\.opencode\/bin/.test(line)) return null;
  const m = line.match(/^(\s*export\s+PATH=)(["']?)(.*?)\2\s*$/);
  if (!m) return null;
  const [, prefix, quote, value] = m;
  const parts = value.split(':').filter((p) => !/\.opencode\/bin\/?$/.test(p.trim()));
  const newValue = parts.join(':');
  if (newValue === value) return null;
  return `${prefix}${quote}${newValue}${quote}`;
}

function brewHas(pkg) {
  try { return spawnSync('brew', ['list', pkg], { stdio: 'ignore' }).status === 0; } catch (_) { return false; }
}

function detectFootprint(home, { checkBrew = true } = {}) {
  const dirs = OC_DIRS.filter((rel) => {
    try { return fs.existsSync(path.join(home, rel)); } catch (_) { return false; }
  });
  const profiles = PROFILES.filter((f) => {
    try {
      const p = path.join(home, f);
      return fs.existsSync(p) && /\.opencode\/bin/.test(fs.readFileSync(p, 'utf8'));
    } catch (_) { return false; }
  });
  const brew = checkBrew ? BREW_PKGS.filter(brewHas) : [];
  return { dirs, profiles, brew, present: dirs.length > 0 || profiles.length > 0 || brew.length > 0 };
}

function cleanProfiles(home) {
  const changed = [];
  for (const f of PROFILES) {
    const p = path.join(home, f);
    try {
      if (!fs.existsSync(p)) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      let touched = false;
      const out = lines.map((l) => {
        const cleaned = stripOpencodeFromPathLine(l);
        if (cleaned != null && cleaned !== l) { touched = true; return cleaned; }
        return l;
      });
      if (touched) {
        fs.copyFileSync(p, `${p}.gsdcampus-backup`);
        fs.writeFileSync(p, out.join('\n'));
        changed.push(f);
      }
    } catch (_) { /* ignora il singolo profilo */ }
  }
  return changed;
}

function removeDirs(home) {
  const removed = [];
  for (const rel of OC_DIRS) {
    const p = path.join(home, rel);
    // Guardia di sicurezza: solo percorsi dentro HOME, mai HOME stessa.
    if (!home || p === home || !p.startsWith(home + path.sep)) continue;
    try {
      if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); removed.push(rel); }
    } catch (_) { /* ignora */ }
  }
  return removed;
}

function uninstallBrew() {
  const removed = [];
  for (const pkg of BREW_PKGS) {
    if (!brewHas(pkg)) continue;
    try {
      const r = spawnSync('brew', ['uninstall', pkg], { stdio: 'inherit' });
      if (!r.error && r.status === 0) removed.push(pkg);
    } catch (_) { /* ignora */ }
  }
  return removed;
}

function removeOpencode(home, { skipBrew = false } = {}) {
  if (!home || home === '/' || home === path.parse(home).root) {
    throw new Error('HOME non valida: rimozione annullata');
  }
  const summary = [];
  const brew = skipBrew ? [] : uninstallBrew();
  if (brew.length) summary.push(`brew: ${brew.join(', ')}`);
  const dirs = removeDirs(home);
  if (dirs.length) summary.push(`cartelle: ${dirs.join(', ')}`);
  const profiles = cleanProfiles(home);
  if (profiles.length) summary.push(`PATH in: ${profiles.join(', ')}`);
  writeDecision(home, 'removed', { removed: summary });
  return summary;
}

function parseHome(argv) {
  const i = argv.indexOf('--home');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  return process.env.HOME || os.homedir();
}

function main() {
  const cmd = process.argv[2];
  const home = parseHome(process.argv);
  switch (cmd) {
    case 'status': {
      if (readDecision(home)) { process.stdout.write('skip\n'); return; }
      const fp = detectFootprint(home);
      process.stdout.write(`${fp.present ? 'prompt' : 'skip'}\n`);
      return;
    }
    case 'remove': {
      const summary = removeOpencode(home, { skipBrew: process.env.GSD_OPENCODE_SKIP_BREW === '1' });
      process.stdout.write(summary.length
        ? `OpenCode rimosso (${summary.join(' · ')}). I tuoi corsi e dati non sono stati toccati.\n`
        : 'OpenCode non risultava installato: niente da rimuovere.\n');
      return;
    }
    case 'keep': {
      writeDecision(home, 'kept');
      process.stdout.write('OpenCode lasciato installato: non te lo chiedero piu.\n');
      return;
    }
    default:
      process.stdout.write('uso: opencode-cleanup.js status|remove|keep [--home <dir>]\n');
  }
}

if (require.main === module) {
  try { main(); } catch (e) { process.stderr.write(`[opencode-cleanup] ${e && e.message}\n`); }
  process.exitCode = 0;
}

module.exports = {
  stripOpencodeFromPathLine, detectFootprint, cleanProfiles, removeDirs,
  removeOpencode, readDecision, writeDecision, markerPath,
};
