// A driver's expenses, put "under that day's works".
//
// Rules
//   • An expense the driver tied to ONE work   → charged fully to that work.
//   • An expense tied to no work ("whole day")  → shared EQUALLY across ALL of that
//     day's works: ₹3,000 over 3 works is ₹1,000 each. (Not by distance: the
//     accounts team wants a flat, easy-to-explain split.)
//   • A "whole day" expense on a day with no works, or one tied to a work that is
//     no longer on that day (moved / cancelled) → UNALLOCATED, flagged — never
//     silently dropped or forced onto some other work.
//
// Nothing is stored: allocations are computed on read from the day's current
// works, so if a work is added, moved or cancelled the split stays consistent.
// Money is split in paise so the shares always add back to the exact amount: an
// amount that doesn't divide evenly gives the spare paise to the earliest works
// (₹100 over 3 works → 33.34, 33.33, 33.33).
//
// Pure functions — tests/expenseAllocation.test.js.

export const toPaise = (rupees) => Math.round((Number(rupees) || 0) * 100);
export const toRupees = (paise) => paise / 100;

/// Split `totalPaise` into `n` equal parts that add up exactly; the spare paise
/// (when it doesn't divide) go one each to the first parts.
export const splitEqually = (totalPaise, n) => {
  const base = Math.floor(totalPaise / n);
  const spare = totalPaise - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < spare ? 1 : 0));
};

/**
 * @param {object}  o
 * @param {Array}   o.works     [{ id }] — the day's works, in order (cancelled ones already excluded)
 * @param {Array}   o.expenses  [{ id, bookingId|null, amount, category }]
 * @returns {{ lines, perWork, unallocated, sharedTotal }}
 *   lines[]   { expenseId, bookingId|null, amount, mode: 'direct'|'shared'|'unallocated', reason? }
 *   perWork   { [bookingId]: { total, direct, shared, byCategory: { [category]: amount } } }
 */
export const allocateExpenses = ({ works = [], expenses = [] }) => {
  const ids = works.map((w) => String(w.id));
  const known = new Set(ids);

  const paise = Object.fromEntries(ids.map((id) => [id, { direct: 0, shared: 0, byCategory: {} }]));
  const lines = [];
  let unallocatedPaise = 0;
  let sharedPaise = 0;

  const put = (id, cat, amountPaise, kind) => {
    paise[id][kind] += amountPaise;
    paise[id].byCategory[cat] = (paise[id].byCategory[cat] || 0) + amountPaise;
  };

  for (const e of expenses) {
    const amountPaise = toPaise(e.amount);
    const cat = e.category || 'other';
    const link = e.bookingId ? String(e.bookingId) : null;

    if (link && known.has(link)) {
      put(link, cat, amountPaise, 'direct');
      lines.push({ expenseId: e.id, bookingId: link, amount: toRupees(amountPaise), mode: 'direct' });
    } else if (link) {
      unallocatedPaise += amountPaise;
      lines.push({
        expenseId: e.id, bookingId: null, amount: toRupees(amountPaise), mode: 'unallocated',
        reason: 'The work it was for is no longer on this day.',
      });
    } else if (ids.length === 0) {
      unallocatedPaise += amountPaise;
      lines.push({
        expenseId: e.id, bookingId: null, amount: toRupees(amountPaise), mode: 'unallocated',
        reason: 'No work on this day to put it under.',
      });
    } else {
      const parts = splitEqually(amountPaise, ids.length);
      ids.forEach((id, i) => {
        put(id, cat, parts[i], 'shared');
        lines.push({ expenseId: e.id, bookingId: id, amount: toRupees(parts[i]), mode: 'shared' });
      });
      sharedPaise += amountPaise;
    }
  }

  const perWork = {};
  for (const id of ids) {
    const p = paise[id];
    perWork[id] = {
      total: toRupees(p.direct + p.shared),
      direct: toRupees(p.direct),
      shared: toRupees(p.shared),
      byCategory: Object.fromEntries(Object.entries(p.byCategory).map(([c, v]) => [c, toRupees(v)])),
    };
  }
  return { lines, perWork, unallocated: toRupees(unallocatedPaise), sharedTotal: toRupees(sharedPaise) };
};
