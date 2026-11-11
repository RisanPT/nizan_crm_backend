import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanAmount,
  normalizeCostPlan,
  resolveCost,
  mayStart,
  spendingLimit,
  describeCostChange,
  money,
  checkDecision,
  canSeeCostAmounts,
  COST_CATEGORY_KEYS,
  MAX_COST_LINES,
} from '../utils/projectCost.js';

describe('an amount', () => {
  test('a number, or a string of one, to the paisa', () => {
    assert.equal(cleanAmount(1250), 1250);
    assert.equal(cleanAmount('1,25,000'), 125000);
    assert.equal(cleanAmount(10.456), 10.46);
    assert.equal(cleanAmount(0), 0);
  });
  test('nothing usable: empty, negative, not a number, absurdly large', () => {
    for (const v of [undefined, null, '', -1, 'abc', NaN, Infinity, 1e15]) assert.equal(cleanAmount(v), null, String(v));
  });
});

describe('the breakdown', () => {
  test('lines with an amount, and the total of them', () => {
    const r = normalizeCostPlan([
      { category: 'manpower', amount: 50000 },
      { category: 'tools', amount: '12,500.50', note: ' licences ' },
    ]);
    assert.equal(r.total, 62500.5);
    assert.deepEqual(r.plan, [
      { category: 'manpower', amount: 50000, note: '' },
      { category: 'tools', amount: 12500.5, note: 'licences' },
    ]);
  });
  test('an empty row on the form is left out, and so is a zero', () => {
    const r = normalizeCostPlan([{ category: 'travel', amount: '' }, { category: 'travel', amount: 0 }, { category: 'other', amount: 5 }, null]);
    assert.deepEqual(r.plan.map((l) => l.category), ['other']);
    assert.equal(r.total, 5);
  });
  test('an unknown kind of cost is "other"', () => {
    assert.equal(normalizeCostPlan([{ category: 'lunch', amount: 10 }]).plan[0].category, 'other');
  });
  test('the total is exact however many lines (paise)', () => {
    const r = normalizeCostPlan(Array.from({ length: 10 }, () => ({ category: 'other', amount: 0.1 })));
    assert.equal(r.total, 1);
  });
  test('a bad amount refuses the whole list; too many lines refuse it too; not a list refuses it', () => {
    assert.ok(normalizeCostPlan([{ category: 'other', amount: 'x' }]).error);
    assert.ok(normalizeCostPlan([{ category: 'other', amount: -5 }]).error);
    assert.ok(normalizeCostPlan(Array.from({ length: MAX_COST_LINES + 1 }, () => ({ category: 'other', amount: 1 }))).error);
    assert.ok(normalizeCostPlan('nope').error);
  });
  test('no breakdown at all is fine', () => {
    assert.deepEqual(normalizeCostPlan(undefined), { plan: [], total: 0 });
    assert.deepEqual(normalizeCostPlan([]), { plan: [], total: 0 });
  });
  test('every kind the form offers is a known one', () => {
    assert.deepEqual(COST_CATEGORY_KEYS, ['manpower', 'vendors', 'tools', 'travel', 'marketing', 'other']);
  });
});

describe('what is asked for', () => {
  test('the single amount typed', () => {
    assert.deepEqual(resolveCost({ budget: '75,000' }), { budget: 75000, plan: [] });
  });
  test('with a breakdown, the total of it — a different typed amount cannot disagree with it', () => {
    const r = resolveCost({ budget: 1, costPlan: [{ category: 'vendors', amount: 400 }, { category: 'tools', amount: 100 }] });
    assert.equal(r.budget, 500);
    assert.equal(r.plan.length, 2);
  });
  test('no cost is refused: nothing, zero, an empty breakdown', () => {
    for (const body of [{}, { budget: 0 }, { budget: '' }, { budget: null, costPlan: [] }, { costPlan: [{ category: 'other', amount: '' }] }]) {
      const r = resolveCost(body);
      assert.equal(r.code, 'COST_REQUIRED', JSON.stringify(body));
      assert.match(r.error, /estimated cost/i);
    }
  });
  test('a cost that is not a number is refused as invalid, not as missing', () => {
    assert.equal(resolveCost({ budget: 'lots' }).code, 'COST_INVALID');
    assert.equal(resolveCost({ budget: -10 }).code, 'COST_INVALID');
    assert.equal(resolveCost({ costPlan: [{ category: 'other', amount: 'x' }] }).code, 'COST_INVALID');
  });
});

describe('starting a project', () => {
  test('held while the finance head has not approved it, or sent it back', () => {
    assert.equal(mayStart('pending'), false);
    assert.equal(mayStart('returned'), false);
  });
  test('allowed once approved, and for a project from before costs existed', () => {
    assert.equal(mayStart('approved'), true);
    assert.equal(mayStart('none'), true);
    assert.equal(mayStart(undefined), true);
  });
});

