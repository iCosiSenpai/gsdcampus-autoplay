#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function normalizeOllamaModel(model) {
  const value = String(model || '').trim();
  if (!value) return 'gemma4:31b-cloud';
  if (!/^[a-zA-Z0-9._:/-]+$/.test(value)) throw new Error('Nome modello Ollama non valido');
  return value;
}

function createOpenCodeConfig(projectRoot = path.resolve(__dirname, '..', '..')) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8')); } catch (_) {}
  const model = normalizeOllamaModel(cfg.ollamaModel || 'gemma4:31b-cloud');
  const port = Math.max(1024, Math.min(65535, Number(cfg.aiCloudProxyPort) || 11435));

  return {
    $schema: 'https://opencode.ai/config.json',
    model: `ollama-budget/${model}`,
    small_model: `ollama-budget/${model}`,
    share: 'disabled',
    autoupdate: false,
    instructions: ['AGENTS.md'],
    enabled_providers: ['ollama-budget'],
    provider: {
      'ollama-budget': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama locale/Cloud (budget protetto)',
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: process.env.GSD_AI_PROXY_TOKEN || 'local-budget-proxy',
        },
        models: {
          [model]: {
            name: `${model} via Ollama`,
            limit: { context: 256000, output: 8192 },
          },
        },
      },
    },
    permission: {
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      bash: 'allow',
      webfetch: 'allow',
      websearch: 'allow',
      question: 'allow',
      edit: 'deny',
      task: 'deny',
      external_directory: 'deny',
    },
  };
}

if (require.main === module) {
  process.stdout.write(JSON.stringify(createOpenCodeConfig()));
}

module.exports = { createOpenCodeConfig, normalizeOllamaModel };
