// Which earlier period a dashboard period is compared with ("+12% vs last month").
//
// Everything here works on IST day strings ('YYYY-MM-DD'), never on instants, so a day is the same day for the
// team whatever the server's clock says.
//
//   month       the period is within ONE calendar month and starts on the 1st → the same days of the previous month
//               (1–5 Nov, with today the 5th, is compared with 1–5 Oct; a whole past month with the whole month before)
//   fy          the period starts on 1 April and covers more than a month → the same dates a year earlier
//   preceding   anything else (a custom range) → the period of the same length that ends the day before it starts
//
// Only the days that have HAPPENED count: a period that runs past today is compared up to today, so the first days of a
// month are not measured against a whole month. A period that is wholly in the future has no comparison (null).
//
// Pure — tests/periodCompare.test.js.

const DAY_MS = 86400000;
const parse = (s) => {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const daysBetween = (a, b) => Math.round((b - a) / DAY_MS);
const lastDayOf = (y, m0) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); // m0 = 0-based month
const sameMonth = (a, b) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();

/// The same calendar date [years] earlier (29 Feb → 28 Feb in a non-leap year).
const yearsBack = (d, years) => {
  const y = d.getUTCFullYear() - years;
  const m = d.getUTCMonth();
  return new Date(Date.UTC(y, m, Math.min(d.getUTCDate(), lastDayOf(y, m))));
};

/**
 * @param {string} from   first day of the period
 * @param {string} to     last day of the period
 * @param {string} today  today (IST)
 * @returns {{ from: string, to: string, mode: 'month'|'fy'|'preceding', days: number } | null}
 *   `days` = how many days of the period have happened (the length of both windows)
 */
export const previousWindow = (from, to, today) => {
  const start = parse(from);
  const end = parse(to);
  const now = parse(today);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return null;
  const upTo = end > now ? now : end;
  if (upTo < start) return null; // not started yet
  const days = daysBetween(start, upTo) + 1;

  if (start.getUTCDate() === 1 && sameMonth(start, end)) {
    const prevStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    const prevLast = lastDayOf(prevStart.getUTCFullYear(), prevStart.getUTCMonth());
    const prevEnd = addDays(prevStart, Math.min(days, prevLast) - 1);
    return { from: fmt(prevStart), to: fmt(prevEnd), mode: 'month', days };
  }
  if (start.getUTCMonth() === 3 && start.getUTCDate() === 1 && !sameMonth(start, end)) {
    return { from: fmt(yearsBack(start, 1)), to: fmt(yearsBack(upTo, 1)), mode: 'fy', days };
  }
  const prevEnd = addDays(start, -1);
  return { from: fmt(addDays(prevEnd, -(days - 1))), to: fmt(prevEnd), mode: 'preceding', days };
};
