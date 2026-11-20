// Pure unit tests: node --test tests/marketingStrategyStats.test.js
// How Strategies & Developments counts: progress from tasks, owner / due day, status (due date against progress), KPI counts, plans,
// focus areas, strategy performance, roadmap quarters and timeline bars, research counts, review scores, recent updates.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../utils/marketingStrategyStats.js';

const R = { from: '2026-11-01', to: '2026-11-30', brand: 'all' };
let n = 0;
const task = (extra = {}) => ({ _id: `t${++n}`, title: `Task ${n}`, assigneeId: 'm1', status: 'in_progress', progress: 0, dueDate: null, completedAt: null, ...extra });
const initiative = (extra = {}) => ({ _id: `i${++n}`, title: `Initiative ${n}`, brand: 'main', focusArea: 'Growth', status: 'active', dueDate: null, startDate: null, ownerId: null, progress: null, planId: null, impact: 'medium', createdAt: '2026-11-02T05:00:00Z', completedAt: null, ...extra });
const project = (extra = {}) => ({ _id: `p${++n}`, name: `Project ${n}`, brand: 'main', category: 'Tech', status: 'in_progress', startDate: null, endDate: null, ownerId: null, progress: null, planId: null, createdAt: '2026-11-02T05:00:00Z', completedAt: null, ...extra });

// ── progress from the work ───────────────────────────────────────────────────

test('task progress: completed is 100 whatever it says; other statuses count their own figure (clamped, whole)', () => {
  assert.equal(S.taskProgress({ status: 'completed', progress: 20 }), 100);
  assert.equal(S.taskProgress({ status: 'in_progress', progress: 40 }), 40);
  assert.equal(S.taskProgress({ status: 'blocked', progress: 30 }), 30);
  assert.equal(S.taskProgress({ status: 'not_started', progress: 0 }), 0);
  assert.equal(S.taskProgress({ status: 'pending', progress: 140 }), 100);
  assert.equal(S.taskProgress({ status: 'pending', progress: -5 }), 0);
  assert.equal(S.taskProgress({ status: 'pending', progress: 33.6 }), 34);
  assert.equal(S.taskProgress({ status: 'pending' }), 0, 'a missing figure is 0');
});

test('work progress: the mean of the tasks (all statuses count); the owner\'s figure only while there is no task; else none', () => {
  const p = S.progressOf([task({ status: 'completed' }), task({ progress: 50 }), task({ status: 'blocked', progress: 0 }), task({ status: 'not_started' })], 90);
  assert.deepEqual(p, { pct: 38, source: 'tasks', taskCount: 4, doneCount: 1 }, '(100+50+0+0)/4 = 37.5 → 38, and the typed 90 is ignored');
  assert.deepEqual(S.progressOf([task({ status: 'completed' })], 10), { pct: 100, source: 'tasks', taskCount: 1, doneCount: 1 });
  assert.deepEqual(S.progressOf([], 65), { pct: 65, source: 'owner', taskCount: 0, doneCount: 0 });
  assert.deepEqual(S.progressOf([], 0), { pct: 0, source: 'owner', taskCount: 0, doneCount: 0 }, 'a typed 0 is a typed figure');
  assert.deepEqual(S.progressOf([], 140), { pct: 100, source: 'owner', taskCount: 0, doneCount: 0 }, 'clamped');
  for (const none of [null, undefined, '', 'abc']) assert.deepEqual(S.progressOf([], none), { pct: 0, source: 'none', taskCount: 0, doneCount: 0 }, String(none));
  assert.equal(S.progressOf([task({ progress: 33 }), task({ progress: 33 }), task({ progress: 34 })]).pct, 33);
});

test('owner: the one chosen; else whoever holds most tasks (tie → the lowest id); else nobody', () => {
  assert.deepEqual(S.resolveOwner('m9', [task({ assigneeId: 'm1' })]), { id: 'm9', source: 'set' });
  assert.deepEqual(S.resolveOwner(null, [task({ assigneeId: 'm2' }), task({ assigneeId: 'm1' }), task({ assigneeId: 'm2' })]), { id: 'm2', source: 'tasks' });
  assert.deepEqual(S.resolveOwner(null, [task({ assigneeId: 'm2' }), task({ assigneeId: 'm1' })]), { id: 'm1', source: 'tasks' }, 'tie');
  assert.deepEqual(S.resolveOwner(null, []), { id: null, source: 'none' });
  assert.deepEqual(S.resolveOwner(null, [task({ assigneeId: null })]), { id: null, source: 'none' });
});

