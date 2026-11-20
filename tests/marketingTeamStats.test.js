// Pure unit tests: node --test tests/marketingTeamStats.test.js
// How the Marketing Team Dashboard counts: work items, rates, states, timesheets, performance.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../utils/marketingTeamStats.js';
import { sumLogs } from '../services/marketingRollup.js';

const m = (id, extra = {}) => ({ _id: id, name: id.toUpperCase(), shortName: id, roleName: 'Executive', ...extra });
const task = (id, extra = {}) => ({ _id: id, assigneeId: 'a', status: 'in_progress', dueDate: null, completedAt: null, groupId: 'g1', ...extra });
const log = (id, extra = {}) => ({ _id: id, memberId: 'a', entryDate: '2026-11-03', status: 'completed', kind: 'task', groupId: 'g1', timeSpentMinutes: 60, ...extra });
const FROM = '2026-11-02';
const TO = '2026-11-08';
const groupName = (id) => ({ g1: 'Content', g2: 'Campaigns' })[id] ?? '';

test('dates: the IST day, ranges, and the period before', () => {
  assert.equal(S.istDay(new Date('2026-11-02T20:00:00Z')), '2026-11-03', '20:00 UTC is already the next morning in India');
  assert.equal(S.addDays('2026-11-30', 1), '2026-12-01');
  assert.deepEqual(S.eachDay('2026-11-02', '2026-11-04'), ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual(S.eachDay('2026-11-05', '2026-11-04'), []);
  assert.deepEqual(S.previousRange({ from: FROM, to: TO }), { from: '2026-10-26', to: '2026-11-01' });
  assert.equal(S.eachDay('2020-01-01', '2026-01-01').length, 400, 'a wild range is capped');
});

test('work items: a task counts once; a log linked to a task is not a second item; meetings are not work items', () => {
  const tasks = [task('t1', { status: 'completed', completedAt: '2026-11-04T05:00:00Z' })];
  const acts = [log('l1', { taskId: 't1' }), log('l2'), log('l3', { kind: 'meeting' })];
  const items = S.buildItems({ tasks, activities: acts, from: FROM, to: TO });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.source).sort(), ['log', 'task']);
  assert.equal(S.kpiCounts(items).completed, 2);
});

test('work items: a task completed OUTSIDE the range is not counted; one still open is, whenever it was made', () => {
  const tasks = [task('old', { status: 'completed', completedAt: '2026-10-01T05:00:00Z' }), task('open', { status: 'in_progress' }), task('blocked', { status: 'blocked' })];
  const k = S.kpiCounts(S.buildItems({ tasks, activities: [], from: FROM, to: TO }));
  assert.deepEqual(k, { completed: 0, inProgress: 1, pendingBlocked: 1 });
});

test('work items: logs outside the range are ignored', () => {
  const items = S.buildItems({ tasks: [], activities: [log('l1', { entryDate: '2026-11-09' }), log('l2', { entryDate: '2026-11-01' }), log('l3')], from: FROM, to: TO });
  assert.equal(items.length, 1);
});

test('change against the previous period: a percentage, and nothing when there is nothing to compare', () => {
  assert.equal(S.changePct(42, 30), 40);
  assert.equal(S.changePct(5, 10), -50);
  assert.equal(S.changePct(5, 0), null);
});

test('on-time delivery: completed tasks with a due date, delivered by it — and null when none were due', () => {
  const tasks = [
    task('a', { status: 'completed', dueDate: '2026-11-05', completedAt: '2026-11-04T05:00:00Z' }),
    task('b', { status: 'completed', dueDate: '2026-11-03', completedAt: '2026-11-04T05:00:00Z' }),
    task('c', { status: 'completed', dueDate: null, completedAt: '2026-11-04T05:00:00Z' }),
    task('d', { status: 'in_progress', dueDate: '2026-11-03' }),
  ];
  assert.equal(S.onTimeRate({ tasks, from: FROM, to: TO }), 50);
  assert.equal(S.onTimeRate({ tasks: [task('x')], from: FROM, to: TO }), null);
});

test('on-time delivery: finishing ON the due day is on time', () => {
  const tasks = [task('a', { status: 'completed', dueDate: '2026-11-05', completedAt: '2026-11-05T05:00:00Z' })];
  assert.equal(S.onTimeRate({ tasks, from: FROM, to: TO }), 100);
});

