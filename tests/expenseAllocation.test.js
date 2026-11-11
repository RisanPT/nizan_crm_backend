// Pure unit tests (no database): node --test tests/expenseAllocation.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateExpenses } from '../utils/expenseAllocation.js';

const works = [{ id: 'A' }, { id: 'B' }];
const exp = (id, amount, bookingId = null, category = 'toll') => ({ id, amount, bookingId, category });
const sumLines = (lines) => Math.round(lines.reduce((s, l) => s + l.amount, 0) * 100) / 100;

test('an expense tied to one work is charged fully to that work', () => {
  const r = allocateExpenses({ works, expenses: [exp('e1', 300, 'B', 'fuel')] });
  assert.equal(r.perWork.B.total, 300);
  assert.equal(r.perWork.B.direct, 300);
  assert.equal(r.perWork.A.total, 0);
  assert.deepEqual(r.perWork.B.byCategory, { fuel: 300 });
  assert.deepEqual(r.lines.map((l) => [l.bookingId, l.mode]), [['B', 'direct']]);
});

test('THE RULE: a driver with 3 works spends ₹3,000 → ₹1,000 to each work', () => {
  const three = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const r = allocateExpenses({ works: three, expenses: [exp('e1', 3000, null, 'food')] });
  assert.deepEqual([r.perWork.A.total, r.perWork.B.total, r.perWork.C.total], [1000, 1000, 1000]);
  assert.deepEqual(r.lines.map((l) => [l.bookingId, l.amount, l.mode]), [
    ['A', 1000, 'shared'], ['B', 1000, 'shared'], ['C', 1000, 'shared'],
  ]);
  assert.equal(r.sharedTotal, 3000);
  assert.equal(r.unallocated, 0);
  assert.deepEqual(r.perWork.B.byCategory, { food: 1000 });
});

test('the split is equal whatever the distances: the old km weights are ignored', () => {
  const r = allocateExpenses({
    works: [{ id: 'A', plannedKm: 10 }, { id: 'B', plannedKm: 50 }],
    expenses: [exp('e1', 600)],
  });
  assert.equal(r.perWork.A.total, 300);
  assert.equal(r.perWork.B.total, 300);
});

test('shares always add back to the exact amount; the spare paisa goes to the first works', () => {
  const three = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
  const r = allocateExpenses({ works: three, expenses: [exp('e1', 100)] }); // 100 / 3
  assert.deepEqual([r.perWork.A.total, r.perWork.B.total, r.perWork.C.total], [33.34, 33.33, 33.33]);
  assert.equal(sumLines(r.lines), 100);
  const two = allocateExpenses({ works: [{ id: 'A' }, { id: 'B' }], expenses: [exp('e1', 0.01)] }); // one paisa, two works
  assert.deepEqual([two.perWork.A.total, two.perWork.B.total], [0.01, 0]);
});

test('a day with ONE work: a whole-day expense simply lands on it', () => {
  const r = allocateExpenses({ works: [{ id: 'A', plannedKm: 20 }], expenses: [exp('e1', 80)] });
  assert.equal(r.perWork.A.total, 80);
});

test('direct + shared mix, with per-category totals per work', () => {
  const r = allocateExpenses({
    works,
    expenses: [exp('e1', 120, 'A', 'food'), exp('e2', 600, null, 'toll'), exp('e3', 60, null, 'parking')],
  });
  assert.equal(r.perWork.A.direct, 120);
  assert.equal(r.perWork.A.shared, 330); // half of 660
  assert.equal(r.perWork.A.total, 450);
  assert.deepEqual(r.perWork.A.byCategory, { food: 120, toll: 300, parking: 30 });
  assert.equal(r.perWork.B.total, 330);
});

test('an expense tied to a work no longer on the day is flagged unallocated, not moved', () => {
  const r = allocateExpenses({ works, expenses: [exp('e1', 90, 'GONE')] });
  assert.equal(r.unallocated, 90);
  assert.equal(r.perWork.A.total + r.perWork.B.total, 0);
  assert.equal(r.lines[0].mode, 'unallocated');
  assert.match(r.lines[0].reason, /no longer on this day/);
});

test('a whole-day expense on a day with no works is unallocated', () => {
  const r = allocateExpenses({ works: [], expenses: [exp('e1', 50)] });
  assert.equal(r.unallocated, 50);
  assert.deepEqual(r.perWork, {});
  assert.match(r.lines[0].reason, /No work on this day/);
});

test('empty input → empty result', () => {
  const r = allocateExpenses({});
  assert.deepEqual(r, { lines: [], perWork: {}, unallocated: 0, sharedTotal: 0 });
});

test('ObjectId-like ids (objects with toString) match by string value', () => {
  const oid = (s) => ({ toString: () => s });
  const r = allocateExpenses({ works: [{ id: oid('a1'), plannedKm: 5 }], expenses: [exp('e1', 40, oid('a1'))] });
  assert.equal(r.perWork.a1.direct, 40);
});
