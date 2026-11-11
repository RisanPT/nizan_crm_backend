// Pure unit tests: node --test tests/monthlyObjectives.test.js tests/monthlyObjectiveAccess.test.js
// Monthly objectives per department: months, input, key-result merging, summaries, carry-over, reminders, and who may do what.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  istMonthOf, prevMonth, nextMonth, compareMonth, monthKey, monthLabel, parseMonth,
  validateObjectiveInput, mergeKeyResults, validateCheckIn, progressOf, summarize,
  hasWorkLeft, carryOverPlan, reminderPlan, reminderText, MAX_KEY_RESULTS,
  addMonths, monthsBetween, spanInfo, buildSpan, suggestedResult, planChanges, RESULTS, KR_KINDS, isReadyToClose,
  trendMonths, trendSeries,
} from '../utils/monthlyObjectives.js';
import { canViewDepartment, canManageDepartment, rightsFor, mayAddToMonth } from '../utils/monthlyObjectiveAccess.js';

// ── months ──────────────────────────────────────────────────────────────────

test('the IST month: the company runs on Indian time, not the server\'s', () => {
  assert.deepEqual(istMonthOf(new Date('2026-11-09T10:00:00Z')), { year: 2026, month: 11 });
  // 18:40 UTC on 30 Nov is already 00:10 on 1 Dec in India
  assert.deepEqual(istMonthOf(new Date('2026-11-30T18:40:00Z')), { year: 2026, month: 12 });
  assert.deepEqual(istMonthOf(new Date('2026-11-30T18:29:00Z')), { year: 2026, month: 11 });
  assert.deepEqual(istMonthOf(new Date('2026-12-31T19:00:00Z')), { year: 2027, month: 1 });
});

test('the month before and after, over a year end', () => {
  assert.deepEqual(prevMonth({ year: 2026, month: 1 }), { year: 2025, month: 12 });
  assert.deepEqual(prevMonth({ year: 2026, month: 7 }), { year: 2026, month: 6 });
  assert.deepEqual(nextMonth({ year: 2026, month: 12 }), { year: 2027, month: 1 });
  assert.deepEqual(nextMonth({ year: 2026, month: 3 }), { year: 2026, month: 4 });
  assert.ok(compareMonth({ year: 2026, month: 11 }, { year: 2026, month: 12 }) < 0);
  assert.ok(compareMonth({ year: 2027, month: 1 }, { year: 2026, month: 12 }) > 0);
  assert.equal(compareMonth({ year: 2026, month: 5 }, { year: 2026, month: 5 }), 0);
});

test('a month has a stable date to dedupe by, and a label', () => {
  assert.equal(monthKey({ year: 2026, month: 11 }).toISOString(), '2026-11-01T00:00:00.000Z');
  assert.equal(monthLabel({ year: 2026, month: 11 }), 'November 2026');
});

test('year and month from a request: blank means now (IST); nonsense is refused', () => {
  const now = new Date('2026-11-09T10:00:00Z');
  assert.deepEqual(parseMonth(undefined, undefined, now), { ok: true, value: { year: 2026, month: 11 } });
  assert.deepEqual(parseMonth('2027', '3', now), { ok: true, value: { year: 2027, month: 3 } });
  assert.deepEqual(parseMonth('', '', now).value, { year: 2026, month: 11 });
  for (const [y, m] of [[2026, 0], [2026, 13], [2026, 1.5], [1999, 5], [2101, 5], ['abc', 5], [2026, 'x']]) assert.equal(parseMonth(y, m, now).ok, false, `${y}/${m}`);
});

// ── input ───────────────────────────────────────────────────────────────────

const kr = (over = {}) => ({ title: 'Bookings', targetValue: 40, unit: 'bookings', ...over });

test('a good objective: trimmed, priority lower-cased, key results cleaned', () => {
  const r = validateObjectiveInput({ objective: '  Win more brides ', description: 'x', priority: 'HIGH', ownerId: ' e1 ', keyResults: [kr({ title: ' Bookings ', currentValue: '12.5' })] });
  assert.equal(r.ok, true);
  assert.equal(r.value.objective, 'Win more brides');
  assert.equal(r.value.priority, 'high');
  assert.equal(r.value.ownerId, 'e1');
  assert.equal(r.value.keyResults[0].title, 'Bookings');
  assert.equal(r.value.keyResults[0].currentValue, 12.5);
  assert.equal(r.value.keyResults[0].targetValue, 40);
});

test('what is refused, with a message a person can act on', () => {
  const bad = (body, re) => {
    const r = validateObjectiveInput(body);
    assert.equal(r.ok, false);
    assert.match(r.message, re);
  };
  bad({}, /title/);
  bad({ objective: '   ' }, /title/);
  bad({ objective: 'x'.repeat(201) }, /too long/);
  bad({ objective: 'a', priority: 'urgent' }, /Priority/);
  bad({ objective: 'a', description: 'x'.repeat(2001) }, /description/);
  bad({ objective: 'a', keyResults: 'nope' }, /list/);
  bad({ objective: 'a', keyResults: [kr({ title: '' })] }, /Key result 1 needs a title/);
  bad({ objective: 'a', keyResults: [kr(), kr({ targetValue: 0 })] }, /Key result 2 needs a target above zero/);
  bad({ objective: 'a', keyResults: [kr({ targetValue: 'abc' })] }, /target/);
  bad({ objective: 'a', keyResults: [kr({ targetValue: -3 })] }, /target/);
  bad({ objective: 'a', keyResults: [kr({ currentValue: -1 })] }, /negative/);
  bad({ objective: 'a', keyResults: Array.from({ length: MAX_KEY_RESULTS + 1 }, () => kr()) }, new RegExp(`${MAX_KEY_RESULTS} key results at most`));
});