test('due day: the typed one; else the latest among the tasks; else none', () => {
  assert.deepEqual(S.resolveDue('2026-12-01', [task({ dueDate: '2026-12-20' })]), { due: '2026-12-01', source: 'set' });
  assert.deepEqual(S.resolveDue(null, [task({ dueDate: '2026-11-10' }), task({ dueDate: '2026-11-25' }), task({ dueDate: null })]), { due: '2026-11-25', source: 'tasks' });
  assert.deepEqual(S.resolveDue('', []), { due: null, source: 'none' });
  assert.deepEqual(S.resolveDue('2026-02-31x', []), { due: null, source: 'none' }, 'not a day');
});

// ── status: due date against progress ────────────────────────────────────────

const st = (extra = {}) => S.statusOf({ stored: 'active', progress: { pct: 50, source: 'tasks', taskCount: 2, doneCount: 0 }, start: '2026-11-01', due: '2026-11-21', today: '2026-11-11', ...extra });

test('status: cancelled, completed (stored or all tasks done) and on hold come first and are never second-guessed', () => {
  assert.equal(st({ stored: 'cancelled' }), 'cancelled');
  assert.equal(st({ stored: 'completed', due: '2026-10-01' }), 'completed', 'stored completed beats overdue');
  assert.equal(st({ stored: 'on_hold', due: '2026-10-01' }), 'on_hold', 'on hold beats overdue');
  assert.equal(st({ progress: { pct: 100, source: 'tasks', taskCount: 3, doneCount: 3 }, due: '2026-10-01' }), 'completed', 'every task done');
  assert.equal(st({ progress: { pct: 80, source: 'tasks', taskCount: 3, doneCount: 2 }, due: '2026-10-01' }), 'at_risk', 'one task still open');
  assert.equal(st({ progress: { pct: 100, source: 'owner', taskCount: 0, doneCount: 0 } }), 'on_track', 'a typed 100 does not complete it: only tasks or the manager do');
});

test('status: overdue is at risk; no due day or no progress is only in progress', () => {
  assert.equal(st({ due: '2026-11-10' }), 'at_risk', 'due yesterday');
  assert.equal(st({ due: '2026-11-11', progress: { pct: 90, source: 'tasks', taskCount: 2, doneCount: 1 } }), 'on_track', 'due today is not overdue yet');
  assert.equal(st({ due: '2026-11-11' }), 'at_risk', 'but the whole time has gone, so 50% is far behind');
  assert.equal(st({ due: null }), 'in_progress');
  assert.equal(st({ due: null, today: '2030-01-01' }), 'in_progress', 'no due day never goes overdue');
  assert.equal(st({ progress: { pct: 0, source: 'none', taskCount: 0, doneCount: 0 } }), 'in_progress', 'no progress known → not enough to judge');
  assert.equal(st({ progress: { pct: 0, source: 'none', taskCount: 0, doneCount: 0 }, due: '2026-11-10' }), 'at_risk', 'but overdue is overdue');
});

test('status: behind the clock by MORE than the margin is at risk; at or ahead, or within the margin, is on track', () => {
  assert.equal(S.AT_RISK_MARGIN, 15);
  // start 11-01 → due 11-21 is 20 days; on 11-11 half the time has gone (50%)
  const at = (pct) => st({ progress: { pct, source: 'tasks', taskCount: 2, doneCount: 0 } });
  assert.equal(at(80), 'on_track', 'ahead');
  assert.equal(at(50), 'on_track', 'exactly level');
  assert.equal(at(35), 'on_track', '15 points behind is within the margin');
  assert.equal(at(34), 'at_risk', '16 points behind');
  assert.equal(at(0), 'at_risk');
  // not started yet: nothing elapsed, nothing behind
  assert.equal(st({ today: '2026-10-20', progress: { pct: 0, source: 'tasks', taskCount: 1, doneCount: 0 } }), 'on_track');
  // the last day: the whole time has gone, so it must be (nearly) done
  assert.equal(st({ today: '2026-11-21', progress: { pct: 85, source: 'tasks', taskCount: 1, doneCount: 0 } }), 'on_track');
  assert.equal(st({ today: '2026-11-21', progress: { pct: 84, source: 'tasks', taskCount: 1, doneCount: 0 } }), 'at_risk');
  // a due day on or before the start: due today means the whole time has gone
  assert.equal(st({ start: '2026-11-11', due: '2026-11-11', progress: { pct: 90, source: 'owner', taskCount: 0, doneCount: 0 } }), 'on_track');
  assert.equal(st({ start: '2026-11-15', due: '2026-11-11', progress: { pct: 50, source: 'owner', taskCount: 0, doneCount: 0 } }), 'at_risk');
});

