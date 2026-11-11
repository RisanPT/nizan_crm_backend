import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, checkSpend, levelOf, alertFor, canOverspend, expenseRow, WARN_AT_PERCENT } from '../utils/projectSpend.js';

const e = (amount, status = 'approved', extra = {}) => ({ amount, status, expenseHead: 'OFF-01', department: 'Marketing', date: '2026-11-10T08:00:00Z', ...extra });

describe('how far along the limit', () => {
  test('no limit approved: none', () => {
    assert.equal(levelOf(0, 0), 'none');
    assert.equal(levelOf(5000, 0), 'none');
  });
  test('ok below 80%, warn from 80%, over only past the limit', () => {
    assert.equal(WARN_AT_PERCENT, 80);
    assert.equal(levelOf(7999, 10000), 'ok');
    assert.equal(levelOf(8000, 10000), 'warn');
    assert.equal(levelOf(9999, 10000), 'warn');
    assert.equal(levelOf(10000, 10000), 'warn', 'exactly the limit is not over');
    assert.equal(levelOf(10001, 10000), 'over');
  });
});

describe('where a project stands', () => {
  test('approved is spent, pending is committed, rejected is nothing', () => {
    const s = summarize({ limit: 100000, expenses: [e(30000), e(20000, 'pending'), e(99999, 'rejected')] });
    assert.equal(s.spent, 30000);
    assert.equal(s.committed, 20000);
    assert.equal(s.used, 50000);
    assert.equal(s.available, 50000);
    assert.equal(s.usedPercent, 50);
    assert.equal(s.level, 'ok');
  });
  test('committed counts toward the limit', () => {
    const s = summarize({ limit: 100000, expenses: [e(50000), e(35000, 'pending')] });
    assert.equal(s.level, 'warn');
    assert.equal(s.usedPercent, 85);
  });
  test('over: available goes negative', () => {
    const s = summarize({ limit: 10000, expenses: [e(12500)] });
    assert.equal(s.level, 'over');
    assert.equal(s.available, -2500);
    assert.equal(s.usedPercent, 125);
  });
  test('no limit yet: nothing to compare with, but what was spent is still shown', () => {
    const s = summarize({ limit: 0, requested: 90000, expenses: [e(1000)] });
    assert.equal(s.level, 'none');
    assert.equal(s.usedPercent, null);
    assert.equal(s.spent, 1000);
    assert.equal(s.requested, 90000);
  });
  test('no expenses', () => {
    const s = summarize({ limit: 5000 });
    assert.equal(s.spent, 0);
    assert.equal(s.level, 'ok');
    assert.deepEqual(s.byHead, []);
  });
  test('the pieces add back to the whole, to the paisa', () => {
    const s = summarize({ limit: 1000, expenses: Array.from({ length: 10 }, () => e(0.1)) });
    assert.equal(s.spent, 1);
    const sumHead = s.byHead.reduce((a, r) => a + r.spent, 0);
    assert.equal(Math.round(sumHead * 100), 100);
  });
  test('an empty or negative amount is ignored', () => {
    const s = summarize({ limit: 1000, expenses: [e(0), e(-50), e('abc'), e(40)] });
    assert.equal(s.spent, 40);
  });
  test('by head, department and month, biggest first', () => {
    const s = summarize({
      limit: 100000,
      expenses: [
        e(1000, 'approved', { expenseHead: 'TRV-01', department: 'Sales', date: '2026-10-05T00:00:00Z' }),
        e(5000, 'approved', { expenseHead: 'OFF-01', department: 'Marketing', date: '2026-11-05T00:00:00Z' }),
        e(2000, 'pending', { expenseHead: 'OFF-01', department: 'Marketing', date: '2026-11-20T00:00:00Z' }),
      ],
    });
    assert.deepEqual(s.byHead, [
      { key: 'OFF-01', spent: 5000, committed: 2000 },
      { key: 'TRV-01', spent: 1000, committed: 0 },
    ]);
    assert.deepEqual(s.byDepartment.map((r) => r.key), ['Marketing', 'Sales']);
    assert.deepEqual(s.byMonth.map((r) => r.key), ['2026-10', '2026-11'], 'months run oldest first');
  });
  test('an expense with no head or department is "other", and a bad date is "unknown"', () => {
    const s = summarize({ limit: 10, expenses: [{ amount: 5, status: 'approved', date: 'nope' }] });
    assert.equal(s.byHead[0].key, 'other');
    assert.equal(s.byDepartment[0].key, 'other');
    assert.equal(s.byMonth[0].key, 'unknown');
  });
});