test('an objective with no key results is allowed (add them as the month takes shape)', () => {
  assert.equal(validateObjectiveInput({ objective: 'Hire a trainer' }).ok, true);
  assert.deepEqual(validateObjectiveInput({ objective: 'x', keyResults: [] }).value.keyResults, []);
});

test('eight key results are the most an objective can have', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ title: `KR ${i + 1}`, targetValue: 10 }));
  assert.equal(validateObjectiveInput({ objective: 'x', keyResults: many(8) }).ok, true);
  const nine = validateObjectiveInput({ objective: 'x', keyResults: many(9) });
  assert.equal(nine.ok, false);
  assert.match(nine.message, /8 key results at most/);
});

test('an edit checks only what it sends', () => {
  assert.deepEqual(validateObjectiveInput({ priority: 'low' }, { partial: true }), { ok: true, value: { priority: 'low' } });
  assert.equal(validateObjectiveInput({ objective: '' }, { partial: true }).ok, false); // sent but blank
  assert.deepEqual(validateObjectiveInput({}, { partial: true }), { ok: true, value: {} });
});

// ── key results kept across an edit ─────────────────────────────────────────

const stored = [
  { id: 'a', title: 'Bookings', targetValue: 40, currentValue: 25, unit: '', completed: false, checkIns: [{ value: 25 }] },
  { id: 'b', title: 'Reviews', targetValue: 10, currentValue: 10, unit: '', completed: true, checkIns: [] },
];

test('editing keeps a key result\'s id, check-ins and current value; a new one gets an id; one left out goes', () => {
  const incoming = validateObjectiveInput({
    objective: 'x',
    keyResults: [{ id: 'a', title: 'Bookings (renamed)', targetValue: 50 }, { title: 'Referrals', targetValue: 5 }],
  }).value.keyResults;
  const merged = mergeKeyResults(stored, incoming);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, 'a');
  assert.equal(merged[0].title, 'Bookings (renamed)');
  assert.equal(merged[0].targetValue, 50);
  assert.equal(merged[0].currentValue, 25); // not reset by the edit
  assert.deepEqual(merged[0].checkIns, [{ value: 25 }]);
  assert.notEqual(merged[1].id, '');
  assert.equal(merged[1].currentValue, 0);
  assert.deepEqual(merged[1].checkIns, []);
  assert.ok(!merged.some((k) => k.id === 'b')); // left out: removed
});

test('…unless the form sent a current value of its own', () => {
  const incoming = validateObjectiveInput({ objective: 'x', keyResults: [{ id: 'a', title: 'Bookings', targetValue: 40, currentValue: 31 }] }).value.keyResults;
  assert.equal(mergeKeyResults(stored, incoming)[0].currentValue, 31);
});

test('a key result that was done stays done through an edit; an id the object never had is a new key result', () => {
  const incoming = validateObjectiveInput({ objective: 'x', keyResults: [{ id: 'b', title: 'Reviews', targetValue: 10 }, { id: 'ghost', title: 'New', targetValue: 3 }] }).value.keyResults;
  const merged = mergeKeyResults(stored, incoming);
  assert.equal(merged[0].completed, true);
  assert.notEqual(merged[1].id, 'ghost');
});

// ── check-ins ───────────────────────────────────────────────────────────────

test('a check-in sets the current value; reaching the target is done', () => {
  const k = { targetValue: 40, currentValue: 25, completed: false };
  assert.deepEqual(validateCheckIn({ value: 30 }, k), { ok: true, value: { currentValue: 30, completed: false } });
  assert.deepEqual(validateCheckIn({ value: 40 }, k).value, { currentValue: 40, completed: true });
  assert.deepEqual(validateCheckIn({ value: 55 }, k).value, { currentValue: 55, completed: true });
  assert.deepEqual(validateCheckIn({ value: '12.345' }, k).value.currentValue, 12.35);
});

test('"done" can be ticked without a number, and un-ticked', () => {
  const k = { targetValue: 40, currentValue: 25, completed: false };
  assert.deepEqual(validateCheckIn({ completed: true }, k).value, { currentValue: 25, completed: true });
  assert.deepEqual(validateCheckIn({ completed: false }, { ...k, completed: true }).value, { currentValue: 25, completed: false });
  // a value under target with an explicit "not done" stays open
  assert.equal(validateCheckIn({ value: 45, completed: false }, k).value.completed, false);
});

test('a check-in with nothing in it, or a negative number, is refused', () => {
  const k = { targetValue: 40, currentValue: 25 };
  assert.equal(validateCheckIn({}, k).ok, false);
  assert.equal(validateCheckIn({ value: -1 }, k).ok, false);
  assert.equal(validateCheckIn({ value: 'abc' }, k).ok, false);
});

// ── progress and summaries ──────────────────────────────────────────────────

test('progress is the key results\' average; none means none', () => {
  assert.equal(progressOf({ keyResults: [] }), 0);
  assert.equal(progressOf({}), 0);
  assert.equal(progressOf({ keyResults: [{ targetValue: 40, currentValue: 20 }, { targetValue: 10, currentValue: 10 }] }), 75);
  assert.equal(progressOf({ keyResults: [{ targetValue: 10, currentValue: 30 }] }), 100); // over target counts as 100, no more
  assert.equal(progressOf({ keyResults: [{ targetValue: 10, currentValue: 0, completed: true }] }), 100);
});

