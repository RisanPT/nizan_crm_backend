// Pure leave arithmetic — no database, no Date.now(). Unit-tested in
// tests/leaveMath.test.js. All dates are handled as 'YYYY-MM-DD' day keys.
//
// Rules (owner-decided):
//  • Leave days = calendar days in range − the employee's weekly offs − holidays.
//    No sandwich rule: offs/holidays inside a leave are never charged.
//  • A single-day half-day leave on a working day is 0.5.
//  • Quota is credited monthly Jan–Dec: annualQuota/12 per month credited so far
//    (from January, or from the joining month if they joined that year).
//  • Carry-forward = last year's unused credit, capped at carryForwardMax
//    (0 = nothing carries), one level only.
//  • A leave crossing Dec→Jan charges each year only its own working days.

export const DEFAULT_WEEKLY_OFFS = [0]; // Sunday

const KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const IST_OFFSET_MS = 330 * 60000;

/// Day key for a Date/string. Strings already shaped 'YYYY-MM-DD…' keep their
/// date part; Date objects are read on the India calendar day, so both the
/// midday-UTC leave dates and midnight-IST / midnight-UTC holiday dates land on
/// the intended day.
export function toDayKey(d) {
  if (d == null || d === '') return null;
  if (typeof d === 'string') {
    const m = d.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m && !/T/.test(d)) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return new Date(dt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const parts = (key) => {
  const m = KEY_RE.exec(key);
  return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
};
const keyToUtc = (key) => {
  const p = parts(key);
  return p ? Date.UTC(p.y, p.m - 1, p.d) : NaN;
};
const utcToKey = (ms) => new Date(ms).toISOString().slice(0, 10);

export const weekdayOf = (key) => new Date(keyToUtc(key)).getUTCDay();
export const yearOf = (key) => parts(key)?.y ?? null;
export const roundHalf = (n) => Math.round((Number(n) || 0) * 2) / 2;

/// Every day key from `fromKey` to `toKey` inclusive.
export function eachDay(fromKey, toKey) {
  const out = [];
  const a = keyToUtc(fromKey);
  const b = keyToUtc(toKey);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return out;
  for (let t = a; t <= b; t += 86400000) out.push(utcToKey(t));
  return out;
}

/// Normalise weekly offs: an array of 0–6. `undefined`/null → Sunday; an
/// explicit empty array means "no weekly off".
export function normaliseWeeklyOffs(offs) {
  if (!Array.isArray(offs)) return [...DEFAULT_WEEKLY_OFFS];
  return [...new Set(offs.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
}

/// Holiday lookup from [{ date, recurring, type }]. Optional holidays are not
/// company-wide days off, so they are not excluded from leave.
export function buildHolidayMatcher(holidays = []) {
  const exact = new Set();
  const recurring = new Set(); // 'MM-DD'
  for (const h of holidays || []) {
    if (!h || h.type === 'optional') continue;
    const key = toDayKey(h.date);
    if (!key) continue;
    exact.add(key);
    if (h.recurring) recurring.add(key.slice(5));
  }
  return (key) => exact.has(key) || recurring.has(key.slice(5));
}

/// Count chargeable leave days.
/// Returns { days, byYear: { [year]: days }, workingDays: [keys] }.
export function countLeaveDays({ from, to, weeklyOffs, holidays = [], halfDay = 'none' }) {
  const fromKey = toDayKey(from);
  const toKey = toDayKey(to);
  const offs = new Set(normaliseWeeklyOffs(weeklyOffs));
  const isHoliday = buildHolidayMatcher(holidays);
  const workingDays = eachDay(fromKey, toKey).filter((k) => !offs.has(weekdayOf(k)) && !isHoliday(k));
  const half = (halfDay || 'none') !== 'none' && fromKey === toKey;
  const per = half ? 0.5 : 1;
  const byYear = {};
  for (const k of workingDays) {
    const y = yearOf(k);
    byYear[y] = (byYear[y] || 0) + per;
  }
  return { days: workingDays.length * per, byYear, workingDays };
}

/// Months of quota credited in `year`, as of the day `asOfKey`.
/// Counts January (or the joining month if they joined in `year`) up to and
/// including the as-of month. A past year is fully credited; a future year 0.
export function monthsCredited({ year, asOfKey, joinKey = null }) {
  const asOf = parts(asOfKey);
  if (!asOf) return 0;
  const join = joinKey ? parts(joinKey) : null;
  if (join && join.y > year) return 0;
  const startMonth = join && join.y === year ? join.m : 1;
  let endMonth;
  if (year < asOf.y) endMonth = 12;
  else if (year > asOf.y) return 0;
  else endMonth = asOf.m;
  return Math.max(0, endMonth - startMonth + 1);
}

/// Days of a leave that fall in `year`. Same-year leaves use the stored `days`
/// (what was charged at apply time); a Dec→Jan leave is split by working day.
export function daysInYear(leave, year, { weeklyOffs, holidays = [] } = {}) {
  const fk = toDayKey(leave.fromDate);
  const tk = toDayKey(leave.toDate);
  const fy = yearOf(fk);
  const ty = yearOf(tk);
  if (fy === ty) return fy === year ? Number(leave.days) || 0 : 0;
  if (year < fy || year > ty) return 0;
  const { byYear } = countLeaveDays({ from: fk, to: tk, weeklyOffs, holidays, halfDay: 'none' });
  return byYear[year] || 0;
}

/// Balance of one leave type for one year.
/// type: { annualQuota, paid, carryForward, carryForwardMax }
/// used/pending: days already charged to `year`; lastYearUsed: approved days in year-1.
export function computeTypeBalance({ type, year, asOfKey, joinKey = null, used = 0, pending = 0, lastYearUsed = 0 }) {
  const quota = Number(type?.annualQuota) || 0;
  const u = roundHalf(used);
  const p = roundHalf(pending);
  const hasQuota = quota > 0;
  let credited = 0;
  let carriedForward = 0;
  if (hasQuota) {
    credited = roundHalf((quota / 12) * monthsCredited({ year, asOfKey, joinKey }));
    if (type.carryForward) {
      const lastCredited = roundHalf(
        (quota / 12) * monthsCredited({ year: year - 1, asOfKey: `${year - 1}-12-31`, joinKey })
      );
      const unused = Math.max(0, lastCredited - (Number(lastYearUsed) || 0));
      // carryForwardMax is a hard cap: 0 means nothing carries (owner decision).
      const cap = Math.max(0, Number(type.carryForwardMax) || 0);
      carriedForward = roundHalf(Math.min(unused, cap));
    }
  }
  const available = hasQuota ? roundHalf(credited + carriedForward - u - p) : 0;
  return {
    quota,
    allocated: quota, // legacy field the app already reads
    credited,
    carriedForward,
    used: u,
    pending: p,
    available,
    limited: hasQuota && type?.paid !== false,
  };
}

/// Clamp `todayKey` into `year` (past year → 31 Dec, future year → 1 Jan), the
/// as-of day used when a balance is asked for a year other than the current one.
export function asOfForYear(year, todayKey) {
  const t = yearOf(todayKey);
  if (t === year) return todayKey;
  return t > year ? `${year}-12-31` : `${year}-01-01`;
}
