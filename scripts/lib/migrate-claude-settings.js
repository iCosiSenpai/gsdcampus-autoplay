#!/usr/bin/env node

/**
 * Rimuove esclusivamente override Claude riconducibili al vecchio ponte Ollama
 * del progetto. Non cancella conversazioni, tema, modello personale, login
 * Anthropic o provider non-Ollama.
 */

const fs = require('fs');
const path = require('path');

const PROVIDER_MARKER = /ollama|127\.0\.0\.1:11434|localhost:11434/i;
const PROVIDER_SECRET_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
]);

function objectMentionsOllama(value) {
  try { return PROVIDER_MARKER.test(JSON.stringify(value)); } catch (_) { return false; }
}

function cleanSettingsObject(input) {
  const output = JSON.parse(JSON.stringify(input || {}));
  let changed = false;

  if (output.env && typeof output.env === 'object' && objectMentionsOllama(output.env)) {
    for (const key of PROVIDER_SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(output.env, key)) {
        delete output.env[key];
        changed = true;
      }
    }
    if (Object.keys(output.env).length === 0) delete output.env;
  }

  if (output.providers && typeof output.providers === 'object') {
    for (const [name, provider] of Object.entries(output.providers)) {
      if (PROVIDER_MARKER.test(name) || objectMentionsOllama(provider)) {
        delete output.providers[name];
        changed = true;
      }
    }
    if (Object.keys(output.providers).length === 0) delete output.providers;
  }

  return { changed, value: output };
}

function cleanFile(file) {
  if (!fs.existsSync(file)) return { file, changed: false, exists: false };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
    return { file, changed: false, exists: true, invalid: true };
  }
  const cleaned = cleanSettingsObject(raw);
  if (!cleaned.changed) return { file, changed: false, exists: true };
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(cleaned.value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { file, changed: true, exists: true };
}

function cleanShellProfile(file) {
  if (!fs.existsSync(file)) return { file, changed: false, exists: false };
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((line) => {
    const isProviderVar = /(?:export\s+)?(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|ANTHROPIC_MODEL)\s*=/.test(line);
    return !(isProviderVar && PROVIDER_MARKER.test(line));
  });
  const changed = kept.length !== lines.length;
  if (changed) fs.writeFileSync(file, kept.join('\n'), { mode: 0o600 });
  return { file, changed, exists: true };
}

function migrate({ home = process.env.HOME, project = process.cwd() } = {}) {
  const candidates = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.config', 'claude', 'settings.json'),
    path.join(project, '.claude', 'settings.json'),
    path.join(project, '.claude', 'settings.local.json'),
  ];
  const results = [...new Set(candidates)].map(cleanFile);
  for (const profile of ['.zshrc', '.zprofile', '.bash_profile', '.bashrc', '.profile']) {
    results.push(cleanShellProfile(path.join(home, profile)));
  }
  return { changed: results.filter((item) => item.changed).length, results };
}

if (require.main === module) {
  const result = migrate();
  console.log(result.changed > 0
    ? `Rimossi override GSD/Ollama da ${result.changed} file Claude.`
    : 'Nessun override GSD/Ollama persistente trovato in Claude.');
}

module.exports = { cleanSettingsObject, migrate, objectMentionsOllama };
