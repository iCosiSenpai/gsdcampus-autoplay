/** Igiene, confronto e hash deterministico delle banche risposta. */
const crypto = require('crypto');
const { normKey, normalize } = require('./quiz-match');

function isMetaKey(key) {
  return String(key || '').startsWith('README');
}

function unicode(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function canonicalQuestion(question) {
  return normKey(unicode(question));
}

function canonicalAnswer(answer) {
  return normalize(unicode(answer));
}

function hasReplacementChar(value) {
  return String(value == null ? '' : value).includes('\uFFFD');
}

function preferredEntry(entries) {
  return [...entries].sort((a, b) => {
    const score = (x) => (hasReplacementChar(x.question) ? 0 : 1000) + unicode(x.question).length;
    return score(b) - score(a);
  })[0];
}

function auditBank(bank) {
  const source = bank && typeof bank === 'object' && !Array.isArray(bank) ? bank : {};
  const groups = new Map();
  const invalid = [];
  for (const [question, answer] of Object.entries(source)) {
    if (isMetaKey(question)) continue;
    const key = canonicalQuestion(question);
    const answerKey = canonicalAnswer(answer);
    const issues = [];
    if (!key) issues.push('empty_question');
    if (!answerKey) issues.push('empty_answer');
    // Una domanda non comincia con un trattino: quello è un argomento della riga di comando.
    //
    // Misurato il 7 agosto 2026: la banca conteneva la voce `--force` → «la Matrice di
    // Eisenhower», cioè un flag finito dentro come se fosse una domanda, e l'audit rispondeva
    // «voci non valide: 0». Era anche nella banca condivisa, quindi era arrivata ai colleghi.
    // Non fa danno diretto (quella chiave non combacerà mai con una domanda vera) ma dice che
    // una chiamata a `set` è andata storta, e quella volta la risposta vera può essere andata
    // perduta: è proprio il caso in cui un controllo deve parlare.
    if (/^--?[A-Za-z]/.test(unicode(question))) issues.push('looks_like_cli_flag');
    if (hasReplacementChar(question) || hasReplacementChar(answer)) issues.push('replacement_character');
    if (issues.length) invalid.push({ question, issues });
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ question, answer: unicode(answer), answerKey });
  }

  const duplicates = [];
  const conflicts = [];
  for (const [key, entries] of groups) {
    if (entries.length > 1) duplicates.push({ key, entries });
    const answers = new Set(entries.map((entry) => entry.answerKey));
    if (answers.size > 1) conflicts.push({ key, entries });
  }

  const canonicalRows = [...groups.entries()].map(([key, entries]) => {
    const selected = preferredEntry(entries);
    return [key, selected ? selected.answerKey : ''];
  }).sort((a, b) => a[0].localeCompare(b[0]));
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(canonicalRows)).digest('hex');
  return {
    entries: [...groups.values()].reduce((n, rows) => n + rows.length, 0),
    canonicalEntries: groups.size,
    invalid,
    duplicates,
    conflicts,
    sha256,
    ok: invalid.length === 0 && conflicts.length === 0,
  };
}

function normalizeBank(bank) {
  const source = bank && typeof bank === 'object' && !Array.isArray(bank) ? bank : {};
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (isMetaKey(key)) out[key] = value;
  }
  const groups = new Map();
  for (const [question, answer] of Object.entries(source)) {
    if (isMetaKey(question)) continue;
    const key = canonicalQuestion(question);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ question, answer: unicode(answer), answerKey: canonicalAnswer(answer) });
  }

  let removed = 0;
  const conflicts = [];
  for (const [key, entries] of groups) {
    const answers = new Set(entries.map((entry) => entry.answerKey));
    if (answers.size > 1) {
      conflicts.push({ key, entries });
      for (const entry of entries) out[unicode(entry.question)] = entry.answer;
      continue;
    }
    const selected = preferredEntry(entries);
    if (selected) out[unicode(selected.question)] = selected.answer;
    removed += Math.max(0, entries.length - 1);
  }
  return { bank: out, removed, conflicts, audit: auditBank(out) };
}

function upsertBankEntry(bank, question, answer) {
  const source = { ...(bank && typeof bank === 'object' ? bank : {}) };
  const key = canonicalQuestion(question);
  const replaced = [];
  for (const existing of Object.keys(source)) {
    if (!isMetaKey(existing) && canonicalQuestion(existing) === key) {
      replaced.push({ question: existing, answer: source[existing] });
      delete source[existing];
    }
  }
  source[unicode(question)] = unicode(answer);
  return { bank: source, replaced };
}

