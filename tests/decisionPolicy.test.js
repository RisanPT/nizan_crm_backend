// Pure unit tests: node --test tests/decisionPolicy.test.js
// How the decision rules read to the app (services/decisions.js policyView) and how the limits are applied.
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyView } from '../services/decisions.js';
import { needsLeadership, policyIsOn, limitFor, budgetIncrease } from '../utils/decisionRules.js';

const POLICY = { spendLimits: { expense: 50_000, payout: 20_000, projectBudget: 100_000 }, hiringPlansNeedLeadership: true };

test('a policy nobody has set is off, and says nothing is escalated', () => {
  for (const p of [null, undefined, {}, { spendLimits: {} }, { spendLimits: { expense: null, payout: null, projectBudget: null } }]) {
    const v = policyView(p);
    assert.equal(v.on, false);
    assert.deepEqual(v.spendLimits, { expense: null, payout: null, projectBudget: null });
    assert.equal(v.hiringPlansNeedLeadership, false);
    assert.equal(v.summary, 'Nothing is escalated by amount.');
  }
});

test('a set policy is read back as it was set, with a summary a person can read', () => {
  const v = policyView({ ...POLICY, updatedByName: 'Admin', history: [{ at: new Date('2026-11-01'), byName: 'Admin', before: null, after: {} }] });
  assert.deepEqual(v.spendLimits, { expense: 50_000, payout: 20_000, projectBudget: 100_000 });
  assert.equal(v.on, true);
  assert.match(v.summary, /department expenses above ₹50,000/);
  assert.match(v.summary, /artist payouts above ₹20,000/);
  assert.match(v.summary, /project budget increases above ₹1,00,000/);
  assert.match(v.summary, /hiring plans/);
  assert.equal(v.updatedByName, 'Admin');
});

test('a zero, negative or junk limit in the database counts as off, never as "everything"', () => {
  for (const bad of [0, -1, NaN, 'abc', true, [], {}]) {
    const p = { spendLimits: { expense: bad } };
    assert.equal(limitFor(p, 'spend_expense'), null, JSON.stringify(bad));
    assert.equal(needsLeadership(p, 'spend_expense', 1e9), false, JSON.stringify(bad));
    assert.equal(policyIsOn(p), false, JSON.stringify(bad));
  }
});

test('only the last ten changes are shown, newest first', () => {
  const history = Array.from({ length: 14 }, (_, i) => ({ at: new Date(2026, 0, i + 1), byName: `u${i}`, before: null, after: null }));
  const v = policyView({ ...POLICY, history });
  assert.equal(v.history.length, 10);
  assert.equal(v.history[0].byName, 'u13');
  assert.equal(v.history[9].byName, 'u4');
});

test('each limit applies to its own kind only', () => {
  assert.equal(needsLeadership(POLICY, 'spend_expense', 50_001), true);
  assert.equal(needsLeadership(POLICY, 'spend_payout', 20_001), true);
  assert.equal(needsLeadership(POLICY, 'spend_payout', 20_000), false);
  assert.equal(needsLeadership({ spendLimits: { expense: 50_000 } }, 'spend_payout', 1e9), false, 'a limit that is not set does not escalate');
  assert.equal(needsLeadership(POLICY, 'project_proposal', 1e9), false, 'a proposal is not decided by amount');
  assert.equal(needsLeadership(POLICY, 'made_up_kind', 1e9), false);
});

test('a budget is judged by what it adds, not by its size', () => {
  assert.equal(budgetIncrease({ proposed: 410_000, previousApproved: 350_000 }), 60_000);
  assert.equal(needsLeadership(POLICY, 'project_budget', budgetIncrease({ proposed: 410_000, previousApproved: 350_000 })), false);
  assert.equal(needsLeadership(POLICY, 'project_budget', budgetIncrease({ proposed: 560_000, previousApproved: 410_000 })), true);
  assert.equal(budgetIncrease({ proposed: 300_000, previousApproved: 410_000 }), 0, 'a cut is no increase');
  assert.equal(needsLeadership(POLICY, 'project_budget', budgetIncrease({ proposed: 400_000, previousApproved: 0 })), true, 'a first approval counts from zero');
});
