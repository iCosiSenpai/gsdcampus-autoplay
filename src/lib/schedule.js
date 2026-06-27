/**
 * Gestione orari lavorativi per l'automazione.
 * Legge la configurazione da config.json se disponibile, altrimenti usa default:
 * lunedì-venerdì, turni 09:30-13:00 e 16:30-20:00.
 *
 * Formato flessibile per gli orari: H:MM, HH:MM, H.MM, HH.MM, HHMM (es. 9:30).
 * I turni vengono normalizzati, ordinati e verificati per sovrapposizioni.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_SHIFTS = [
  { startHour: 9, startMin: 30, endHour: 13, endMin: 0 },
  { startHour: 16, startMin: 30, endHour: 20, endMin: 0 },
];

const WEEKDAY_NAMES = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

/**
 * Converte una stringa orario in {hour, min}.
 * Accetta "09:30", "9:30", "09.30", "9.30", "0930", "930".
 * Ritorna null se l'input non è valido.
 */
function parseTime(str) {
  if (typeof str !== 'string' || str.trim() === '') return null;
  const cleaned = str.trim().toLowerCase();

  // Formato H:MM / HH:MM / H.MM / HH.MM
  const m = cleaned.match(/^(\d{1,2})[:\.](\d{2})$/);
  if (m) {
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return { hour: h, min };
    }
  }

  // Formato HHMM o HMM (es. "930" oppure "0930")
  const n = cleaned.match(/^(\d{3,4})$/);
  if (n) {
    const padded = cleaned.padStart(4, '0');
    const h = parseInt(padded.slice(0, 2), 10);
    const min = parseInt(padded.slice(2, 4), 10);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
      return { hour: h, min };
    }
  }

  return null;
}

