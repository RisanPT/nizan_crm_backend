// Pure unit tests: node --test tests/fuelExpenseQuery.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExpenseQuery, escapeRegex, QueryError } from '../utils/fuelExpenseQuery.js';

test('no filters → everything empty, newest first', () => {
  const p = parseExpenseQuery({});
  assert.deepEqual(p.statuses, []);
  assert.deepEqual(p.categories, []);
  assert.equal(p.sort, 'date_desc');
  assert.equal(p.minAmount, null);
  assert.equal(p.search, '');
  assert.deepEqual(parseExpenseQuery(undefined).statuses, []);
});

test('comma lists are read, lower-cased, de-duplicated', () => {
  const p = parseExpenseQuery({ status: 'Pending, approved,pending', category: 'fuel,toll', paymentMode: 'UPI' });
  assert.deepEqual(p.statuses, ['pending', 'approved']);
  assert.deepEqual(p.categories, ['fuel', 'toll']);
  assert.deepEqual(p.paymentModes, ['upi']);
});

test('unknown values are refused with a 400, never ignored silently', () => {
  for (const q of [{ status: 'done' }, { category: 'fuel,coffee' }, { paymentMode: 'bitcoin' }, { sort: 'random' }, { bill: 'maybe' }, { work: 'some' }]) {
    assert.throws(() => parseExpenseQuery(q), (e) => e instanceof QueryError && e.status === 400, JSON.stringify(q));
  }
});

test('dates must be real days, in order', () => {
  assert.equal(parseExpenseQuery({ from: '2026-10-01', to: '2026-10-31' }).to, '2026-10-31');
  assert.throws(() => parseExpenseQuery({ from: '2026-10-1' }), QueryError);
  assert.throws(() => parseExpenseQuery({ to: '2026-13-40' }), QueryError);
  assert.throws(() => parseExpenseQuery({ from: '2026-11-01', to: '2026-10-01' }), /after/);
});

test('ids must look like ids', () => {
  const ok = '64b64c4f1a2b3c4d5e6f7a8b';
  assert.equal(parseExpenseQuery({ driverId: ok }).driverId, ok);
  assert.throws(() => parseExpenseQuery({ driverId: 'not-an-id' }), QueryError);
  assert.throws(() => parseExpenseQuery({ vehicleId: '123' }), QueryError);
});

test('amounts: numbers (commas allowed), not negative, min ≤ max', () => {
  const p = parseExpenseQuery({ minAmount: '1,000', maxAmount: '2500.50' });
  assert.deepEqual([p.minAmount, p.maxAmount], [1000, 2500.5]);
  assert.equal(parseExpenseQuery({ minAmount: '0' }).minAmount, 0);
  assert.throws(() => parseExpenseQuery({ minAmount: 'abc' }), QueryError);
  assert.throws(() => parseExpenseQuery({ maxAmount: '-5' }), QueryError);
  assert.throws(() => parseExpenseQuery({ minAmount: '500', maxAmount: '100' }), /minimum/);
});

test('search is trimmed and capped; regex characters are escaped', () => {
  assert.equal(parseExpenseQuery({ search: '  Ravi  ' }).search, 'Ravi');
  assert.equal(parseExpenseQuery({ search: 'x'.repeat(500) }).search.length, 80);
  const re = new RegExp(escapeRegex('KL 11 (AB)+.*?'), 'i');
  assert.ok(re.test('kl 11 (ab)+.*?'));
  assert.ok(!re.test('KL 11 AB'));
});

test('bill / work / sort', () => {
  const p = parseExpenseQuery({ bill: 'WITH', work: 'whole_day', sort: 'amount_desc' });
  assert.deepEqual([p.bill, p.work, p.sort], ['with', 'whole_day', 'amount_desc']);
});