test('elapsed share: held between 0 and 1', () => {
  assert.equal(S.elapsedShare('2026-11-01', '2026-11-11', '2026-10-01'), 0);
  assert.equal(S.elapsedShare('2026-11-01', '2026-11-11', '2026-11-06'), 0.5);
  assert.equal(S.elapsedShare('2026-11-01', '2026-11-11', '2027-01-01'), 1);
  assert.equal(S.elapsedShare('2026-11-11', '2026-11-11', '2026-11-10'), 0);
  assert.equal(S.elapsedShare('2026-11-11', '2026-11-11', '2026-11-11'), 1);
});

// ── a piece of work, worked out ──────────────────────────────────────────────

test('an initiative is worked out from its tasks: progress, owner, due day, status, closed day and minutes', () => {
  const doc = initiative({ title: 'Launch', startDate: '2026-11-01', ownerId: null, dueDate: null });
  const e = S.enrichWork('initiative', doc, [task({ assigneeId: 'm7', status: 'completed', completedAt: '2026-11-05T05:00:00Z', dueDate: '2026-11-08' }), task({ assigneeId: 'm7', progress: 50, dueDate: '2026-11-20' })], { today: '2026-11-11', minutes: 125 });
  assert.equal(e.kind, 'initiative');
  assert.equal(e.title, 'Launch');
  assert.equal(e.progress, 75);
  assert.equal(e.progressSource, 'tasks');
  assert.equal(e.ownerId, 'm7');
  assert.equal(e.ownerSource, 'tasks');
  assert.equal(e.due, '2026-11-20');
  assert.equal(e.dueSource, 'tasks');
  assert.equal(e.status, 'on_track');
  assert.equal(e.minutes, 125);
  assert.equal(e.closedDay, null, 'not completed');
  assert.equal(e.taskCount, 2);
  assert.equal(e.doneCount, 1);
});

test('a project reads name, category and its end day; with no tasks it shows the owner\'s typed progress, labelled', () => {
  const doc = project({ name: 'Website v2', category: 'Technology', ownerId: 'm3', startDate: '2026-11-01', endDate: '2026-11-21', progress: 85 });
  const e = S.enrichWork('project', doc, [], { today: '2026-11-11' });
  assert.equal(e.kind, 'project');
  assert.equal(e.title, 'Website v2');
  assert.equal(e.category, 'Technology');
  assert.equal(e.ownerId, 'm3');
  assert.equal(e.ownerSource, 'set');
  assert.equal(e.progress, 85);
  assert.equal(e.progressSource, 'owner');
  assert.equal(e.due, '2026-11-21');
  assert.equal(e.status, 'on_track');
  const none = S.enrichWork('project', project({ endDate: '2026-12-31' }), [], { today: '2026-11-11' });
  assert.equal(none.progressSource, 'none', 'never invented');
  assert.equal(none.status, 'in_progress');
  assert.equal(none.ownerId, null);
});

test('start falls back to the day the record was made; a completed one is closed on the manager\'s day, else its last task\'s', () => {
  const e = S.enrichWork('initiative', initiative({ createdAt: '2026-11-03T20:00:00Z' }), [], { today: '2026-11-11' });
  assert.equal(e.start, '2026-11-04', '20:00 UTC on the 3rd is the 4th in IST');
  const byHand = S.enrichWork('initiative', initiative({ status: 'completed', completedAt: '2026-11-09T05:00:00Z' }), [task({ status: 'completed', completedAt: '2026-11-07T05:00:00Z' })], { today: '2026-11-11' });
  assert.equal(byHand.status, 'completed');
  assert.equal(byHand.closedDay, '2026-11-09');
  const byTasks = S.enrichWork('initiative', initiative(), [task({ status: 'completed', completedAt: '2026-11-06T05:00:00Z' }), task({ status: 'completed', completedAt: '2026-11-08T05:00:00Z' })], { today: '2026-11-11' });
  assert.equal(byTasks.status, 'completed');
  assert.equal(byTasks.closedDay, '2026-11-08');
});