test('a department\'s month at a glance', () => {
  const objectives = [
    { keyResults: [{ targetValue: 10, currentValue: 10 }], result: 'achieved' },
    { keyResults: [{ targetValue: 10, currentValue: 5 }], result: 'partly' },
    { keyResults: [{ targetValue: 10, currentValue: 0 }], result: 'missed' },
    { keyResults: [{ targetValue: 10, currentValue: 5 }] }, // still open
  ];
  const none = { continued: 0, cancelled: 0, deferred: 0 };
  assert.deepEqual(summarize(objectives), { count: 4, avgProgress: 50, open: 1, closed: 3, achieved: 1, partly: 1, missed: 1, ...none });
  assert.deepEqual(summarize([]), { count: 0, avgProgress: 0, open: 0, closed: 0, achieved: 0, partly: 0, missed: 0, ...none });
  assert.equal(summarize(undefined).count, 0);
});

// ── carrying over ───────────────────────────────────────────────────────────

const obj = (over = {}) => ({
  _id: 'o1', objective: 'Win brides', description: 'd', ownerId: 'e1', ownerName: 'Amna', priority: 'high',
  keyResults: [{ id: 'k1', title: 'Bookings', targetValue: 40, currentValue: 25, unit: 'b' }, { id: 'k2', title: 'Reviews', targetValue: 10, currentValue: 10, completed: true }],
  ...over,
});

test('what is left to do', () => {
  assert.equal(hasWorkLeft(obj()), true);
  assert.equal(hasWorkLeft(obj({ result: 'achieved' })), false);
  assert.equal(hasWorkLeft(obj({ keyResults: [{ targetValue: 10, currentValue: 10 }] })), false); // every key result done
  assert.equal(hasWorkLeft(obj({ keyResults: [] })), true); // no key results: nothing says it is done
  assert.equal(hasWorkLeft(obj({ result: 'missed' })), true);
  assert.equal(hasWorkLeft(obj({ result: 'partly' })), true);
});

test('carrying over takes what is LEFT of each unfinished key result, from zero, and drops the finished ones', () => {
  const { items, skipped } = carryOverPlan([obj()]);
  assert.equal(skipped.length, 0);
  assert.equal(items.length, 1);
  const c = items[0];
  assert.equal(c.fromId, 'o1');
  assert.equal(c.objective, 'Win brides');
  assert.equal(c.ownerId, 'e1');
  assert.equal(c.priority, 'high');
  assert.equal(c.keyResults.length, 1); // "Reviews" was done
  assert.equal(c.keyResults[0].title, 'Bookings');
  assert.equal(c.keyResults[0].targetValue, 15); // 40 − 25
  assert.equal(c.keyResults[0].currentValue, 0);
  assert.deepEqual(c.keyResults[0].checkIns, []);
  assert.notEqual(c.keyResults[0].id, 'k1'); // its own key result, not the old one
});

test('achieved, finished and already-carried objectives are not carried; and why', () => {
  const { items, skipped } = carryOverPlan([
    obj({ _id: 'a', result: 'achieved' }),
    obj({ _id: 'b', keyResults: [{ targetValue: 5, currentValue: 5 }] }),
    obj({ _id: 'c', carriedToId: 'x' }),
    obj({ _id: 'd', result: 'missed' }),
  ]);
  assert.deepEqual(items.map((i) => i.fromId), ['d']);
  assert.deepEqual(skipped, [
    { id: 'a', reason: 'achieved' },
    { id: 'b', reason: 'nothing left' },
    { id: 'c', reason: 'already carried over' },
  ]);
});

test('an objective with no key results carries as it is', () => {
  const { items } = carryOverPlan([obj({ keyResults: [] })]);
  assert.deepEqual(items[0].keyResults, []);
});

test('a key result whose remainder rounds to nothing still has a target above zero', () => {
  const { items } = carryOverPlan([obj({ keyResults: [{ title: 'x', targetValue: 10, currentValue: 9.999 }] })]);
  assert.ok(items[0].keyResults[0].targetValue > 0);
});

// ── reminders ───────────────────────────────────────────────────────────────

const dept = (id, name, heads) => ({ id, name, headUserIds: heads });

test('a head is told about a department with nothing set this month, and one with last month still open', () => {
  const plan = reminderPlan({
    departments: [dept('d1', 'IT', ['u1']), dept('d2', 'HR', ['u2']), dept('d3', 'Sales', ['u3'])],
    thisMonth: new Map([['d2', 3]]), // HR has set its month
    lastMonth: new Map([['d2', { count: 3, open: 2 }], ['d3', { count: 4, open: 0 }]]),
  });
  assert.deepEqual(plan, [
    { userId: 'u1', set: ['IT'], close: [] },
    { userId: 'u2', set: [], close: ['HR'] }, // set already, but last month is not closed
    { userId: 'u3', set: ['Sales'], close: [] }, // last month fully closed: nothing to close
  ]);
});

test('a department with nothing to do, or no head, produces no reminder', () => {
  assert.deepEqual(reminderPlan({ departments: [dept('d1', 'IT', ['u1'])], thisMonth: new Map([['d1', 2]]), lastMonth: new Map([['d1', { count: 2, open: 0 }]]) }), []);
  assert.deepEqual(reminderPlan({ departments: [dept('d1', 'Artist', [])], thisMonth: new Map(), lastMonth: new Map() }), []);
});

test('last month with no objectives at all is nothing to close', () => {
  assert.deepEqual(reminderPlan({ departments: [dept('d1', 'IT', ['u1'])], thisMonth: new Map([['d1', 1]]), lastMonth: new Map([['d1', { count: 0, open: 0 }]]) }), []);
});

