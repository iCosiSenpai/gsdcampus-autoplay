/**
 * Client Ollama per rispondere a domande di quiz.
 * Usa il modello cloud locale configurato in Ollama (gemma4:31b-cloud).
 *
 * Strategie di parsing multiple + 1 retry di conferma per maggiore affidabilità.
 * Non cambia il provider (Ollama locale).
 */

const http = require('http');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const MODEL = 'gemma4:31b-cloud';
const TIMEOUT_MS = 30000;

function askOllama(prompt, numPredict) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: numPredict || 64 }
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

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// Rimuove markdown comune (*, _, `, **) da una stringa.
function stripMarkdown(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/_([^_]*)_/g, '$1')
    .trim();
}

/**
 * Parsing multi-strategia della lettera di risposta.
 * Ritorna { letter, strategy, confidence } o null.
 * Le strategie sono in ordine di priorità (confidence decrescente).
 */
function parseAnswerLetter(response, options) {
  const labels = ['A', 'B', 'C', 'D'];
  const raw = String(response || '');
  const clean = stripMarkdown(raw);
  const low = clean.toLowerCase();
  const short = clean.length < 60;

  // 1. Prefisso esplicito: "Risposta: A", "Risposta- A", "Risposta A"
  let m = clean.match(/risposta\s*(?:corretta)?\s*[:\-]?\s*([A-D])\b/i);
  if (m) {
    const letter = m[1].toUpperCase();
    if (labels.includes(letter)) return { letter, strategy: 'explicit', confidence: 1.0 };
  }

  // 2. Frase: "la risposta è A", "l'opzione corretta è A"
  m = low.match(/(?:risposta|opzione)\s+(?:corretta\s+)?(?:è|e|sarà)?\s*([A-D])\b/);
  if (m) {
    const letter = m[1].toUpperCase();
    if (labels.includes(letter)) return { letter, strategy: 'phrase', confidence: 1.0 };
  }

  // 3. Markdown bold/backtick esplicito: **A** o `A`
  m = raw.match(/\*\*([A-D])\*\*/) || raw.match(/`([A-D])`/);
  if (m) {
    const letter = m[1].toUpperCase();
    if (labels.includes(letter)) return { letter, strategy: 'markdown', confidence: 0.95 };
  }

  // 4. Lettera isolata, solo se la risposta è breve (evita match di una A casuale in testo lungo)
  if (short) {
    m = clean.match(/\b([A-D])\b/);
    if (m) {
      const letter = m[1].toUpperCase();
      if (labels.includes(letter)) return { letter, strategy: 'short_letter', confidence: 0.9 };
    }
  }

  // 5. Match sul testo dell'opzione (confidenza più bassa)
  const normResponse = low.replace(/[^a-z0-9]/g, '');
  for (let i = 0; i < options.length; i++) {
    const normOpt = options[i].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normOpt.length === 0) continue;
    if (normResponse.includes(normOpt) || (normOpt.length > 8 && normOpt.includes(normResponse.slice(0, Math.min(30, normResponse.length))))) {
      return { letter: labels[i], strategy: 'text_match', confidence: 0.6 };
    }
  }

  return null;
}

function buildPrompt(question, options) {
  const labels = ['A', 'B', 'C', 'D'];
  const optsText = options.map((o, i) => `${labels[i]}) ${o}`).join('\n');
  return `Sei un assistente che risponde a domande a risposta multipla di un corso e-learning su competenze digitali, privacy, sicurezza informatica e strumenti aziendali.

Domanda: ${normalizeText(question)}

Opzioni:
${optsText}

Esempio di output: C

Rispondi con ESATTAMENTE una lettera (A, B, C o D) seguita da una breve motivazione di massimo una riga. Se non sei sicuro, scegli l'opzione più plausibile in base alla tua conoscenza. Non aggiungere altro testo.`;
}

function buildConfirmationPrompt(firstResponse) {
  return `Hai indicato: "${String(firstResponse || '').trim().slice(0, 200)}".
Rispondi SOLO con una singola lettera A, B, C o D. Se non sei sicuro, scegli l'opzione più plausibile. Nessuna motivazione, solo la lettera.`;
}

async function askQuizQuestion(question, options, log) {
  try {
    log(`Chiedo aiuto a Ollama (${MODEL}) per la risposta...`);
    const response = await askOllama(buildPrompt(question, options));
    log(`Risposta Ollama (1): ${response.trim().replace(/\n/g, ' ')}`);

    let parsed = parseAnswerLetter(response, options);

    // Retry di conferma se il primo parse è nullo o a bassa confidenza.
    if (!parsed || parsed.confidence < 0.8) {
      try {
        const confirm = await askOllama(buildConfirmationPrompt(response), 8);
        log(`Risposta Ollama (conferma): ${confirm.trim().replace(/\n/g, ' ')}`);
        const parsed2 = parseAnswerLetter(confirm, options);
        if (parsed2) {
          // La conferma vince: è più affidabile (output forzato a singola lettera).
          parsed = parsed2;
        }
      } catch (e) {
        log(`Retry conferma fallito: ${e.message}`);
      }
    }

    if (!parsed) return null;

    const labels = ['A', 'B', 'C', 'D'];
    const index = labels.indexOf(parsed.letter);
    if (index < 0 || index >= options.length) return null;

    return {
      letter: parsed.letter,
      text: options[index],
      reason: response.trim(),
      confidence: parsed.confidence,
      strategy: parsed.strategy
    };
  } catch (e) {
    log(`Errore Ollama quiz: ${e.message}`);
    return null;
  }
}

module.exports = { askQuizQuestion, parseAnswerLetter };
