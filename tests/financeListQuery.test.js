// Pure unit tests: node --test tests/financeListQuery.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFinanceQuery, isNewStyleQuery, sortFor, QueryError } from '../utils/financeListQuery.js';

test('nothing asked → empty filters, newest first', () => {
  const c = parseFinanceQuery({}, 'collection');
  assert.deepEqual([c.statuses, c.paymentModes, c.categories, c.ocr], [[], [], [], []]);
  assert.equal(c.sort, 'date_desc');
  assert.equal(c.employeeId, '');
  assert.equal(c.workType, '');
});

test('each filter only exists on the kind it belongs to', () => {
  const q = { paymentMode: 'upi,cash', category: 'fuel', workType: 'model_shoot' };
  const coll = parseFinanceQuery(q, 'collection');
  assert.deepEqual(coll.paymentModes, ['upi', 'cash']);
  assert.deepEqual(coll.categories, []);
  assert.equal(coll.workType, '');
  const exp = parseFinanceQuery(q, 'expense');
  assert.deepEqual(exp.categories, ['fuel']);
  assert.deepEqual(exp.paymentModes, []);
  assert.equal(exp.workType, 'model_shoot');
});

test('statuses use pending / verified / rejected (not the fleet "approved")', () => {
  assert.deepEqual(parseFinanceQuery({ status: 'Verified, pending' }, 'collection').statuses, ['verified', 'pending']);
  assert.throws(() => parseFinanceQuery({ status: 'approved' }, 'collection'), QueryError);
});

test('bad values are a 400, never ignored', () => {
  for (const [q, kind] of [
    [{ paymentMode: 'bitcoin' }, 'collection'], [{ category: 'rent' }, 'expense'], [{ ocr: 'maybe' }, 'collection'],
    [{ bill: 'x' }, 'collection'], [{ link: 'trial' }, 'expense'], [{ workType: 'wedding' }, 'expense'],
    [{ sort: 'random' }, 'collection'], [{ employeeId: 'nope' }, 'collection'], [{ from: '2026-1-1' }, 'collection'],
    [{ from: '2026-11-01', to: '2026-10-01' }, 'collection'], [{ minAmount: '9', maxAmount: '1' }, 'expense'],
  ]) {
    assert.throws(() => parseFinanceQuery(q, kind), (e) => e instanceof QueryError && e.status === 400, JSON.stringify(q));
  }
});

test('link: collections may be tied to a booking, a trial or neither; expenses to a booking or nothing', () => {
  assert.equal(parseFinanceQuery({ link: 'trial' }, 'collection').link, 'trial');
  assert.equal(parseFinanceQuery({ link: 'none' }, 'expense').link, 'none');
});

test('workType "All" (the old app\'s wording) means no filter', () => {
  assert.equal(parseFinanceQuery({ workType: 'All' }, 'expense').workType, '');
});

test('screenshot-check values, amounts, search, dates', () => {
  const p = parseFinanceQuery({ ocr: 'mismatch,pending', minAmount: '1,000', maxAmount: '5000', search: '  Greeshma ', from: '2026-10-01', to: '2026-10-31' }, 'collection');
  assert.deepEqual(p.ocr, ['mismatch', 'pending']);
  assert.deepEqual([p.minAmount, p.maxAmount, p.search, p.from, p.to], [1000, 5000, 'Greeshma', '2026-10-01', '2026-10-31']);
});

test('sorts map to the amount field of these collections (not the fleet one)', () => {
  assert.deepEqual(sortFor('amount_desc'), { amount: -1, date: -1 });
  assert.deepEqual(sortFor('date_asc'), { date: 1, createdAt: 1 });
  assert.deepEqual(sortFor('nonsense'), { date: -1, createdAt: -1 });
});

test('older callers (none of the new parameters) are recognised, so their behaviour is untouched', () => {
  assert.equal(isNewStyleQuery({}), false);
  assert.equal(isNewStyleQuery({ status: 'pending', employeeId: 'x', startDate: 'y', workType: 'All', bookingId: 'z', paymentMode: 'cash' }), false);
  for (const k of ['page', 'limit', 'export', 'summary', 'search', 'sort', 'from', 'to', 'minAmount', 'maxAmount', 'bill', 'link', 'ocr', 'category']) {
    assert.equal(isNewStyleQuery({ [k]: '1' }), true, k);
  }
  assert.equal(isNewStyleQuery({ search: '' }), false);
});