test('a range: work counts when its span overlaps; cancelled and the other brand count nowhere', () => {
  const mk = (extra, tasks = []) => S.enrichWork('initiative', initiative(extra), tasks, { today: '2026-11-11' });
  const inR = (e, r = R) => S.workInRange(e, r);
  assert.equal(inR(mk({ startDate: '2026-11-10', dueDate: '2026-11-20' })), true);
  assert.equal(inR(mk({ startDate: '2026-10-01', dueDate: '2026-10-31' })), false, 'ended before');
  assert.equal(inR(mk({ startDate: '2026-12-01', dueDate: '2026-12-31' })), false, 'starts after');
  assert.equal(inR(mk({ startDate: '2026-10-20', dueDate: '2026-11-01' })), true, 'ends on the first day');
  assert.equal(inR(mk({ startDate: '2026-11-30', dueDate: '2026-12-31' })), true, 'starts on the last day');
  assert.equal(inR(mk({ startDate: '2026-01-01' })), true, 'no due day: open, so it is still live');
  assert.equal(inR(mk({ startDate: '2026-01-01', status: 'completed', completedAt: '2026-03-01T05:00:00Z' })), false, 'completed in March: not live in November');
  assert.equal(inR(mk({ status: 'cancelled', startDate: '2026-11-10', dueDate: '2026-11-20' })), false);
  assert.equal(inR(mk({ brand: 'kerala', startDate: '2026-11-10', dueDate: '2026-11-20' }), { ...R, brand: 'main' }), false);
  assert.equal(inR(mk({ brand: 'kerala', startDate: '2026-11-10', dueDate: '2026-11-20' }), { ...R, brand: 'kerala' }), true);
});

test('a completed one with a due day stays in range until that day (its planned span); with no due day it ends the day it was completed', () => {
  const done = S.enrichWork('initiative', initiative({ status: 'completed', completedAt: '2026-03-01T05:00:00Z', startDate: '2026-02-01', dueDate: '2026-12-31' }), [], { today: '2026-11-11' });
  assert.equal(done.closedDay, '2026-03-01');
  assert.deepEqual(S.spanOf(done), { start: '2026-02-01', end: '2026-12-31' }, 'the due day, not the day it was finished');
  assert.equal(S.workInRange(done, R), true, 'still on the plan in November');
  const noDue = S.enrichWork('initiative', initiative({ status: 'completed', completedAt: '2026-03-01T05:00:00Z', startDate: '2026-02-01' }), [], { today: '2026-11-11' });
  assert.deepEqual(S.spanOf(noDue), { start: '2026-02-01', end: '2026-03-01' });
  assert.equal(S.workInRange(noDue, R), false);
  assert.deepEqual(S.spanOf({ start: '2026-02-01', due: null, closedDay: null }), { start: '2026-02-01', end: null });
});

test('KPI counts: total, open (on track + in progress + at risk), completed, on hold', () => {
  const list = [{ status: 'on_track' }, { status: 'on_track' }, { status: 'at_risk' }, { status: 'in_progress' }, { status: 'on_hold' }, { status: 'completed' }, { status: 'completed' }];
  assert.deepEqual(S.workCounts(list), { total: 7, open: 4, completed: 2, onHold: 1, onTrack: 2, atRisk: 1, inProgress: 1 });
  assert.deepEqual(S.workCounts([]), { total: 0, open: 0, completed: 0, onHold: 0, onTrack: 0, atRisk: 0, inProgress: 0 });
});

test('the order for the Overview: open work by due day, no due day last; then on hold; completed last', () => {
  const rows = [
    { title: 'D', status: 'completed', due: '2026-11-01' },
    { title: 'C', status: 'on_track', due: null },
    { title: 'B', status: 'at_risk', due: '2026-11-20' },
    { title: 'A', status: 'on_track', due: '2026-11-10' },
    { title: 'E', status: 'on_hold', due: '2026-11-02' },
  ];
  assert.deepEqual([...rows].sort(S.byDueOpenFirst).map((r) => r.title), ['A', 'B', 'C', 'E', 'D']);
});

test('strategy performance: mean progress per focus area over the initiatives that HAVE progress; unmeasured ones do not drag it to 0', () => {
  const e = (focusArea, progress, progressSource = 'tasks') => ({ focusArea, progress, progressSource });
  const rows = S.performanceByFocusArea([e('Brand', 90), e('Brand', 70), e('Brand', 0, 'none'), e('Revenue', 60), e('', 40), e('Team', 0, 'none')]);
  assert.deepEqual(rows, [
    { focusArea: 'Brand', progress: 80, initiatives: 3, measured: 2 },
    { focusArea: 'Others', progress: 40, initiatives: 1, measured: 1 },
    { focusArea: 'Revenue', progress: 60, initiatives: 1, measured: 1 },
    { focusArea: 'Team', progress: null, initiatives: 1, measured: 0 },
  ]);
  assert.deepEqual(S.performanceByFocusArea([]), []);
});

// ── plans ────────────────────────────────────────────────────────────────────

const plan = (extra = {}) => ({ _id: `pl${++n}`, title: `Plan ${n}`, focusArea: 'Brand', year: 2026, brand: 'main', status: 'active', goals: [], ...extra });