test('someone who leads two departments gets ONE message of each kind, naming both', () => {
  const plan = reminderPlan({
    departments: [dept('d1', 'IT', ['u1']), dept('d2', 'HR', ['u1'])],
    thisMonth: new Map(),
    lastMonth: new Map([['d1', { count: 1, open: 1 }]]),
  });
  assert.equal(plan.length, 1);
  assert.deepEqual(plan[0], { userId: 'u1', set: ['HR', 'IT'], close: ['IT'] });
});

test('a department two people lead tells both', () => {
  const plan = reminderPlan({ departments: [dept('d1', 'IT', ['u1', 'u2'])], thisMonth: new Map(), lastMonth: new Map() });
  assert.deepEqual(plan.map((p) => p.userId), ['u1', 'u2']);
});

test('the wording names the month and the departments', () => {
  const nov = { year: 2026, month: 11 };
  assert.deepEqual(reminderText('set', ['IT'], nov), { title: "Set November 2026's objectives", body: 'IT has no objectives for November 2026 yet. Add them so the month starts with a plan.' });
  assert.match(reminderText('set', ['HR', 'IT'], nov).body, /^HR and IT have no objectives/);
  assert.match(reminderText('set', ['A', 'B', 'C'], nov).body, /^A, B and C have no objectives/);
  assert.equal(reminderText('close', ['IT'], nov).title, 'Close out November 2026');
  assert.match(reminderText('close', ['IT'], nov).body, /still has November 2026 objectives open/);
  assert.match(reminderText('close', ['IT', 'HR'], nov).body, /still have/);
});

// ── who may do what ─────────────────────────────────────────────────────────

const who = (over = {}) => ({ full: false, viewOnly: false, employeeId: 'emp1', headDeptIds: new Set(), memberDeptIds: new Set(), ...over });

test('a department\'s head manages it and sees it; its members see it; nobody else does', () => {
  const head = who({ headDeptIds: new Set(['d1']), memberDeptIds: new Set(['d1']) });
  const member = who({ memberDeptIds: new Set(['d1']) });
  const outsider = who({ memberDeptIds: new Set(['d2']) });
  assert.equal(canViewDepartment(head, 'd1'), true);
  assert.equal(canManageDepartment(head, 'd1'), true);
  assert.equal(canViewDepartment(member, 'd1'), true);
  assert.equal(canManageDepartment(member, 'd1'), false);
  assert.equal(canViewDepartment(outsider, 'd1'), false);
  assert.equal(canManageDepartment(outsider, 'd1'), false);
});

test('a head of one department does not manage another', () => {
  const head = who({ headDeptIds: new Set(['d1']), memberDeptIds: new Set(['d1']) });
  assert.equal(canManageDepartment(head, 'd2'), false);
  assert.equal(canViewDepartment(head, 'd2'), false);
});

test('someone who leads two departments manages both', () => {
  const head = who({ headDeptIds: new Set(['d1', 'd2']) });
  assert.equal(canManageDepartment(head, 'd1'), true);
  assert.equal(canManageDepartment(head, 'd2'), true);
});

test('full access sees and manages every department; the CEO sees every department and changes none', () => {
  assert.equal(canViewDepartment(who({ full: true }), 'dX'), true);
  assert.equal(canManageDepartment(who({ full: true }), 'dX'), true);
  const ceo = who({ full: true, viewOnly: true });
  assert.equal(canViewDepartment(ceo, 'dX'), true);
  assert.equal(canManageDepartment(ceo, 'dX'), false);
  assert.deepEqual(rightsFor(ceo, { departmentId: 'dX', ownerId: 'emp1' }), { canManage: false, canCheckIn: false });
});

test('an objective\'s owner may report progress on it, but not rewrite it', () => {
  const member = who({ memberDeptIds: new Set(['d1']), employeeId: 'emp9' });
  assert.deepEqual(rightsFor(member, { departmentId: 'd1', ownerId: 'emp9' }), { canManage: false, canCheckIn: true });
  assert.deepEqual(rightsFor(member, { departmentId: 'd1', ownerId: 'emp2' }), { canManage: false, canCheckIn: false });
  assert.deepEqual(rightsFor(member, { departmentId: 'd1', ownerId: null }), { canManage: false, canCheckIn: false });
  assert.deepEqual(rightsFor(who({ headDeptIds: new Set(['d1']) }), { departmentId: 'd1', ownerId: 'someone' }), { canManage: true, canCheckIn: true });
});

test('past months are history: a head plans this month and ahead; only full access adds to a past one', () => {
  const now = { year: 2026, month: 11 };
  const head = who({ headDeptIds: new Set(['d1']) });
  assert.equal(mayAddToMonth(head, { year: 2026, month: 11 }, now), true);
  assert.equal(mayAddToMonth(head, { year: 2026, month: 12 }, now), true);
  assert.equal(mayAddToMonth(head, { year: 2027, month: 2 }, now), true);
  assert.equal(mayAddToMonth(head, { year: 2026, month: 10 }, now), false);
  assert.equal(mayAddToMonth(head, { year: 2025, month: 12 }, now), false);
  assert.equal(mayAddToMonth(who({ full: true }), { year: 2026, month: 10 }, now), true);
});

// ── what is not a number to reach ───────────────────────────────────────────

test('a percentage is out of 100 and a yes/no is done or not: neither takes a target from the form', () => {
  const pct = validateObjectiveInput({ objective: 'x', keyResults: [{ title: 'Automation built', kind: 'percent', targetValue: 7, unit: 'pages', currentValue: 60 }] }).value.keyResults[0];
  assert.deepEqual([pct.kind, pct.targetValue, pct.unit, pct.currentValue], ['percent', 100, '%', 60]);
  const yn = validateObjectiveInput({ objective: 'x', keyResults: [{ title: 'Launched', kind: 'yesno', targetValue: 9, unit: 'x' }] }).value.keyResults[0];
  assert.deepEqual([yn.kind, yn.targetValue, yn.unit, yn.currentValue, yn.completed], ['yesno', 1, '', 0, false]);
  // an older key result, or one that does not say, is a number — as it always was
  assert.equal(validateObjectiveInput({ objective: 'x', keyResults: [{ title: 'k', targetValue: 5 }] }).value.keyResults[0].kind, 'number');
  assert.deepEqual(KR_KINDS, ['number', 'percent', 'yesno']);
});

