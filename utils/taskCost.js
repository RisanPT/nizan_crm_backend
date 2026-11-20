// THE PLANNED COST OF A TASK, and what the tasks of a project add up to — pure rules (services/taskCost.js does the database part;
// tests/taskCost.test.js).
//
//   • A task has a planned cost, stated one of two ways: an AMOUNT typed in rupees, or HOURS × a RATE (the task's estimated hours times a
//     rupee-per-hour rate). The planned cost is always worked out here from what was stated — a client never sets it — so a change of
//     hours on an hours-based task moves its cost with it.
//   • Only LEAF tasks carry cost. A phase (a task that has sub-tasks) shows the sum of the leaves under it; a task that gains its first
//     sub-task gives its own cost up to them. So nothing is ever counted twice.
//   • The tasks add up to "the plan by tasks". It is held against the project's budget CEILING: what the finance head approved, or what is
//     asked for while a request is waiting (so tasks inside a pending request do not raise a request each).
//   • GUARDRAIL: a change that makes the plan exceed the ceiling, and adds to what it was, is not simply saved. It needs a budget increase
//     asked of the finance head (the same approve / return flow as any change to a project's cost). A change that does not add to the plan
//     — taking a cost out, a status change, a progress update — is never held up, even when the plan is already over.
//
// Money is in rupees with two decimals, added in paise so the parts always add up to the total.

import { MAX_AMOUNT, MAX_COST_LINES, cleanAmount, toPaise, toRupees } from './projectCost.js';

/// '' = no cost given · amount = a typed amount · rate = estimated hours × a rate per hour
export const COST_MODES = ['', 'amount', 'rate'];

/// What a client may send about a task's cost. (plannedCost is the server's alone.)
export const TASK_COST_KEYS = ['costMode', 'costAmount', 'costRate'];

/// Everything that moves a task's planned cost: the cost keys and the hours an hours-based cost is worked out from.
export const COST_MOVING_KEYS = [...TASK_COST_KEYS, 'estimatedHours'];

const none = { costMode: '', costAmount: 0, costRate: 0, plannedCost: 0 };

/**
 * A task's cost as stored, from what was stated.
 * @param {{ costMode?, costAmount?, costRate?, estimatedHours? }} t
 * @returns {{ costMode, costAmount, costRate, plannedCost } | { error: string, code: string }}
 */
export const resolveTaskCost = (t = {}) => {
  const mode = t.costMode ?? '';
  if (!COST_MODES.includes(mode)) return { error: 'A task\'s cost is an amount, or hours × a rate.', code: 'TASK_COST_INVALID' };
  if (mode === '') return { ...none };
  if (mode === 'amount') {
    const amount = cleanAmount(t.costAmount ?? 0);
    if (amount === null) return { error: 'The task\'s cost must be an amount of 0 or more.', code: 'TASK_COST_INVALID' };
    return { costMode: 'amount', costAmount: amount, costRate: 0, plannedCost: amount };
  }
  const rate = cleanAmount(t.costRate ?? 0);
  if (rate === null) return { error: 'The rate per hour must be an amount of 0 or more.', code: 'TASK_COST_INVALID' };
  const hours = Number(t.estimatedHours ?? 0);
  if (!Number.isFinite(hours) || hours < 0) return { error: 'The estimated hours must be 0 or more.', code: 'TASK_COST_INVALID' };
  const planned = toRupees(Math.round(hours * toPaise(rate)));
  if (planned > MAX_AMOUNT) return { error: 'That hours × rate is too large to be right.', code: 'TASK_COST_INVALID' };
  return { costMode: 'rate', costAmount: 0, costRate: rate, plannedCost: planned };
};

const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/**
 * What a project's tasks add up to. Leaf tasks only; the planned cost of a task that has sub-tasks is never counted.
 * @param {Array<{ _id, parentTaskId?, plannedCost?, departmentName? }>} tasks
 * @param {{ ownerDepartment?: string }} opts  the department a task with no department of its own belongs to
 * @returns {{ planned: number, leaves: number, priced: number, unpriced: number,
 *             byDepartment: Array<{ name: string, planned: number, tasks: number }>, rolled: Map<string, number> }}
 */
export const rollup = (tasks = [], { ownerDepartment = '' } = {}) => {
  const ids = new Set(tasks.map((t) => idOf(t._id)));
  const parents = new Set(tasks.map((t) => idOf(t.parentTaskId)).filter((p) => p && ids.has(p)));
  const rolled = new Map();
  const byDept = new Map();
  let paise = 0;
  let leaves = 0;
  let priced = 0;

  // each leaf's cost, then added up the chain of parents
  const parentOf = new Map(tasks.map((t) => [idOf(t._id), idOf(t.parentTaskId)]));
  for (const t of tasks) {
    const id = idOf(t._id);
    if (parents.has(id)) continue; // a phase: it shows the sum of its leaves
    const cost = toPaise(Number(t.plannedCost) || 0);
    leaves += 1;
    if (cost > 0) priced += 1;
    paise += cost;
    const dept = String(t.departmentName || ownerDepartment || '').trim();
    const row = byDept.get(dept) ?? { paise: 0, tasks: 0 };
    row.paise += cost;
    row.tasks += 1;
    byDept.set(dept, row);
    // walk up (guarding against a loop in bad data)
    const seen = new Set();
    for (let at = id; at && !seen.has(at); at = parentOf.get(at)) {
      seen.add(at);
      rolled.set(at, (rolled.get(at) ?? 0) + cost);
    }
  }
  for (const [id, p] of rolled) rolled.set(id, toRupees(p));
  return {
    planned: toRupees(paise),
    leaves,
    priced,
    unpriced: leaves - priced,
    byDepartment: [...byDept.entries()]
      .map(([name, r]) => ({ name, planned: toRupees(r.paise), tasks: r.tasks }))
      .sort((a, b) => b.planned - a.planned || a.name.localeCompare(b.name)),
    rolled,
  };
};

