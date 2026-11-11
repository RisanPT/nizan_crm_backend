// Pure unit tests (no database, no server): node --test tests/leaveMath.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  asOfForYear,
  computeTypeBalance,
  countLeaveDays,
  daysInYear,
  monthsCredited,
  normaliseWeeklyOffs,
  toDayKey,
} from '../utils/leaveMath.js';

test('weekly offs and holidays are excluded (no sandwich rule)', () => {
  // Mon 2 Nov – Sun 8 Nov 2026, Sunday off → 6 days.
  assert.equal(countLeaveDays({ from: '2026-11-02', to: '2026-11-08', weeklyOffs: [0] }).days, 6);
  // Sat+Sun off → 5.
  assert.equal(countLeaveDays({ from: '2026-11-02', to: '2026-11-08', weeklyOffs: [0, 6] }).days, 5);
  // Fri–Mon with Sunday off: Sunday inside the leave is not charged → 3.
  assert.equal(countLeaveDays({ from: '2026-11-06', to: '2026-11-09', weeklyOffs: [0] }).days, 3);
  // Holiday on Wed 4 Nov removes one more.
  const holidays = [{ date: '2026-11-04', type: 'national' }];
  assert.equal(countLeaveDays({ from: '2026-11-02', to: '2026-11-08', weeklyOffs: [0], holidays }).days, 5);
  // Optional holidays don't count as days off.
  assert.equal(
    countLeaveDays({ from: '2026-11-04', to: '2026-11-04', weeklyOffs: [0], holidays: [{ date: '2026-11-04', type: 'optional' }] }).days,
    1
  );
  // Recurring holiday (stored for an earlier year) still applies.
  assert.equal(
    countLeaveDays({ from: '2026-01-26', to: '2026-01-26', weeklyOffs: [0], holidays: [{ date: '2024-01-26', recurring: true }] }).days,
    0
  );
  // Only offs → 0 (caller rejects).
  assert.equal(countLeaveDays({ from: '2026-11-08', to: '2026-11-08', weeklyOffs: [0] }).days, 0);
});

test('holiday Date stored at midnight IST still matches its day', () => {
  const istMidnight = new Date('2026-11-03T18:30:00.000Z'); // 4 Nov 00:00 IST
  assert.equal(toDayKey(istMidnight), '2026-11-04');
  assert.equal(toDayKey(new Date('2026-11-04T12:00:00.000Z')), '2026-11-04');
  assert.equal(countLeaveDays({ from: '2026-11-04', to: '2026-11-04', weeklyOffs: [0], holidays: [{ date: istMidnight }] }).days, 0);
});

test('default / empty weekly offs', () => {
  assert.deepEqual(normaliseWeeklyOffs(undefined), [0]);
  assert.deepEqual(normaliseWeeklyOffs([]), []);
  assert.deepEqual(normaliseWeeklyOffs([6, 0, 9, '6']), [0, 6]);
  assert.equal(countLeaveDays({ from: '2026-11-02', to: '2026-11-08', weeklyOffs: [] }).days, 7);
});

test('half day: a single working day is 0.5; on a weekly off it is 0', () => {
  assert.equal(countLeaveDays({ from: '2026-11-05', to: '2026-11-05', weeklyOffs: [0], halfDay: 'first' }).days, 0.5);
  assert.equal(countLeaveDays({ from: '2026-11-08', to: '2026-11-08', weeklyOffs: [0], halfDay: 'first' }).days, 0);
  // halfDay ignored on a multi-day range.
  assert.equal(countLeaveDays({ from: '2026-11-05', to: '2026-11-06', weeklyOffs: [0], halfDay: 'first' }).days, 2);
});

test('monthly credit Jan–Dec', () => {
  assert.equal(monthsCredited({ year: 2026, asOfKey: '2026-01-15' }), 1);
  assert.equal(monthsCredited({ year: 2026, asOfKey: '2026-11-06' }), 11);
  assert.equal(monthsCredited({ year: 2025, asOfKey: '2026-11-06' }), 12);
  assert.equal(monthsCredited({ year: 2027, asOfKey: '2026-11-06' }), 0);
  const b = computeTypeBalance({
    type: { annualQuota: 12, paid: true },
    year: 2026,
    asOfKey: '2026-11-06',
    used: 3,
    pending: 1,
  });
  assert.equal(b.credited, 11);
  assert.equal(b.available, 7);
  // 15/yr × 11 months = 13.75 → rounded to 14.
  assert.equal(computeTypeBalance({ type: { annualQuota: 15 }, year: 2026, asOfKey: '2026-11-06' }).credited, 14);
});

