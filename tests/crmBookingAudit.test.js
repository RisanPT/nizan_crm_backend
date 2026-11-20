// Who did what to a booking, and when (utils/crmBookingAudit.js): node --test tests/crmBookingAudit.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { creationAudit, decisionCreditOf, isDecided, recordStatusChange, requestArrivedAt } from '../utils/crmBookingAudit.js';

const t = (h) => new Date(`2026-11-17T${String(h).padStart(2, '0')}:00:00+05:30`);
const asha = { _id: 'u-asha', name: 'Asha' };
const head = { _id: 'u-head', name: 'Meera' };

test('a request from the public form, and a booking made in the app', () => {
  assert.deepEqual(creationAudit({ status: 'pending', now: t(9) }), {
    origin: 'public',
    statusHistory: [{ status: 'pending', from: '', at: t(9), by: null, byName: '' }],
  });
  const staff = creationAudit({ status: 'Confirmed', user: asha, now: t(10) });
  assert.equal(staff.origin, 'staff');
  assert.deepEqual(staff.statusHistory[0], { status: 'confirmed', from: '', at: t(10), by: 'u-asha', byName: 'Asha' });
  assert.equal(creationAudit({ status: '' }).statusHistory[0].status, 'pending');
});

test('the first decision on a request is recorded once — with who decided and who owned it', () => {
  const b = { status: 'pending', crmOwnerId: 'u-asha', ...creationAudit({ status: 'pending', now: t(9) }) };
  assert.equal(recordStatusChange(b, { from: 'pending', to: 'confirmed', user: head, now: t(11) }), true);
  assert.deepEqual([b.requestDecision, b.requestDecidedBy, b.requestDecidedByName, b.decidedOwnerId], ['confirmed', 'u-head', 'Meera', 'u-asha']);
  assert.deepEqual(b.requestDecidedAt, t(11));
  assert.equal(isDecided(b), true);
  assert.equal(decisionCreditOf(b), 'u-asha', 'the owner gets the credit, not whoever pressed the button');
  // a later change of mind is history, not a new decision
  recordStatusChange(b, { from: 'confirmed', to: 'pending', user: head, now: t(12) });
  recordStatusChange(b, { from: 'pending', to: 'rejected', user: asha, now: t(13) });
  assert.deepEqual([b.requestDecision, b.requestDecidedAt], ['confirmed', t(11)]);
  assert.deepEqual(b.statusHistory.map((h) => `${h.from}>${h.status}`), ['>pending', 'pending>confirmed', 'confirmed>pending', 'pending>rejected']);
});

test('with no owner the credit goes to whoever decided', () => {
  const b = { status: 'pending' };
  recordStatusChange(b, { from: 'pending', to: 'rejected', user: asha, now: t(10) });
  assert.equal(b.decidedOwnerId, null);
  assert.equal(decisionCreditOf(b), 'u-asha');
});

test('re-saving the same status (the app sends the whole booking) records nothing; case and spaces do not matter', () => {
  const b = { status: 'confirmed', statusHistory: [] };
  assert.equal(recordStatusChange(b, { from: 'confirmed', to: 'Confirmed ', user: asha }), false);
  assert.equal(recordStatusChange(b, { from: 'confirmed', to: '', user: asha }), false);
  assert.equal(b.statusHistory.length, 0);
  assert.equal(b.requestDecidedAt, undefined);
});

test('a status change on a booking that was never a request is history only', () => {
  const b = { status: 'confirmed' };
  recordStatusChange(b, { from: 'confirmed', to: 'completed', user: asha, now: t(15) });
  assert.equal(b.statusHistory.length, 1, 'starts a history on a booking from before there was one');
  assert.equal(isDecided(b), false);
});

test('when a request arrived: the first history entry, else (an older booking) when it was created', () => {
  assert.deepEqual(requestArrivedAt({ statusHistory: [{ at: t(8) }], createdAt: t(1) }), t(8), 'createdAt can be back-dated; the history cannot');
  assert.deepEqual(requestArrivedAt({ statusHistory: [], createdAt: t(1) }), t(1));
  assert.equal(requestArrivedAt(null), null);
});