function mergeMissingByCanonical(target, source) {
  const out = { ...(target && typeof target === 'object' ? target : {}) };
  const index = new Map();
  for (const [q, a] of Object.entries(out)) {
    if (!isMetaKey(q)) index.set(canonicalQuestion(q), { question: q, answer: a });
  }
  const added = [];
  const conflicts = [];
  for (const [q, a] of Object.entries(source && typeof source === 'object' ? source : {})) {
    if (isMetaKey(q)) continue;
    const key = canonicalQuestion(q);
    const current = index.get(key);
    if (!current) {
      const cleanQ = unicode(q);
      out[cleanQ] = unicode(a);
      index.set(key, { question: cleanQ, answer: a });
      added.push(cleanQ);
    } else if (canonicalAnswer(current.answer) !== canonicalAnswer(a)) {
      conflicts.push({ key, target: current, source: { question: q, answer: a } });
    }
  }
  return { bank: out, added, conflicts };
}

/**
 * Riconcilia i CONFLITTI fra banca trusted locale e banca condivisa: per la
 * stessa domanda vince la risposta CONDIVISA (è quella curata e distribuita a
 * tutti), e quella locale viene messa da parte per una revisione.
 *
 * Perché serve: un conflitto bloccava l'avvio (`answers-cli verify` è un gate in
 * start.sh) e fermava l'automazione su quel Mac finché non interveniva qualcuno.
 * Fermare i corsi è peggio del disaccordo: qui si allinea al condiviso e si
 * conserva la traccia di cosa è stato sostituito.
 *
 * Pure: non scrive niente su disco.
 * @param {object} trusted banca locale
 * @param {object} shared banca pubblica/condivisa
 * @returns {{ bank: object, replaced: Array<{question:string, local:string, shared:string}> }}
 */
function reconcileConflicts(trusted, shared) {
  const t = trusted && typeof trusted === 'object' ? trusted : {};
  const s = shared && typeof shared === 'object' ? shared : {};
  const sharedIndex = new Map();
  for (const [q, a] of Object.entries(s)) {
    if (!isMetaKey(q)) sharedIndex.set(canonicalQuestion(q), { question: q, answer: a, answerKey: canonicalAnswer(a) });
  }
  const bank = {};
  const replaced = [];
  for (const [q, a] of Object.entries(t)) {
    if (isMetaKey(q)) {
      bank[q] = a;
      continue;
    }
    const hit = sharedIndex.get(canonicalQuestion(q));
    if (hit && hit.answerKey !== canonicalAnswer(a)) {
      bank[q] = hit.answer;                                  // vince il condiviso
      replaced.push({ question: q, local: String(a), shared: String(hit.answer) });
    } else {
      bank[q] = a;
    }
  }
  return { bank, replaced };
}

function compareBanks(left, right) {
  const toIndex = (bank) => {
    const map = new Map();
    for (const [q, a] of Object.entries(bank && typeof bank === 'object' ? bank : {})) {
      if (!isMetaKey(q)) map.set(canonicalQuestion(q), { question: q, answer: a, answerKey: canonicalAnswer(a) });
    }
    return map;
  };
  const l = toIndex(left);
  const r = toIndex(right);
  const onlyLeft = [...l.keys()].filter((key) => !r.has(key));
  const onlyRight = [...r.keys()].filter((key) => !l.has(key));
  const conflicts = [...l.keys()].filter((key) => r.has(key) && l.get(key).answerKey !== r.get(key).answerKey)
    .map((key) => ({ key, left: l.get(key), right: r.get(key) }));
  return {
    onlyLeft,
    onlyRight,
    conflicts,
    leftHash: auditBank(left).sha256,
    rightHash: auditBank(right).sha256,
    equal: onlyLeft.length === 0 && onlyRight.length === 0 && conflicts.length === 0,
  };
}

module.exports = {
  reconcileConflicts,
  isMetaKey,
  unicode,
  canonicalQuestion,
  canonicalAnswer,
  auditBank,
  normalizeBank,
  upsertBankEntry,
  mergeMissingByCanonical,
  compareBanks,
};