test('joiner this year is credited from the joining month', () => {
  assert.equal(monthsCredited({ year: 2026, asOfKey: '2026-11-06', joinKey: '2026-08-20' }), 4);
  assert.equal(monthsCredited({ year: 2026, asOfKey: '2026-11-06', joinKey: '2026-12-01' }), 0);
  assert.equal(monthsCredited({ year: 2026, asOfKey: '2026-11-06', joinKey: '2020-03-01' }), 11);
  const b = computeTypeBalance({ type: { annualQuota: 12 }, year: 2026, asOfKey: '2026-11-06', joinKey: '2026-08-20' });
  assert.equal(b.credited, 4);
  assert.equal(b.available, 4);
});

test('overdrawn balance is negative, not hidden', () => {
  const b = computeTypeBalance({ type: { annualQuota: 12 }, year: 2026, asOfKey: '2026-02-10', used: 5 });
  assert.equal(b.credited, 2);
  assert.equal(b.available, -3);
});

test('carry-forward: last year unused, capped, pro-rata for last-year joiner', () => {
  const type = { annualQuota: 12, carryForward: true, carryForwardMax: 6 };
  // Full last year: 12 credited − 2 used = 10 unused → capped at 6.
  let b = computeTypeBalance({ type, year: 2026, asOfKey: '2026-01-10', lastYearUsed: 2 });
  assert.equal(b.carriedForward, 6);
  assert.equal(b.credited, 1);
  assert.equal(b.available, 7);
  // Joined Oct last year: 3 credited − 1 used = 2 (under the cap).
  b = computeTypeBalance({ type, year: 2026, asOfKey: '2026-01-10', joinKey: '2025-10-05', lastYearUsed: 1 });
  assert.equal(b.carriedForward, 2);
  // Overused last year never carries negative.
  b = computeTypeBalance({ type, year: 2026, asOfKey: '2026-01-10', lastYearUsed: 20 });
  assert.equal(b.carriedForward, 0);
  // No carry-forward flag → 0.
  b = computeTypeBalance({ type: { annualQuota: 12 }, year: 2026, asOfKey: '2026-01-10', lastYearUsed: 0 });
  assert.equal(b.carriedForward, 0);
  // Carry-forward on but max 0 → nothing carries.
  b = computeTypeBalance({ type: { annualQuota: 12, carryForward: true, carryForwardMax: 0 }, year: 2026, asOfKey: '2026-01-10', lastYearUsed: 0 });
  assert.equal(b.carriedForward, 0);
  // Joined this year → nothing to carry.
  b = computeTypeBalance({ type, year: 2026, asOfKey: '2026-05-10', joinKey: '2026-02-01' });
  assert.equal(b.carriedForward, 0);
});

test('Dec→Jan leave charges each year only its own working days', () => {
  // Mon 28 Dec 2026 – Mon 4 Jan 2027, Sunday off, 1 Jan holiday.
  const ctx = { weeklyOffs: [0], holidays: [{ date: '2027-01-01' }] };
  const r = countLeaveDays({ from: '2026-12-28', to: '2027-01-04', ...ctx });
  assert.deepEqual(r.byYear, { 2026: 4, 2027: 2 }); // 28–31 Dec; 2 + 4 Jan (3rd Sunday, 1st holiday)
  assert.equal(r.days, 6);
  const leave = { fromDate: '2026-12-28', toDate: '2027-01-04', days: 6 };
  assert.equal(daysInYear(leave, 2026, ctx), 4);
  assert.equal(daysInYear(leave, 2027, ctx), 2);
  assert.equal(daysInYear(leave, 2025, ctx), 0);
  // Same-year leaves use the stored days.
  assert.equal(daysInYear({ fromDate: '2026-03-02', toDate: '2026-03-03', days: 1.5 }, 2026, ctx), 1.5);
});

test('unpaid / zero-quota types have no limit', () => {
  const b = computeTypeBalance({ type: { annualQuota: 0, paid: false }, year: 2026, asOfKey: '2026-11-06', used: 4 });
  assert.equal(b.limited, false);
  assert.equal(b.used, 4);
  assert.equal(b.credited, 0);
});

test('asOfForYear clamps today into the asked year', () => {
  assert.equal(asOfForYear(2026, '2026-11-06'), '2026-11-06');
  assert.equal(asOfForYear(2025, '2026-11-06'), '2025-12-31');
  assert.equal(asOfForYear(2027, '2026-11-06'), '2027-01-01');
});
