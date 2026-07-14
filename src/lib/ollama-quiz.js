/**
 * Client Ollama per rispondere a domande di quiz.
 * Usa il modello cloud locale configurato in Ollama (config.json: ollamaModel).
 *
 * Strategia (revisione 07/2026):
 *  - Few-shot: 2-3 esempi verificati presi da data/known_answers.json (banca
 *    TRUSTED) prepended al prompt, così il modello vede stile e dominio.
 *  - Self-consistency: N=3 campionamenti (temperature 0.4 per diversità) + voto
 *    a maggioranza sulla lettera. confidence = voti/3 (3/3=1.0 alta, 2/3=0.67
 *    media, 1/3=0.33 bassa). Sostituisce il vecchio confirmation-retry che
 *    poteva sovrascrivere un buon parse con una conferma peggiore.
 *  - Il modello viene riletto da config.json a ogni askQuizQuestion (cache mtime):
 *    un cambio di ollamaModel prende effetto senza restart.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { readJsonCached } = require('./io');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
// 60s (era 30): i modelli cloud a freddo possono superare i 30s al primo token,
// e ogni timeout butta via un sample della self-consistency.
const TIMEOUT_MS = 60000;
const SAMPLES = 3;            // campionamenti per self-consistency
const SAMPLE_TEMP = 0.4;      // temperatura per i campioni (diversità)
const SINGLE_TEMP = 0.1;      // temperatura per il fallback a singolo call
// Unica fonte di verità per il fallback modello: DEVE coincidere con
// config.json.example e MODEL_FALLBACK in launch-ai-supervisor.sh (prima era
// 'gemma4:31b-cloud': con config.json assente/corrotto si chiedeva un modello
// mai scaricato e ogni domanda finiva in need_answer.json).
const DEFAULT_MODEL = 'gemma4:cloud';

// Cache mtime del modello: se config.json cambia (es. cambio ollamaModel),
// il prossimo askQuizQuestion rilegge invece di restituire il modello stantio.
let _modelCache = null;
let _modelPath = null;
let _modelMtime = 0;

/**
 * Legge il modello Ollama da config.json (campo `ollamaModel`).
 * Fallback: DEFAULT_MODEL (coerente con config.json.example e launcher).
 */
function readOllamaModel() {
  try {
    const root = path.resolve(__dirname, '..', '..');
    const p = path.join(root, 'config.json');
    const st = fs.statSync(p);
    if (_modelPath === p && _modelCache !== null && st.mtimeMs === _modelMtime) {
      return _modelCache;
    }
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    const m = cfg.ollamaModel ? String(cfg.ollamaModel).trim() : DEFAULT_MODEL;
    _modelCache = m;
    _modelPath = p;
    _modelMtime = st.mtimeMs;
    return m;
  } catch (e) {
    // config.json potrebbe non esistere: usa il default.
  }
  return DEFAULT_MODEL;
}

function askOllama(prompt, numPredict, model, temperature) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: model || readOllamaModel(),
      prompt,
      stream: false,
      // keep_alive: tiene il modello caldo tra i 3 sample della self-consistency
      // (senza, tra una chiamata e l'altra il modello può essere scaricato e
      // ricaricato). Per i modelli cloud è un no-op innocuo.
      keep_alive: '10m',
      options: { temperature: temperature != null ? temperature : 0.1, num_predict: numPredict || 64 }
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

// Carica 2-3 esempi verificati dalla banca TRUSTED per il few-shot. Solo entry
// con risposta breve e chiara (una lettera o testo opzione). Ritorna [] se la
// banca è troppo piccola (<3) o illeggibile. readJsonCached (mtime): prima si
// rileggeva il file da disco a ogni domanda.
function loadFewShotExamples(root) {
  try {
    const knownPath = path.join(root, 'data', 'known_answers.json');
    const known = readJsonCached(knownPath, {});
    const entries = Object.entries(known).filter(([q, a]) => q && a && !String(q).startsWith('README'));
    if (entries.length < 3) return [];
    // Prendi fino a 3 esempi (i primi, stabili tra run).
    return entries.slice(0, 3).map(([q, a]) => ({ question: q, answer: a }));
  } catch (e) {
    return [];
  }
}

function buildPrompt(question, options, examples) {
  const labels = ['A', 'B', 'C', 'D'];
  const optsText = options.map((o, i) => `${labels[i]}) ${o}`).join('\n');

  let fewShot = '';
  if (examples && examples.length > 0) {
    const shotText = examples.map((ex, i) => {
      const exLabels = ['A', 'B', 'C', 'D'];
      // Non abbiamo le opzioni originali dell'esempio: mostriamo domanda + risposta
      // testuale come stile (il modello impara il dominio e il formato atteso).
      return `Domanda: ${normalizeText(ex.question)}\nRisposta corretta: ${normalizeText(ex.answer)}`;
    }).join('\n\n');
    fewShot = `Esempi di domande con risposta corretta (stile del corso):\n${shotText}\n\n`;
  }

  return `${fewShot}Sei un assistente che risponde a domande a risposta multipla di un corso e-learning su competenze digitali, privacy, sicurezza informatica e strumenti aziendali.

Domanda: ${normalizeText(question)}

Opzioni:
${optsText}

Rispondi con ESATTAMENTE una lettera (A, B, C o D) seguita da una breve motivazione di massimo una riga. Se non sei sicuro, scegli l'opzione più plausibile in base alla tua conoscenza. Non aggiungere altro testo.`;
}