test('member states: approved leave wins even over a shoot log on the same day', () => {
  const date = '2026-11-05';
  const states = S.memberStates({
    members: [m('both')],
    date,
    activities: [{ memberId: 'both', entryDate: date, kind: 'shoot', status: 'in_progress' }],
    leaves: new Map([['both', new Set([date])]]),
  });
  assert.equal(states.get('both').state, 'On Leave');
});

test('expected days: not Sundays, not holidays, not leave, only while the member is active', () => {
  const ctx = { weeklyOff: 0, holidays: new Set(['2026-11-04']), leaves: new Map([['a', new Set(['2026-11-05'])]]) };
  const a = m('a', { activeFrom: '2026-11-03T00:00:00Z' });
  assert.equal(S.isExpectedDay(a, '2026-11-08', ctx), false, 'Sunday');
  assert.equal(S.isExpectedDay(a, '2026-11-04', ctx), false, 'a holiday');
  assert.equal(S.isExpectedDay(a, '2026-11-05', ctx), false, 'on approved leave');
  assert.equal(S.isExpectedDay(a, '2026-11-02', ctx), false, 'before the member joined');
  assert.equal(S.isExpectedDay(a, '2026-11-06', ctx), true);
  assert.equal(S.isExpectedDay(m('b', { activeTo: '2026-11-05T00:00:00Z' }), '2026-11-06', ctx), false, 'after the member left');
});

test('activity rate: member-days with a log ÷ member-days expected, up to today only', () => {
  const ctx = { weeklyOff: 0, holidays: new Set(), leaves: new Map() };
  const days = S.eachDay(FROM, TO); // Mon..Sun
  const logged = new Set(['a|2026-11-02', 'a|2026-11-03', 'b|2026-11-02']);
  const r = S.activityRate({ members: [m('a'), m('b')], days, logged, today: '2026-11-04', ctx });
  assert.deepEqual(r, { expected: 6, actual: 3, pct: 50 }); // Mon, Tue, Wed × 2 people; the rest of the week has not happened
  assert.equal(S.activityRate({ members: [], days, logged, today: TO, ctx }).pct, null);
});

test('member rows: tasks, how many done, progress, and who is on shoot', () => {
  const items = S.buildItems({ tasks: [task('t1', { status: 'completed', completedAt: '2026-11-04T05:00:00Z' }), task('t2')], activities: [], from: FROM, to: TO });
  const rows = S.memberRows({ members: [m('a'), m('b')], items, states: new Map([['a', { state: 'On Shoot' }]]) });
  assert.deepEqual(rows.map((r) => [r.memberId, r.tasks, r.completed, r.progress, r.state]), [['a', 2, 1, 50, 'On Shoot'], ['b', 0, 0, 0, 'Not in yet']]);
});

test('workload and progress by group: no group falls under Others; biggest first', () => {
  const items = S.buildItems({ tasks: [task('1'), task('2'), task('3', { groupId: 'g2', status: 'completed', completedAt: '2026-11-04T05:00:00Z' }), task('4', { groupId: null })], activities: [], from: FROM, to: TO });
  assert.deepEqual(S.workloadByGroup(items, groupName), [{ group: 'Content', count: 2, pct: 50 }, { group: 'Campaigns', count: 1, pct: 25 }, { group: 'Others', count: 1, pct: 25 }]);
  const p = S.progressByGroup(items, groupName);
  assert.equal(p[0].group, 'Campaigns');
  assert.equal(p[0].pct, 100);
});

test('the daily trend: tasks completed that day and the share of the team that logged', () => {
  const ctx = { weeklyOff: 0, holidays: new Set(), leaves: new Map() };
  const items = S.buildItems({ tasks: [task('t1', { status: 'completed', completedAt: '2026-11-03T05:00:00Z' })], activities: [], from: FROM, to: TO });
  const t = S.dailyTrend({ days: ['2026-11-02', '2026-11-03', '2026-11-09'], items, members: [m('a'), m('b')], logged: new Set(['a|2026-11-03']), today: '2026-11-04', ctx });
  assert.deepEqual(t.map((d) => [d.day, d.completed, d.activityPct]), [['2026-11-02', 0, 0], ['2026-11-03', 1, 50], ['2026-11-09', 0, null]]);
});

