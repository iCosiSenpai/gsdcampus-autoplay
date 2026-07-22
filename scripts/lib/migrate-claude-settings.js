#!/usr/bin/env node

/**
 * Rimuove esclusivamente override Claude riconducibili al vecchio ponte Ollama
 * del progetto. Non cancella conversazioni, tema, modello personale, login
 * Anthropic o provider non-Ollama.
 */

const fs = require('fs');
const path = require('path');

const PROVIDER_MARKER = /ollama|127\.0\.0\.1:11434|localhost:11434/i;
const DUMMY_SECRET_MARKER = /ollama|not[-_ ]?needed|dummy|local[-_ ]?only/i;
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

  if (output.env && typeof output.env === 'object') {
    const localBase = PROVIDER_MARKER.test(String(output.env.ANTHROPIC_BASE_URL || ''));
    for (const key of PROVIDER_SECRET_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(output.env, key)) continue;
      const value = String(output.env[key] == null ? '' : output.env[key]);
      const isBase = key === 'ANTHROPIC_BASE_URL';
      const isModel = /MODEL$/.test(key);
      const isSecret = key === 'ANTHROPIC_API_KEY' || key === 'ANTHROPIC_AUTH_TOKEN';
      // Non dedurre mai che una chiave Anthropic personale sia del progetto
      // soltanto perche un'altra variabile (es. OLLAMA_HOST) menziona Ollama.
      // Rimuovi URL/modelli del bridge locale e soli token chiaramente dummy.
      const remove = (isBase && PROVIDER_MARKER.test(value))
        || (isModel && (PROVIDER_MARKER.test(value) || localBase))
        || (isSecret && DUMMY_SECRET_MARKER.test(value));
      if (remove) {
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

function backupOnce(file) {
  const backup = `${file}.gsdcampus-backup`;
  if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
  try { fs.chmodSync(backup, 0o600); } catch (_) {}
  return backup;
}

function cleanFile(file) {
  if (!fs.existsSync(file)) return { file, changed: false, exists: false };
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
    return { file, changed: false, exists: true, invalid: true };
  }
  const cleaned = cleanSettingsObject(raw);
  if (!cleaned.changed) return { file, changed: false, exists: true };
  backupOnce(file);
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
  if (changed) {
    backupOnce(file);
    fs.writeFileSync(file, kept.join('\n'), { mode: 0o600 });
  }
  return { file, changed, exists: true };
}

function migrateProjectConfig(project) {
  const file = path.join(project, 'config.json');
  if (!fs.existsSync(file)) return { file, changed: false, exists: false, kind: 'project-config' };
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {
    return { file, changed: false, exists: true, invalid: true, kind: 'project-config' };
  }
  const before = JSON.stringify(cfg);
  cfg.aiSupervisorClient = 'claude-on-demand';
  cfg.useOllamaForQuiz = false;
  if (!cfg.ollamaLocalEndpoint) cfg.ollamaLocalEndpoint = 'http://127.0.0.1:11434';
  if (!cfg.aiCloudProxyPort) cfg.aiCloudProxyPort = 11435;
  if (!cfg.aiWeeklyRequestLimit) cfg.aiWeeklyRequestLimit = 400;
  if (!cfg.aiDailyRequestLimit) cfg.aiDailyRequestLimit = 80;
  if (!cfg.aiPerMinuteRequestLimit) cfg.aiPerMinuteRequestLimit = 8;
  if (!cfg.aiMinRequestIntervalMs) cfg.aiMinRequestIntervalMs = 1500;
  cfg.aiMaxConcurrentRequests = 1;
  const configuredBatchLimit = Number(cfg.aiClaudeMaxRequestsPerBatch);
  cfg.aiClaudeMaxRequestsPerBatch = Number.isFinite(configuredBatchLimit)
    ? Math.max(1, Math.min(8, Math.floor(configuredBatchLimit)))
    : 8;
  const configuredTimeout = Number(cfg.aiClaudeTimeoutMs);
  cfg.aiClaudeTimeoutMs = Number.isFinite(configuredTimeout)
    ? Math.max(60000, Math.min(1800000, Math.floor(configuredTimeout)))
    : 900000;
  if (JSON.stringify(cfg) === before) return { file, changed: false, exists: true, kind: 'project-config' };
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
  return { file, changed: true, exists: true, kind: 'project-config' };
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
  results.push(migrateProjectConfig(project));
  return { changed: results.filter((item) => item.changed).length, results };
}

if (require.main === module) {
  const result = migrate();
  console.log(result.changed > 0
    ? `Migrazione Claude on-demand applicata a ${result.changed} file.`
    : 'Configurazione Claude on-demand gia allineata.');
}

module.exports = { cleanSettingsObject, migrate, migrateProjectConfig, objectMentionsOllama };
