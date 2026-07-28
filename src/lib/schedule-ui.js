// @ts-check
/**
 * schedule-ui.js — dagli orari del NEGOZIO ai turni, e anteprima della settimana.
 *
 * Il collega non pensa in "turni": pensa "il negozio apre alle 9, chiude all'1,
 * riapre alle 4 e chiude alle 8". Qui traduciamo quel modello mentale nella
 * struttura `workSchedule.shifts` che usa lo scheduler, e produciamo l'anteprima
 * settimanale da mostrare PRIMA di salvare (vedere è più rassicurante che
 * rileggere una lista di orari).
 *
 * Tutto puro: nessun I/O, testabile senza terminale.
 */

const WEEKDAYS = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];
const WEEKDAYS_LONG = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

/** minuti dall'inizio della giornata → {hour, min} */
function toHm(totalMin) {
  const t = Math.max(0, Math.min(24 * 60, Math.round(Number(totalMin) || 0)));
  return { hour: Math.floor(t / 60) % 24, min: t % 60 };
}

/** {hour,min} (o minuti) → minuti dall'inizio della giornata */
function toMinutes(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Math.round(value);
  const h = Number(value.hour);
  const m = Number(value.min);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** minuti → "HH:MM" */
function formatMinutes(totalMin) {
  const { hour, min } = toHm(totalMin);
  return `${pad2(hour)}:${pad2(min)}`;
}

/**
 * Turni a partire dall'orario del negozio.
 * Con la pausa pranzo diventano due fasce, senza pausa una sola.
 * @param {{ open: any, close: any, pause?: { start: any, end: any }|null }} hours
 * @returns {{ ok: boolean, reason?: string, shifts: Array<{startHour:number,startMin:number,endHour:number,endMin:number}> }}
 */
function buildShiftsFromStoreHours(hours = /** @type any */ ({})) {
  const open = toMinutes(hours.open);
  const close = toMinutes(hours.close);
  if (open == null || close == null) return { ok: false, reason: 'orari_mancanti', shifts: [] };
  if (close <= open) return { ok: false, reason: 'chiusura_prima_apertura', shifts: [] };

  const shift = (a, b) => {
    const s = toHm(a);
    const e = toHm(b);
    return { startHour: s.hour, startMin: s.min, endHour: e.hour, endMin: e.min };
  };

  const pause = hours.pause || null;
  const pStart = pause ? toMinutes(pause.start) : null;
  const pEnd = pause ? toMinutes(pause.end) : null;
  if (pStart == null || pEnd == null) return { ok: true, shifts: [shift(open, close)] };
  if (pEnd <= pStart) return { ok: false, reason: 'pausa_invertita', shifts: [] };
  if (pStart <= open || pEnd >= close) return { ok: false, reason: 'pausa_fuori_orario', shifts: [] };

  return { ok: true, shifts: [shift(open, pStart), shift(pEnd, close)] };
}

/** "09:00-13:00 e 16:00-20:00" (per riepiloghi parlati) */
function describeShiftsHuman(shifts = []) {
  const parts = shifts.map((s) => `${pad2(s.startHour)}:${pad2(s.startMin)}-${pad2(s.endHour)}:${pad2(s.endMin)}`);
  if (parts.length === 0) return 'nessun orario';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;
}

/** "lunedì, martedì e venerdì" — niente numeri dei giorni davanti all'utente. */
function describeDaysHuman(days = []) {
  const list = [...new Set(days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
    .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b))
    .map((d) => WEEKDAYS_LONG[d]);
  if (list.length === 0) return 'nessun giorno';
  if (list.length === 7) return 'tutti i giorni';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} e ${list[list.length - 1]}`;
}

/**
 * Anteprima settimanale a blocchi da 30 minuti: si VEDE quando lavora.
 * Ritorna righe di testo semplice (i colori li mette chi stampa).
 *
 * @param {{ days: number[], shifts: Array<object> }} schedule
 * @param {{ from?: number, to?: number, filled?: string, empty?: string, closed?: string }} [opts]
 * @returns {string[]}
 */
function renderWeekPreview(schedule = /** @type any */ ({}), opts = {}) {
  const days = [...new Set((schedule.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))];
  const shifts = Array.isArray(schedule.shifts) ? schedule.shifts : [];
  const filled = opts.filled || '█';
  const empty = opts.empty || '·';

  const starts = shifts.map((s) => Number(s.startHour) + Number(s.startMin) / 60);
  const ends = shifts.map((s) => Number(s.endHour) + Number(s.endMin) / 60);
  const from = Math.max(0, Math.floor(opts.from != null ? opts.from : Math.min(...(starts.length ? starts : [8])) - 1));
  const to = Math.min(24, Math.ceil(opts.to != null ? opts.to : Math.max(...(ends.length ? ends : [20])) + 1));
  const hours = Math.max(1, to - from);
  const cells = hours * 2; // mezz'ora per cella

  // Righello delle ore: un'etichetta ogni due ore, allineata alla cella.
  let ruler = '';
  for (let h = from; h < to; h += 1) {
    ruler += (h - from) % 2 === 0 ? pad2(h) : '  ';
  }

  const label = (d) => WEEKDAYS[d].padEnd(4);
  const lines = [`        ${ruler}`];   // allineato al prefisso delle righe (2+4+2)
  const order = [1, 2, 3, 4, 5, 6, 0]; // settimana che inizia da lunedì
  for (const d of order) {
    if (!days.includes(d)) {
      lines.push(`  ${label(d)}  ${'chiuso'}`);
      continue;
    }
    let row = '';
    for (let i = 0; i < cells; i += 1) {
      const cellStart = from * 60 + i * 30;
      const cellEnd = cellStart + 30;
      const covered = shifts.some((s) => {
        const st = Number(s.startHour) * 60 + Number(s.startMin);
        const en = Number(s.endHour) * 60 + Number(s.endMin);
        return cellStart < en && cellEnd > st;
      });
      row += covered ? filled : empty;
    }
    lines.push(`  ${label(d)}  ${row}`);
  }
  return lines;
}

module.exports = {
  WEEKDAYS,
  WEEKDAYS_LONG,
  toHm,
  toMinutes,
  formatMinutes,
  buildShiftsFromStoreHours,
  describeShiftsHuman,
  describeDaysHuman,
  renderWeekPreview,
};
