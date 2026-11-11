// A project's COST: the estimate asked for when it is added, the finance head's approval of it, and the changes after.
//
//   - Every project needs an estimated cost (a number above zero), with an optional breakdown by kind of cost.
//   - Nothing is spent against a project until the finance head approves its cost, and a project cannot start
//     (go "active") before that. There is no limit below which it is skipped.
//   - A project from before this existed has no cost (status "none"): it keeps running, and is asked for one.
//   - After approval a change needs a reason and goes back to the finance head; until it is approved the
//     previously approved amount stays the limit.
//
// Pure — no database. Money is in rupees with two decimals, added in paise so the lines always add up to the total.
// tests/projectCost.test.js.

export const COST_CATEGORIES = [
  { key: 'manpower', label: 'Manpower' },
  { key: 'vendors', label: 'Vendors & services' },
  { key: 'tools', label: 'Tools & software' },
  { key: 'travel', label: 'Travel & stay' },
  { key: 'marketing', label: 'Marketing' },
  { key: 'other', label: 'Other' },
];
export const COST_CATEGORY_KEYS = COST_CATEGORIES.map((c) => c.key);

/// none = from before costs existed · pending = with the finance head · approved · returned = sent back to be revised
export const COST_STATUSES = ['none', 'pending', 'approved', 'returned'];

export const MAX_COST_LINES = 12;
export const MAX_AMOUNT = 1_000_000_000_000; // a thousand crore: anything above is a slip of the finger

export const toPaise = (rupees) => Math.round(Number(rupees) * 100);
export const toRupees = (paise) => paise / 100;

const labelOf = (key) => COST_CATEGORIES.find((c) => c.key === key)?.label ?? 'Other';

/// A usable amount: a finite number from 0 to the maximum, rounded to paise; otherwise null.
export const cleanAmount = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '').trim()) : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return null;
  return toRupees(toPaise(n));
};

/**
 * The breakdown as stored: only lines with an amount, a known kind of cost (anything else is "other"), at most
 * MAX_COST_LINES, and the total of them.
 * @returns {{ plan: Array<{category, amount, note}>, total: number } | { error: string }}
 */
export const normalizeCostPlan = (input) => {
  if (input === undefined || input === null) return { plan: [], total: 0 };
  if (!Array.isArray(input)) return { error: 'The cost breakdown must be a list.' };
  const plan = [];
  let paise = 0;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.amount === undefined || raw.amount === null || raw.amount === '') continue; // an empty row on the form
    const amount = cleanAmount(raw.amount);
    if (amount === null) return { error: 'Each cost line needs an amount of zero or more.' };
    if (amount === 0) continue;
    const category = COST_CATEGORY_KEYS.includes(raw.category) ? raw.category : 'other';
    plan.push({ category, amount, note: String(raw.note ?? '').trim().slice(0, 120) });
    paise += toPaise(amount);
  }
  if (plan.length > MAX_COST_LINES) return { error: `At most ${MAX_COST_LINES} cost lines.` };
  return { plan, total: toRupees(paise) };
};

/**
 * What is asked for: the breakdown's total when there is one (so the two can never disagree), else the single
 * amount typed. Must be above zero.
 * @returns {{ budget: number, plan: Array } | { error: string, code: string }}
 */
export const resolveCost = ({ budget, costPlan } = {}) => {
  const lines = normalizeCostPlan(costPlan);
  if (lines.error) return { error: lines.error, code: 'COST_INVALID' };
  if (lines.plan.length > 0) return { budget: lines.total, plan: lines.plan };
  const typed = cleanAmount(budget);
  if (typed === null && budget !== undefined && budget !== null && budget !== '') {
    return { error: 'The estimated cost must be a number.', code: 'COST_INVALID' };
  }
  if (typed === null || typed <= 0) return { error: 'Enter the estimated cost of this project (an amount above zero).', code: 'COST_REQUIRED' };
  return { budget: typed, plan: [] };
};

/// May the project start (be set to "active")? Not while its cost waits for, or was sent back by, the finance head.
/// A project from before costs existed is not held up.
export const mayStart = (costStatus) => !['pending', 'returned'].includes(costStatus ?? 'none');

/// The amount spending is held against: what the finance head approved (never what is merely asked for).
export const spendingLimit = (project) => (project?.costStatus === 'approved' || Number(project?.approvedBudget) > 0 ? Number(project?.approvedBudget) || 0 : 0);

const sameLines = (a = [], b = []) =>
  a.length === b.length && a.every((l, i) => l.category === b[i].category && toPaise(l.amount) === toPaise(b[i].amount));

/**
 * What changed between two costs, as short lines for the history. Empty when nothing did.
 * @param {{ budget, plan }} before
 * @param {{ budget, plan }} after
 */
export const describeCostChange = (before, after) => {
  const out = [];
  if (toPaise(before.budget ?? 0) !== toPaise(after.budget ?? 0)) {
    out.push(`Estimated cost ${money(before.budget ?? 0)} → ${money(after.budget ?? 0)}`);
  }
  if (!sameLines(before.plan ?? [], after.plan ?? [])) {
    const was = new Map((before.plan ?? []).map((l) => [l.category, l.amount]));
    const now = new Map((after.plan ?? []).map((l) => [l.category, l.amount]));
    for (const key of new Set([...was.keys(), ...now.keys()])) {
      const a = was.get(key) ?? 0;
      const b = now.get(key) ?? 0;
      if (toPaise(a) === toPaise(b)) continue;
      out.push(`${labelOf(key)}: ${a === 0 ? 'added' : money(a)} → ${b === 0 ? 'removed' : money(b)}`);
    }
  }
  return out;
};

/// ₹1,25,000 (Indian grouping), without trailing .00.
export const money = (n) => {
  const v = Number(n) || 0;
  const fixed = Number.isInteger(v) ? String(v) : v.toFixed(2);
  const [int, dec] = fixed.split('.');
  const last3 = int.slice(-3);
  const rest = int.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `₹${grouped}${dec ? `.${dec}` : ''}`;
};

/**
 * What the finance head decided, checked. approve: a limit above zero (default what was asked for), and a note when it
 * is not what was asked for; return: a note saying what to change.
 * @returns {{ decision: 'approve', amount: number, note: string } | { decision: 'return', note: string } | { error: string, code: string }}
 */
export const checkDecision = ({ decision, approvedAmount, note }, requested) => {
  const text = String(note ?? '').trim().slice(0, 500);
  if (decision === 'return') {
    if (text.length < 3) return { error: 'Say what should be changed.', code: 'NOTE_REQUIRED' };
    return { decision: 'return', note: text };
  }
  if (decision !== 'approve') return { error: 'Decide to approve or to return it.', code: 'DECISION_REQUIRED' };
  const given = approvedAmount === undefined || approvedAmount === null || approvedAmount === '' ? requested : cleanAmount(approvedAmount);
  if (given === null || given <= 0) return { error: 'The approved amount must be above zero.', code: 'AMOUNT_INVALID' };
  if (toPaise(given) !== toPaise(requested) && text.length < 3) {
    return { error: `Say why you approved ${money(given)} when ${money(requested)} was asked for.`, code: 'NOTE_REQUIRED' };
  }
  return { decision: 'approve', amount: given, note: text };
};

/// Who may see the amounts: those who run the project, finance, and those who oversee every project. Others do not
/// see the money — only that it is waiting for approval.
export const canSeeCostAmounts = ({ full, manager, ownerHead, finance }) => !!(full || manager || ownerHead || finance);
