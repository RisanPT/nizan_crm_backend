// Final-settlement prorating (owner rule 2026-11-06): the final settlement is
// ONLY the unpaid salary up to the last working day — no leave encashment, no
// gratuity, no recoveries. Pure functions, no database: see
// tests/settlementMath.test.js.

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/// Calendar days in a month (month 1-12).
export const daysInMonth = (year, month) => new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();

const parseDay = (day) => {
  const m = DAY_RE.exec(String(day ?? ''));
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
};

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Prorates a monthly salary for one payroll month, counting calendar days from
 * the 1st of that month up to and including the last working day.
 *
 * @param {object} p
 * @param {number} p.baseSalary   monthly base salary
 * @param {number} [p.allowances] monthly allowances (prorated the same way)
 * @param {string} p.lastWorkingDay 'YYYY-MM-DD' (IST calendar day)
 * @param {number} [p.year]  payroll year  (defaults to the LWD's year)
 * @param {number} [p.month] payroll month 1-12 (defaults to the LWD's month)
 * @returns {{ year, month, daysInMonth, daysWorked, baseSalary, allowances,
 *             proratedBase, proratedAllowances, amount, lastWorkingDay }}
 *          or null when lastWorkingDay is not a valid day.
 */
export function prorateFinalSettlement({ baseSalary, allowances = 0, lastWorkingDay, year, month }) {
  const lwd = parseDay(lastWorkingDay);
  if (!lwd) return null;
  const y = Number(year) || lwd.year;
  const mo = Number(month) || lwd.month;
  const dim = daysInMonth(y, mo);

  let daysWorked;
  const lwdKey = lwd.year * 12 + lwd.month;
  const monthKey = y * 12 + mo;
  if (lwdKey < monthKey) daysWorked = 0; // left before this month started
  else if (lwdKey > monthKey) daysWorked = dim; // still employed all month
  else daysWorked = Math.min(lwd.day, dim);

  const base = money(baseSalary);
  const allow = money(allowances);
  const proratedBase = Math.round((base * daysWorked) / dim);
  const proratedAllowances = Math.round((allow * daysWorked) / dim);
  return {
    year: y,
    month: mo,
    daysInMonth: dim,
    daysWorked,
    baseSalary: base,
    allowances: allow,
    proratedBase,
    proratedAllowances,
    amount: proratedBase + proratedAllowances,
    lastWorkingDay: String(lastWorkingDay),
  };
}
