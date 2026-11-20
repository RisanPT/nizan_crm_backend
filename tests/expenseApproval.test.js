import test from 'node:test';
import assert from 'node:assert/strict';
import { planApproval, planRejection, loggedOf, isAdjusted } from '../utils/expenseApproval.js';

const pending = (amount) => ({ amount, loggedAmount: null, approvalNote: '' });

test('approving in full: no amount sent, or the same amount, keeps the logged figure and keeps no original', () => {
  assert.deepEqual(planApproval(pending(1517)), { amount: 1517, loggedAmount: null, approvalNote: '' });
  assert.deepEqual(planApproval(pending(1517), { approvedAmount: 1517, note: 'ignored' }), { amount: 1517, loggedAmount: null, approvalNote: '' });
  assert.deepEqual(planApproval(pending(1517), { approvedAmount: '1517' }), { amount: 1517, loggedAmount: null, approvalNote: '' });
  assert.deepEqual(planApproval(pending(1517), { approvedAmount: '' }), { amount: 1517, loggedAmount: null, approvalNote: '' }, 'a blank box is "nothing said"');
  assert.deepEqual(planApproval(pending(1517), { approvedAmount: null }), { amount: 1517, loggedAmount: null, approvalNote: '' });
});

test('approving for less: the approved amount counts, the logged one is kept, with the note', () => {
  assert.deepEqual(planApproval(pending(1517), { approvedAmount: 1400, note: '  over the meal limit ' }), {
    amount: 1400,
    loggedAmount: 1517,
    approvalNote: 'over the meal limit',
  });
  assert.equal(planApproval(pending(1517), { approvedAmount: '1400.456' }).amount, 1400.46, 'paise, rounded');
  assert.equal(planApproval(pending(1517), { approvedAmount: 0.01 }).amount, 0.01);
  assert.equal(planApproval(pending(1517), { approvedAmount: 1400 }).approvalNote, '', 'no note is fine');
  assert.equal(planApproval(pending(1517), { approvedAmount: 1400, note: 'x'.repeat(500) }).approvalNote.length, 300);
});

test('the approved amount can never be more than what was logged, nor nothing, nor not a number', () => {
  const tooMuch = planApproval(pending(1517), { approvedAmount: 1518 });
  assert.match(tooMuch.error, /cannot be more than what was logged \(₹1,517\)/);
  assert.equal(tooMuch.amount, undefined);
  assert.match(planApproval(pending(1517), { approvedAmount: 0 }).error, /more than ₹0/);
  assert.match(planApproval(pending(1517), { approvedAmount: -5 }).error, /more than ₹0/);
  assert.match(planApproval(pending(1517), { approvedAmount: 'abc' }).error, /not a number/);
  assert.match(planApproval(pending(1517), { approvedAmount: Infinity }).error, /not a number/);
  assert.match(planApproval(pending(1517), { approvedAmount: 0.004 }).error, /more than ₹0/, 'rounds to nothing');
});

test('approving again is judged against what the ARTIST logged, not the earlier approved amount', () => {
  const adjusted = { amount: 1400, loggedAmount: 1517, approvalNote: 'meal limit' };
  assert.equal(loggedOf(adjusted), 1517);
  assert.deepEqual(planApproval(adjusted, { approvedAmount: 1500, note: 'second look' }), { amount: 1500, loggedAmount: 1517, approvalNote: 'second look' });
  assert.deepEqual(planApproval(adjusted, { approvedAmount: 1517 }), { amount: 1517, loggedAmount: null, approvalNote: '' }, 'back to in full');
  assert.match(planApproval(adjusted, { approvedAmount: 1600 }).error, /₹1,517/);
  assert.deepEqual(planApproval(adjusted), { amount: 1400, loggedAmount: 1517, approvalNote: 'meal limit' }, 'an older client that sends no amount leaves it as it was');
});

test('rejecting pays nothing, so the logged amount comes back', () => {
  assert.deepEqual(planRejection({ amount: 1400, loggedAmount: 1517, approvalNote: 'meal limit' }), { amount: 1517, loggedAmount: null, approvalNote: '' });
  assert.deepEqual(planRejection(pending(300)), { amount: 300, loggedAmount: null, approvalNote: '' });
});

test('isAdjusted: only when the approved amount is really less than the logged one', () => {
  assert.equal(isAdjusted({ amount: 1400, loggedAmount: 1517 }), true);
  assert.equal(isAdjusted({ amount: 1517, loggedAmount: 1517 }), false);
  assert.equal(isAdjusted({ amount: 1517, loggedAmount: null }), false);
  assert.equal(isAdjusted({ amount: 1517 }), false);
});
