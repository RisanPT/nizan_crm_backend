// The rules of a CRM case (utils/crmCaseRules.js): node --test tests/crmCaseRules.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { caseChangeRefusal, caseNumberCandidate, caseSlaHoursFor, dueAtFor, flippedCaseKinds, isOverdue, normalizePhone, resolvedOnTime, reviewCaseKinds } from '../utils/crmCaseRules.js';

const t = (h, d = 17) => new Date(`2026-11-${d}T${String(h).padStart(2, '0')}:00:00+05:30`);

test('a phone is its last 10 digits', () => {
  assert.equal(normalizePhone('+91 98950 00001'), '9895000001');
  assert.equal(normalizePhone('9895000001'), '9895000001');
  assert.equal(normalizePhone(null), '');
});

test('the time limit by kind, and when that makes a case due', () => {
  const s = { caseSlaHours: { complaint: 48, re_engagement: 168 } };
  assert.equal(caseSlaHoursFor(s, 'complaint'), 48);
  assert.equal(caseSlaHoursFor(s, 're_engagement'), 168);
  assert.equal(caseSlaHoursFor(s, 'follow_up'), 48, 'missing → 48');
  assert.equal(dueAtFor(t(9), 48).getTime(), t(9, 19).getTime());
  assert.equal(dueAtFor(t(9), 0).getTime(), t(10).getTime(), 'never less than an hour');
});

test('overdue: open and past due — not when resolved; on time: resolved by the due time', () => {
  assert.equal(isOverdue({ status: 'open', dueAt: t(9) }, t(10)), true);
  assert.equal(isOverdue({ status: 'in_progress', dueAt: t(9) }, t(10)), true);
  assert.equal(isOverdue({ status: 'open', dueAt: t(11) }, t(10)), false);
  assert.equal(isOverdue({ status: 'resolved', dueAt: t(9) }, t(10)), false);
  assert.equal(resolvedOnTime({ resolvedAt: t(9), dueAt: t(9) }), true, 'exactly at the due time is on time');
  assert.equal(resolvedOnTime({ resolvedAt: t(10), dueAt: t(9) }), false);
  assert.equal(resolvedOnTime({ dueAt: t(9) }), false);
});

test('what a submitted review opens: a complaint for an unhappy client, a follow-up when asked', () => {
  assert.deepEqual(reviewCaseKinds({ complaint: true }), ['complaint']);
  assert.deepEqual(reviewCaseKinds({ nps: 6 }), ['complaint'], 'NPS at the line is a detractor');
  assert.deepEqual(reviewCaseKinds({ nps: 7 }), []);
  assert.deepEqual(reviewCaseKinds({ nps: 5 }, { lowNps: 4 }), [], 'the line comes from the settings');
  assert.deepEqual(reviewCaseKinds({ nps: null, complaint: false }), []);
  assert.deepEqual(reviewCaseKinds({ nps: '' }), [], 'an empty NPS is no answer, not zero');
  assert.deepEqual(reviewCaseKinds({ complaint: true, followUpRequired: true }), ['complaint', 'follow_up']);
});

test('what a staff edit opens: only a flag that was just switched on', () => {
  assert.deepEqual(flippedCaseKinds({ complaint: false }, { complaint: true }), ['complaint']);
  assert.deepEqual(flippedCaseKinds({ complaint: true }, { complaint: true }), [], 'already on: nothing new');
  assert.deepEqual(flippedCaseKinds({}, { followUpRequired: true }), ['follow_up']);
  assert.deepEqual(flippedCaseKinds({ complaint: true }, { complaint: false }), [], 'switching off opens nothing');
});

const c = (status, ownerId = 'u1', extra = {}) => ({ status, ownerId, ...extra });

test('who may change a case: its owner or the head; leadership only looks', () => {
  assert.equal(caseChangeRefusal(c('open'), { viewer: 'member', actorId: 'u1', next: 'in_progress' }), null);
  assert.match(caseChangeRefusal(c('open'), { viewer: 'member', actorId: 'u2', next: 'in_progress' }), /owner or the CRM Head/);
  assert.equal(caseChangeRefusal(c('open'), { viewer: 'head', actorId: 'u9', next: 'in_progress' }), null);
  assert.equal(caseChangeRefusal(c('open'), { viewer: 'admin', actorId: 'u9', next: 'in_progress' }), null);
  assert.match(caseChangeRefusal(c('open'), { viewer: 'leadership', actorId: 'u9' }), /only look/);
  assert.match(caseChangeRefusal(c('open', null), { viewer: 'member', actorId: 'u1', next: 'in_progress' }), /owner or the CRM Head/, 'an unassigned case is the head\'s to give out');
});

test('resolving needs a note; only the head reopens; no jumping back and forth', () => {
  assert.match(caseChangeRefusal(c('open'), { viewer: 'member', actorId: 'u1', next: 'resolved' }), /Write what was done/);
  assert.match(caseChangeRefusal(c('open'), { viewer: 'member', actorId: 'u1', next: 'closed', note: ' ok ' }), /Write what was done/, 'two letters is not a note');
  assert.equal(caseChangeRefusal(c('open'), { viewer: 'member', actorId: 'u1', next: 'resolved', note: 'Refunded the trial fee' }), null);
  assert.equal(caseChangeRefusal(c('in_progress', 'u1', { resolutionNote: 'Called and apologised' }), { viewer: 'member', actorId: 'u1', next: 'resolved' }), null, 'a note already written counts');
  assert.match(caseChangeRefusal(c('resolved'), { viewer: 'member', actorId: 'u1', next: 'open' }), /Only the CRM Head can reopen/);
  assert.equal(caseChangeRefusal(c('resolved'), { viewer: 'head', actorId: 'u9', next: 'open' }), null);
  assert.match(caseChangeRefusal(c('resolved'), { viewer: 'head', actorId: 'u9', next: 'closed' }), /cannot become closed/);
  assert.equal(caseChangeRefusal(c('open'), { viewer: 'member', actorId: 'u1', next: 'open' }), null, 'no change is no refusal');
});

test('the case number: CC-YYMMDD (IST) and four characters', () => {
  assert.match(caseNumberCandidate(new Date('2026-11-17T20:00:00Z')), /^CC-261118-[0-9A-Z]{4}$/, '1:30 AM IST on the 18th');
});