describe('what one more expense would do', () => {
  test('within the limit', () => {
    const r = checkSpend({ limit: 100000, spent: 30000, committed: 10000, amount: 20000 });
    assert.equal(r.after, 60000);
    assert.equal(r.over, false);
    assert.equal(r.level, 'ok');
    assert.equal(r.available, 40000);
  });
  test('taking it to 80% is a warning, not over', () => {
    const r = checkSpend({ limit: 100000, spent: 50000, committed: 0, amount: 30000 });
    assert.equal(r.level, 'warn');
    assert.equal(r.over, false);
    assert.equal(r.usedPercentAfter, 80);
  });
  test('exactly the limit is allowed; one paisa more is over', () => {
    assert.equal(checkSpend({ limit: 1000, spent: 400, committed: 100, amount: 500 }).over, false);
    assert.equal(checkSpend({ limit: 1000, spent: 400, committed: 100, amount: 500.01 }).over, true);
  });
  test('over says by how much', () => {
    const r = checkSpend({ limit: 1000, spent: 900, committed: 0, amount: 300 });
    assert.equal(r.over, true);
    assert.equal(r.after, 1200);
    assert.equal(r.available, -200);
  });
  test('with no limit approved nothing can be over (the project has not been approved to spend at all)', () => {
    const r = checkSpend({ limit: 0, spent: 0, committed: 0, amount: 500 });
    assert.equal(r.over, false);
    assert.equal(r.level, 'none');
  });
});

describe('who is told when', () => {
  test('crossing up: 80% warns once, going over tells again', () => {
    assert.equal(alertFor('ok', 'warn'), 'warn');
    assert.equal(alertFor('warn', 'over'), 'over');
    assert.equal(alertFor('ok', 'over'), 'over');
  });
  test('staying where it was says nothing', () => {
    for (const l of ['ok', 'warn', 'over', 'none']) assert.equal(alertFor(l, l), null, l);
  });
  test('coming back down says nothing, and re-arms the warning', () => {
    assert.equal(alertFor('over', 'warn'), null);
    assert.equal(alertFor('over', 'ok'), null);
    assert.equal(alertFor('ok', 'warn'), 'warn', 'a top-up lowered it, then spending raised it again');
  });
  test('a project with no limit yet is never alerted', () => {
    assert.equal(alertFor('none', 'none'), null);
    assert.equal(alertFor(undefined, 'ok'), null);
  });
});

describe('who may approve past the limit', () => {
  test('the finance head and an administrator', () => {
    assert.equal(canOverspend('finance_head'), true);
    assert.equal(canOverspend('admin'), true);
    assert.equal(canOverspend(' Finance_Head '), true);
  });
  test('not Accounts, a manager, the CEO or anyone else', () => {
    for (const r of ['accounts', 'manager', 'ceo', 'crm', '', undefined]) assert.equal(canOverspend(r), false, String(r));
  });
});

describe('an expense as listed', () => {
  test('the fields the project page shows', () => {
    const row = expenseRow({ _id: 'x1', title: 'Hosting', amount: '1500', date: '2026-11-01', status: 'pending', department: 'IT', expenseHead: 'SUB-01', createdBy: { name: 'Asha' }, overBudgetReason: '' });
    assert.deepEqual(row, { id: 'x1', title: 'Hosting', amount: 1500, date: '2026-11-01', status: 'pending', department: 'IT', expenseHead: 'SUB-01', filedByName: 'Asha', overBudgetReason: '' });
  });
});
