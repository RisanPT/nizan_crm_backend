// Pure unit tests (no database, no server): node --test tests/goalMath.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillDays, mtdFigures, pct, periodOf, sumDays } from '../utils/goalMath.js';

test('periodOf: day, Monday-start week, calendar month', () => {
  assert.deepEqual(periodOf('day', '2026-10-21').days, ['2026-10-21']);

  const w = periodOf('week', '2026-10-25'); // a Sunday
  assert.equal(w.start, '2026-10-19');
  assert.equal(w.end, '2026-10-25');
  assert.equal(w.days.length, 7);

  const m = periodOf('month', '2026-02-10');
  assert.equal(m.start, '2026-02-01');
  assert.equal(m.end, '2026-02-28');
  assert.equal(m.days.length, 28);

  assert.equal(periodOf('year', '2026-10-21'), null);
  assert.equal(periodOf('day', 'nope'), null);
});

test('week and month totals equal the sum of their days (no gaps, no double counting)', () => {
  // Activity on some days of Oct 2026; days with none must count as zero.
  const byDay = new Map([
    ['2026-10-05', { leads: 3, bookings: 1, revenue: 12000.5, trials: 1 }],
    ['2026-10-19', { leads: 5, bookings: 2, revenue: 30000, trials: 0 }],
    ['2026-10-25', { leads: 1, bookings: 0, revenue: 0, trials: 2 }],
    ['2026-10-26', { leads: 4, bookings: 1, revenue: 8000, trials: 0 }],
  ]);
  const month = sumDays(fillDays(periodOf('month', '2026-10-01').days, byDay));
  assert.deepEqual(month, { leads: 13, bookings: 4, revenue: 50000.5, trials: 3 });

  const wk = sumDays(fillDays(periodOf('week', '2026-10-21').days, byDay)); // 19–25 Oct
  assert.deepEqual(wk, { leads: 6, bookings: 2, revenue: 30000, trials: 2 });

  // Splitting the month into its Monday-start weeks and adding them back up.
  const weeks = ['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26'];
  let leads = 0;
  for (const start of weeks) {
    const days = periodOf('week', start).days.filter((d) => d.startsWith('2026-10'));
    leads += sumDays(fillDays(days, byDay)).leads;
  }
  assert.equal(leads, month.leads);
});

test('mtdFigures pro-rates the goal to today', () => {
  // Day 10 of a 30-day month, goal 300 → expected 100 by now.
  const onTrack = mtdFigures({ achieved: 120, goal: 300, dayOfMonth: 10, daysInMonth: 30 });
  assert.equal(onTrack.proRatedGoal, 100);
  assert.equal(onTrack.ratioPct, 120);
  assert.equal(onTrack.monthPct, 40);
  assert.equal(onTrack.status, 'on_track');

  assert.equal(mtdFigures({ achieved: 85, goal: 300, dayOfMonth: 10, daysInMonth: 30 }).status, 'slightly_behind');
  assert.equal(mtdFigures({ achieved: 50, goal: 300, dayOfMonth: 10, daysInMonth: 30 }).status, 'behind');
});

test('mtdFigures without a goal never divides by zero', () => {
  const r = mtdFigures({ achieved: 10, goal: 0, dayOfMonth: 10, daysInMonth: 30 });
  assert.equal(r.status, 'no_goal');
  assert.equal(r.ratioPct, null);
  assert.equal(pct(5, 0), null);
});

test('last day of the month: pro-rated goal equals the full goal', () => {
  const r = mtdFigures({ achieved: 300, goal: 300, dayOfMonth: 31, daysInMonth: 31 });
  assert.equal(r.proRatedGoal, 300);
  assert.equal(r.ratioPct, 100);
  assert.equal(r.status, 'on_track');
});
