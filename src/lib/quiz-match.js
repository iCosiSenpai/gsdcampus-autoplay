/**
 * quiz-match.js — pure functions per il matching della banca TRUSTED.
 *
 * Nessun I/O, nessun browser: solo normalizzazione testo + Jaccard + lookup
 * opzioni. Usato da quiz.js (runtime) e dai test unitari.
 *
 * Soglie storiche (non cambiare senza test):
 *  - match accettato se bestScore >= 0.75
 *  - sottostringa solo se coverage token >= 0.8 (anti-hijack domanda corta)
 *  - match opzione per include o similarity > 0.85
 */

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
const tokenize = (s) => normalize(s).split(/\s+/).filter(t => t.length > 2);

// Similarità Jaccard normalizzata tra due stringhe (0..1). Ignora le stop word
// italiane comuni per concentrarsi sulle parole semanticamente rilevanti.
function similarity(a, b) {
  const stopWords = new Set(['che','cui','del','della','dei','delle','il','la','lo','gli','le','un','una','uno','con','per','tra','fra','sul','sulla','su','di','a','da','in','e','o','ma','è','sono','come','non','si']);
  const tokensA = new Set(tokenize(a).filter(t => !stopWords.has(t)));
  const tokensB = new Set(tokenize(b).filter(t => !stopWords.has(t)));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter(x => tokensB.has(x)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

// Normalizza una chiave domanda togliendo il prefisso di numerazione ("1. ",
// "2. "…) che la piattaforma a volte aggiunge: senza questo, la banca duplicava
// la stessa domanda come "X" e "1. X" e non le riconciliava. Va applicata sia
// in lettura (findKnownAnswer) che in scrittura (mergeIntoKnown/scrape).
function normKey(s) {
  return normalize(s).replace(/^\d+\s+/, '').trim();
}

// Cerca una risposta nota usando matching esatto, sottostringa (con copertura
// minima) e similarità Jaccard.
function findKnownAnswer(question, options, knownAnswers) {
  const normQ = normKey(question);
  let bestMatch = null;
  let bestScore = 0;

  for (const [knownQ, knownA] of Object.entries(knownAnswers)) {
    const normKnownQ = normKey(knownQ);
    let score = 0;
    if (normQ === normKnownQ) {
      score = 1;
    } else if (normQ.includes(normKnownQ) || normKnownQ.includes(normQ)) {
      // Sottostringa: accetta SOLO se la domanda più corta copre >=80% dei token
      // di quella più lunga. Senza questo gate, una domanda corta nota hijackava
      // una domanda lunga nuova (falso match a 0.9).
      const tokShort = new Set(tokenize(normQ.length < normKnownQ.length ? normQ : normKnownQ));
      const tokLong  = new Set(tokenize(normQ.length < normKnownQ.length ? normKnownQ : normQ));
      const coverage = tokLong.size > 0 ? (new Set([...tokShort].filter(t => tokLong.has(t))).size / tokLong.size) : 0;
      score = coverage >= 0.8 ? 0.9 : 0;
    } else {
      score = similarity(question, knownQ);
    }

    if (score > bestScore) {
      const normA = normalize(knownA);
      const optIndex = options.findIndex(o =>
        normalize(o.text).includes(normA) || normA.includes(normalize(o.text)) || similarity(o.text, knownA) > 0.85
      );
      if (optIndex !== -1) {
        bestScore = score;
        bestMatch = { question: knownQ, answer: knownA, optionIndex: optIndex, optionText: options[optIndex].text, score };
      }
    }
  }

  // Soglia minima di confidenza per evitare falsi positivi.
  if (bestScore >= 0.75) {
    return bestMatch;
  }
  return null;
}

module.exports = {
  normalize,
  tokenize,
  similarity,
  normKey,
  findKnownAnswer,
};