test('member states: leave beats shoot beats active beats not in yet', () => {
  const date = '2026-11-05';
  const members = [m('leave'), m('shoot'), m('active'), m('logged'), m('away')];
  const states = S.memberStates({
    members,
    date,
    activities: [
      { memberId: 'shoot', entryDate: date, kind: 'shoot', status: 'in_progress' },
      { memberId: 'logged', entryDate: date, kind: 'task', status: 'completed' },
      { memberId: 'leave', entryDate: date, kind: 'task', status: 'completed' },
    ],
    attendanceByEmployee: new Map([['e-active', { status: 'Present', checkInTime: '2026-11-05T04:00:00Z', checkOutTime: '2026-11-05T12:30:00Z' }]]),
    leaves: new Map([['leave', new Set([date])]]),
    employeeOf: (x) => (x._id === 'active' ? 'e-active' : ''),
  });
  assert.equal(states.get('leave').state, 'On Leave');
  assert.equal(states.get('shoot').state, 'On Shoot');
  assert.equal(states.get('active').state, 'Active');
  assert.equal(states.get('active').hours, 8.5);
  assert.equal(states.get('logged').state, 'Active', 'a log is enough to be counted as in');
  assert.equal(states.get('away').state, 'Not in yet');
  assert.deepEqual(S.attendanceSummary(states), { present: 2, onShoot: 1, wfh: 0, onLeave: 1, absent: 1 });
});

test('deadlines: open tasks due today or later, soonest first; overdue are counted apart', () => {
  const tasks = [task('late', { dueDate: '2026-11-01' }), task('b', { dueDate: '2026-11-09' }), task('a', { dueDate: '2026-11-05' }), task('done', { dueDate: '2026-11-06', status: 'completed' }), task('none')];
  assert.deepEqual(S.upcomingDeadlines(tasks, '2026-11-04').map((t) => t._id), ['a', 'b']);
  assert.equal(S.overdueCount(tasks, '2026-11-04'), 1);
});

test('timesheet: minutes per person, per day and per group; the split of the team\'s time', () => {
  const acts = [log('1', { timeSpentMinutes: 90 }), log('2', { timeSpentMinutes: 30, entryDate: '2026-11-04', groupId: 'g2' }), log('3', { memberId: 'b', timeSpentMinutes: 60, groupId: null })];
  const t = S.timesheet({ members: [m('a'), m('b')], activities: acts, groupName });
  assert.equal(t.totalMinutes, 180);
  assert.deepEqual(t.rows[0].byDay, { '2026-11-03': 90, '2026-11-04': 30 });
  assert.equal(t.rows[0].daysLogged, 2);
  assert.deepEqual(t.split.map((s) => [s.group, s.minutes, s.pct]), [['Content', 90, 50], ['Campaigns', 30, 17], ['Others', 60, 33]].sort((x, y) => y[1] - x[1]));
  assert.equal(S.hoursLabel(465), '7h 45m');
  assert.equal(S.hoursLabel(120), '2h');
  assert.equal(S.hoursLabel(45), '45m');
  assert.equal(S.hoursLabel(0), '—');
});

test('performance: completion, on-time and activity rate, averaged over what exists; best first', () => {
  const ctx = { weeklyOff: 0, holidays: new Set(), leaves: new Map() };
  const tasks = [
    task('1', { assigneeId: 'a', status: 'completed', dueDate: '2026-11-05', completedAt: '2026-11-04T05:00:00Z' }),
    task('2', { assigneeId: 'b', status: 'in_progress', dueDate: '2026-11-06' }),
  ];
  const items = S.buildItems({ tasks, activities: [], from: FROM, to: TO });
  const rows = S.performanceRows({ members: [m('b'), m('a')], items, tasks, logged: new Set(['a|2026-11-02']), days: ['2026-11-02', '2026-11-03'], today: '2026-11-03', ctx, from: FROM, to: TO });
  assert.equal(rows[0].memberId, 'a');
  assert.deepEqual([rows[0].completion, rows[0].onTime, rows[0].activityRate, rows[0].overall], [100, 100, 50, 83]);
  assert.deepEqual([rows[1].completion, rows[1].onTime, rows[1].activityRate], [0, null, 0]);
  assert.equal(rows[1].overall, 0, 'the average of what exists: 0 and 0');
});

test('weekly performance: of the tasks due in the week, the % done and the % of those on time', () => {
  const tasks = [
    task('1', { status: 'completed', dueDate: '2026-11-03', completedAt: '2026-11-02T05:00:00Z' }),
    task('2', { status: 'completed', dueDate: '2026-11-03', completedAt: '2026-11-05T05:00:00Z' }),
    task('3', { dueDate: '2026-11-10' }),
  ];
  const w = S.weeklyPerformance({ tasks, from: FROM, to: '2026-11-15' });
  assert.deepEqual(w.map((x) => [x.week, x.tasks, x.completion, x.onTime]), [[1, 2, 100, 50], [2, 1, 0, null]]);
});

