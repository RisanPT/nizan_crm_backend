// FLEET AVAILABILITY: is this vehicle / driver free for a work, or already committed?
//
// A vehicle or driver is committed to a booking for each day the booking runs, from the day's
// first start to the day's last end (the package times on the booking's items, else the booking's
// own start/end time of day). Two works on the same vehicle or driver clash when:
//   • OVERLAP — their times overlap (a hard clash: needs a person to say "yes, assign anyway");
//   • TIGHT   — they don't overlap, but the gap between them is shorter than the drive from one
//               venue to the next plus a little handling time (a warning only).
// A vehicle that is under service / in an accident, a driver who is on approved leave or no
// longer active, is UNAVAILABLE for the day. Overdue legal papers (insurance, pollution, tax) are
// WARNINGS.
//
// Pure — no database, no network. The drive time between two venues comes in as a function.
// tests/fleetAvailability.test.js.

import { IST_OFFSET_MS, istDayKey } from './istDate.js';

/// Bookings in these states are not on the road: they never commit a vehicle or driver.
export const EXCLUDED_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'lost', 'postponed']);

/// A work whose end is missing or not after its start is taken to last this long.
export const DEFAULT_DURATION_MIN = 240;
/// Loading / unloading / settling in, added to every drive between two works.
export const HANDLING_MIN = 30;
/// Drive time between two venues when either one can't be located.
export const DEFAULT_TRAVEL_MIN = 90;
const ROAD_FACTOR = 1.35; // roads are longer than the straight line
const AVG_KMH = 40; // Kerala road average, all stops included

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

const pad = (n) => String(n).padStart(2, '0');

/// 'HH:MM' (IST) of an instant; '' when it isn't one.
export const istTime = (d) => {
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return '';
  return new Date(t + IST_OFFSET_MS).toISOString().slice(11, 16);
};

/// The instant of [hhmm] on IST day [day].
export const istDateTime = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);

const cleanTime = (s) => {
  const m = HHMM_RE.exec(String(s ?? '').trim());
  return m ? `${pad(m[1])}:${m[2]}` : '';
};

/**
 * The days a booking runs and, for each, when its team is out: [{ day, start, end }], earliest day first.
 * @param {object} b  a booking (plain): selectedDates, bookingDate, serviceStart, serviceEnd, bookingItems[{ selectedDates, startTime, endTime }]
 */
export const workWindows = (b) => {
  const baseStart = cleanTime(istTime(b?.serviceStart)) || '09:00';
  const baseEnd = cleanTime(istTime(b?.serviceEnd)) || '13:00';

  let days = [...new Set((b?.selectedDates ?? []).map(String).filter((d) => DAY_RE.test(d)))];
  if (days.length === 0) {
    const first = b?.serviceStart ?? b?.bookingDate;
    days = Number.isNaN(new Date(first).getTime()) ? [] : [istDayKey(first)];
  }

  const perDay = new Map();
  const add = (day, startTod, endTod) => {
    const start = istDateTime(day, startTod);
    let end = istDateTime(day, endTod);
    if (!(end > start)) end = new Date(start.getTime() + DEFAULT_DURATION_MIN * 60000);
    const cur = perDay.get(day);
    perDay.set(day, cur ? { start: start < cur.start ? start : cur.start, end: end > cur.end ? end : cur.end } : { start, end });
  };

  const items = Array.isArray(b?.bookingItems) ? b.bookingItems : [];
  if (items.length > 0) {
    for (const item of items) {
      const itemDays = [...new Set((item?.selectedDates ?? []).map(String).filter((d) => DAY_RE.test(d)))];
      for (const day of itemDays.length ? itemDays : days) {
        add(day, cleanTime(item?.startTime) || baseStart, cleanTime(item?.endTime) || baseEnd);
      }
    }
  } else {
    for (const day of days) add(day, baseStart, baseEnd);
  }

  return [...perDay.entries()].sort(([a], [b2]) => a.localeCompare(b2)).map(([day, w]) => ({ day, ...w }));
};

/// Does a work take its team out on [day] (an IST 'YYYY-MM-DD')?
export const runsOn = (windows, day) => windows.some((w) => w.day === day);

const toRad = (d) => (d * Math.PI) / 180;
/// Straight-line km between two { lat, lng } points.
export const haversineKm = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/// Minutes to get from one venue to the next, handling time included.
///   → { minutes, known }   known = false when either place couldn't be located (a flat default)
export const travelBetween = (from, to) => {
  const ok = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  if (!ok(from) || !ok(to)) return { minutes: DEFAULT_TRAVEL_MIN, known: false };
  const km = haversineKm(from, to) * ROAD_FACTOR;
  return { minutes: Math.round((km / AVG_KMH) * 60 + HANDLING_MIN), known: true };
};

