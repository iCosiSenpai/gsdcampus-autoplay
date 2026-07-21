#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

function directCloudModel(model) {
  const value = String(model || '').trim();
  if (!value) return 'gemma4:31b';
  if (!/^[a-zA-Z0-9._:/-]+$/.test(value)) throw new Error('Nome modello Ollama non valido');
  if (value.endsWith('-cloud')) return value.slice(0, -'-cloud'.length);
  if (value.endsWith(':cloud')) return value.slice(0, -':cloud'.length);
  return value;
}

function createOpenCodeConfig(projectRoot = path.resolve(__dirname, '..', '..')) {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'config.json'), 'utf8')); } catch (_) {}
  const model = directCloudModel(cfg.ollamaModel || 'gemma4:31b-cloud');
  const port = Math.max(1024, Math.min(65535, Number(cfg.aiCloudProxyPort) || 11435));

  return {
    $schema: 'https://opencode.ai/config.json',
    model: `ollama-cloud/${model}`,
    small_model: `ollama-cloud/${model}`,
    share: 'disabled',
    autoupdate: false,
    instructions: ['AGENTS.md'],
    enabled_providers: ['ollama-cloud'],
    provider: {
      'ollama-cloud': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Ollama Cloud (budget protetto)',
        options: {
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKey: process.env.GSD_AI_PROXY_TOKEN || 'local-budget-proxy',
        },
        models: {
          [model]: {
            name: `${model} via Ollama Cloud`,
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

module.exports = { createOpenCodeConfig, directCloudModel };
