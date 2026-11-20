// Pure unit tests: node --test tests/marketingTimebox.test.js
// The Marketing team's attendance taken from Timebox: Timebox's records read as the screens use them, and the member states and month
// rates taking Timebox's figures EXACTLY for a linked member (a work log no longer makes someone "present").
import test from 'node:test';
import assert from 'node:assert/strict';
import { dayRecord, planRecord, summaryRecord } from '../services/marketingTimebox.js';
import { attendanceRates, attendanceSummary, memberStates } from '../utils/marketingTeamStats.js';

test('a Timebox day: in and out, Timebox\'s own hours — none while still in', () => {
  const out = dayRecord({ date: '2026-11-18', login_time: '2026-11-18T09:12:00+05:30', logout_time: '2026-11-18T18:05:00+05:30', worked_minutes: 493, lunch_minutes: 40, logout_estimated: false });
  assert.equal(out.day, '2026-11-18');
  assert.equal(out.loginAt.toISOString(), '2026-11-18T03:42:00.000Z');
  assert.equal(out.stillIn, false);
  assert.equal(out.workedMinutes, 493);
  const still = dayRecord({ date: '2026-11-18', login_time: '2026-11-18T09:12:00+05:30', logout_time: null, worked_minutes: null });
  assert.deepEqual([still.stillIn, still.workedMinutes, still.logoutAt], [true, null, null]);
  assert.equal(dayRecord({ date: '2026-11-18', login_time: '2026-11-18T09:00:00+05:30', logout_time: '2026-11-18T17:00:00+05:30', worked_hours: '7.5' }).workedMinutes, 450, 'hours when minutes are not given');
  assert.equal(dayRecord({ date: '2026-11-18', login_time: 'None', logout_time: 'None' }).loginAt, null, 'Python\'s None as text is no time');
});

test('a Timebox month and a Timebox plan', () => {
  assert.deepEqual(summaryRecord({ days_present: '13', expected_days: '23', attendance_percent: '57', hours_worked: '89.7', excused_leave_days: '1' }), { daysPresent: 13, expectedDays: 23, percent: 57, hoursWorked: 89.7, excusedLeaveDays: 1 });
  assert.deepEqual(planRecord({ items: { worklist: [{ slot: 1, content: 'Edit reel', done: true }, { slot: 2, content: 'Shoot plan', done: 'False' }, { slot: 3, content: '  ', done: true }] } }), { total: 2, done: 1 });
  assert.deepEqual(planRecord({}), { total: 0, done: 0 });
});

const members = [{ _id: 'a', name: 'Ashique' }, { _id: 'b', name: 'Shahala' }, { _id: 'c', name: 'Saeeda' }];
const day = '2026-11-18';
const logged = [{ memberId: 'a', entryDate: day, kind: 'log' }, { memberId: 'b', entryDate: day, kind: 'log' }];

test('linked to Timebox: present only with a punch — a work log is not presence; times and hours are Timebox\'s', () => {
  const tbDay = {
    linked: new Set(['a', 'b']),
    days: new Map([['a', dayRecord({ date: day, login_time: '2026-11-18T09:12:00+05:30', logout_time: '2026-11-18T18:05:00+05:30', worked_minutes: 493 })]]),
  };
  const crm = new Map([['emp-b', { status: 'Present', checkInTime: '2026-11-18T03:00:00Z' }]]);
  const s = memberStates({ members, date: day, activities: logged, attendanceByEmployee: crm, employeeOf: (m) => `emp-${m._id}`, timebox: tbDay });
  const a = s.get('a');
  assert.deepEqual([a.state, a.status, a.hours, a.source], ['Active', 'Out', 8.2, 'timebox']);
  const b = s.get('b');
  assert.deepEqual([b.state, b.status, b.source, b.checkIn], ['Not in yet', 'Not punched in', 'timebox', null], 'logged work and a CRM record do not count: Timebox has no punch');
  const c = s.get('c');
  assert.deepEqual([c.state, c.source], ['Not in yet', ''], 'not linked, nothing at all');
  assert.deepEqual(attendanceSummary(s), { present: 1, onShoot: 0, wfh: 0, onLeave: 0, absent: 2 });
});

test('still in: Active, "In", no hours yet; leave and a work mode still say so for a linked member with no punch', () => {
  const tbDay = { linked: new Set(['a', 'b', 'c']), days: new Map([['a', dayRecord({ date: day, login_time: '2026-11-18T09:12:00+05:30' })]]) };
  const s = memberStates({ members, date: day, activities: [], timebox: tbDay, leaves: new Map([['b', new Set([day])]]), modes: new Map([['c', 'wfh']]) });
  assert.deepEqual([s.get('a').state, s.get('a').status, s.get('a').hours, s.get('a').stillIn], ['Active', 'In', null, true]);
  assert.deepEqual([s.get('b').state, s.get('b').status], ['On Leave', 'On Leave']);
  assert.deepEqual([s.get('c').state, s.get('c').status], ['Work From Home', 'Set by member']);
});

test('without Timebox (not connected, or did not answer): the CRM record and the logs, as before, labelled by source', () => {
  const crm = new Map([['emp-b', { status: 'Present', checkInTime: '2026-11-18T03:00:00Z', checkOutTime: '2026-11-18T12:00:00Z' }]]);
  const s = memberStates({ members, date: day, activities: logged, attendanceByEmployee: crm, employeeOf: (m) => `emp-${m._id}`, timebox: null });
  assert.deepEqual([s.get('a').state, s.get('a').source], ['Active', 'logs']);
  assert.deepEqual([s.get('b').state, s.get('b').source, s.get('b').hours], ['Active', 'crm', 9]);
});

test('the month: a linked member takes Timebox\'s days and %, exactly; the team rate adds them in', () => {
  const ctx = { weeklyOff: 0, holidays: new Set(), leaves: new Map() };
  const days = ['2026-11-16', '2026-11-17', '2026-11-18'];
  const r = attendanceRates({
    members,
    days,
    today: day,
    ctx,
    attended: new Set(['b|2026-11-16', 'b|2026-11-17']),
    tracked: new Set(['b']),
    timeboxMonth: new Map([['a', { daysPresent: 13, expectedDays: 16, percent: 81, hoursWorked: 101 }]]),
  });
  assert.deepEqual(r.byMember.get('a'), { attended: 13, expected: 16, pct: 81, source: 'timebox' });
  assert.equal(r.byMember.get('b').source, undefined);
  assert.equal(r.byMember.get('c').pct, null);
  assert.equal(r.team, Math.round(((13 + 2) / (16 + 3)) * 100));
});

test('Timebox not connected: the bundled demo export is NEVER used — the screens are told Timebox is off', async (t) => {
  const { timeboxMode } = await import('../services/timeboxClient.js');
  if (timeboxMode() === 'live') return t.skip('TIMEBOX_API_URL is set in this shell');
  const { marketingTimebox, TIMEBOX_NOT_CONNECTED } = await import('../services/marketingTimebox.js');
  const r = await marketingTimebox([{ _id: 'a', name: 'Arjun km', userId: null }], '2026-08-01', '2026-08-31', ['days', 'summary', 'plans']);
  assert.equal(r.status.mode, 'off');
  assert.equal(r.status.ok, false);
  assert.equal(r.status.problem, TIMEBOX_NOT_CONNECTED);
  assert.equal(r.days.size + r.summary.size + r.plans.size, 0, 'not one figure from the demo files');
});
