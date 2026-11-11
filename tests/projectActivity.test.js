import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildActivityFeed,
  recordActivity,
  reminderWaitMs,
  statusLabel,
  MAX_STORED_ACTIVITY,
  REMINDER_EVERY_MS,
} from '../utils/projectActivity.js';

const at = (s) => new Date(`2026-11-03T${s}:00.000Z`);
const names = { u1: 'Amna', u2: 'Sana' };
const nameOf = (id) => names[String(id)] ?? '';

const base = {
  createdAt: at('10:24'),
  createdBy: 'u1',
  departments: [{ name: 'Marketing', role: 'owner', status: 'accepted' }],
  activity: [],
};
const dept = (name, over = {}) => ({ name, role: 'participant', status: 'invited', invitedAt: at('10:26'), respondedAt: null, ...over });

test('a new project has one line: created, by whom', () => {
  const feed = buildActivityFeed(base, nameOf);
  assert.deepEqual(feed.map((e) => [e.kind, e.text, e.by]), [['created', 'Project created', 'Amna']]);
});

test('a staff proposal reads "proposed"', () => {
  assert.equal(buildActivityFeed({ ...base, proposedBy: 'u1' }, nameOf)[0].text, 'Project proposed');
});

test('invitations stamped a moment before the project was saved still come after "created"', () => {
  const p = {
    ...base,
    createdAt: new Date('2026-11-03T10:24:00.050Z'),
    departments: [...base.departments, dept('Sales', { invitedAt: new Date('2026-11-03T10:24:00.020Z') })],
  };
  assert.deepEqual(buildActivityFeed(p, nameOf).map((e) => e.text), ['Project created', 'Invitation sent to Sales']);
});

test('departments invited in the same save are one line', () => {
  const p = { ...base, departments: [...base.departments, dept('Accounts'), dept('Finance', { invitedAt: at('10:26') }), dept('HR')] };
  const feed = buildActivityFeed(p, nameOf);
  assert.deepEqual(feed.map((e) => e.text), ['Project created', 'Invitations sent to 3 departments']);
});

test('one invited department is named', () => {
  const feed = buildActivityFeed({ ...base, departments: [...base.departments, dept('Sales')] }, nameOf);
  assert.equal(feed[1].text, 'Invitation sent to Sales');
});

test('invitations sent at different times are separate lines', () => {
  const p = { ...base, departments: [...base.departments, dept('Sales'), dept('CRM', { invitedAt: at('11:40') })] };
  const feed = buildActivityFeed(p, nameOf);
  assert.deepEqual(feed.map((e) => e.text), ['Project created', 'Invitation sent to Sales', 'Invitation sent to CRM']);
});

test('answers are lines of their own, with who answered', () => {
  const p = {
    ...base,
    departments: [
      ...base.departments,
      dept('Accounts', { status: 'accepted', respondedAt: at('12:00'), respondedBy: 'u2' }),
      dept('HR', { status: 'declined', respondedAt: at('12:30') }),
    ],
  };
  const feed = buildActivityFeed(p, nameOf);
  assert.deepEqual(
    feed.map((e) => [e.text, e.by]),
    [['Project created', 'Amna'], ['Invitations sent to 2 departments', ''], ['Accounts joined the project', 'Sana'], ['HR declined the invitation', '']],
  );
});

test("the saver's own department is accepted on the spot: no invitation, no answer", () => {
  const same = at('10:25');
  const p = { ...base, departments: [...base.departments, dept('Finance', { status: 'accepted', invitedAt: same, respondedAt: same })] };
  assert.deepEqual(buildActivityFeed(p, nameOf).map((e) => e.text), ['Project created']);
});

test('stored events (status change, reminder) are woven in by time, oldest first', () => {
  const p = {
    ...base,
    departments: [...base.departments, dept('Sales')],
    activity: [
      { kind: 'reminder', text: 'Reminder sent to Sales', byName: 'Amna', at: at('14:00') },
      { kind: 'status', text: 'Project moved to Planning', byName: 'Amna', at: at('10:27') },
    ],
  };
  const feed = buildActivityFeed(p, nameOf);
  assert.deepEqual(feed.map((e) => e.text), ['Project created', 'Invitation sent to Sales', 'Project moved to Planning', 'Reminder sent to Sales']);
  assert.equal(feed.at(-1).by, 'Amna');
});

test('a project from before departments existed (no stored departments, no createdAt) does not break', () => {
  assert.deepEqual(buildActivityFeed({ activity: undefined, departments: undefined }), []);
  assert.deepEqual(buildActivityFeed({ createdAt: at('09:00') }).map((e) => e.text), ['Project created']);
});

test('recordActivity keeps only the latest events', () => {
  const p = { activity: [] };
  for (let i = 0; i < MAX_STORED_ACTIVITY + 5; i++) recordActivity(p, 'status', `moved ${i}`, { name: 'A' }, at('10:00'));
  assert.equal(p.activity.length, MAX_STORED_ACTIVITY);
  assert.equal(p.activity[0].text, 'moved 5');
  assert.equal(p.activity.at(-1).byName, 'A');
});

test('recordActivity starts a list when the project has none', () => {
  const p = {};
  recordActivity(p, 'reminder', 'Reminder sent to HR', null);
  assert.equal(p.activity[0].byName, '');
});

test('a reminder can go out again only after the wait', () => {
  const t0 = at('10:00');
  assert.equal(reminderWaitMs(null, t0), 0);
  assert.equal(reminderWaitMs(undefined, t0), 0);
  assert.equal(reminderWaitMs(t0, t0), REMINDER_EVERY_MS);
  assert.equal(reminderWaitMs(t0, new Date(t0.getTime() + 10 * 60000)), REMINDER_EVERY_MS - 10 * 60000);
  assert.equal(reminderWaitMs(t0, new Date(t0.getTime() + REMINDER_EVERY_MS)), 0);
});

test('statusLabel', () => {
  assert.equal(statusLabel('planning'), 'Planning');
  assert.equal(statusLabel('on-hold'), 'On hold');
  assert.equal(statusLabel(''), '');
});
