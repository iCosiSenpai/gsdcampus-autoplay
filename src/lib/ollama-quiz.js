/**
 * Client Ollama per rispondere a domande di quiz.
 * Usa il modello cloud locale configurato in Ollama.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const TIMEOUT_MS = 30000;

/**
 * Legge il modello Ollama da config.json (campo `ollamaModel`).
 * Fallback: gemma4:31b-cloud per retrocompatibilità.
 */
function readOllamaModel() {
  try {
    const root = path.resolve(__dirname, '..', '..');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
    if (cfg.ollamaModel) return String(cfg.ollamaModel).trim();
  } catch (e) {
    // config.json potrebbe non esistere: usa il default.
  }
  return 'gemma4:31b-cloud';
}

const MODEL = readOllamaModel();

function askOllama(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 50 }
    });

    const req = http.request(OLLAMA_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.response || '');
        } catch (e) {
          reject(new Error(`Risposta Ollama non valida: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout Ollama'));
    });

    req.write(body);
    req.end();
  });
}

async function askQuizQuestion(question, options, log) {
  try {
    const labels = ['A', 'B', 'C', 'D'];
    const optsText = options.map((o, i) => `${labels[i]}) ${o}`).join('\n');

    const prompt = `Sei un assistente che risponde a domande a risposta multipla di un corso e-learning su competenze digitali, privacy, sicurezza informatica e strumenti aziendali.

Domanda: ${question}

Opzioni:
${optsText}

Rispondi SOLTANTO con la lettera corretta (A, B, C o D) e una breve motivazione di massimo una riga. Non aggiungere altro testo.`;

    log(`Chiedo aiuto a Ollama (${MODEL}) per la risposta...`);
    const response = await askOllama(prompt);
    log(`Risposta Ollama: ${response.trim().replace(/\n/g, ' ')}`);

    // Estrai la lettera
    const letterMatch = response.trim().match(/\b([A-D])\b/);
    if (letterMatch) {
      const index = labels.indexOf(letterMatch[1]);
      if (index >= 0 && index < options.length) {
        return { letter: letterMatch[1], text: options[index], reason: response.trim() };
      }
    }

    // Se non trova lettera, prova a matchare il testo della risposta
    const normResponse = response.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (let i = 0; i < options.length; i++) {
      const normOpt = options[i].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
      if (normResponse.includes(normOpt) || normOpt.includes(normResponse.slice(0, 30))) {
        return { letter: labels[i], text: options[i], reason: response.trim() };
      }
    }

    return null;
  } catch (e) {
    log(`Errore Ollama quiz: ${e.message}`);
    return null;
  }
}

module.exports = { askQuizQuestion };
