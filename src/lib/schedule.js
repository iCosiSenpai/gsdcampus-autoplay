/**
 * Gestione orari lavorativi per l'automazione.
 * Legge la configurazione da config.json se disponibile, altrimenti usa default:
 * lunedì-venerdì, turni 09:30-13:00 e 16:30-20:00.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = [1, 2, 3, 4, 5];
const DEFAULT_SHIFTS = [
  { startHour: 9, startMin: 30, endHour: 13, endMin: 0 },
  { startHour: 16, startMin: 30, endHour: 20, endMin: 0 },
];

function loadScheduleConfig() {
  try {
    const root = path.join(__dirname, '..', '..');
    const cfgPath = path.join(root, 'config.json');
    if (!fs.existsSync(cfgPath)) {
      return { days: DEFAULT_DAYS, shifts: DEFAULT_SHIFTS };
    }
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.workSchedule && Array.isArray(cfg.workSchedule.days) && Array.isArray(cfg.workSchedule.shifts)) {
      return cfg.workSchedule;
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

function nextShiftBoundary(date = new Date()) {
  const nextStart = nextWorkStart(date);
  const nextEnd = nextWorkEnd(date);
  return { nextStart, nextEnd };
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

function msUntil(date) {
  return date ? Math.max(0, date.getTime() - Date.now()) : 0;
}

module.exports = {
  isWorkTime,
  nextShiftBoundary,
  nextWorkEnd,
  nextWorkStart,
  msUntil,
};