test('insights: plain lines, only the ones that apply', () => {
  const lines = S.insights({ completed: 42, previousCompleted: 30, activityPct: 94, pendingBlocked: 2, overdue: 0, nextDeadline: { title: 'Bridal Campaign', dueDate: '2026-11-09' } });
  assert.equal(lines[0], 'Team completed 42 tasks (+40% against the previous period).');
  assert.ok(lines.includes('Overall activity rate is 94%.'));
  assert.ok(lines.includes('2 tasks are pending or blocked.'));
  assert.ok(!lines.some((l) => /overdue/.test(l)));
  assert.ok(lines.includes('Next deadline: Bridal Campaign on 2026-11-09.'));
  const none = S.insights({ completed: 1, previousCompleted: 0, activityPct: null, pendingBlocked: 0, overdue: 2, nextDeadline: null });
  assert.deepEqual(none, ['Team completed 1 task.', 'Nothing is blocked.', '2 tasks are overdue.']);
});

test('the day roll-up: hours from minutes, counts added per activity, notes joined, and the day check', () => {
  const s = sumLogs([
    { timeSpentMinutes: 90, values: [{ metricId: 'm1', value: 2 }, { metricId: 'm2', value: 1 }], workedOn: 'Edited reels', comment: 'two done' },
    { timeSpentMinutes: 45, values: [{ metricId: 'm1', value: 3 }], workedOn: 'Posted stories' },
  ]);
  assert.equal(s.hours, 2.25);
  assert.deepEqual(s.values, [{ metricId: 'm1', value: 5 }, { metricId: 'm2', value: 1 }]);
  assert.equal(s.notes, 'Edited reels — two done\nPosted stories');
  assert.equal(s.checkStatus, 'OK');
  assert.equal(sumLogs([{ timeSpentMinutes: 0, values: [{ metricId: 'm1', value: 2 }], workedOn: 'x' }]).checkStatus, 'WARNING');
  assert.match(sumLogs([{ timeSpentMinutes: 0, values: [], workedOn: 'x' }]).checkMessage, /No hours or counts/);
  assert.equal(sumLogs([{ timeSpentMinutes: 1000, workedOn: 'x' }, { timeSpentMinutes: 600, workedOn: 'y' }]).checkStatus, 'WARNING', 'more than 24 hours');
  assert.equal(sumLogs([]).hours, 0);
});

// ── audit fixes (T1–T10) ──────────────────────────────────────────────────────