/**
 * The tasks behind a project's plan, one line for each leaf task (a task that has sub-tasks is its leaves' total, so it is not a line of its
 * own): what the finance head looks at before deciding a budget. Those with a cost come first, the biggest first; then the ones with none,
 * in the order they were given.
 * @param {Array<{ _id, parentTaskId?, title?, plannedCost?, departmentName? }>} tasks
 * @param {{ ownerDepartment?: string, limit?: number }} opts
 * @returns {{ lines: Array<{ id, title, department, phase, planned }>, more: number }}  `more` = how many lines were left out by the limit
 */
export const taskCostLines = (tasks = [], { ownerDepartment = '', limit = 40 } = {}) => {
  const byId = new Map(tasks.map((t) => [idOf(t._id), t]));
  const parents = new Set(tasks.map((t) => idOf(t.parentTaskId)).filter((id) => id && byId.has(id)));
  // the top of the chain a task hangs under (its phase), guarding against a loop in bad data
  const phaseOf = (t) => {
    const seen = new Set([idOf(t._id)]);
    let top = null;
    for (let at = byId.get(idOf(t.parentTaskId)); at && !seen.has(idOf(at._id)); at = byId.get(idOf(at.parentTaskId))) {
      seen.add(idOf(at._id));
      top = at;
    }
    return top ? String(top.title ?? '') : '';
  };
  const all = tasks
    .filter((t) => !parents.has(idOf(t._id)))
    .map((t, order) => ({
      order,
      id: idOf(t._id),
      title: String(t.title ?? ''),
      department: String(t.departmentName || ownerDepartment || '').trim(),
      phase: phaseOf(t),
      planned: toRupees(toPaise(Number(t.plannedCost) || 0)),
    }));
  all.sort((a, b) => (b.planned > 0) - (a.planned > 0) || b.planned - a.planned || a.order - b.order);
  const lines = all.slice(0, Math.max(0, limit)).map(({ order, ...line }) => line);
  return { lines, more: all.length - lines.length };
};

/// The amount the plan is held against: what the finance head approved, or — while a request waits — what is asked for if that is more.
/// 0 = nothing approved or asked yet (the plan is not held against anything).
export const planCeiling = ({ costStatus, approvedBudget, budget } = {}) => {
  const approved = Number(approvedBudget) || 0;
  const asked = costStatus === 'pending' ? Number(budget) || 0 : 0;
  return Math.max(approved, asked);
};

/// none (no ceiling) · ok · warn (at 80% or more) · over
export const planLevel = (planned, ceiling) => {
  const limit = toPaise(Number(ceiling) || 0);
  if (limit <= 0) return 'none';
  const used = toPaise(Number(planned) || 0);
  if (used > limit) return 'over';
  return used * 100 >= limit * 80 ? 'warn' : 'ok';
};

/**
 * Is this change held for a budget increase? Yes when there is a ceiling, the plan after the change is above it, and the change ADDS to
 * the plan (it is above what it was before). Nothing that leaves the plan the same or lower is ever held.
 * @returns {{ held: boolean, over: number }}  over = how far above the ceiling the plan would be (0 when not)
 */
export const checkGuard = ({ before, after, ceiling }) => {
  const limit = toPaise(Number(ceiling) || 0);
  const a = toPaise(Number(after) || 0);
  const b = toPaise(Number(before) || 0);
  const held = limit > 0 && a > limit && a > b;
  return { held, over: a > limit && limit > 0 ? toRupees(a - limit) : 0 };
};

/**
 * The cost to ask the finance head for so the plan fits: the new total, with the shortfall put on an "other" line (note "Task plan")
 * when the project has a breakdown, so the lines still add up to the total.
 * @param {{ budget?: number, plan?: Array<{category, amount, note}> }} cost  the cost as it stands (what was asked for)
 * @param {number} amount  the new total
 * @returns {{ budget: number, costPlan: Array } | { error: string, code: string }}
 */
export const raiseCost = ({ budget = 0, plan = [] } = {}, amount) => {
  const target = toPaise(amount);
  if (!plan.length) return { budget: toRupees(target), costPlan: [] };
  const total = plan.reduce((p, l) => p + toPaise(l.amount), 0);
  const gap = target - total;
  const lines = plan.map((l) => ({ category: l.category, amount: toRupees(toPaise(l.amount)), note: l.note ?? '' }));
  if (gap <= 0) return { budget: toRupees(Math.max(target, total)), costPlan: lines };
  const other = lines.find((l) => l.category === 'other');
  if (other) {
    other.amount = toRupees(toPaise(other.amount) + gap);
    if (!other.note) other.note = 'Task plan';
  } else if (lines.length >= MAX_COST_LINES) {
    return { error: `The cost already has ${MAX_COST_LINES} lines. Fold some together, then raise it.`, code: 'COST_LINES_FULL' };
  } else {
    lines.push({ category: 'other', amount: toRupees(gap), note: 'Task plan' });
  }
  return { budget: toRupees(target), costPlan: lines };
};
