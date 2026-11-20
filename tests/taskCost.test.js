import test from 'node:test';
import assert from 'node:assert/strict';
import { COST_MODES, COST_MOVING_KEYS, TASK_COST_KEYS, checkGuard, planCeiling, planLevel, raiseCost, resolveTaskCost, rollup, taskCostLines } from '../utils/taskCost.js';

const T = (id, plannedCost, extra = {}) => ({ _id: id, plannedCost, ...extra });

test('a task with no cost given has none', () => {
  assert.deepEqual(resolveTaskCost({}), { costMode: '', costAmount: 0, costRate: 0, plannedCost: 0 });
  assert.deepEqual(resolveTaskCost({ costMode: '', costAmount: 500, costRate: 9 }), { costMode: '', costAmount: 0, costRate: 0, plannedCost: 0 });
  assert.deepEqual(COST_MODES, ['', 'amount', 'rate']);
});

test('an amount is the cost, cleaned to paise', () => {
  assert.deepEqual(resolveTaskCost({ costMode: 'amount', costAmount: '12,500' }), { costMode: 'amount', costAmount: 12500, costRate: 0, plannedCost: 12500 });
  assert.equal(resolveTaskCost({ costMode: 'amount', costAmount: '10.456' }).plannedCost, 10.46);
  assert.equal(resolveTaskCost({ costMode: 'amount', costAmount: 0 }).plannedCost, 0);
  assert.equal(resolveTaskCost({ costMode: 'amount' }).plannedCost, 0, 'no amount typed yet is zero, not an error');
});

test('hours × rate is worked out from the hours, so more hours cost more', () => {
  assert.deepEqual(resolveTaskCost({ costMode: 'rate', costRate: 750, estimatedHours: 8 }), { costMode: 'rate', costAmount: 0, costRate: 750, plannedCost: 6000 });
  assert.equal(resolveTaskCost({ costMode: 'rate', costRate: 750, estimatedHours: 12.5 }).plannedCost, 9375);
  assert.equal(resolveTaskCost({ costMode: 'rate', costRate: 333.33, estimatedHours: 3 }).plannedCost, 999.99);
  assert.equal(resolveTaskCost({ costMode: 'rate', costRate: 750, estimatedHours: 0 }).plannedCost, 0);
  assert.equal(resolveTaskCost({ costMode: 'rate', costRate: 0, estimatedHours: 40 }).plannedCost, 0);
});

test('every wrong cost is refused in plain words, with a code', () => {
  for (const bad of [
    { costMode: 'sideways' },
    { costMode: 'amount', costAmount: -1 },
    { costMode: 'amount', costAmount: 'lots' },
    { costMode: 'amount', costAmount: 1e13 },
    { costMode: 'rate', costRate: -5, estimatedHours: 3 },
    { costMode: 'rate', costRate: 'x', estimatedHours: 3 },
    { costMode: 'rate', costRate: 100, estimatedHours: -2 },
    { costMode: 'rate', costRate: 100, estimatedHours: 'many' },
    { costMode: 'rate', costRate: 999999999, estimatedHours: 999999 },
  ]) {
    const r = resolveTaskCost(bad);
    assert.equal(r.code, 'TASK_COST_INVALID', JSON.stringify(bad));
    assert.ok(r.error.length > 10, JSON.stringify(bad));
  }
});

test('the keys a client may send, and the keys that move a cost', () => {
  assert.deepEqual(TASK_COST_KEYS, ['costMode', 'costAmount', 'costRate']);
  assert.ok(!TASK_COST_KEYS.includes('plannedCost'), 'plannedCost is the server\'s alone');
  assert.deepEqual(COST_MOVING_KEYS, ['costMode', 'costAmount', 'costRate', 'estimatedHours']);
});

test('only leaf tasks are counted; a phase shows the sum of its leaves', () => {
  const tasks = [
    T('p1', 999, { parentTaskId: null }), // a phase: its own number is ignored
    T('a', 1000, { parentTaskId: 'p1' }),
    T('b', 2500.5, { parentTaskId: 'p1' }),
    T('p2', 0, { parentTaskId: null }),
    T('c', 400, { parentTaskId: 'p2' }),
    T('solo', 50),
  ];
  const r = rollup(tasks);
  assert.equal(r.planned, 3950.5);
  assert.equal(r.leaves, 4);
  assert.equal(r.rolled.get('p1'), 3500.5);
  assert.equal(r.rolled.get('p2'), 400);
  assert.equal(r.rolled.get('a'), 1000);
  assert.equal(r.rolled.get('solo'), 50);
});