// Voto a maggioranza su N campionamenti. Ritorna la lettera più votata e la
// confidenza = voti/N. In caso di pareggio prende la lettera con il primo parse
// più affidabile (strategia più alta tra i pareggianti).
function voteSamples(parses) {
  const valid = parses.filter(Boolean);
  if (valid.length === 0) return null;
  const counts = {};
  const bestByLetter = {};
  // priorità strategia (explicit=1.0, phrase=1.0, markdown=0.95, short=0.9, text=0.6)
  const stratRank = { explicit: 5, phrase: 4, markdown: 3, short_letter: 2, text_match: 1 };
  for (const p of valid) {
    counts[p.letter] = (counts[p.letter] || 0) + 1;
    const rank = stratRank[p.strategy] || 0;
    if (!bestByLetter[p.letter] || rank > (bestByLetter[p.letter].rank || -1)) {
      bestByLetter[p.letter] = { p, rank };
    }
  }
  let bestLetter = null;
  let bestCount = 0;
  for (const [letter, count] of Object.entries(counts)) {
    if (count > bestCount || (count === bestCount && bestLetter !== null &&
        (bestByLetter[letter].rank || 0) > (bestByLetter[bestLetter].rank || 0))) {
      bestLetter = letter;
      bestCount = count;
    } else if (bestLetter === null) {
      bestLetter = letter;
      bestCount = count;
    }
  }
  const confidence = bestCount / SAMPLES;
  const strategy = bestByLetter[bestLetter] ? bestByLetter[bestLetter].p.strategy : 'vote';
  return { letter: bestLetter, confidence, strategy, votes: bestCount };
}

async function askQuizQuestion(question, options, log, root) {
  const model = readOllamaModel();
  try {
    const examples = root ? loadFewShotExamples(root) : [];
    const prompt = buildPrompt(question, options, examples);
    log(`Chiedo aiuto a Ollama (${model}) — self-consistency x${SAMPLES}${examples.length ? ` + ${examples.length} few-shot` : ''}...`);

    // Self-consistency: N campionamenti a temperature 0.4 (diversità tra sample).
    const samples = [];
    const sampleResponses = [];
    for (let i = 0; i < SAMPLES; i++) {
      try {
        const resp = await askOllama(prompt, 64, model, SAMPLE_TEMP);
        sampleResponses.push(resp);
        samples.push(parseAnswerLetter(resp, options));
      } catch (e) {
        log(`Sample ${i + 1}/${SAMPLES} fallito: ${e.message}`);
        samples.push(null);
      }
    }

    let voted = voteSamples(samples);
    if (voted) {
      log(`Voto: ${voted.letter} (${voted.votes}/${SAMPLES}, confidenza ${(voted.confidence * 100).toFixed(0)}%, strategia ${voted.strategy})`);
      const labels = ['A', 'B', 'C', 'D'];
      const index = labels.indexOf(voted.letter);
      if (index >= 0 && index < options.length) {
        // reason: il primo response il cui parse ha votato la lettera vincente
        // (per tracciabilità). samples[] è già allineato 1:1 a sampleResponses:
        // niente doppio parseAnswerLetter ridondante dentro il find.
        const idx = samples.findIndex(s => s && s.letter === voted.letter);
        const reason = ((idx >= 0 ? sampleResponses[idx] : sampleResponses.find(Boolean)) || '').trim();
        return {
          letter: voted.letter,
          text: options[index],
          reason,
          confidence: voted.confidence,
          strategy: voted.strategy
        };
      }
    }

    // Fallback: se tutti i sample non hanno parse valido, prova un singolo call
    // a bassa temperatura (Ollama potrebbe essere rumoroso ma non down).
    if (!voted) {
      log('Self-consistency senza parse utile. Fallback singolo call...');
      try {
        const resp = await askOllama(prompt, 8, model, SINGLE_TEMP);
        const parsed = parseAnswerLetter(resp, options);
        if (parsed) {
          const labels = ['A', 'B', 'C', 'D'];
          const index = labels.indexOf(parsed.letter);
          if (index >= 0 && index < options.length) {
            log(`Fallback parse: ${parsed.letter} (confidenza ${parsed.confidence}, ${parsed.strategy})`);
            return {
              letter: parsed.letter,
              text: options[index],
              reason: resp.trim(),
              confidence: parsed.confidence,
              strategy: parsed.strategy
            };
          }
        }
      } catch (e) {
        log(`Fallback singolo call fallito: ${e.message}`);
      }
    }

    return null;
  } catch (e) {
    log(`Errore Ollama quiz: ${e.message}`);
    return null;
  }
}

module.exports = { askQuizQuestion, parseAnswerLetter };