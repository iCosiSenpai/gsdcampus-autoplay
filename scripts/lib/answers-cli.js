#!/usr/bin/env node
/**
 * answers-cli.js — gestione della banca risposte condivisa (data/known_answers.json).
 *
 * Strumento per il MANUTENTORE e l'AI supervisore. La banca known_answers.json è
 * TRUSTED: cresce solo con risposte verificate dalla piattaforma (scrape post-quiz)
 * o fornite dall'AI supervisore (WebSearch + ragionamento). I guess Ollama NON
 * vengono mai promossi automaticamente (restano in pending_quiz_answers.json).
 *
 * Comandi:
 *   node scripts/lib/answers-cli.js stats
 *       Mostra risposte note (trusted), pending (guess Ollama, per-account) e
 *       richieste AI in attesa (ai_quiz_request, per-account). Legge i path
 *       per-account dell'account attivo (CF da config.json) oltre ai legacy flat.
 *
 *   node scripts/lib/answers-cli.js list
 *       Elenca le domande note (troncate).
 *
 *   node scripts/lib/answers-cli.js merge
 *       Aggiunge a known_answers.json le risposte presenti in pending_quiz_answers.json
 *       (per-account) che non sono già note (non sovrascrive). Stampa cosa ha aggiunto.
 *       NOTA: i pending sono guess Ollama NON verificati — usare con cautela, solo
 *       dopo averli controllati. Scrittura atomica.
 *
 *   node scripts/lib/answers-cli.js set "testo domanda" "testo risposta"
 *       Aggiunge/aggiorna (overwrite) una risposta trusted. È il canale con cui
 *       l'AI supervisore scrive le risposte verificate nella banca condivisa.
 *       Scrittura atomica.
 *
 *   node scripts/lib/answers-cli.js audit
 *       Elenca le voci della banca trusted (utile per il cleanup: le voci storiche
 *       promosse in passato da guess Ollama andrebbero verificate con WebSearch).
 *
 *   node scripts/lib/answers-cli.js publish
 *       Merges la banca trusted LOCALE (known_answers.json, gitignorata) nella banca
 *       CONDIVISA tracciata (known_answers_public.json): le risposte locali verificate
 *       diventano disponibili a tutti i colleghi al prossimo "Aggiorna e avvia"
 *       (update-known-answers.sh le scarica e le mergia nel loro file locale). Le
 *       risposte locali NON sovrascrivono voci pubbliche già presenti (la pubblica è
 *       curata); aggiunge solo le nuove. Stampa quante ne ha aggiunte e promemoria
 *       di share. Scrittura atomica.
 *
 *   node scripts/lib/answers-cli.js share
 *       Come publish, poi invia le entry *nuove* al Cloudflare Worker (POST /answers)
 *       che le committà su main senza bisogno di git push. Path principale per i
 *       colleghi. Exit 0 anche se remote noop; exit 1 solo se remote fallisce con
 *       errori di rete/config dopo che c'erano entry da inviare.
 */

const fs = require('fs');
const path = require('path');
const { writeJsonAtomic, readJsonSafe } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'io'));
const account = require(path.join(__dirname, '..', '..', 'src', 'lib', 'account'));
const { clearResolvedFromHandoff } = require(path.join(__dirname, '..', '..', 'src', 'lib', 'quiz'));
const { shareAnswersToRemote } = require(path.join(__dirname, 'answers-share'));

const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');
const KNOWN = path.join(DATA, 'known_answers.json');
const PUBLIC = path.join(DATA, 'known_answers_public.json');

// Mergia le chiavi nuove del trusted locale nella banca pubblica condivisa
// (senza sovrascrivere le voci pubbliche esistenti, curate). Ritorna la lista
// delle domande aggiunte. Riusata da `publish` e `resolve`.
function mergeIntoPublic(known) {
  const pub = readJsonSafe(PUBLIC, {});
  const added = [];
  for (const [q, a] of Object.entries(known)) {
    if (!pub[q]) { pub[q] = a; added.push(q); }
  }
  if (added.length > 0) writeJsonAtomic(PUBLIC, pub);
  return added;
}

// Path per-account dell'account attivo (CF da config.json), con fallback ai
// legacy flat in data/ se il CF non è determinabile.
function perAccountPaths() {
  const paths = account.stateFilePaths(ROOT);
  return {
    pending: paths.pending,
    needAnswer: paths.needAnswer,
    aiRequest: path.join(paths.accountDir, 'ai_quiz_request.json'),
    cf: paths.codiceFiscale
  };
}

function readJson(p, fallback) { return readJsonSafe(p, fallback); }

const cmd = process.argv[2] || 'stats';