describe('the limit spending is held against', () => {
  test('what was approved, not what is merely asked for', () => {
    assert.equal(spendingLimit({ costStatus: 'approved', approvedBudget: 90000, budget: 120000 }), 90000);
    assert.equal(spendingLimit({ costStatus: 'pending', approvedBudget: 0, budget: 120000 }), 0);
  });
  test('while a change waits, the earlier approved amount still stands', () => {
    assert.equal(spendingLimit({ costStatus: 'pending', approvedBudget: 90000, budget: 150000 }), 90000);
  });
  test('nothing approved, nothing to spend', () => {
    assert.equal(spendingLimit({ costStatus: 'none', budget: 0 }), 0);
    assert.equal(spendingLimit(null), 0);
  });
});

describe('what changed', () => {
  test('the total, and each kind of cost that moved', () => {
    const out = describeCostChange(
      { budget: 100000, plan: [{ category: 'manpower', amount: 60000 }, { category: 'tools', amount: 40000 }] },
      { budget: 130000, plan: [{ category: 'manpower', amount: 90000 }, { category: 'tools', amount: 40000 }] },
    );
    assert.deepEqual(out, ['Estimated cost ₹1,00,000 → ₹1,30,000', 'Manpower: ₹60,000 → ₹90,000']);
  });
  test('a kind added or removed', () => {
    const out = describeCostChange({ budget: 100, plan: [{ category: 'tools', amount: 100 }] }, { budget: 100, plan: [{ category: 'travel', amount: 100 }] });
    assert.deepEqual(out, ['Tools & software: ₹100 → removed', 'Travel & stay: added → ₹100']);
  });
  test('nothing changed, nothing said', () => {
    const same = { budget: 100, plan: [{ category: 'other', amount: 100 }] };
    assert.deepEqual(describeCostChange(same, { ...same }), []);
  });
  test('moving the same total between kinds is a change', () => {
    const out = describeCostChange(
      { budget: 100, plan: [{ category: 'tools', amount: 60 }, { category: 'other', amount: 40 }] },
      { budget: 100, plan: [{ category: 'tools', amount: 50 }, { category: 'other', amount: 50 }] },
    );
    assert.equal(out.length, 2);
  });
});

describe('money in words', () => {
  test('Indian grouping', () => {
    assert.equal(money(0), '₹0');
    assert.equal(money(999), '₹999');
    assert.equal(money(1000), '₹1,000');
    assert.equal(money(125000), '₹1,25,000');
    assert.equal(money(12345678), '₹1,23,45,678');
    assert.equal(money(1250.5), '₹1,250.50');
  });
});

describe('the finance head\'s decision', () => {
  test('approve as asked: no note needed', () => {
    assert.deepEqual(checkDecision({ decision: 'approve' }, 100000), { decision: 'approve', amount: 100000, note: '' });
  });
  test('approve a different amount: it needs a reason', () => {
    const r = checkDecision({ decision: 'approve', approvedAmount: 80000 }, 100000);
    assert.equal(r.code, 'NOTE_REQUIRED');
    assert.match(r.error, /₹80,000/);
    assert.match(r.error, /₹1,00,000/);
    assert.deepEqual(checkDecision({ decision: 'approve', approvedAmount: 80000, note: 'Tools already bought' }, 100000), {
      decision: 'approve',
      amount: 80000,
      note: 'Tools already bought',
    });
  });
  test('a different amount can be more as well as less', () => {
    assert.equal(checkDecision({ decision: 'approve', approvedAmount: '1,20,000', note: 'add contingency' }, 100000).amount, 120000);
  });
  test('the amount must be above zero and a number', () => {
    assert.equal(checkDecision({ decision: 'approve', approvedAmount: 0, note: 'zero' }, 100).code, 'AMOUNT_INVALID');
    assert.equal(checkDecision({ decision: 'approve', approvedAmount: 'many', note: 'zero' }, 100).code, 'AMOUNT_INVALID');
  });
  test('return: says what to change', () => {
    assert.equal(checkDecision({ decision: 'return' }, 100).code, 'NOTE_REQUIRED');
    assert.equal(checkDecision({ decision: 'return', note: 'ok' }, 100).code, 'NOTE_REQUIRED');
    assert.deepEqual(checkDecision({ decision: 'return', note: ' Split out the vendor cost ' }, 100), { decision: 'return', note: 'Split out the vendor cost' });
  });
  test('anything else is not a decision', () => {
    assert.equal(checkDecision({ decision: 'maybe' }, 100).code, 'DECISION_REQUIRED');
    assert.equal(checkDecision({}, 100).code, 'DECISION_REQUIRED');
  });
  test('a very long note is cut, not refused', () => {
    assert.equal(checkDecision({ decision: 'return', note: 'x'.repeat(900) }, 100).note.length, 500);
  });
});

describe('who sees the amounts', () => {
  test('those who run the project, finance and those over all projects', () => {
    for (const k of ['full', 'manager', 'ownerHead', 'finance']) assert.equal(canSeeCostAmounts({ [k]: true }), true, k);
  });
  test('nobody else', () => {
    assert.equal(canSeeCostAmounts({}), false);
    assert.equal(canSeeCostAmounts({ full: false, manager: false, ownerHead: false, finance: false }), false);
  });
});
