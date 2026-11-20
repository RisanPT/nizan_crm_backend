import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DONE_STATUSES, MAX_DAYS_AHEAD, buildExtension, checkExtension, cleanReason, dayDiff, extensionMessage, fmtDay, isDone, isOverdue, istDay, overdueDays,
  parseDay, summarizeExtensions,
} from '../utils/taskExtension.js';

// 17 Nov 2026, 10:00 IST
const NOW = new Date('2026-11-17T04:30:00.000Z');
const due = (iso, extra = {}) => ({ deadline: new Date(iso), status: 'in-progress', percentComplete: 20, ...extra });

test('days are IST calendar days, whatever the hour or how the date was stored', () => {
  assert.equal(istDay('2026-11-12T00:00:00.000Z'), '2026-11-12'); // UTC midnight = 05:30 IST
  assert.equal(istDay('2026-11-11T18:30:00.000Z'), '2026-11-12'); // IST midnight, stored the other way
  assert.equal(istDay('2026-11-12T18:29:00.000Z'), '2026-11-12'); // 23:59 IST
  assert.equal(istDay('2026-11-12T18:30:00.000Z'), '2026-11-13');
  assert.equal(istDay(null), '');
  assert.equal(istDay(''), '');
  assert.equal(istDay('nonsense'), '');
  assert.equal(dayDiff('2026-11-17T04:30:00Z', '2026-11-12T00:00:00Z'), 5);
  assert.equal(dayDiff('2026-11-12T00:00:00Z', '2026-11-17T00:00:00Z'), -5);
  assert.equal(dayDiff('2026-11-12T00:00:00Z', '2026-11-11T18:30:00Z'), 0, 'the same IST day');
  assert.ok(Number.isNaN(dayDiff(null, '2026-11-12')));
  assert.equal(fmtDay('2026-11-12T00:00:00Z'), '12 Nov 2026');
  assert.equal(fmtDay('2026-01-05T00:00:00Z'), '5 Jan 2026');
  assert.equal(fmtDay(null), '');
});

test('a task is overdue from the day AFTER its due day, until it is finished', () => {
  assert.equal(overdueDays(due('2026-11-17T00:00:00Z'), NOW), 0, 'due today is not overdue');
  assert.equal(overdueDays(due('2026-11-16T00:00:00Z'), NOW), 1);
  assert.equal(overdueDays(due('2026-11-12T00:00:00Z'), NOW), 5);
  assert.equal(overdueDays(due('2026-11-30T00:00:00Z'), NOW), 0, 'not yet due');
  assert.equal(overdueDays({ status: 'todo' }, NOW), 0, 'no due date');
  assert.equal(isOverdue(due('2026-11-12T00:00:00Z'), NOW), true);
  assert.equal(isOverdue(due('2026-11-30T00:00:00Z'), NOW), false);
});

test('a finished task is never overdue and cannot be extended', () => {
  for (const status of DONE_STATUSES) {
    assert.equal(isDone({ status }), true, status);
    assert.equal(overdueDays(due('2026-11-01T00:00:00Z', { status }), NOW), 0, status);
  }
  assert.equal(isDone({ status: ' Closed ' }), true);
  assert.equal(isDone({ status: 'todo', percentComplete: 100 }), true);
  assert.equal(isDone({ status: 'todo', percentComplete: 99 }), false);
  assert.equal(overdueDays(due('2026-11-01T00:00:00Z', { percentComplete: 100 }), NOW), 0);
  const r = checkExtension({ task: due('2026-11-01T00:00:00Z', { status: 'closed' }), newDeadline: '2026-11-30', reason: 'More time', now: NOW });
  assert.equal(r.code, 'TASK_DONE');
});

test('a new due date is a plain day or a date-time; nonsense is nothing', () => {
  assert.equal(parseDay('2026-11-20').toISOString(), '2026-11-20T00:00:00.000Z');
  assert.equal(parseDay(' 2026-11-20 ').toISOString(), '2026-11-20T00:00:00.000Z');
  assert.ok(parseDay('2026-11-20T10:00:00.000Z') instanceof Date);
  for (const bad of [null, undefined, '', 'tomorrow', '2026-13-45', '2026-02-30', {}, []]) assert.equal(parseDay(bad), null, JSON.stringify(bad));
});

test('a reason is words only, trimmed, capped', () => {
  assert.equal(cleanReason('  Waiting   for\nthe client  '), 'Waiting for the client');
  assert.equal(cleanReason(null), '');
  assert.equal(cleanReason('x'.repeat(400)).length, 300);
});

test('an extension needs a later day and a reason; what it says about the task is worked out, not typed', () => {
  const task = due('2026-11-12T00:00:00Z');
  const ok = checkExtension({ task, newDeadline: '2026-11-20', reason: '  Client sent the files late ', now: NOW });
  assert.equal(ok.days, 8);
  assert.equal(ok.reason, 'Client sent the files late');
  assert.equal(ok.overdueDays, 5, 'it was five days overdue when it was extended');
  assert.equal(ok.to.toISOString(), '2026-11-20T00:00:00.000Z');
  // a task not yet overdue can be extended too, with no overdue days
  assert.equal(checkExtension({ task: due('2026-11-25T00:00:00Z'), newDeadline: '2026-11-27', reason: 'Scope grew', now: NOW }).overdueDays, 0);
});