/// What the screens show about another booking.
export const briefOf = (b) => ({
  bookingId: String(b?._id ?? ''),
  bookingNumber: String(b?.bookingNumber ?? ''),
  customerName: String(b?.customerName ?? ''),
});

const iso = (d) => d.toISOString();

/**
 * How [mine] (the work being assigned) sits with [other] (a booking the same vehicle / driver already has).
 * @param {Array}    mine      workWindows of the work being assigned
 * @param {object}   other     { booking, windows }
 * @param {Function} travel    (otherBooking) => { minutes, known } — drive time between the two venues
 * @returns {Array<{ kind: 'overlap'|'tight', day, start, end, with, gapMinutes?, neededMinutes?, estimated? }>}
 *   one per day at most, the worse of overlap / tight; `start`/`end` are the OTHER work's times
 */
export const clashesWith = (mine, other, travel) => {
  const worst = new Map(); // day → clash
  for (const w of mine) {
    for (const o of other.windows) {
      if (o.day !== w.day) continue;
      const base = { day: w.day, start: iso(o.start), end: iso(o.end), with: briefOf(other.booking) };
      if (w.start < o.end && o.start < w.end) {
        worst.set(w.day, { kind: 'overlap', ...base });
        continue;
      }
      if (worst.get(w.day)?.kind === 'overlap') continue;
      const gap = Math.round(((o.end <= w.start ? w.start - o.end : o.start - w.end)) / 60000);
      const t = travel(other.booking);
      if (gap < t.minutes) worst.set(w.day, { kind: 'tight', ...base, gapMinutes: gap, neededMinutes: t.minutes, estimated: !t.known });
    }
  }
  return [...worst.values()];
};

/// The one word for a resource: unavailable > busy (overlap) > tight > free.
export const statusOf = (problems) => {
  if (problems.some((p) => p.kind === 'unavailable')) return 'unavailable';
  if (problems.some((p) => p.kind === 'overlap')) return 'busy';
  if (problems.some((p) => p.kind === 'tight')) return 'tight';
  return 'free';
};

const VEHICLE_STATE = { under_service: 'is under service', accident: 'is out after an accident', complaint: 'has a complaint open', other: 'is marked unavailable' };

/// A vehicle that is not running is unavailable. → { kind: 'unavailable', reason } | null
export const vehicleProblem = (vehicle) => {
  const s = vehicle?.status;
  if (!s || s === 'running') return null;
  return { kind: 'unavailable', reason: `${vehicle.name || 'This vehicle'} ${VEHICLE_STATE[s] ?? 'is not running'}` };
};

/**
 * A driver who is inactive or on leave on any of [days]. A half-day leave is only a warning.
 * @param {object} o  { employee, leaves: [{ fromDay, toDay, halfDay }], days }
 * @returns {Array<{ kind: 'unavailable'|'warning', reason, day? }>}
 */
export const driverProblems = ({ employee, leaves = [], days = [] }) => {
  const name = employee?.name || 'This driver';
  const out = [];
  if (employee?.status === 'inactive') out.push({ kind: 'unavailable', reason: `${name} is no longer active` });
  for (const day of days) {
    const leave = leaves.find((l) => l.fromDay <= day && day <= l.toDay);
    if (!leave) continue;
    const half = leave.halfDay && leave.halfDay !== 'none';
    out.push(
      half
        ? { kind: 'warning', day, reason: `${name} has a half-day leave on ${day}` }
        : { kind: 'unavailable', day, reason: `${name} is on leave on ${day}` },
    );
  }
  return out;
};

const LEGAL_PAPERS = new Set(['Insurance', 'Pollution', 'Tax']);
/// Overdue insurance / pollution / tax for a vehicle on [day] — warnings, never a block.
export const paperWarnings = (reminders, day) =>
  (reminders ?? [])
    .filter((r) => r.status === 'pending' && LEGAL_PAPERS.has(r.serviceType) && r.dueDate && istDayKey(r.dueDate) < day)
    .map((r) => ({ kind: 'warning', reason: `${r.serviceType} was due on ${istDayKey(r.dueDate)}` }));

/// The problems that stop an assignment unless a person confirms: overlaps and unavailability.
export const isBlocking = (p) => p.kind === 'overlap' || p.kind === 'unavailable';
