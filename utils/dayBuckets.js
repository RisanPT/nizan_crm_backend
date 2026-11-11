// Day-by-day figures for a dashboard period: money (and how many entries) per IST day.
//
// A source of income or expense gives rows { day: 'YYYY-MM-DD', amount, count } (days it has nothing on are simply
// missing). buildSeries puts every source of a kind together over EVERY day of the period, so the chart has a point for
// each day and the days add back up to the period's totals. Sources with no dates of their own (a subscription's run-rate
// estimate) are spread evenly over the days.
//
// Pure — tests/dayBuckets.test.js.

const DAY_MS = 86400000;
const IST_MS = 330 * 60 * 1000;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/// The IST calendar day ('YYYY-MM-DD') an instant falls on; '' for no date.
export const istDayOf = (d) => {
  if (!d) return '';
  const t = new Date(d).getTime();
  return Number.isNaN(t) ? '' : new Date(t + IST_MS).toISOString().slice(0, 10);
};

/// Every day from [from] to [to] inclusive, as 'YYYY-MM-DD'.
export const daysOf = (from, to) => {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const out = [];
  for (let t = Date.UTC(fy, fm - 1, fd); t <= Date.UTC(ty, tm - 1, td); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/// Rows { day, amount, count } from documents, one per day: [{ at, amount }] → bucketed by the IST day of `at`.
export const bucketDocs = (docs, atOf, amountOf) => {
  const by = new Map();
  for (const d of docs) {
    const day = istDayOf(atOf(d));
    if (!day) continue;
    const row = by.get(day) ?? { day, amount: 0, count: 0 };
    row.amount += Number(amountOf(d)) || 0;
    row.count += 1;
    by.set(day, row);
  }
  return [...by.values()];
};

/// The total and the number of entries over some rows.
export const sumRows = (rows) => ({
  amount: round2(rows.reduce((s, r) => s + (Number(r.amount) || 0), 0)),
  count: rows.reduce((s, r) => s + (Number(r.count) || 0), 0),
});

/**
 * @param {string} from
 * @param {string} to
 * @param {{ rows: Array[], spread: number[] }} income    rows: one array of day rows per source; spread: amounts to share evenly over the days
 * @param {{ rows: Array[], spread: number[] }} expense
 * @returns {Array<{ date, income, incomeCount, expense, expenseCount }>}  one entry per day of the period
 */
export const buildSeries = (from, to, income, expense) => {
  const days = daysOf(from, to);
  const index = new Map(days.map((d, i) => [d, i]));
  const make = () => ({ amount: days.map(() => 0), count: days.map(() => 0) });
  const fill = (side) => {
    const acc = make();
    for (const rows of side.rows ?? []) {
      for (const r of rows) {
        const i = index.get(r.day);
        if (i === undefined) continue; // outside the period (e.g. a salary dated by its month)
        acc.amount[i] += Number(r.amount) || 0;
        acc.count[i] += Number(r.count) || 0;
      }
    }
    for (const total of side.spread ?? []) {
      const share = (Number(total) || 0) / (days.length || 1);
      for (let i = 0; i < days.length; i++) acc.amount[i] += share;
    }
    return acc;
  };
  const inc = fill(income);
  const exp = fill(expense);
  return days.map((date, i) => ({
    date,
    income: round2(inc.amount[i]),
    incomeCount: inc.count[i],
    expense: round2(exp.amount[i]),
    expenseCount: exp.count[i],
  }));
};