if (cmd === 'stats') {
  const known = readJson(KNOWN, {});
  const pa = perAccountPaths();
  const pending = readJson(pa.pending, {});
  const need = readJson(pa.needAnswer, null);
  const aiReq = readJson(pa.aiRequest, null);
  const knownCount = Object.keys(known).filter(k => !String(k).startsWith('README')).length;
  console.log(`Risposte trusted (known_answers.json):    ${knownCount}`);
  console.log(`Pending guess Ollama (per-account${pa.cf ? ' ' + pa.cf : ' (legacy)'}): ${Object.keys(pending).length}  [${pa.pending}]`);
  console.log(`Richieste AI in attesa (ai_quiz_request):  ${aiReq && Array.isArray(aiReq.questions) ? aiReq.questions.length : 0}  [${pa.aiRequest}]`);
  console.log(`need_answer.json:                          ${need ? (Array.isArray(need.questions) ? need.questions.length : 1) : 0}  [${pa.needAnswer}]`);
  if (aiReq && Array.isArray(aiReq.questions) && aiReq.questions.length > 0) {
    console.log(`  → reason: ${aiReq.reason || '?'}`);
    aiReq.questions.slice(0, 5).forEach(q => {
      const g = q.ollamaGuess;
      const guess = g ? ` (guess Ollama: ${g.letter || '?'} conf ${(g.confidence != null ? Math.round(g.confidence * 100) : '?')}%)` : ' (nessun guess)';
      console.log(`    • ${String(q.question).slice(0, 70)}${guess}`);
    });
  }
} else if (cmd === 'list') {
  const known = readJson(KNOWN, {});
  Object.entries(known).forEach(([q, a], i) => {
    console.log(`${String(i + 1).padStart(3)}. ${q.slice(0, 70)}  →  ${String(a).slice(0, 40)}`);
  });
  console.log(`\nTotale: ${Object.keys(known).length} risposte note.`);
} else if (cmd === 'merge') {
  const known = readJson(KNOWN, {});
  const pa = perAccountPaths();
  const pending = readJson(pa.pending, {});
  let added = 0;
  const addedList = [];
  for (const [q, a] of Object.entries(pending)) {
    if (!known[q]) { known[q] = a; added++; addedList.push(q); }
  }
  if (added > 0) {
    writeJsonAtomic(KNOWN, known);
    console.log(`Aggiunte ${added} risposte (pending→trusted) alla banca condivisa:`);
    addedList.forEach(q => console.log(`  + ${q.slice(0, 80)}`));
    console.log('\nATTENZIONE: i pending sono guess Ollama NON verificati. Ricontrolla che siano corrette prima di rilasciare il pacchetto ai colleghi.');
  } else {
    console.log('Nessuna nuova risposta da aggiungere (le pending sono già note o assenti).');
  }
} else if (cmd === 'set') {
  const q = process.argv[3];
  const a = process.argv[4];
  if (!q || !a) {
    console.error('Uso: node scripts/lib/answers-cli.js set "testo domanda" "testo risposta"');
    process.exit(1);
  }
  const known = readJson(KNOWN, {});
  known[q] = a; // overwrite: l'AI supervisore corregge anche risposte sbagliate
  writeJsonAtomic(KNOWN, known);
  // Auto-pulizia handoff: la domanda ora è risolta, toglila da ai_quiz_request /
  // need_answer così l'inbox dell'AI non resta pieno di domande già fatte.
  const cleaned = clearResolvedFromHandoff(ROOT, [q]);
  console.log(`Salvata (trusted): "${q.slice(0, 70)}" → "${a.slice(0, 50)}"`);
  if (cleaned > 0) console.log(`  (rimossa da ${cleaned} voce/i dell'handoff AI)`);
} else if (cmd === 'resolve') {
  // resolve = set + handoff clear + merge public file + auto-share Worker (fleet F1).
  // autoShareAnswers default true (opt-out in config.json).
  const q = process.argv[3];
  const a = process.argv[4];
  if (!q || !a) {
    console.error('Uso: node scripts/lib/answers-cli.js resolve "testo domanda" "testo risposta"');
    process.exit(1);
  }
  const known = readJson(KNOWN, {});
  known[q] = a;
  writeJsonAtomic(KNOWN, known);
  const cleaned = clearResolvedFromHandoff(ROOT, [q]);
  const added = mergeIntoPublic({ [q]: a });
  console.log(`Risolta: "${q.slice(0, 70)}" → "${a.slice(0, 50)}"`);
  console.log(`  trusted: aggiornata · handoff: -${cleaned} · banca condivisa: ${added.length > 0 ? '+1 (nuova)' : 'già presente'}`);

  let autoShare = true;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    if (cfg && cfg.autoShareAnswers === false) autoShare = false;
  } catch (_) {}
  if (added.length > 0 && autoShare) {
    // Share remoto best-effort: non fallisce resolve se Worker down.
    shareAnswersToRemote({ [q]: a }).then((res) => {
      if (res.ok) {
        console.log(`  share Worker: ok (+${res.added != null ? res.added : '?'} remote)`);
      } else {
        console.log(`  share Worker: skip (${res.error || 'fail'}) — riprova: ./scripts/publish-answers.sh`);
      }
      process.exit(0);
    }).catch((e) => {
      console.log(`  share Worker: errore ${e.message} — riprova: ./scripts/publish-answers.sh`);
      process.exit(0);
    });
  } else {
    if (added.length > 0 && !autoShare) {
      console.log('  autoShareAnswers=false: per distribuire usa ./scripts/publish-answers.sh');
    }
    process.exit(0);
  }
} else if (cmd === 'audit') {
  const known = readJson(KNOWN, {});
  const entries = Object.entries(known).filter(([q]) => !String(q).startsWith('README'));
  console.log(`Voci banca trusted: ${entries.length}`);
  console.log('Queste voci dovrebbero essere verificate (piattaforma-scrape o AI).');
  console.log('Le voci storiche promosse da guess Ollama (pre-redesign) vanno controllate con WebSearch.\n');
  entries.forEach(([q, a], i) => {
    console.log(`${String(i + 1).padStart(3)}. ${q.slice(0, 80)}  →  ${String(a).slice(0, 40)}`);
  });
} else if (cmd === 'publish') {
  // Local (gitignorato, trusted) -> pubblico (tracciato, condiviso). Le risposte
  // locali verificate diventano disponibili ai colleghi al loro prossimo aggiornamento.
  // NON sovrascrive voci pubbliche esistenti (la banca pubblica è curata): aggiunge
  // solo le chiavi nuove.
  const known = readJson(KNOWN, {});
  const addedList = mergeIntoPublic(known);
  if (addedList.length > 0) {
    console.log(`Aggiunte ${addedList.length} risposte alla banca condivisa (known_answers_public.json):`);
    addedList.forEach(q => console.log(`  + ${q.slice(0, 80)}`));
    console.log('\nOra distribuiscile:  ./scripts/publish-answers.sh  (o: node scripts/lib/answers-cli.js share)');
  } else {
    console.log('Nessuna nuova risposta da pubblicare (tutte già nella banca pubblica).');
  }
} else if (cmd === 'share') {
  // 1) merge local trusted → public file
  // 2) POST al Worker delle entry nuove (o --all per ritentare un invio fallito)
  const forceAll = process.argv.includes('--all');
  const known = readJson(KNOWN, {});
  const addedList = mergeIntoPublic(known);
  const payload = {};
  if (addedList.length > 0) {
    for (const q of addedList) {
      if (known[q] != null) payload[q] = known[q];
    }
    console.log(`Preparo share di ${addedList.length} risposte nuove (delta locale)...`);
  } else if (forceAll) {
    let n = 0;
    for (const [q, a] of Object.entries(known)) {
      if (String(q).startsWith('README')) continue;
      payload[q] = a;
      n++;
    }
    if (n === 0) {
      console.log('Banca trusted vuota: niente da condividere.');
      process.exit(0);
    }
    console.log(`Preparo share --all di ${n} risposte trusted (chunk da 50)...`);
  } else {
    console.log('Nessuna nuova risposta locale da condividere (banca pubblica già allineata).');
    console.log('Per ritentare l\'invio remoto: node scripts/lib/answers-cli.js share --all');
    process.exit(0);
  }
  shareAnswersToRemote(payload).then((res) => {
    if (res.ok) {
      if (res.added === 0) {
        console.log('Receiver: nessuna voce nuova sul remoto (già presenti). ok.');
      } else {
        const ch = res.chunks && res.chunks > 1 ? ` in ${res.chunks} chunk` : '';
        console.log(`Receiver: +${res.added} risposte committate su main${ch} (totale banca ~${res.total != null ? res.total : '?'}).`);
        console.log('I colleghi le riceveranno al prossimo "Aggiorna e avvia".');
      }
      process.exit(0);
    }
    console.error(`Share remoto fallito: ${res.error || 'unknown'}${res.detail ? ' — ' + res.detail : ''}`);
    if (res.error === 'no_endpoint') {
      console.error('  (endpoint Worker non configurato: vedi worker/README.md)');
    } else if (res.error === 'github_token') {
      console.error('  (PAT del Worker senza scope Contents:write — il maintainer deve aggiornare ISSUE_TOKEN)');
    }
    console.error('  Riprova con: node scripts/lib/answers-cli.js share --all');
    process.exit(1);
  }).catch((e) => {
    console.error('Share remoto errore:', e.message);
    process.exit(1);
  });
} else if (cmd === 'lag' || cmd === 'missing-vs-public') {
  // F8: lag trusted locale vs public file (e opz. quante solo-local da share).
  const { bankLag } = require(path.join(ROOT, 'src', 'lib', 'bank-sync'));
  const lag = bankLag(ROOT);
  console.log(`Trusted locale:  ${lag.trusted}`);
  console.log(`Public (file):   ${lag.publicFile}`);
  console.log(`Solo locale (da share):  ${lag.onlyLocal}`);
  console.log(`Solo public (da pull):   ${lag.onlyPublic}`);
  if (lag.onlyLocal > 0) {
    console.log('→ node scripts/lib/answers-cli.js share   (o share --all)');
  }
  if (lag.onlyPublic > 0) {
    console.log('→ ./scripts/update-known-answers.sh  oppure start.sh (sync throttled)');
  }
} else {
  console.error(`Comando sconosciuto: ${cmd}\nComandi: stats | list | merge | set | resolve | audit | publish | share | lag`);
  process.exit(1);
}