test('a key result of an unknown kind, a number without a target, or a percentage over 100 is refused', () => {
  const bad = (kr, re) => {
    const r = validateObjectiveInput({ objective: 'x', keyResults: [kr] });
    assert.equal(r.ok, false);
    assert.match(r.message, re);
  };
  bad({ title: 'k', kind: 'ratio', targetValue: 5 }, /type must be/);
  bad({ title: 'k', kind: 'number' }, /target above zero/);
  bad({ title: 'k', kind: 'percent', currentValue: 120 }, /cannot be above 100/);
  assert.equal(validateObjectiveInput({ objective: 'x', keyResults: [{ title: 'k', kind: 'yesno' }] }).ok, true); // no target needed
});

test('a yes/no key result is done by ticking it, never by a number; a percentage stops at 100', () => {
  const yn = { kind: 'yesno', targetValue: 1, currentValue: 0 };
  assert.deepEqual(validateCheckIn({ completed: true }, yn).value, { currentValue: 1, completed: true });
  assert.deepEqual(validateCheckIn({ completed: false }, { ...yn, currentValue: 1, completed: true }).value, { currentValue: 0, completed: false });
  assert.equal(validateCheckIn({ value: 1 }, yn).ok, false); // a number tells nothing here
  const pct = { kind: 'percent', targetValue: 100, currentValue: 40 };
  assert.deepEqual(validateCheckIn({ value: 100 }, pct).value, { currentValue: 100, completed: true });
  assert.deepEqual(validateCheckIn({ value: 65 }, pct).value, { currentValue: 65, completed: false });
  assert.match(validateCheckIn({ value: 130 }, pct).message, /above 100/);
});

test('changing a key result\'s kind starts it afresh (20 bookings is not 20%), keeping its id and history', () => {
  const existing = [{ id: 'a', title: 'Bookings', kind: 'number', targetValue: 40, currentValue: 20, completed: false, checkIns: [{ value: 20 }] }];
  const incoming = validateObjectiveInput({ objective: 'x', keyResults: [{ id: 'a', title: 'Bookings', kind: 'yesno' }] }).value.keyResults;
  const [k] = mergeKeyResults(existing, incoming);
  assert.deepEqual([k.id, k.kind, k.currentValue, k.completed, k.checkIns.length], ['a', 'yesno', 0, false, 1]);
});

test('a yes/no key result counts as 0 or 100 in the progress', () => {
  assert.equal(progressOf({ keyResults: [{ kind: 'yesno', targetValue: 1, currentValue: 0 }] }), 0);
  assert.equal(progressOf({ keyResults: [{ kind: 'yesno', targetValue: 1, currentValue: 1, completed: true }] }), 100);
  assert.equal(progressOf({ keyResults: [{ kind: 'percent', targetValue: 100, currentValue: 60 }, { kind: 'yesno', targetValue: 1, currentValue: 0 }] }), 30);
});

// ── a result that differs from the progress ─────────────────────────────────

test('the result the progress points to: done is achieved, half way partly, less missed; no key results, no suggestion', () => {
  const at = (cur) => ({ keyResults: [{ targetValue: 100, currentValue: cur }] });
  assert.equal(suggestedResult(at(100)), 'achieved');
  assert.equal(suggestedResult(at(99)), 'partly');
  assert.equal(suggestedResult(at(50)), 'partly');
  assert.equal(suggestedResult(at(49)), 'missed');
  assert.equal(suggestedResult({ keyResults: [] }), null);
  assert.equal(suggestedResult({}), null);
});

test('the results an objective can end in', () => {
  assert.deepEqual(RESULTS, ['achieved', 'partly', 'missed', 'continued', 'cancelled', 'deferred']);
});

// ── several months ──────────────────────────────────────────────────────────

test('month arithmetic over a year end', () => {
  assert.deepEqual(addMonths({ year: 2026, month: 11 }, 3), { year: 2027, month: 2 });
  assert.deepEqual(addMonths({ year: 2026, month: 12 }, 1), { year: 2027, month: 1 });
  assert.deepEqual(addMonths({ year: 2026, month: 3 }, 0), { year: 2026, month: 3 });
  assert.equal(monthsBetween({ year: 2026, month: 11 }, { year: 2027, month: 2 }), 3);
  assert.equal(monthsBetween({ year: 2027, month: 2 }, { year: 2026, month: 11 }), -3);
});

test('a span: three months from November is November to January; one month (or none) is no span', () => {
  assert.deepEqual(buildSpan({ year: 2026, month: 11 }, 3, null).value, { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 });
  assert.equal(buildSpan({ year: 2026, month: 11 }, 1, null).value, null);
  assert.equal(buildSpan({ year: 2026, month: 11 }, undefined, null).value, null);
  // a carried one keeps its own beginning: month 2 of a 3-month run, asked for 4 in all, ends in month 4 counted from the start
  const existing = { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 };
  assert.deepEqual(buildSpan({ year: 2026, month: 12 }, 4, existing).value, { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 2 });
  assert.match(buildSpan({ year: 2027, month: 3 }, 2, existing).error, /before/); // would finish before this month
});

