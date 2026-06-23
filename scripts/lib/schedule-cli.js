#!/usr/bin/env node
/**
 * Helper CLI per la gestione degli orari lavorativi.
 * Carica config.json dalla root del progetto e offre comandi semplici
 * utilizzabili dagli script shell.
 */

const {
  parseTime,
  formatTime,
  formatShifts,
  formatDays,
  describeSchedule,
  normalizeShifts,
  isWorkTime,
  nextWorkStart,
  nextWorkEnd,
} = require('../../src/lib/schedule');

const cmd = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`Uso: node schedule-cli.js <comando> [args]

Comandi:
  parse-time <orario>              Stampa "HH MM" oppure esce con codice 1.
  format-time <h> <m>             Stampa l'orario formattato HH:MM.
  format-shifts '<json turni>'      Stampa i turni formattati.
  validate-shifts '<json turni>'    Normalizza e valida i turni; stampa JSON.
  describe                         Stampa descrizione leggibile della config attuale.
  is-work-time                     Stampa "yes" o "no".
  next-start                       Stampa ISO del prossimo inizio turno.
  next-end                         Stampa ISO della prossima fine turno.`);
}

function exitError(msg) {
  console.error(msg);
  process.exit(1);
}

switch (cmd) {
  case 'parse-time': {
    const p = parseTime(args[0]);
    if (!p) exitError('INVALID');
    console.log(`${p.hour} ${p.min}`);
    break;
  }

  case 'format-time': {
    const h = Number(args[0]);
    const m = Number(args[1]);
    if (!Number.isFinite(h) || !Number.isFinite(m)) exitError('INVALID');
    console.log(formatTime(h, m));
    break;
  }

  case 'format-shifts': {
    let shifts;
    try {
      shifts = JSON.parse(args[0]);
    } catch (e) {
      exitError('INVALID_JSON');
    }
    console.log(formatShifts(shifts));
    break;
  }

  case 'validate-shifts': {
    let shifts;
    try {
      shifts = JSON.parse(args[0]);
    } catch (e) {
      exitError('INVALID_JSON');
    }
    const normalized = normalizeShifts(shifts);
    if (normalized.length === 0) {
      exitError('NO_VALID_SHIFTS');
    }
    if (normalized.length !== shifts.length) {
      exitError('OVERLAPPING_SHIFTS');
    }
    console.log(JSON.stringify(normalized));
    break;
  }

  case 'describe': {
    console.log(describeSchedule());
    break;
  }

  case 'is-work-time': {
    console.log(isWorkTime() ? 'yes' : 'no');
    break;
  }

  case 'next-start': {
    const s = nextWorkStart(new Date());
    console.log(s ? s.toISOString() : '');
    break;
  }

  case 'next-end': {
    const e = nextWorkEnd(new Date());
    console.log(e ? e.toISOString() : '');
    break;
  }

  default:
    usage();
    process.exit(2);
}
