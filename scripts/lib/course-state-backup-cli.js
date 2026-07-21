#!/usr/bin/env node
/** Lista e ripristina i backup recuperabili di course_state.json. */
const path = require('path');
const {
  listCourseStateBackups,
  restoreCourseStateBackup,
} = require(path.join(__dirname, '..', '..', 'src', 'lib', 'state-backup'));

const ROOT = path.join(__dirname, '..', '..');
const cmd = process.argv[2] || 'list';

if (cmd === 'list') {
  const rows = listCourseStateBackups(ROOT);
  if (!rows.length) {
    console.log('Nessun backup course_state disponibile per l\'account attivo.');
    process.exit(0);
  }
  rows.forEach((row, i) => {
    console.log(`${String(i + 1).padStart(2)}. ${row.name}  ${row.valid ? 'ok' : 'NON VALIDO'}  ${row.reason || '-'}${row.courseId ? ` corso=${row.courseId}` : ''}`);
  });
  process.exit(0);
}

if (cmd === 'restore') {
  const name = process.argv[3];
  const yes = process.argv.includes('--yes');
  if (!name || !yes) {
    console.error('Uso: node scripts/lib/course-state-backup-cli.js restore <nome-backup> --yes');
    process.exit(2);
  }
  try {
    const out = restoreCourseStateBackup(ROOT, name);
    console.log(`Ripristinato: ${path.basename(out.restoredFrom)}`);
    console.log(`Backup di sicurezza dello stato precedente: ${path.basename(out.safetyBackup)}`);
    process.exit(0);
  } catch (e) {
    console.error(`Ripristino rifiutato: ${e.message}`);
    process.exit(1);
  }
}

console.error('Uso: course-state-backup-cli.js list | restore <nome-backup> --yes');
process.exit(2);