test('a deeper tree adds up through every level', () => {
  const tasks = [T('p', 0), T('q', 0, { parentTaskId: 'p' }), T('x', 100, { parentTaskId: 'q' }), T('y', 250, { parentTaskId: 'q' }), T('z', 40, { parentTaskId: 'p' })];
  const r = rollup(tasks);
  assert.equal(r.planned, 390);
  assert.equal(r.rolled.get('q'), 350);
  assert.equal(r.rolled.get('p'), 390);
});

test('priced and unpriced leaves are counted; a project with no tasks adds up to nothing', () => {
  const r = rollup([T('a', 100), T('b', 0), T('c', 0), T('d', 5)]);
  assert.deepEqual([r.leaves, r.priced, r.unpriced], [4, 2, 2]);
  const empty = rollup([]);
  assert.deepEqual([empty.planned, empty.leaves, empty.priced, empty.unpriced, empty.byDepartment], [0, 0, 0, 0, []]);
  assert.equal(rollup().planned, 0);
});

test('paise add up exactly: no float drift', () => {
  const r = rollup([T('a', 0.1), T('b', 0.2), T('c', 0.3)]);
  assert.equal(r.planned, 0.6);
});

test('by department: a task with no department belongs to the owning one; the biggest first', () => {
  const r = rollup(
    [T('a', 1000), T('b', 300, { departmentName: 'Marketing' }), T('c', 4000, { departmentName: 'Marketing' }), T('d', 0, { departmentName: 'HR' })],
    { ownerDepartment: 'IT' },
  );
  assert.deepEqual(r.byDepartment, [
    { name: 'Marketing', planned: 4300, tasks: 2 },
    { name: 'IT', planned: 1000, tasks: 1 },
    { name: 'HR', planned: 0, tasks: 1 },
  ]);
});

test('a parent that is not in the list, or a loop in bad data, does not break it', () => {
  assert.equal(rollup([T('a', 10, { parentTaskId: 'gone' })]).planned, 10, 'an orphan is a leaf');
  const loop = rollup([T('a', 10, { parentTaskId: 'b' }), T('b', 20, { parentTaskId: 'a' })]);
  assert.ok(Number.isFinite(loop.planned));
});

test('ids may be ObjectId-like objects', () => {
  const oid = (s) => ({ _id: s, toString: () => s });
  const r = rollup([{ _id: oid('p'), plannedCost: 0 }, { _id: oid('a'), parentTaskId: oid('p'), plannedCost: 70 }]);
  assert.equal(r.planned, 70);
  assert.equal(r.rolled.get('p'), 70);
});

test('the ceiling is what was approved, or what is asked while a request waits, whichever is more', () => {
  assert.equal(planCeiling({ costStatus: 'approved', approvedBudget: 100000, budget: 100000 }), 100000);
  assert.equal(planCeiling({ costStatus: 'pending', approvedBudget: 100000, budget: 150000 }), 150000, 'tasks inside a pending request do not raise another');
  assert.equal(planCeiling({ costStatus: 'pending', approvedBudget: 100000, budget: 80000 }), 100000, 'a smaller request does not lower it');
  assert.equal(planCeiling({ costStatus: 'pending', approvedBudget: 0, budget: 70000 }), 70000, 'a first request that waits is what is held against');
  assert.equal(planCeiling({ costStatus: 'returned', approvedBudget: 0, budget: 70000 }), 0);
  assert.equal(planCeiling({ costStatus: 'returned', approvedBudget: 100000, budget: 120000 }), 100000, 'sent back: the approved amount again');
  assert.equal(planCeiling({ costStatus: 'none' }), 0);
  assert.equal(planCeiling({}), 0);
  assert.equal(planCeiling(), 0);
});

test('the level: none without a ceiling, ok, warn from 80%, over above', () => {
  assert.equal(planLevel(5000, 0), 'none');
  assert.equal(planLevel(1000, 100000), 'ok');
  assert.equal(planLevel(79999, 100000), 'ok');
  assert.equal(planLevel(80000, 100000), 'warn');
  assert.equal(planLevel(100000, 100000), 'warn', 'exactly at the ceiling is not over');
  assert.equal(planLevel(100000.01, 100000), 'over');
});

test('the guardrail holds a change that adds to a plan going above the ceiling — and only that', () => {
  const g = (before, after, ceiling) => checkGuard({ before, after, ceiling });
  assert.deepEqual(g(90000, 100000, 100000), { held: false, over: 0 }, 'exactly the ceiling fits');
  assert.deepEqual(g(90000, 100000.01, 100000), { held: true, over: 0.01 });
  assert.deepEqual(g(90000, 130000, 100000), { held: true, over: 30000 });
  assert.equal(g(120000, 130000, 100000).held, true, 'already over and adding more is held again');
  assert.equal(g(120000, 120000, 100000).held, false, 'a progress update on an over plan is never held up');
  assert.equal(g(120000, 110000, 100000).held, false, 'taking cost out is never held, even if still over');
  assert.deepEqual(g(120000, 110000, 100000), { held: false, over: 10000 }, 'but it still says how far over it is');
  assert.equal(g(0, 999999, 0).held, false, 'no ceiling, nothing to hold it against');
  assert.equal(g(0, 50, 100000).held, false);
});

