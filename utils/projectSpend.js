// What a project has SPENT against the cost its finance head approved.
//
//   spent      expenses charged to the project that Accounts has approved (they are in the books)
//   committed  expenses charged to it that are still waiting for approval — real money, not yet verified
//   (a rejected expense is not a cost)
//   limit      what the finance head approved (utils/projectCost.js spendingLimit) — never what was merely asked for
//
// An expense that would take spent + committed past the limit is "over budget": it can still be filed (it waits for
// approval, and says so), but only the finance head (or an administrator) may approve it, and with a reason.
// At 80% of the limit the people running the project are warned; going over tells them and Finance.
//
// Pure — no database. Money is added in paise so the parts always add back to the whole.
// tests/projectSpend.test.js.

import { toPaise, toRupees } from './projectCost.js';

export const WARN_AT_PERCENT = 80;

/// Who may approve an expense that takes a project past its limit.
export const canOverspend = (role) => ['finance_head', 'admin'].includes(String(role ?? '').trim().toLowerCase());

/// How far along the limit a total is: none (no limit approved yet) | ok | warn (from 80%) | over (past the limit).
export const levelOf = (usedPaise, limitPaise) => {
  if (!(limitPaise > 0)) return 'none';
  if (usedPaise > limitPaise) return 'over';
  return usedPaise * 100 >= limitPaise * WARN_AT_PERCENT ? 'warn' : 'ok';
};

const monthKey = (d) => {
  const t = new Date(d);
  if (Number.isNaN(t.getTime())) return 'unknown';
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};

const bump = (map, key, field, paise) => {
  const k = key || 'other';
  const row = map.get(k) ?? { spent: 0, committed: 0 };
  row[field] += paise;
  map.set(k, row);
};

const rows = (map) =>
  [...map.entries()]
    .map(([key, v]) => ({ key, spent: toRupees(v.spent), committed: toRupees(v.committed) }))
    .sort((a, b) => b.spent + b.committed - (a.spent + a.committed) || a.key.localeCompare(b.key));

/**
 * Where a project stands.
 * @param {object} p
 * @param {number} p.limit      approved amount (rupees), 0 when none yet
 * @param {number} [p.requested] what was asked for (rupees)
 * @param {Array<{amount, status, expenseHead?, department?, date?}>} p.expenses  every expense charged to the project
 * @returns {{ limit, requested, spent, committed, used, available, usedPercent, level, byHead, byDepartment, byMonth }}
 */
export const summarize = ({ limit = 0, requested = 0, expenses = [] } = {}) => {
  let spent = 0;
  let committed = 0;
  const byHead = new Map();
  const byDepartment = new Map();
  const byMonth = new Map();
  for (const e of expenses) {
    const paise = toPaise(Number(e?.amount) || 0);
    if (paise <= 0) continue;
    const field = e.status === 'approved' ? 'spent' : e.status === 'pending' ? 'committed' : null;
    if (!field) continue; // rejected: not a cost
    if (field === 'spent') spent += paise;
    else committed += paise;
    bump(byHead, e.expenseHead, field, paise);
    bump(byDepartment, e.department, field, paise);
    bump(byMonth, monthKey(e.date), field, paise);
  }
  const limitPaise = toPaise(limit);
  const used = spent + committed;
  return {
    limit: toRupees(limitPaise),
    requested: toRupees(toPaise(requested)),
    spent: toRupees(spent),
    committed: toRupees(committed),
    used: toRupees(used),
    available: toRupees(limitPaise - used), // negative once over
    usedPercent: limitPaise > 0 ? Math.round((used * 100) / limitPaise) : null,
    level: levelOf(used, limitPaise),
    byHead: rows(byHead),
    byDepartment: rows(byDepartment),
    byMonth: [...rows(byMonth)].sort((a, b) => a.key.localeCompare(b.key)),
  };
};

/**
 * What one more [amount] would do to the project — checked before an expense is filed or approved.
 * @param {{ limit, spent, committed, amount }} p  rupees; `spent`/`committed` exclude the expense itself
 * @returns {{ limit, used, after, available, over, level, usedPercentAfter }}
 */
export const checkSpend = ({ limit = 0, spent = 0, committed = 0, amount = 0 } = {}) => {
  const limitPaise = toPaise(limit);
  const used = toPaise(spent) + toPaise(committed);
  const after = used + toPaise(amount);
  return {
    limit: toRupees(limitPaise),
    used: toRupees(used),
    after: toRupees(after),
    available: toRupees(limitPaise - after),
    over: limitPaise > 0 && after > limitPaise,
    level: levelOf(after, limitPaise),
    usedPercentAfter: limitPaise > 0 ? Math.round((after * 100) / limitPaise) : null,
  };
};

/**
 * When the level moves UP past a threshold, who must be told — once. Going back down (a top-up was approved) is silent and
 * re-arms the warning.
 * @param {string} before  the level last recorded on the project
 * @param {string} after   the level now
 * @returns {'warn'|'over'|null}
 */
export const alertFor = (before, after) => {
  const rank = { none: 0, ok: 0, warn: 1, over: 2 };
  const was = rank[before] ?? 0;
  const now = rank[after] ?? 0;
  if (now <= was) return null;
  return now === 2 ? 'over' : 'warn';
};

/// One expense as the project page lists it.
export const expenseRow = (e) => ({
  id: String(e._id ?? e.id),
  title: e.title ?? '',
  amount: Number(e.amount) || 0,
  date: e.date ?? null,
  status: e.status,
  department: e.department ?? '',
  expenseHead: e.expenseHead ?? '',
  filedByName: e.createdBy?.name ?? '',
  overBudgetReason: e.overBudgetReason ?? '',
});
