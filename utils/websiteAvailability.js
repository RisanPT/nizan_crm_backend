// Pure helpers (no database) for the public website calendar.
// Same counting rules as the CRM (utils/slots.js, checkSingleDateAvailability):
//   - each day has a morning and an evening capacity (override row or default)
//   - bookings consume a half by eventSlot; cancelled/rejected/lost/draft don't count
//   - active client-app slot holds also consume capacity
//   - an active Blocked Date takes no bookings
// Only a STATUS per day/half leaves this module — never counts, names or ids.
import { consumesSlot, dayKey, slotHalf } from './slots.js';

// A half / day with this many or fewer open places shows as "few".
export const FEW_THRESHOLD = 2;
// How far ahead the public calendar may look.
export const MAX_MONTHS_AHEAD = 18;

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const isoDay = (d) => dayKey(d).toISOString().slice(0, 10);

export const statusFor = (available, capacity) => {
  if (capacity <= 0 || available <= 0) return 'full';
  if (available <= FEW_THRESHOLD) return 'few';
  return 'available';
};

// "YYYY-MM" → { start, end } as UTC-midnight Dates (end exclusive), or null.
export const monthRange = (month) => {
  const m = MONTH_RE.exec(String(month || ''));
  if (!m) return null;
  const year = Number(m[1]);
  const mon = Number(m[2]);
  return { start: new Date(Date.UTC(year, mon - 1, 1)), end: new Date(Date.UTC(year, mon, 1)) };
};

// "YYYY-MM-DD" → { start, end } covering that one day, or null.
export const dayRange = (iso) => {
  if (!DAY_RE.test(String(iso || ''))) return null;
  const start = dayKey(iso);
  if (Number.isNaN(start.getTime()) || isoDay(start) !== iso) return null; // rejects 2026-02-31
  return { start, end: new Date(start.getTime() + 86400000) };
};

// Only the current month up to MAX_MONTHS_AHEAD ahead may be queried.
export const isAllowedMonth = (month, todayIso) => {
  const range = monthRange(month);
  if (!range) return false;
  const [ty, tm] = todayIso.split('-').map(Number);
  const diff = (range.start.getUTCFullYear() - ty) * 12 + (range.start.getUTCMonth() + 1 - tm);
  return diff >= 0 && diff <= MAX_MONTHS_AHEAD;
};

const holdHalves = (slot) => {
  const s = String(slot || '').toLowerCase();
  if (s.includes('full')) return ['morning', 'evening'];
  if (s.includes('morning')) return ['morning'];
  if (s.includes('evening') || s.includes('afternoon')) return ['evening'];
  return [];
};

/**
 * Status for every day in [start, end).
 *   defaults     { morning, evening }
 *   overrides    SlotCapacity rows with a date
 *   blockedDates Dates of active Blocked Dates
 *   bookings     { bookingDate, eventSlot, status }
 *   holds        active, unexpired SlotHold { dateStr, slot }
 *   todayIso     'YYYY-MM-DD' (IST); earlier days come back as "past"
 * Returns { 'YYYY-MM-DD': { status, morning: { status }, evening: { status } } }
 */
export function buildDayStatuses({
  start,
  end,
  defaults,
  overrides = [],
  blockedDates = [],
  bookings = [],
  holds = [],
  todayIso,
}) {
  const capByDay = new Map(overrides.map((o) => [isoDay(o.date), o]));
  const blocked = new Set(blockedDates.map(isoDay));

  const used = new Map(); // day → { morning, evening }
  const add = (day, half) => {
    const cur = used.get(day) || { morning: 0, evening: 0 };
    cur[half] += 1;
    used.set(day, cur);
  };
  for (const b of bookings) {
    if (!b?.bookingDate || !consumesSlot(b)) continue;
    add(isoDay(b.bookingDate), slotHalf(b.eventSlot));
  }
  for (const h of holds) {
    for (const half of holdHalves(h.slot)) add(h.dateStr, half);
  }

  const days = {};
  for (let t = start.getTime(); t < end.getTime(); t += 86400000) {
    const day = new Date(t).toISOString().slice(0, 10);

    if (todayIso && day < todayIso) {
      days[day] = { status: 'past', morning: { status: 'past' }, evening: { status: 'past' } };
      continue;
    }
    if (blocked.has(day)) {
      days[day] = { status: 'blocked', morning: { status: 'blocked' }, evening: { status: 'blocked' } };
      continue;
    }

    const cap = capByDay.get(day) || defaults;
    const u = used.get(day) || { morning: 0, evening: 0 };
    const mCap = Number(cap.morning) || 0;
    const eCap = Number(cap.evening) || 0;
    const mAvail = Math.max(0, mCap - u.morning);
    const eAvail = Math.max(0, eCap - u.evening);

    days[day] = {
      status: statusFor(mAvail + eAvail, mCap + eCap),
      morning: { status: statusFor(mAvail, mCap) },
      evening: { status: statusFor(eAvail, eCap) },
    };
  }
  return days;
}
