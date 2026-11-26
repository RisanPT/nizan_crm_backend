// Pure unit tests (no database, no server): node --test tests/payrollAttendance.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { attendanceCredit, leaveDaysInRange, payrollOffDaysInRange } from '../utils/leaveMath.js';

const midday = (k) => new Date(`${k}T12:00:00Z`);

test('a leave across a month end is split by working day', () => {
  // Sat 28 Nov – Wed 2 Dec 2026, Sunday off → 4 working days in all.
  const lr = { fromDate: midday('2026-11-28'), toDate: midday('2026-12-02'), days: 4 };
  const ctx = { weeklyOffs: [0], holidays: [] };
  assert.equal(leaveDaysInRange(lr, '2026-11-01', '2026-11-30', ctx), 2); // Sat 28 + Mon 30
  assert.equal(leaveDaysInRange(lr, '2026-12-01', '2026-12-31', ctx), 2); // Tue 1 + Wed 2
  // Saturday off too → Nov gets only Mon 30.
  const lr2 = { ...lr, days: 3 };
  assert.equal(leaveDaysInRange(lr2, '2026-11-01', '2026-11-30', { weeklyOffs: [0, 6] }), 1);
  assert.equal(leaveDaysInRange(lr2, '2026-12-01', '2026-12-31', { weeklyOffs: [0, 6] }), 2);
  // Holiday on 1 Dec is not charged.
  const hol = [{ date: '2026-12-01', type: 'national' }];
  assert.equal(leaveDaysInRange({ ...lr, days: 3 }, '2026-12-01', '2026-12-31', { weeklyOffs: [0], holidays: hol }), 1);
});

test('a leave wholly inside the month keeps its stored days (half day 0.5)', () => {
  const half = { fromDate: midday('2026-11-10'), toDate: midday('2026-11-10'), days: 0.5 };
  assert.equal(leaveDaysInRange(half, '2026-11-01', '2026-11-30', { weeklyOffs: [0] }), 0.5);
  assert.equal(leaveDaysInRange(half, '2026-12-01', '2026-12-31', { weeklyOffs: [0] }), 0);
  const full = { fromDate: midday('2026-11-02'), toDate: midday('2026-11-08'), days: 6 };
  assert.equal(leaveDaysInRange(full, '2026-11-01', '2026-11-30', { weeklyOffs: [0] }), 6);
});

test('weekly offs for payroll come from the department master', () => {
  // November 2026: 5 Sundays (1,8,15,22,29), 4 Saturdays.
  const r = { fromKey: '2026-11-01', toKey: '2026-11-30' };
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: [0, 6], deptName: 'Sales' }), 9);
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: [6], deptName: 'IT' }), 4);
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: [], deptName: 'IT' }), 0);
  // Not configured (default Sunday only / no department) → old rule.
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: [0], deptName: 'IT' }), 9);
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: undefined, deptName: 'it' }), 9);
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: [0], deptName: 'Sales' }), 0);
  assert.equal(payrollOffDaysInRange({ ...r, deptWeeklyOffs: undefined, deptName: '' }), 0);
});

test('regularizations are applied before the free absent day', () => {
  // 1 absence covered by a regularization → no free day used.
  const a = attendanceCredit({ expectedDays: 26, daysPresent: 25, regularizedDays: 1, freeAbsentDays: 1 });
  assert.deepEqual([a.regApplied, a.freeApplied, a.effectiveDaysPresent], [1, 0, 26]);
  // 2 absences, 1 regularized → free day covers the other.
  const b = attendanceCredit({ expectedDays: 26, daysPresent: 24, regularizedDays: 1, freeAbsentDays: 1 });
  assert.deepEqual([b.regApplied, b.freeApplied, b.effectiveDaysPresent], [1, 1, 26]);
  // Paid leave present → no free day (existing policy).
  const c = attendanceCredit({ expectedDays: 26, daysPresent: 23, approvedLeaveDays: 1, freeAbsentDays: 1 });
  assert.deepEqual([c.leaveApplied, c.freeApplied, c.effectiveDaysPresent], [1, 0, 24]);
  // No absence → nothing applied.
  const d = attendanceCredit({ expectedDays: 20, daysPresent: 20, regularizedDays: 2, freeAbsentDays: 1 });
  assert.deepEqual([d.regApplied, d.freeApplied, d.effectiveDaysPresent], [0, 0, 20]);
});