test('where an objective is in its run', () => {
  const span = { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 };
  assert.equal(spanInfo({ year: 2026, month: 11 }), null); // ordinary
  assert.deepEqual(spanInfo({ year: 2026, month: 11, span }), { number: 1, total: 3, final: false, overran: false });
  assert.deepEqual(spanInfo({ year: 2027, month: 1, span }), { number: 3, total: 3, final: true, overran: false });
  assert.deepEqual(spanInfo({ year: 2027, month: 2, span }), { number: 4, total: 3, final: true, overran: true });
});

test('a month that is not the last of a run ends as "continues" unless the work is done', () => {
  const span = { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 };
  const at = (cur, month, year = 2026) => ({ year, month, span, keyResults: [{ targetValue: 100, currentValue: cur }] });
  assert.equal(suggestedResult(at(30, 11)), 'continued');
  assert.equal(suggestedResult(at(30, 12)), 'continued');
  assert.equal(suggestedResult(at(100, 11)), 'achieved'); // finished early
  assert.equal(suggestedResult(at(70, 1, 2027)), 'partly'); // the last planned month is scored like any other
  assert.equal(suggestedResult(at(20, 1, 2027)), 'missed');
});

test('a several-month objective carries ALL its key results with their running totals, and keeps its run', () => {
  const span = { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 };
  const o = obj({ span, year: 2026, month: 11, result: 'continued' });
  const [item] = carryOverPlan([o]).items;
  assert.deepEqual(item.span, span);
  assert.equal(item.keyResults.length, 2); // the finished one stays, so the objective's progress holds
  const [a, b] = item.keyResults;
  assert.deepEqual([a.targetValue, a.currentValue, a.completed], [40, 25, false]); // not "15 left": the total runs on
  assert.deepEqual([b.targetValue, b.currentValue, b.completed], [10, 10, true]);
  assert.notEqual(a.id, 'k1'); // fresh ids for the new month's key results
  assert.equal(progressOf({ keyResults: item.keyResults }), progressOf(o)); // nothing lost in the move
});

// ── kinds when carried ──────────────────────────────────────────────────────

test('carried over: a number keeps only what is left, a percentage carries on from where it got to, a yes/no is still not done', () => {
  const o = obj({
    keyResults: [
      { id: 'n', title: 'Bookings', kind: 'number', targetValue: 40, currentValue: 25 },
      { id: 'p', title: 'Automation built', kind: 'percent', targetValue: 100, currentValue: 60, unit: '%' },
      { id: 'y', title: 'Launched', kind: 'yesno', targetValue: 1, currentValue: 0 },
      { id: 'd', title: 'Done', kind: 'yesno', targetValue: 1, currentValue: 1, completed: true },
    ],
  });
  const [item] = carryOverPlan([o]).items;
  assert.equal(item.span, null);
  assert.deepEqual(item.keyResults.map((k) => [k.title, k.kind, k.targetValue, k.currentValue, k.completed]), [
    ['Bookings', 'number', 15, 0, false],
    ['Automation built', 'percent', 100, 60, false],
    ['Launched', 'yesno', 1, 0, false],
  ]);
});

// ── cancelled, postponed ────────────────────────────────────────────────────

test('a cancelled objective has nothing left and is not carried (and says why); a postponed one is carried', () => {
  assert.equal(hasWorkLeft(obj({ result: 'cancelled' })), false);
  assert.equal(hasWorkLeft(obj({ result: 'deferred' })), true);
  assert.equal(hasWorkLeft(obj({ result: 'continued' })), true);
  const plan = carryOverPlan([obj({ _id: 'c', result: 'cancelled' }), obj({ _id: 'd', result: 'deferred' })]);
  assert.deepEqual(plan.skipped, [{ id: 'c', reason: 'cancelled' }]);
  assert.deepEqual(plan.items.map((i) => i.fromId), ['d']);
});

test('a cancelled or postponed objective is no longer the month\'s plan: it stays out of the average but is still counted', () => {
  const live = { keyResults: [{ targetValue: 10, currentValue: 10 }] }; // 100%
  const dropped = { keyResults: [{ targetValue: 10, currentValue: 0 }], result: 'cancelled' }; // would have dragged it to 50%
  const later = { keyResults: [{ targetValue: 10, currentValue: 0 }], result: 'deferred' };
  const s = summarize([live, dropped, later, { keyResults: [{ targetValue: 10, currentValue: 5 }], result: 'continued' }]);
  assert.equal(s.count, 4);
  assert.equal(s.avgProgress, 75); // (100 + 50) / 2: the live one and the continuing one
  assert.deepEqual([s.cancelled, s.deferred, s.continued, s.closed, s.open], [1, 1, 1, 3, 1]);
  assert.equal(summarize([dropped, later]).avgProgress, 0);
});

// ── the plan changing ───────────────────────────────────────────────────────

test('what counts as a change of plan: the title, key results added / removed, their name, type and target — not the details', () => {
  const before = { objective: 'Win brides', keyResults: [
    { id: 'a', title: 'Bookings', kind: 'number', targetValue: 40 },
    { id: 'b', title: 'Reviews', kind: 'number', targetValue: 10 },
    { id: 'c', title: 'Launch', kind: 'number', targetValue: 5 },
  ] };
  const after = { objective: 'Win more brides', keyResults: [
    { id: 'a', title: 'Bookings', kind: 'number', targetValue: 30 },
    { id: 'c', title: 'Launch day', kind: 'yesno', targetValue: 1 },
    { id: 'n', title: 'Referrals', kind: 'number', targetValue: 8 },
  ] };
  assert.deepEqual(planChanges(before, after), [
    'Title: “Win brides” → “Win more brides”',
    '“Bookings” target 40 → 30',
    'Key result “Launch” renamed “Launch day”',
    '“Launch day” changed from number to yes/no',
    'Added key result “Referrals”',
    'Removed key result “Reviews”',
  ]);
  assert.deepEqual(planChanges(before, { objective: 'Win brides' }), []);
  assert.deepEqual(planChanges(before, {}), []);
  assert.deepEqual(planChanges(before, { keyResults: before.keyResults }), []);
});

