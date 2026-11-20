// THE PERIOD A REPORT IS FOR — read from a request, the same way for every report that takes dates.
//
//   ?from=2026-11-01&to=2026-11-17     IST calendar days, BOTH inclusive (the 17th counts to its last millisecond)
//   ?month=11&year=2026                the older form, still read (apps built before custom dates send it)
//   ?month=2026-11                     the analyst report's form
//
// A range wins over a month. A range that cannot be read, runs backwards, or is longer than the report can reasonably be is REFUSED with
// a plain message and a code — never quietly turned into something else (a report for the wrong dates is worse than none).
// Days are IST days (utils/istDate.js): a booking at midnight IST belongs to that day wherever the server's clock is set.

import { DAY_MS, addDays, istEnd, istMonthBounds, istStart, parseDayParam, todayIst } from './istDate.js';

/// The longest span one report may cover (about two years and two months).
export const MAX_REPORT_DAYS = 800;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const long = (day) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

/// Whole days from `a` to `b` (both 'YYYY-MM-DD'), both ends counted.
export const daysInclusive = (a, b) => Math.round((istStart(b).getTime() - istStart(a).getTime()) / DAY_MS) + 1;

/// "1 Nov 2026" · "1 Nov – 17 Nov 2026" · "28 Dec 2025 – 3 Jan 2026" (the same wording as the app's range label).
export const periodLabel = (from, to) => {
  if (from === to) return long(from);
  // the same year is said once: "28 Oct – 3 Nov 2026"
  if (from.slice(0, 4) === to.slice(0, 4)) return `${Number(from.slice(8, 10))} ${MONTHS[Number(from.slice(5, 7)) - 1]} – ${long(to)}`;
  return `${long(from)} – ${long(to)}`;
};

const refuse = (message, code) => ({ error: message, code });
const blank = (v) => v == null || String(v).trim() === '';

const shaped = (from, to, extra = {}) => ({
  from,
  to,
  start: istStart(from),
  end: istEnd(to),
  days: daysInclusive(from, to),
  label: periodLabel(from, to),
  tag: from === to ? from : `${from}_to_${to}`,
  ...extra,
});

/**
 * @param {object} query  req.query
 * @param {object} [opts]
 * @param {number} [opts.maxDays]       longest span allowed
 * @param {boolean} [opts.monthIsText]  true: `month` is 'YYYY-MM' (analyst); false: `month` and `year` are numbers (finance)
 * @param {boolean} [opts.defaultToThisMonth] when nothing is given, use this IST month instead of refusing
 * @returns {{ from, to, start, end, days, label, tag, custom: boolean, month?: number, year?: number } | { error: string, code: string }}
 */
export const resolveReportPeriod = (query = {}, { maxDays = MAX_REPORT_DAYS, monthIsText = false, defaultToThisMonth = false } = {}) => {
  if (!blank(query.from) || !blank(query.to)) {
    const from = parseDayParam(query.from);
    const to = parseDayParam(query.to);
    if (!from || !to) return refuse('Give both dates, from and to, as days (YYYY-MM-DD).', 'RANGE_INVALID');
    if (to < from) return refuse('The end date is before the start date.', 'RANGE_REVERSED');
    if (daysInclusive(from, to) > maxDays) return refuse(`Choose at most ${maxDays} days for one report.`, 'RANGE_TOO_LONG');
    return shaped(from, to, { custom: true });
  }

  let year;
  let month;
  if (monthIsText) {
    const m = /^(\d{4})-(\d{2})$/.exec(String(query.month ?? '').trim());
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
      year = Number(m[1]);
      month = Number(m[2]);
    }
  } else {
    const m = Number(query.month);
    const y = Number(query.year);
    if (Number.isInteger(m) && m >= 1 && m <= 12 && Number.isInteger(y) && y >= 2000 && y <= 2100) {
      month = m;
      year = y;
    }
  }
  if (month == null) {
    if (!defaultToThisMonth) return refuse('Give the dates (from and to), or a month and year.', 'PERIOD_REQUIRED');
    const today = todayIst();
    year = Number(today.slice(0, 4));
    month = Number(today.slice(5, 7));
  }
  const b = istMonthBounds(year, month);
  return shaped(b.from, b.to, { custom: false, month, year });
};

/// The stretch of the same length right after a period: next month for a month, the days that follow for a range.
export const followingPeriod = (period) => {
  if (!period.custom && period.month != null) {
    const next = period.month === 12 ? istMonthBounds(period.year + 1, 1) : istMonthBounds(period.year, period.month + 1);
    return { from: next.from, to: next.to, start: next.start, end: next.end };
  }
  const from = addDays(period.to, 1);
  const to = addDays(from, period.days - 1);
  return { from, to, start: istStart(from), end: istEnd(to) };
};
