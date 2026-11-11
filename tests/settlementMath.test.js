// Pure unit tests (no database, no server): node --test tests/settlementMath.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, prorateFinalSettlement } from '../utils/settlementMath.js';

test('daysInMonth handles 30/31 days and leap years', () => {
  assert.equal(daysInMonth(2026, 11), 30);
  assert.equal(daysInMonth(2026, 12), 31);
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
});

test('mid-month exit: 1st → LWD inclusive, rounded', () => {
  const r = prorateFinalSettlement({ baseSalary: 30000, allowances: 3000, lastWorkingDay: '2026-11-15' });
  assert.equal(r.year, 2026);
  assert.equal(r.month, 11);
  assert.equal(r.daysInMonth, 30);
  assert.equal(r.daysWorked, 15);
  assert.equal(r.proratedBase, 15000);
  assert.equal(r.proratedAllowances, 1500);
  assert.equal(r.amount, 16500);

  const odd = prorateFinalSettlement({ baseSalary: 25000, lastWorkingDay: '2026-10-10' });
  assert.equal(odd.daysInMonth, 31);
  assert.equal(odd.proratedBase, Math.round((25000 * 10) / 31)); // 8065
  assert.equal(odd.amount, 8065);
});

test('LWD on the last day of the month pays the full month', () => {
  const r = prorateFinalSettlement({ baseSalary: 31000, allowances: 1000, lastWorkingDay: '2026-12-31' });
  assert.equal(r.daysWorked, 31);
  assert.equal(r.amount, 32000);
});

test('LWD before the payroll month starts gives 0', () => {
  const r = prorateFinalSettlement({ baseSalary: 30000, allowances: 2000, lastWorkingDay: '2026-10-31', year: 2026, month: 11 });
  assert.equal(r.daysWorked, 0);
  assert.equal(r.amount, 0);
});

test('LWD after the payroll month pays that month in full', () => {
  const r = prorateFinalSettlement({ baseSalary: 30000, lastWorkingDay: '2026-12-05', year: 2026, month: 11 });
  assert.equal(r.daysWorked, 30);
  assert.equal(r.amount, 30000);
});

test('February: 28 days, and 29 in a leap year', () => {
  const r = prorateFinalSettlement({ baseSalary: 28000, lastWorkingDay: '2027-02-14' });
  assert.equal(r.daysInMonth, 28);
  assert.equal(r.daysWorked, 14);
  assert.equal(r.amount, 14000);

  const full = prorateFinalSettlement({ baseSalary: 28000, lastWorkingDay: '2027-02-28' });
  assert.equal(full.amount, 28000);

  const leap = prorateFinalSettlement({ baseSalary: 29000, lastWorkingDay: '2028-02-10' });
  assert.equal(leap.daysInMonth, 29);
  assert.equal(leap.amount, 10000);
});

test('invalid input: bad LWD → null, negative/blank salary → 0', () => {
  assert.equal(prorateFinalSettlement({ baseSalary: 1000, lastWorkingDay: '' }), null);
  assert.equal(prorateFinalSettlement({ baseSalary: 1000, lastWorkingDay: '15/11/2026' }), null);
  const r = prorateFinalSettlement({ baseSalary: -5, allowances: undefined, lastWorkingDay: '2026-11-15' });
  assert.equal(r.amount, 0);
});
