// Pure unit tests: node --test tests/dayBuckets.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { istDayOf, daysOf, bucketDocs, sumRows, buildSeries } from '../utils/dayBuckets.js';

test('an instant falls on the IST day, not the UTC one', () => {
  assert.equal(istDayOf('2026-11-04T19:00:00Z'), '2026-11-05', '00:30 IST the next day');
  assert.equal(istDayOf('2026-11-05T18:29:59Z'), '2026-11-05');
  assert.equal(istDayOf('2026-11-05T18:30:00Z'), '2026-11-06');
  assert.equal(istDayOf(null), '');
  assert.equal(istDayOf('garbage'), '');
});

test('every day of a period, both ends', () => {
  assert.deepEqual(daysOf('2026-11-29', '2026-12-02'), ['2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02']);
  assert.deepEqual(daysOf('2026-11-05', '2026-11-05'), ['2026-11-05']);
  assert.equal(daysOf('2026-02-01', '2026-02-28').length, 28);
});

test('documents are bucketed by day, summed and counted', () => {
  const rows = bucketDocs(
    [{ at: '2026-11-04T19:00:00Z', v: 100 }, { at: '2026-11-05T05:00:00Z', v: 50 }, { at: '2026-11-06T05:00:00Z', v: 7 }, { at: null, v: 999 }],
    (d) => d.at,
    (d) => d.v,
  );
  assert.deepEqual(rows.sort((a, b) => a.day.localeCompare(b.day)), [
    { day: '2026-11-05', amount: 150, count: 2 },
    { day: '2026-11-06', amount: 7, count: 1 },
  ]);
  assert.deepEqual(sumRows(rows), { amount: 157, count: 3 });
  assert.deepEqual(sumRows([]), { amount: 0, count: 0 });
});

test('a series has a point for EVERY day, sources are added, other days are zero', () => {
  const s = buildSeries(
    '2026-11-01',
    '2026-11-04',
    { rows: [[{ day: '2026-11-02', amount: 100, count: 1 }], [{ day: '2026-11-02', amount: 50, count: 2 }, { day: '2026-11-04', amount: 10, count: 1 }]] },
    { rows: [[{ day: '2026-11-03', amount: 30, count: 1 }]] },
  );
  assert.equal(s.length, 4);
  assert.deepEqual(s.map((d) => d.income), [0, 150, 0, 10]);
  assert.deepEqual(s.map((d) => d.incomeCount), [0, 3, 0, 1]);
  assert.deepEqual(s.map((d) => d.expense), [0, 0, 30, 0]);
  assert.equal(s[0].date, '2026-11-01');
});

test('rows outside the period are ignored; an estimate is shared evenly over the days', () => {
  const s = buildSeries('2026-11-01', '2026-11-04', { rows: [[{ day: '2026-10-31', amount: 999, count: 1 }]] }, { rows: [], spread: [400] });
  assert.deepEqual(s.map((d) => d.income), [0, 0, 0, 0]);
  assert.deepEqual(s.map((d) => d.expense), [100, 100, 100, 100]);
  assert.deepEqual(s.map((d) => d.expenseCount), [0, 0, 0, 0], 'an estimate is not an entry');
});

test('the days add back up to the totals', () => {
  const rows = [[{ day: '2026-11-01', amount: 33.33, count: 1 }, { day: '2026-11-02', amount: 66.67, count: 1 }]];
  const s = buildSeries('2026-11-01', '2026-11-03', { rows }, { rows: [] });
  assert.equal(Math.round(s.reduce((t, d) => t + d.income, 0) * 100) / 100, sumRows(rows[0]).amount);
});