test('plans: a plan counts in a range whose years include its year, in the brand', () => {
  const plans = [plan({ year: 2025 }), plan({ year: 2026 }), plan({ year: 2027 }), plan({ year: 2026, brand: 'kerala' })];
  assert.equal(S.plansInRange(plans, R).length, 2);
  assert.equal(S.plansInRange(plans, { ...R, brand: 'kerala' }).length, 1);
  assert.equal(S.plansInRange(plans, { from: '2026-12-20', to: '2027-01-10', brand: 'all' }).length, 3, 'a range over New Year touches both years');
});

test('plans: active = active or in progress (the live ones); counts, status slices, focus areas and goals', () => {
  const plans = [
    plan({ focusArea: 'Brand', status: 'active', goals: ['Qualified leads +40%', ' '] }),
    plan({ focusArea: 'Brand', status: 'in_progress', goals: ['Engagement +50%'] }),
    plan({ focusArea: 'Revenue', status: 'in_progress', goals: ['2 new verticals'] }),
    plan({ focusArea: 'Revenue', status: 'on_hold', goals: ['Never shown: on hold'] }),
    plan({ focusArea: 'Team', status: 'completed', goals: ['Never shown: done'] }),
  ];
  assert.deepEqual(S.planCounts(plans), { total: 5, active: 3, inProgress: 2, onHold: 1, completed: 1 });
  assert.deepEqual(S.planStatusSlices(plans).map((s) => [s.key, s.count, s.pct]), [['active', 1, 20], ['in_progress', 2, 40], ['on_hold', 1, 20], ['completed', 1, 20]]);
  assert.deepEqual(S.focusAreaBreakdown(plans), [{ focusArea: 'Brand', count: 2 }, { focusArea: 'Revenue', count: 1 }], 'the live plans only: the total equals Active Strategies');
  assert.equal(S.focusAreaBreakdown(plans).reduce((s, r) => s + r.count, 0), S.planCounts(plans).active);
  assert.deepEqual(S.keyGoals(plans).map((g) => g.text), ['Qualified leads +40%', 'Engagement +50%', '2 new verticals']);
  assert.equal(S.keyGoals(plans, 2).length, 2);
  assert.deepEqual(S.planCounts([]), { total: 0, active: 0, inProgress: 0, onHold: 0, completed: 0 });
  assert.deepEqual(S.planStatusSlices([]).map((s) => s.pct), [0, 0, 0, 0]);
  assert.deepEqual(S.focusAreaBreakdown([plan({ focusArea: '' })]), [{ focusArea: 'Others', count: 1 }]);
});

// ── roadmap ──────────────────────────────────────────────────────────────────

const line = (extra = {}) => ({ _id: `r${++n}`, year: 2026, quarter: 1, theme: '', title: `Line ${n}`, done: false, ...extra });

