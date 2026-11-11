// Pure unit tests: node --test tests/periodCompare.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { previousWindow } from '../utils/periodCompare.js';

const w = (from, to, today) => previousWindow(from, to, today);

test('this month, part way through: the SAME days of last month (1–5 Nov vs 1–5 Oct)', () => {
  assert.deepEqual(w('2026-11-01', '2026-11-30', '2026-11-05'), { from: '2026-10-01', to: '2026-10-05', mode: 'month', days: 5 });
});

test('a whole past month: the whole month before', () => {
  assert.deepEqual(w('2026-10-01', '2026-10-31', '2026-11-05'), { from: '2026-09-01', to: '2026-09-30', mode: 'month', days: 31 });
});

test('a long month against a short one is cut to the short one', () => {
  assert.deepEqual(w('2026-03-01', '2026-03-31', '2026-04-10'), { from: '2026-02-01', to: '2026-02-28', mode: 'month', days: 31 });
  assert.equal(w('2028-03-01', '2028-03-31', '2028-04-10').to, '2028-02-29', 'a leap year');
});

test('January is compared with December of the year before', () => {
  assert.deepEqual(w('2027-01-01', '2027-01-31', '2027-02-01'), { from: '2026-12-01', to: '2026-12-31', mode: 'month', days: 31 });
});

test('the financial year to date: the same dates a year earlier', () => {
  assert.deepEqual(w('2026-04-01', '2026-11-05', '2026-11-05'), { from: '2025-04-01', to: '2025-11-05', mode: 'fy', days: 219 });
});

test('a custom range: the period of the same length just before it', () => {
  assert.deepEqual(w('2026-11-03', '2026-11-09', '2026-11-20'), { from: '2026-10-27', to: '2026-11-02', mode: 'preceding', days: 7 });
  assert.deepEqual(w('2026-11-05', '2026-11-05', '2026-11-20'), { from: '2026-11-04', to: '2026-11-04', mode: 'preceding', days: 1 });
});

test('a custom range that runs past today is compared only up to today', () => {
  assert.deepEqual(w('2026-11-03', '2026-11-30', '2026-11-09'), { from: '2026-10-27', to: '2026-11-02', mode: 'preceding', days: 7 });
});

test('a period that has not started has no comparison; nor does nonsense', () => {
  assert.equal(w('2026-12-01', '2026-12-31', '2026-11-05'), null);
  assert.equal(w('2026-11-10', '2026-11-01', '2026-11-20'), null, 'the end is before the start');
  assert.equal(w('nope', '2026-11-01', '2026-11-20'), null);
});

test('the leap day: 29 Feb a year later falls back to 28 Feb', () => {
  const r = w('2028-04-01', '2029-02-28', '2029-03-10');
  assert.equal(r.mode, 'fy');
  assert.equal(r.to, '2028-02-28');
});