test('every wrong extension is refused in plain words, with a code', () => {
  const task = due('2026-11-12T00:00:00Z');
  const code = (extra) => checkExtension({ task, newDeadline: '2026-11-20', reason: 'A reason', now: NOW, ...extra }).code;
  assert.equal(code({ newDeadline: undefined }), 'DATE_REQUIRED');
  assert.equal(code({ newDeadline: 'soon' }), 'DATE_REQUIRED');
  assert.equal(code({ newDeadline: '2026-11-12' }), 'NOT_LATER', 'the same day');
  assert.equal(code({ newDeadline: '2026-11-11' }), 'NOT_LATER', 'an earlier day');
  assert.equal(code({ newDeadline: '2026-11-11T18:30:00.000Z' }), 'NOT_LATER', 'the same IST day written another way');
  assert.equal(code({ reason: '' }), 'REASON_REQUIRED');
  assert.equal(code({ reason: '  ab ' }), 'REASON_REQUIRED');
  assert.equal(code({ reason: undefined }), 'REASON_REQUIRED');
  assert.equal(code({ task: { status: 'todo' } }), 'NO_DEADLINE');
  const far = new Date(NOW.getTime() + (MAX_DAYS_AHEAD + 30) * 86400000).toISOString().slice(0, 10);
  assert.equal(code({ newDeadline: far }), 'TOO_FAR');
  const r = checkExtension({ task, newDeadline: '2026-11-12', reason: 'x', now: NOW });
  assert.match(r.error, /after the current one \(12 Nov 2026\)/);
});

test('the checks run in the order a person would meet them (finished first, then no date, then the date, then the reason)', () => {
  assert.equal(checkExtension({ task: { status: 'closed' }, newDeadline: 'x', reason: '', now: NOW }).code, 'TASK_DONE');
  assert.equal(checkExtension({ task: { status: 'todo' }, newDeadline: 'x', reason: '', now: NOW }).code, 'NO_DEADLINE');
  assert.equal(checkExtension({ task: due('2026-11-12T00:00:00Z'), newDeadline: 'x', reason: '', now: NOW }).code, 'DATE_REQUIRED');
  assert.equal(checkExtension({ task: due('2026-11-12T00:00:00Z'), newDeadline: '2026-11-20', reason: '', now: NOW }).code, 'REASON_REQUIRED');
});

test('an entry keeps who, when, from, to, how many days, how overdue it was and why', () => {
  const task = due('2026-11-12T00:00:00Z');
  const user = { _id: 'u1', name: 'Mira' };
  const e = buildExtension({ task, to: new Date('2026-11-20T00:00:00Z'), days: 8, reason: 'Client sent the files late', overdue: 5, user, at: NOW });
  assert.deepEqual(
    { by: e.by, byName: e.byName, days: e.days, reason: e.reason, overdueDays: e.overdueDays, viaEdit: e.viaEdit, at: e.at },
    { by: 'u1', byName: 'Mira', days: 8, reason: 'Client sent the files late', overdueDays: 5, viaEdit: false, at: NOW },
  );
  assert.equal(e.from, task.deadline);
  const edit = buildExtension({ task, to: new Date('2026-11-20T00:00:00Z'), days: 8, user, at: NOW, viaEdit: true });
  assert.deepEqual([edit.reason, edit.overdueDays, edit.viaEdit], ['', 0, true]);
});

test('the log line says how long, from when to when, how overdue it was, and why', () => {
  const base = { from: new Date('2026-11-12T00:00:00Z'), to: new Date('2026-11-20T00:00:00Z'), days: 8, overdueDays: 5, reason: 'Client sent the files late' };
  assert.equal(extensionMessage(base), 'Due date extended by 8 days: 12 Nov 2026 → 20 Nov 2026 (it was 5 days overdue). Reason: Client sent the files late');
  assert.equal(extensionMessage({ ...base, days: 1, overdueDays: 1 }), 'Due date extended by 1 day: 12 Nov 2026 → 20 Nov 2026 (it was 1 day overdue). Reason: Client sent the files late');
  assert.equal(extensionMessage({ ...base, overdueDays: 0 }), 'Due date extended by 8 days: 12 Nov 2026 → 20 Nov 2026. Reason: Client sent the files late');
  assert.match(extensionMessage({ ...base, reason: '' }), /No reason was given\.$/);
});

test('the history adds up: how many times, how many days, the first due date, the latest', () => {
  const list = [
    { at: new Date('2026-11-18'), from: new Date('2026-11-20'), to: new Date('2026-11-25'), days: 5, overdueDays: 0, byName: 'B' },
    { at: new Date('2026-11-10'), from: new Date('2026-11-05'), to: new Date('2026-11-20'), days: 15, overdueDays: 5, byName: 'A' },
    { at: new Date('2026-11-27'), from: new Date('2026-11-25'), to: new Date('2026-12-01'), days: 6, overdueDays: 2, byName: 'C' },
  ];
  const s = summarizeExtensions(list);
  assert.equal(s.count, 3);
  assert.equal(s.totalDays, 26);
  assert.equal(String(s.originalDeadline), String(new Date('2026-11-05')), 'the due date before the first extension, whatever order they arrive in');
  assert.equal(s.last.byName, 'C');
  assert.equal(s.whileOverdue, 2);
  assert.deepEqual(summarizeExtensions([]), { count: 0, totalDays: 0, originalDeadline: null, last: null, whileOverdue: 0 });
  assert.equal(summarizeExtensions(undefined).count, 0);
  assert.equal(summarizeExtensions(null).count, 0);
  assert.equal(list[0].byName, 'B', 'the list is not reordered');
});
