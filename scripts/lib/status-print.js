#!/usr/bin/env node
/**
 * status-print.js — stampa in modo leggibile lo stato runtime da logs/status.json.
 *
 * Estratto da status.sh (era un node -e inline) perché le template literal con
 * ${...} dentro la stringa shell scatenavano "bad substitution" in zsh,
 * corrompendo l'output (es. "Corsi undefined"). In un file .js dedicato non c'è
 * alcuna quoting shell di mezzo: niente più fragilità.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const STATUS = path.join(ROOT, 'logs', 'status.json');

let s;
try {
  s = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
} catch (e) {
  console.error('Impossibile leggere logs/status.json.');
  process.exit(1);
}

const lines = [];
if (s.phase) lines.push(['Fase', s.phase]);
if (s.courseUrl) lines.push(['Corso', s.courseUrl]);
if (s.lessonUrl) lines.push(['Lezione', s.lessonUrl]);
if (s.lessonTitle) lines.push(['Titolo', s.lessonTitle]);
if (s.videoProgress) lines.push(['Video', s.videoProgress]);
if (s.lastQuizResult) lines.push(['Esito quiz', s.lastQuizResult]);
if (s.courseStateSummary) {
  const cs = s.courseStateSummary;
  lines.push(['Corsi', `done: ${cs.done || 0}, need_help: ${cs.needHelp || 0}, in_progress: ${cs.inProgress || 0}`]);
}
if (s.phase === 'autologin_invalid') {
  lines.push(['ATTENZIONE', "Stato salvato segnala autologin scaduto: VERIFICA dal vivo (node scripts/lib/healthcheck-cli.js) prima di concludere."]);
}
if (s.phase === 'need_help') {
  lines.push(['ATTENZIONE', 'Uno o più corsi richiedono intervento: leggi data/accounts/<CF>/need_answer.json, aggiungi risposte a data/known_answers.json, poi riavvia.']);
}
if (s.phase === 'session_lost') {
  lines.push(['ATTENZIONE', "Sessione instabile: l'accesso cade dopo il login (riavvio in corso; se persiste, verifica il link dal vivo)."]);
}
if (s.note) lines.push(['Nota', s.note]);
if (s.lastError) lines.push(['Ultimo errore', s.lastError]);
if (s.running !== undefined) lines.push(['Running', s.running ? 'sì' : 'no']);
if (s.startedAt) lines.push(['Avviato alle', s.startedAt]);
if (s.lastUpdate) lines.push(['Ultimo aggiornamento', s.lastUpdate]);

const width = lines.reduce((m, [k]) => Math.max(m, k.length), 0);
lines.forEach(([k, v]) => console.log('  ' + k.padEnd(width + 2) + v));