test('roadmap: four quarters; the name is the theme typed most often (ties → earliest); progress is ticked ÷ lines', () => {
  const items = [
    line({ quarter: 1, theme: 'Foundation', done: true }),
    line({ quarter: 1, theme: 'Foundation', done: false }),
    line({ quarter: 1, theme: 'Base', done: true }),
    line({ quarter: 2, theme: 'Growth' }),
    line({ quarter: 2, theme: 'Scale' }),
    line({ quarter: 4, theme: '' }),
    line({ year: 2025, quarter: 3, theme: 'Last year' }),
  ];
  const q = S.roadmapQuarters(items, 2026);
  assert.equal(q.length, 4);
  assert.deepEqual(q.map((x) => x.label), ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.deepEqual(q.map((x) => x.months), ['Jan – Mar', 'Apr – Jun', 'Jul – Sep', 'Oct – Dec']);
  assert.deepEqual(q.map((x) => x.theme), ['Foundation', 'Growth', '', ''], 'tie in Q2 → the earliest');
  assert.deepEqual(q.map((x) => [x.done, x.total, x.pct]), [[2, 3, 67], [0, 2, 0], [0, 0, null], [0, 1, 0]], 'another year\'s line is not here; an empty quarter has no percentage');
  assert.equal(S.quarterTheme([]), '');
});

test('timeline bar: the span clipped to the year as fractions; no end day = no bar; outside the year = no bar', () => {
  const w = (start, end) => ({ start, due: end, closedDay: null });
  const whole = S.timelineBar(w('2026-01-01', '2026-12-31'), 2026);
  assert.deepEqual(whole, { from: 0, to: 1, startsBefore: false, endsAfter: false });
  const mid = S.timelineBar(w('2026-07-01', '2026-07-31'), 2026);
  assert.equal(mid.from, Number((181 / 365).toFixed(4)));
  assert.equal(mid.to, Number((212 / 365).toFixed(4)));
  const clip = S.timelineBar(w('2025-10-01', '2027-02-01'), 2026);
  assert.deepEqual(clip, { from: 0, to: 1, startsBefore: true, endsAfter: true });
  assert.equal(S.timelineBar(w('2026-03-01', null), 2026), null, 'no end day');
  assert.equal(S.timelineBar(w('2025-01-01', '2025-12-31'), 2026), null, 'ended before the year');
  assert.equal(S.timelineBar(w('2027-01-01', '2027-02-01'), 2026), null, 'starts after the year');
  assert.deepEqual(S.timelineBar(w('2026-12-31', '2026-12-31'), 2026), { from: Number((364 / 365).toFixed(4)), to: 1, startsBefore: false, endsAfter: false }, 'one day');
  const leap = S.timelineBar(w('2028-01-01', '2028-12-31'), 2028);
  assert.deepEqual([leap.from, leap.to], [0, 1], 'a leap year');
  // a completed one with no due day ends the day it was closed
  assert.ok(S.timelineBar({ start: '2026-02-01', due: null, closedDay: '2026-02-20' }, 2026));
});

// ── research ─────────────────────────────────────────────────────────────────

test('research: findings count on their date, in the brand; the KPI strip counts kinds', () => {
  const f = (extra = {}) => ({ _id: `f${++n}`, kind: 'report', brand: 'main', date: '2026-11-10', ...extra });
  const all = [f(), f({ kind: 'market_insight' }), f({ kind: 'market_insight', date: '2026-11-30' }), f({ kind: 'competitor' }), f({ kind: 'opportunity', brand: 'kerala' }), f({ date: '2026-10-31' }), f({ date: '2026-12-01' })];
  const inR = S.findingsInRange(all, R);
  assert.equal(inR.length, 5, 'the boundary days count; the days outside do not');
  assert.deepEqual(S.researchCounts(inR), { total: 5, report: 1, marketInsight: 2, competitor: 1, opportunity: 1 });
  assert.deepEqual(S.researchCounts(S.findingsInRange(all, { ...R, brand: 'kerala' })), { total: 1, report: 0, marketInsight: 0, competitor: 0, opportunity: 1 });
  assert.deepEqual(S.researchCounts([]), { total: 0, report: 0, marketInsight: 0, competitor: 0, opportunity: 0 });
});

// ── reviews ──────────────────────────────────────────────────────────────────

test('review score: counted from the outcomes; the overall score is the Achieved share; nothing to count → no score', () => {
  const o = (state) => ({ text: state, state });
  const s = S.reviewScores([o('achieved'), o('achieved'), o('achieved'), o('partial'), o('missed')]);
  assert.deepEqual(s, { total: 5, achieved: 3, partial: 1, missed: 1, achievedPct: 60, partialPct: 20, missedPct: 20, overall: 60 });
  const none = S.reviewScores([]);
  assert.equal(none.total, 0);
  assert.equal(none.overall, null);
  assert.equal(none.achievedPct, null);
  assert.equal(S.reviewScores([o('missed')]).overall, 0);
  assert.equal(S.reviewScores([{ text: 'x', state: 'weird' }]).total, 0, 'an unknown state counts as nothing');
});

test('reviews: in range by their day and brand; the latest is the newest on or before a day (then the newest made)', () => {
  const rv = (extra = {}) => ({ _id: `rv${++n}`, brand: 'main', type: 'quarterly', reviewDate: '2026-11-10', createdAt: '2026-11-10T05:00:00Z', ...extra });
  const a = rv({ reviewDate: '2026-09-30' });
  const b = rv({ reviewDate: '2026-11-10', createdAt: '2026-11-10T05:00:00Z' });
  const c = rv({ reviewDate: '2026-11-10', createdAt: '2026-11-10T09:00:00Z' });
  const d = rv({ reviewDate: '2026-12-15' });
  assert.deepEqual(S.reviewsInRange([a, b, c, d], R).map((r) => r._id), [b._id, c._id]);
  assert.equal(S.latestReview([a, b, c, d], '2026-11-30')._id, c._id, 'same day → the one made last');
  assert.equal(S.latestReview([a, b, c, d], '2026-09-30')._id, a._id);
  assert.equal(S.latestReview([a, b, c, d], '2026-09-29'), null);
  assert.equal(S.latestReview([], '2026-11-30'), null);
});

// ── week, new this week, recent updates ──────────────────────────────────────

test('week: Monday–Sunday of the day; a Sunday belongs to the week that ends on it', () => {
  assert.deepEqual(S.weekOf('2026-11-13'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(S.weekOf('2026-11-15'), { from: '2026-11-09', to: '2026-11-15' });
  assert.deepEqual(S.weekOf('2026-11-16'), { from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(S.weekOf('2026-11-09'), { from: '2026-11-09', to: '2026-11-15' });
});

test('new this week: made during the week (IST day), not cancelled, in the brand, whatever the range', () => {
  const w = { weekFrom: '2026-11-09', weekTo: '2026-11-15', brand: 'all' };
  const rec = (createdAt, extra = {}) => ({ status: 'active', brand: 'main', createdAt, ...extra });
  assert.equal(S.newThisWeek([rec('2026-11-09T00:00:00Z'), rec('2026-11-15T17:00:00Z'), rec('2026-11-15T19:00:00Z'), rec('2026-11-08T17:00:00Z'), rec('2026-11-08T19:00:00Z'), rec('2026-11-10T05:00:00Z', { status: 'cancelled' }), rec('2026-11-10T05:00:00Z', { brand: 'kerala' }), rec(null)], w), 4, 'the 15th 17:00 UTC is still the 15th IST; 19:00 UTC is the 16th; the 8th 19:00 UTC is the 9th');
  assert.equal(S.newThisWeek([rec('2026-11-10T05:00:00Z', { brand: 'kerala' })], { ...w, brand: 'main' }), 0);
});

test('recent updates: only real changes inside the range, newest first, capped; each says what and by whom', () => {
  const day = (d, h = 5) => `2026-11-${d}T0${h}:00:00Z`;
  const out = S.recentUpdates(
    {
      tasks: [{ _id: 't1', title: 'Hero reel', completedAt: day('12'), workTitle: 'Bridal Campaign', assignee: 'Asha' }, { _id: 't0', title: 'Too old', completedAt: '2026-10-02T05:00:00Z', workTitle: 'x', assignee: 'Asha' }, { _id: 'tn', title: 'Open task', completedAt: null }],
      roadmap: [{ _id: 'r1', title: 'Content engine setup', quarter: 4, year: 2026, done: true, doneAt: day('11'), doneByName: 'Ravi' }, { _id: 'r2', title: 'Not ticked', quarter: 1, year: 2026, done: false, doneAt: null }],
      reviews: [{ _id: 'v1', type: 'quarterly', periodLabel: 'Q3 2026', createdAt: day('10'), createdByName: 'Meera' }],
      findings: [{ _id: 'f1', title: 'Instagram trends', kind: 'market_insight', createdAt: day('13'), authorName: 'Ravi' }],
      plans: [{ _id: 'p1', title: 'Brand plan', focusArea: 'Brand', createdAt: day('09') }],
      work: [{ _id: 'w1', kind: 'initiative', title: 'CRM', createdAt: day('08') }, { _id: 'w2', kind: 'project', title: 'Website v2', createdAt: day('07') }],
    },
    R,
    20,
  );
  assert.deepEqual(out.map((e) => e.kind), ['finding', 'task_done', 'roadmap_done', 'review', 'plan', 'initiative', 'project']);
  assert.equal(out[0].text, 'Instagram trends');
  assert.equal(out[0].by, 'Ravi');
  assert.equal(out[1].text, 'Hero reel completed');
  assert.equal(out[1].subtitle, 'Bridal Campaign');
  assert.equal(out[2].subtitle, 'Q4 2026 roadmap');
  assert.equal(out[3].text, 'Q3 2026 review added');
  assert.equal(out[3].subtitle, 'Quarterly review');
  assert.equal(out[6].text, 'Website v2 project made');
  assert.equal(S.recentUpdates({ tasks: [{ _id: 'a', title: 'a', completedAt: day('12') }, { _id: 'b', title: 'b', completedAt: day('13') }] }, R, 1).length, 1, 'capped');
  assert.deepEqual(S.recentUpdates({}, R), []);
  // the boundary: an event at 20:00 UTC on the 30th is the 1st of the next month in IST — outside November
  assert.equal(S.recentUpdates({ tasks: [{ _id: 'x', title: 'x', completedAt: '2026-11-30T19:00:00Z' }] }, R).length, 0);
  assert.equal(S.recentUpdates({ tasks: [{ _id: 'x', title: 'x', completedAt: '2026-11-30T17:00:00Z' }] }, R).length, 1);
});

test('hours label', () => {
  assert.equal(S.hoursLabel(0), '0m');
  assert.equal(S.hoursLabel(45), '45m');
  assert.equal(S.hoursLabel(60), '1h');
  assert.equal(S.hoursLabel(125), '2h 5m');
  assert.equal(S.hoursLabel(null), '0m');
});

test('status labels are the document\'s words', () => {
  assert.deepEqual([S.STATUS_LABEL.on_track, S.STATUS_LABEL.in_progress, S.STATUS_LABEL.at_risk, S.STATUS_LABEL.on_hold, S.STATUS_LABEL.completed], ['On Track', 'In Progress', 'At Risk', 'On Hold', 'Completed']);
});

// ── audit fixes (S1, S4) ──────────────────────────────────────────────────────

test('quarters: the calendar quarter of a day', () => {
  assert.deepEqual(S.quarterOf('2026-11-18'), { year: 2026, q: 4, from: '2026-10-01', to: '2026-12-31' });
  assert.deepEqual(S.quarterOf('2026-02-28'), { year: 2026, q: 1, from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(S.quarterOf('2026-06-30'), { year: 2026, q: 2, from: '2026-04-01', to: '2026-06-30' });
});

test('enquiry trend: leads so far this quarter against the same number of days of the quarter before, by arrival day and brand', () => {
  const at = (iso, extra = {}) => ({ leadDate: new Date(iso), source: 'WhatsApp', region: 'Bangalore', ...extra });
  const leads = [
    at('2026-10-02T05:00:00Z'), at('2026-11-18T05:00:00Z'), at('2026-11-10T05:00:00Z', { region: 'Calicut' }), // this quarter, to the 18th (49 days)
    at('2026-07-01T05:00:00Z'), at('2026-08-18T05:00:00Z'), // the first 49 days of Q3
    at('2026-08-19T05:00:00Z'), // day 50 of Q3 — not compared
    { leadDate: null, createdAt: new Date('2026-07-05T05:00:00Z'), source: 'IG Leads Kerala' }, // no leadDate → the day it was made; Kerala
  ];
  const t = S.enquiryTrend({ leads, today: '2026-11-18' });
  assert.deepEqual([t.quarter, t.previousQuarter, t.elapsedDays, t.now.leads, t.before.leads, t.before.to, t.change], ['Q4 2026', 'Q3 2026', 49, 3, 3, '2026-08-18', 0]);
  assert.match(t.label, /Enquiry trend vs last quarter/);
  const k = S.enquiryTrend({ leads, today: '2026-11-18', brand: 'kerala' });
  assert.deepEqual([k.now.leads, k.before.leads, k.change], [1, 1, 0]);
  assert.equal(S.enquiryTrend({ leads: [at('2026-11-01T05:00:00Z')], today: '2026-11-18' }).change, null, 'nothing to compare with → no change, never 0');
  const jan = S.enquiryTrend({ leads, today: '2026-01-10' });
  assert.deepEqual([jan.quarter, jan.previousQuarter, jan.before.from, jan.before.to], ['Q1 2026', 'Q4 2025', '2025-10-01', '2025-10-10']);
  // a long quarter: the earlier window stops at the end of its own quarter
  assert.equal(S.enquiryTrend({ leads: [], today: '2026-12-31' }).before.to, '2026-09-30');
});

test('strategy work logged: the Strategies log types counted per initiative and per project (and in all); other counts are left out', () => {
  const names = { s1: 'First drafts prepared', s2: 'Strategy meetings held' };
  const logs = [
    { initiativeId: 'i1', timeSpentMinutes: 60, values: [{ metricId: 's1', value: 2 }, { metricId: 'other', value: 9 }] },
    { initiativeId: 'i1', devProjectId: 'p1', timeSpentMinutes: 30, values: [{ metricId: 's2', value: 1 }] },
    { devProjectId: 'p1', timeSpentMinutes: 15, values: [] },
    { timeSpentMinutes: 15, values: [{ metricId: 's1', value: 1 }] },
  ];
  const c = S.strategyLogCounts(logs, (id) => names[id]);
  assert.deepEqual(c.get('initiative:i1'), { total: 3, minutes: 90, logs: 2, counts: [{ metric: 'First drafts prepared', total: 2 }, { metric: 'Strategy meetings held', total: 1 }] });
  assert.deepEqual(c.get('project:p1'), { total: 1, minutes: 45, logs: 2, counts: [{ metric: 'Strategy meetings held', total: 1 }] });
  assert.deepEqual(c.get('all'), { total: 4, minutes: 105, logs: 3, counts: [{ metric: 'First drafts prepared', total: 3 }, { metric: 'Strategy meetings held', total: 1 }] });
});
