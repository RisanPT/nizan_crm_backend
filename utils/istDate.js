// IST (Asia/Kolkata, UTC+05:30, no DST) calendar-day helpers, shared by every
// report so day / week / month boundaries are cut the same way regardless of
// the server's own timezone. A "day" here is a 'YYYY-MM-DD' string.

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const DAY_MS = 86400000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
// An ISO timestamp that carries its own zone ("…Z" or "…+05:30").
const HAS_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/i;

export const isDay = (s) => DAY_RE.test(String(s ?? ''));

/// First instant of an IST calendar day.
export const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
/// Last millisecond of an IST calendar day.
export const istEnd = (day) => new Date(`${day}T23:59:59.999+05:30`);

/// IST calendar day ('YYYY-MM-DD') of an instant.
export const istDayKey = (d) =>
  new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/// IST calendar month ('YYYY-MM') of an instant.
export const istMonthKey = (d) => istDayKey(d).slice(0, 7);

export const todayIst = () => istDayKey(new Date());

/// 'YYYY-MM-DD' shifted by n days (n may be negative).
export const addDays = (day, n) => istDayKey(new Date(istStart(day).getTime() + n * DAY_MS));

/// Monday ('YYYY-MM-DD') of the IST week containing the given day or instant.
export const istWeekStart = (dayOrDate) => {
  const day = isDay(dayOrDate) ? dayOrDate : istDayKey(dayOrDate);
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
};

/// Bounds of an IST calendar month (month 1-12):
/// { from: 'YYYY-MM-01', to: 'YYYY-MM-<last>', start: Date, end: Date }.
export const istMonthBounds = (year, month) => {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-${String(last).padStart(2, '0')}`;
  return { from, to, start: istStart(from), end: istEnd(to) };
};

/// The IST calendar day a client meant, as 'YYYY-MM-DD' (null if unreadable).
///  • 'YYYY-MM-DD'                         → as is
///  • ISO without a zone (older app builds
///    send local midnight: '2026-10-01T00:00:00.000') → its date part
///  • ISO with a zone ('…Z', '…+05:30')     → the IST day of that instant
///  • Date                                  → the IST day of that instant
export const parseDayParam = (value) => {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : istDayKey(value);
  const s = String(value).trim();
  if (isDay(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
    if (HAS_ZONE_RE.test(s)) {
      const d = new Date(s);
      return Number.isNaN(d.getTime()) ? null : istDayKey(d);
    }
    return s.slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : istDayKey(d);
};

/// Inclusive lower bound for a report window. A Date is an instant and is left
/// alone; a string is read as an IST calendar day and starts at 00:00 IST.
/// Unreadable input → null.
export const fromBound = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const day = parseDayParam(value);
  return day ? istStart(day) : null;
};

/// Inclusive upper bound: strings end at 23:59:59.999 IST of that day.
export const toBound = (value) => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const day = parseDayParam(value);
  return day ? istEnd(day) : null;
};

/// Mongo condition `{ [field]: { $gte?, $lte? } }` for a from/to pair, or {}
/// when neither side is readable (so a bad filter never silently hides data).
export const rangeCondition = (field, from, to) => {
  const range = {};
  const gte = fromBound(from);
  const lte = toBound(to);
  if (gte) range.$gte = gte;
  if (lte) range.$lte = lte;
  return Object.keys(range).length ? { [field]: range } : {};
};