test('daily report: the day asked for, else TODAY — never the first day of the range the app sends; monthly = a calendar month', () => {
  const range = { from: '2026-11-01', to: '2026-11-30', today: '2026-11-18' };
  assert.deepEqual(S.reportWindow('daily', range, {}), { from: '2026-11-18', to: '2026-11-18' });
  assert.deepEqual(S.reportWindow('daily', range, { day: '2026-11-05' }), { from: '2026-11-05', to: '2026-11-05' });
  assert.deepEqual(S.reportWindow('daily', range, { day: '2026-02-31' }), { from: '2026-11-18', to: '2026-11-18' }, 'not a real day → today');
  assert.deepEqual(S.reportWindow('monthly', { ...range, from: '2026-11-25', to: '2026-12-02' }, {}), { from: '2026-12-01', to: '2026-12-31' }, 'the month the range ends in');
  assert.deepEqual(S.reportWindow('monthly', range, { month: '2026-02' }), { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual(S.reportWindow('weekly', range, { day: '2026-11-05' }), { from: '2026-11-01', to: '2026-11-30' });
});

test('a log counts under the category chosen, else its biggest count\'s group, else its task\'s group', () => {
  assert.equal(S.pickGroup({ chosen: 'g2', countGroup: 'g1', taskGroup: 'g3' }), 'g2');
  assert.equal(S.pickGroup({ chosen: null, countGroup: 'g1', taskGroup: 'g3' }), 'g1');
  assert.equal(S.pickGroup({ chosen: null, countGroup: null, taskGroup: 'g3' }), 'g3');
  assert.equal(S.pickGroup({}), null);
});

test('a Coordinations request given to a member reads as their task; cancelled or unassigned ones count nowhere', () => {
  const base = { _id: 'r1', title: 'Need a reel', assigneeId: 'a', fromDept: 'Sales', toDept: 'Marketing', dueDate: '2026-11-05', priority: 'high', brand: 'kerala', progress: 40, createdAt: '2026-11-01T05:00:00Z' };
  const as = (status, extra = {}) => S.requestAsTask({ ...base, status, ...extra }, { groupId: 'gc' });
  assert.deepEqual(['open', 'in_progress', 'waiting_input', 'in_review', 'pending_approval', 'completed'].map((st) => as(st, st === 'completed' ? { closedAt: '2026-11-04T06:00:00Z' } : {}).status), ['not_started', 'in_progress', 'pending', 'pending', 'pending', 'completed']);
  assert.equal(as('cancelled'), null);
  assert.equal(S.requestAsTask({ ...base, status: 'open', assigneeId: null }), null);
  const done = as('completed', { closedAt: '2026-11-04T06:00:00Z' });
  assert.deepEqual([done.source, done.groupId, done.progress, done.projectLabel, done.brand], ['request', 'gc', 100, 'Sales → Marketing', 'kerala']);
  // it flows through every task count: completed in the range, on time, by its group
  const items = S.buildItems({ tasks: [done, as('waiting_input', { _id: 'r2' })], activities: [], from: FROM, to: TO });
  assert.deepEqual(S.kpiCounts(items), { completed: 1, inProgress: 0, pendingBlocked: 1 });
  assert.equal(items[0].source, 'request');
  assert.equal(S.onTimeRate({ tasks: [done], from: FROM, to: TO }), 100, 'closed on the 4th, due the 5th');
  assert.deepEqual(S.workloadByGroup(items, (id) => (id === 'gc' ? 'Coordination' : '')).map((w) => w.group), ['Coordination']);
});

test('member states: a work mode set for the day (Office / On Shoot / Work From Home) decides it — after leave', () => {
  const members = [m('a'), m('b'), m('c'), m('d')];
  const states = S.memberStates({
    members,
    date: '2026-11-03',
    activities: [log('l1', { memberId: 'd', kind: 'shoot', status: 'in_progress' })],
    leaves: new Map([['c', new Set(['2026-11-03'])]]),
    modes: new Map([['a', 'wfh'], ['b', 'office'], ['c', 'wfh'], ['d', 'bogus']]),
  });
  assert.deepEqual(['a', 'b', 'c', 'd'].map((id) => [states.get(id).state, states.get(id).workMode]), [['Work From Home', 'wfh'], ['Active', 'office'], ['On Leave', 'on_leave'], ['On Shoot', 'on_shoot']]);
  assert.equal(states.get('a').modeSet, true);
  assert.equal(states.get('c').modeSet, false, 'leave beats the mode set');
  assert.equal(states.get('a').status, 'Set by member');
  assert.deepEqual(S.attendanceSummary(states), { present: 1, onShoot: 1, wfh: 1, onLeave: 1, absent: 0 });
});

test('attendance rate per person: HR present or a work mode set ÷ expected days; nobody tracked → "—", not 0', () => {
  const members = [m('a'), m('b'), m('c')];
  const days = S.eachDay('2026-11-02', '2026-11-08'); // Mon–Sun, Sunday off
  const attended = new Set(['a|2026-11-02', 'a|2026-11-03', 'b|2026-11-02']);
  const r = S.attendanceRates({ members, days, today: '2026-11-04', ctx: { weeklyOff: 0 }, attended, tracked: new Set(['a', 'b']) });
  assert.deepEqual(r.byMember.get('a'), { attended: 2, expected: 3, pct: 67 });
  assert.deepEqual(r.byMember.get('b'), { attended: 1, expected: 3, pct: 33 });
  assert.deepEqual(r.byMember.get('c'), { attended: 0, expected: 0, pct: null });
  assert.equal(r.team, 50, '3 of 6 expected member-days; the untracked member is left out');
  assert.equal(S.attendanceRates({ members, days, today: '2026-11-04', tracked: new Set() }).team, null);
});

test('Team Activity views: by member, by project (CRM project, typed text, none) and by category, most logs first', () => {
  const acts = [
    log('1', { memberId: 'a', projectId: 'p1', projectLabel: 'Bridal', groupId: 'g1', timeSpentMinutes: 30 }),
    log('2', { memberId: 'a', projectLabel: ' Festive ', groupId: 'g2', status: 'in_progress' }),
    log('3', { memberId: 'b', projectLabel: 'festive', groupId: null }),
    log('4', { memberId: 'b', projectLabel: '', groupId: 'g1' }),
  ];
  assert.equal(S.projectKeyOf(acts[0]), 'id:p1');
  assert.equal(S.projectKeyOf(acts[1]), 'label:festive');
  assert.equal(S.projectKeyOf(acts[3]), 'none');
  const v = S.activityBreakdown({ activities: acts, memberName: (id) => id.toUpperCase(), groupName, projectName: (id) => (id === 'p1' ? 'Bridal Campaign' : '') });
  assert.deepEqual(v.byMember.map((r) => [r.label, r.logs, r.minutes, r.completed]), [['B', 2, 120, 2], ['A', 2, 90, 1]], 'ties on logs: more time first');
  assert.deepEqual(v.byProject.map((r) => [r.key, r.label, r.logs]), [['label:festive', 'Festive', 2], ['none', '(no project)', 1], ['id:p1', 'Bridal Campaign', 1]]);
  assert.deepEqual(v.byCategory.map((r) => [r.key, r.label, r.logs]), [['g1', 'Content', 2], ['g2', 'Campaigns', 1], ['others', 'Others', 1]]);
});

test('work summary: per member, what they completed, what is pending and the next priority — newest answers first', () => {
  const acts = [
    log('1', { memberId: 'a', entryDate: '2026-11-02', completed: 'Cut the teaser', pending: 'Colour grade', nextPriority: 'Teaser', loggedAt: '2026-11-02T05:00:00Z' }),
    log('2', { memberId: 'a', entryDate: '2026-11-03', workedOn: 'Posted the reel', completed: '', pending: '', nextPriority: 'Stories', loggedAt: '2026-11-03T05:00:00Z' }),
    log('3', { memberId: 'a', entryDate: '2026-11-03', status: 'in_progress', workedOn: 'Script', loggedAt: '2026-11-03T04:00:00Z' }),
  ];
  const [a, b] = S.workSummary({ members: [m('a'), m('b')], activities: acts });
  assert.deepEqual(a.completed, ['Posted the reel', 'Cut the teaser'], 'a completed log with no answer counts by what it was');
  assert.deepEqual([a.pending, a.nextPriority, a.logs, a.completedCount, a.lastDay], ['Colour grade', 'Stories', 3, 2, '2026-11-03']);
  assert.deepEqual([b.logs, b.pending, b.nextPriority, b.lastDay], [0, '', '', null]);
});

test('activity report: the counts per activity and per group; money is not added into a group\'s count', () => {
  const info = { m1: { name: 'Reels', groupId: 'g1', unitType: 'count' }, m2: { name: 'Stories', groupId: 'g1', unitType: 'count' }, m3: { name: 'Ad spend', groupId: 'g2', unitType: 'currency' } };
  const acts = [
    log('1', { memberId: 'a', values: [{ metricId: 'm1', value: 2 }, { metricId: 'm3', value: 1500 }] }),
    log('2', { memberId: 'b', values: [{ metricId: 'm1', value: 3 }, { metricId: 'm2', value: 4 }] }),
  ];
  const r = S.activityReport({ activities: acts, metricInfo: (id) => info[id], groupName });
  assert.deepEqual(r.rows.map((x) => [x.metric, x.group, x.total, x.logs, x.members]), [['Ad spend', 'Campaigns', 1500, 1, 1], ['Reels', 'Content', 5, 2, 2], ['Stories', 'Content', 4, 1, 1]]);
  assert.deepEqual(r.groups.map((g) => [g.group, g.total]), [['Content', 9], ['Campaigns', 0]]);
});

test('a member\'s weekly trend: their activity rate each week and the share of their tasks due that week that are done', () => {
  const member = m('a');
  const tasks = [task('t1', { dueDate: '2026-11-03', status: 'completed', completedAt: '2026-11-03T05:00:00Z' }), task('t2', { dueDate: '2026-11-04' }), task('t3', { assigneeId: 'b', dueDate: '2026-11-03' })];
  const logged = new Set(['a|2026-11-02', 'a|2026-11-03']);
  const t = S.memberWeeklyTrend({ member, tasks, logged, from: '2026-11-02', to: '2026-11-15', today: '2026-11-04', ctx: { weeklyOff: 0 } });
  assert.deepEqual(t.map((w) => [w.week, w.activityPct, w.completion]), [[1, 67, 50], [2, null, null]], 'week 2 is still to come and nothing is due in it');
});