function formatTime(h, m) {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function shiftToString(shift) {
  return `${formatTime(shift.startHour, shift.startMin)}-${formatTime(shift.endHour, shift.endMin)}`;
}

function formatShifts(shifts) {
  return shifts.map(shiftToString).join(', ');
}

function formatDays(days) {
  return days
    .slice()
    .sort((a, b) => a - b)
    .map((d) => `${WEEKDAY_NAMES[d] || d}`)
    .join(', ');
}

function describeSchedule({ days, shifts } = loadScheduleConfig()) {
  if (!days || !shifts || shifts.length === 0) return 'Nessun orario configurato';
  return `${formatDays(days)} → ${formatShifts(shifts)}`;
}

function isValidShift(shift) {
  if (!shift || typeof shift !== 'object') return false;
  const sh = Number(shift.startHour);
  const sm = Number(shift.startMin);
  const eh = Number(shift.endHour);
  const em = Number(shift.endMin);
  if (!Number.isFinite(sh) || !Number.isFinite(sm) || !Number.isFinite(eh) || !Number.isFinite(em)) {
    return false;
  }
  if (sh < 0 || sh > 23 || sm < 0 || sm > 59 || eh < 0 || eh > 23 || em < 0 || em > 59) {
    return false;
  }
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start < end;
}

function normalizeShifts(shifts) {
  if (!Array.isArray(shifts) || shifts.length === 0) return [];

  const normalized = shifts
    .filter(isValidShift)
    .map((s) => ({
      startHour: Number(s.startHour),
      startMin: Number(s.startMin),
      endHour: Number(s.endHour),
      endMin: Number(s.endMin),
    }))
    .sort((a, b) => a.startHour * 60 + a.startMin - (b.startHour * 60 + b.startMin));

  // Verifica sovrapposizioni: in caso di conflitto scartiamo i turni successivi.
  // La UI di setup deve impedire sovrapposizioni; questo è solo un fallback difensivo.
  for (let i = 1; i < normalized.length; i++) {
    const prevEnd = normalized[i - 1].endHour * 60 + normalized[i - 1].endMin;
    const currStart = normalized[i].startHour * 60 + normalized[i].startMin;
    if (currStart < prevEnd) {
      return normalized.slice(0, i);
    }
  }

  return normalized;
}

function normalizeDays(days) {
  if (!Array.isArray(days) || days.length === 0) return DEFAULT_DAYS;
  const valid = days
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return valid.length > 0 ? [...new Set(valid)].sort((a, b) => a - b) : DEFAULT_DAYS;
}

function loadScheduleConfig() {
  try {
    const root = path.join(__dirname, '..', '..');
    const cfgPath = path.join(root, 'config.json');
    if (!fs.existsSync(cfgPath)) {
      return { days: DEFAULT_DAYS, shifts: DEFAULT_SHIFTS };
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.workSchedule && Array.isArray(cfg.workSchedule.days) && Array.isArray(cfg.workSchedule.shifts)) {
      const days = normalizeDays(cfg.workSchedule.days);
      const shifts = normalizeShifts(cfg.workSchedule.shifts);
      if (shifts.length > 0) {
        return { days, shifts };
      }
    }
  } catch (e) {
    // fallback su default
  }
  return { days: DEFAULT_DAYS, shifts: DEFAULT_SHIFTS };
}

const { days: WORK_DAYS, shifts: SHIFTS } = loadScheduleConfig();

function isWorkTime(date = new Date()) {
  const day = date.getDay();
  if (!WORK_DAYS.includes(day)) return false;

  const hour = date.getHours();
  const min = date.getMinutes();
  const total = hour * 60 + min;

  return SHIFTS.some((shift) => {
    const start = shift.startHour * 60 + shift.startMin;
    const end = shift.endHour * 60 + shift.endMin;
    return total >= start && total < end;
  });
}

function nextWorkEnd(date = new Date()) {
  let d = new Date(date);
  for (let i = 0; i < 14; i++) {
    const day = d.getDay();
    if (WORK_DAYS.includes(day)) {
      const hour = d.getHours();
      const min = d.getMinutes();
      const total = hour * 60 + min;
      for (const shift of SHIFTS) {
        const end = shift.endHour * 60 + shift.endMin;
        if (total < end) {
          return new Date(d.getFullYear(), d.getMonth(), d.getDate(), shift.endHour, shift.endMin, 0, 0);
        }
      }
    }
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return null;
}

function nextWorkStart(date = new Date()) {
  let d = new Date(date);
  for (let i = 0; i < 14; i++) {
    const day = d.getDay();
    if (WORK_DAYS.includes(day)) {
      const hour = d.getHours();
      const min = d.getMinutes();
      const total = hour * 60 + min;
      for (const shift of SHIFTS) {
        const start = shift.startHour * 60 + shift.startMin;
        if (total < start) {
          return new Date(d.getFullYear(), d.getMonth(), d.getDate(), shift.startHour, shift.startMin, 0, 0);
        }
      }
    }
    d.setDate(d.getDate() + 1);
    d.setHours(0, 0, 0, 0);
  }
  return null;
}

function nextShiftBoundary(date = new Date()) {
  return { nextStart: nextWorkStart(date), nextEnd: nextWorkEnd(date) };
}

// Ritorna i minuti mancanti alla fine del turno attuale, oppure null se non siamo in orario.
function minutesUntilShiftEnd(date = new Date()) {
  const day = date.getDay();
  if (!WORK_DAYS.includes(day)) return null;
  const total = date.getHours() * 60 + date.getMinutes();
  for (const shift of SHIFTS) {
    const start = shift.startHour * 60 + shift.startMin;
    const end = shift.endHour * 60 + shift.endMin;
    if (total >= start && total < end) {
      return end - total;
    }
  }
  return null;
}

function msUntil(date) {
  return date ? Math.max(0, date.getTime() - Date.now()) : 0;
}

module.exports = {
  parseTime,
  formatTime,
  formatShifts,
  formatDays,
  describeSchedule,
  isValidShift,
  normalizeShifts,
  normalizeDays,
  isWorkTime,
  nextShiftBoundary,
  nextWorkEnd,
  nextWorkStart,
  msUntil,
  minutesUntilShiftEnd,
  WORK_DAYS,
  SHIFTS,
};