test('only a number has a target to change: a percentage or yes/no whose target is fixed is not a change', () => {
  const a = { objective: 'x', keyResults: [{ id: 'p', title: 'P', kind: 'percent', targetValue: 100 }] };
  assert.deepEqual(planChanges(a, { keyResults: [{ id: 'p', title: 'P', kind: 'percent', targetValue: 100 }] }), []);
});

test('how long a several-month objective runs is 2 to 24 months', () => {
  assert.equal(validateObjectiveInput({ objective: 'x', spanMonths: 3 }).value.spanMonths, 3);
  assert.equal(validateObjectiveInput({ objective: 'x', spanMonths: null }).value.spanMonths, 1);
  assert.equal(validateObjectiveInput({ objective: 'x', spanMonths: 24 }).ok, true);
  assert.equal(validateObjectiveInput({ objective: 'x', spanMonths: 25 }).ok, false);
  assert.equal(validateObjectiveInput({ objective: 'x', spanMonths: 0 }).ok, false);
  assert.equal(validateObjectiveInput({ objective: 'x', spanMonths: 2.5 }).ok, false);
  assert.equal(validateObjectiveInput({ spanMonths: 4 }, { partial: true }).value.spanMonths, 4);
});

// ── when a key result is done ───────────────────────────────────────────────

const STAMP = { at: new Date('2026-11-10T10:00:00Z'), by: 'u1', byName: 'Ishaan' };
const edit = (existing, kr, stamp = STAMP) =>
  mergeKeyResults(existing, validateObjectiveInput({ objective: 'x', keyResults: [kr] }).value.keyResults, stamp)[0];
const done40 = { id: 'a', title: 'Bookings', kind: 'number', targetValue: 40, currentValue: 40, completed: true, completedAt: new Date('2026-11-04T08:00:00Z'), completedBy: 'u9', completedByName: 'Irfan', checkIns: [] };

test('raising a number\'s target past what was reached opens it again — it must not show 100% at 40 of 60', () => {
  const k = edit([done40], { id: 'a', title: 'Bookings', targetValue: 60 });
  assert.deepEqual([k.targetValue, k.currentValue, k.completed], [60, 40, false]);
  assert.deepEqual([k.completedAt, k.completedBy, k.completedByName], [null, null, '']); // no longer finished: no stamp
  assert.equal(progressOf({ keyResults: [k] }), 67);
});

test('lowering the target to what was reached finishes it, stamped with whoever changed the plan', () => {
  const open = { ...done40, targetValue: 60, completed: false, completedAt: null, completedBy: null, completedByName: '' };
  const k = edit([open], { id: 'a', title: 'Bookings', targetValue: 40 });
  assert.deepEqual([k.completed, k.completedByName, k.completedAt], [true, 'Ishaan', STAMP.at]);
});

test('a key result ticked done under its target stays done and keeps its stamp when nothing about its target changed', () => {
  const ticked = { ...done40, currentValue: 10 }; // done at 10 of 40, ticked by Irfan
  const k = edit([ticked], { id: 'a', title: 'Bookings (renamed)', targetValue: 40 });
  assert.deepEqual([k.completed, k.completedByName, k.completedAt], [true, 'Irfan', ticked.completedAt]);
});

test('a yes/no, whose target never moves, keeps what it was; and a new key result sent done is stamped', () => {
  const yn = { id: 'y', title: 'Launched', kind: 'yesno', targetValue: 1, currentValue: 1, completed: true, completedAt: STAMP.at, completedBy: 'u9', completedByName: 'Irfan', checkIns: [] };
  const k = edit([yn], { id: 'y', title: 'Launched', kind: 'yesno' });
  assert.deepEqual([k.completed, k.completedByName], [true, 'Irfan']);
  const fresh = edit([], { title: 'New', targetValue: 5, completed: true });
  assert.deepEqual([fresh.completed, fresh.completedByName], [true, 'Ishaan']);
  assert.equal(edit([], { title: 'New', targetValue: 5 }).completedAt, null); // open: no stamp
});

test('a target that did not change does not reopen a key result that reached it', () => {
  const k = edit([done40], { id: 'a', title: 'Bookings', targetValue: 40 });
  assert.equal(k.completed, true);
});

test('ready to close: every key result done and still open — counted by what was reached, not only by ticks', () => {
  const kr = (cur, extra = {}) => ({ targetValue: 10, currentValue: cur, ...extra });
  assert.equal(isReadyToClose({ keyResults: [kr(10), kr(3, { completed: true })] }), true);
  assert.equal(isReadyToClose({ keyResults: [kr(10), kr(12)] }), true); // reached it without anyone ticking
  assert.equal(isReadyToClose({ keyResults: [kr(10), kr(9)] }), false);
  assert.equal(isReadyToClose({ keyResults: [] }), false); // nothing says it is done
  assert.equal(isReadyToClose({}), false);
  assert.equal(isReadyToClose({ keyResults: [kr(10)], result: 'achieved' }), false); // already closed
  assert.equal(isReadyToClose({ keyResults: [kr(10)], result: 'continued' }), false);
});