test('raising a cost with no breakdown just sets the amount', () => {
  assert.deepEqual(raiseCost({ budget: 100000, plan: [] }, 130000.5), { budget: 130000.5, costPlan: [] });
});

test('raising a cost with a breakdown puts the shortfall on an "other" line so the lines still add up', () => {
  const plan = [{ category: 'manpower', amount: 60000, note: '' }, { category: 'tools', amount: 40000, note: 'licences' }];
  const r = raiseCost({ budget: 100000, plan }, 130000);
  assert.equal(r.budget, 130000);
  assert.deepEqual(r.costPlan, [
    { category: 'manpower', amount: 60000, note: '' },
    { category: 'tools', amount: 40000, note: 'licences' },
    { category: 'other', amount: 30000, note: 'Task plan' },
  ]);
  assert.equal(r.costPlan.reduce((s, l) => s + l.amount, 0), r.budget);
  // an existing "other" line grows instead
  const again = raiseCost({ budget: 130000, plan: r.costPlan }, 145000.25);
  assert.equal(again.costPlan.length, 3);
  assert.equal(again.costPlan[2].amount, 45000.25);
  assert.equal(again.costPlan[2].note, 'Task plan');
  assert.equal(again.budget, 145000.25);
  // the input is not changed
  assert.equal(plan.length, 2);
});

test('a breakdown that is full of lines and has no "other" line cannot take the shortfall', () => {
  const plan = Array.from({ length: 12 }, (_, i) => ({ category: 'manpower', amount: 1000 + i, note: '' }));
  const r = raiseCost({ budget: 12066, plan }, 20000);
  assert.equal(r.code, 'COST_LINES_FULL');
  assert.match(r.error, /12 lines/);
});

// ── the tasks behind the plan, for the finance head ──
const L = (id, title, plannedCost, extra = {}) => ({ _id: id, title, plannedCost, ...extra });

test('task lines: one for each leaf task, with the phase it hangs under; a phase is not a line of its own', () => {
  const { lines, more } = taskCostLines(
    [
      L('ph', 'Design', 0),
      L('a', 'Wireframes', 30000, { parentTaskId: 'ph', departmentName: 'Design team' }),
      L('b', 'Mockups', 0, { parentTaskId: 'ph' }),
      L('solo', 'Kick-off', 500),
    ],
    { ownerDepartment: 'Marketing' },
  );
  assert.equal(more, 0);
  assert.deepEqual(
    lines.map((l) => [l.id, l.title, l.department, l.phase, l.planned]),
    [
      ['a', 'Wireframes', 'Design team', 'Design', 30000],
      ['solo', 'Kick-off', 'Marketing', '', 500],
      ['b', 'Mockups', 'Marketing', 'Design', 0],
    ],
  );
});

test('task lines: the biggest cost first, then those with none in the order they were given', () => {
  const { lines } = taskCostLines([L('1', 'none-1', 0), L('2', 'small', 10), L('3', 'none-2', 0), L('4', 'big', 900), L('5', 'mid', 100)]);
  assert.deepEqual(lines.map((l) => l.title), ['big', 'mid', 'small', 'none-1', 'none-2']);
});

test('task lines: the phase is the top of the chain, however deep the task is', () => {
  const { lines } = taskCostLines([L('p', 'Phase', 0), L('t', 'Task', 0, { parentTaskId: 'p' }), L('s', 'Step', 70, { parentTaskId: 't' })]);
  assert.deepEqual(lines.map((l) => [l.title, l.phase]), [['Step', 'Phase']]);
});

test('task lines: a limit leaves the rest out and says how many', () => {
  const tasks = Array.from({ length: 7 }, (_, i) => L(`t${i}`, `T${i}`, i * 10));
  const { lines, more } = taskCostLines(tasks, { limit: 3 });
  assert.equal(lines.length, 3);
  assert.equal(more, 4);
  assert.deepEqual(lines.map((l) => l.title), ['T6', 'T5', 'T4']);
  assert.deepEqual(taskCostLines([], {}), { lines: [], more: 0 });
});

test('task lines: a loop in bad data does not hang it, and a missing cost is zero', () => {
  const { lines } = taskCostLines([L('a', 'A', undefined, { parentTaskId: 'b' }), L('b', 'B', null, { parentTaskId: 'a' }), L('c', 'C', 5)]);
  assert.deepEqual(lines.map((l) => l.title), ['C']); // a and b are each other's parent: neither is a leaf
});