test('ready to close is not offered to a several-month objective with months to go (that is the close-out\'s decision), but is in its last month', () => {
  const span = { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 };
  const all = [{ targetValue: 10, currentValue: 10 }];
  assert.equal(isReadyToClose({ year: 2026, month: 11, span, keyResults: all }), false);
  assert.equal(isReadyToClose({ year: 2026, month: 12, span, keyResults: all }), false);
  assert.equal(isReadyToClose({ year: 2027, month: 1, span, keyResults: all }), true);
});

test('carried in a run, a key result finished earlier keeps who and when; an open one carries none', () => {
  const span = { startYear: 2026, startMonth: 11, endYear: 2027, endMonth: 1 };
  const o = obj({ span, year: 2026, month: 11, result: 'continued', keyResults: [
    { id: 'a', title: 'Done one', targetValue: 10, currentValue: 10, completed: true, completedAt: STAMP.at, completedBy: 'u9', completedByName: 'Irfan' },
    { id: 'b', title: 'Open one', targetValue: 10, currentValue: 3 },
  ] });
  const [a, b] = carryOverPlan([o]).items[0].keyResults;
  assert.deepEqual([a.completed, a.completedByName, a.completedAt], [true, 'Irfan', STAMP.at]);
  assert.deepEqual([b.completed, b.completedByName, b.completedAt], [false, '', null]);
});

// ── the trend ───────────────────────────────────────────────────────────────

test('the trend covers the months that END with the one asked for, oldest first', () => {
  assert.deepEqual(trendMonths({ year: 2026, month: 11 }, 6).map((m) => `${m.year}-${m.month}`), ['2026-6', '2026-7', '2026-8', '2026-9', '2026-10', '2026-11']);
});

test('it runs back across a year end', () => {
  assert.deepEqual(trendMonths({ year: 2027, month: 2 }, 4).map((m) => `${m.year}-${m.month}`), ['2026-11', '2026-12', '2027-1', '2027-2']);
});

test('how many months: 6 unless said, between 2 and 12', () => {
  assert.equal(trendMonths({ year: 2026, month: 11 }).length, 6);
  assert.equal(trendMonths({ year: 2026, month: 11 }, 1).length, 2);
  assert.equal(trendMonths({ year: 2026, month: 11 }, 99).length, 12);
  assert.equal(trendMonths({ year: 2026, month: 11 }, 'x').length, 6);
  assert.equal(trendMonths({ year: 2026, month: 11 }, 12).length, 12);
});

const kr100 = [{ kind: 'percent', targetValue: 100, currentValue: 100 }];
const kr40 = [{ kind: 'percent', targetValue: 100, currentValue: 40 }];
const trendObj = (departmentId, year, month, keyResults, extra = {}) => ({ departmentId, year, month, keyResults, ...extra });

test('each month counts its own objectives and averages their progress, for the company and per department', () => {
  const months = trendMonths({ year: 2026, month: 11 }, 3);
  const departments = [{ id: 'd1', name: 'IT' }, { id: 'd2', name: 'HR' }];
  const objectives = [
    trendObj('d1', 2026, 11, kr100, { result: 'achieved' }),
    trendObj('d1', 2026, 11, kr40),
    trendObj('d2', 2026, 11, []),
    trendObj('d1', 2026, 10, kr40),
    trendObj('d1', 2026, 7, kr100), // outside the window
  ];
  const t = trendSeries({ months, objectives, departments });
  assert.deepEqual(t.map((m) => [m.year, m.month, m.count]), [[2026, 9, 0], [2026, 10, 1], [2026, 11, 3]]);
  const nov = t[2];
  assert.equal(nov.avgProgress, Math.round((100 + 40 + 0) / 3));
  assert.equal(nov.closed, 1);
  assert.equal(nov.achieved, 1);
  assert.deepEqual(nov.departments.map((d) => [d.name, d.count, d.avgProgress]), [['IT', 2, 70], ['HR', 1, 0]]);
  assert.deepEqual(t[1].departments.map((d) => [d.name, d.count, d.avgProgress]), [['IT', 1, 40], ['HR', 0, 0]]);
});

test('a month with nothing set has a count of 0 (the app leaves a gap, not a 0%)', () => {
  const t = trendSeries({ months: trendMonths({ year: 2026, month: 11 }, 2), objectives: [], departments: [{ id: 'd1', name: 'IT' }] });
  assert.deepEqual(t.map((m) => m.count), [0, 0]);
  assert.equal(t[0].departments[0].count, 0);
});

test('cancelled and postponed objectives are counted but stay out of the average', () => {
  const t = trendSeries({
    months: [{ year: 2026, month: 11 }],
    objectives: [trendObj('d1', 2026, 11, kr100), trendObj('d1', 2026, 11, kr40, { result: 'cancelled' }), trendObj('d1', 2026, 11, kr40, { result: 'deferred' })],
    departments: [{ id: 'd1', name: 'IT' }],
  });
  assert.equal(t[0].count, 3);
  assert.equal(t[0].avgProgress, 100);
});

test('departments that are not asked about are left out, even if their objectives are passed in', () => {
  const t = trendSeries({ months: [{ year: 2026, month: 11 }], objectives: [trendObj('d1', 2026, 11, kr100), trendObj('secret', 2026, 11, kr100)], departments: [{ id: 'd1', name: 'IT' }] });
  assert.equal(t[0].count, 1);
  assert.equal(t[0].departments.length, 1);
});

test('ids may be ObjectIds or strings', () => {
  const asObject = { toString: () => 'd1' };
  const t = trendSeries({ months: [{ year: 2026, month: 11 }], objectives: [trendObj(asObject, 2026, 11, kr100)], departments: [{ id: 'd1', name: 'IT' }] });
  assert.equal(t[0].departments[0].count, 1);
});
