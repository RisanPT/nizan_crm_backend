// Pure unit tests: node --test tests/crmFeed.test.js
// The CRM dashboard's recent activities and upcoming trials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { requestEvents, chatEvents, caseEvents, reviewEvents, mergeFeed, trialLine } from '../utils/crmFeed.js';

const since = new Date('2026-11-05T00:00:00Z');
const t = (s) => new Date(`2026-11-${s}Z`);

test('a booking request: it came in, and it was decided (by whom) — older than two weeks is left out', () => {
  const ev = requestEvents([
    { _id: 'b1', customerName: 'Amina K.', createdAt: t('17T08:00:00'), requestDecision: 'confirmed', requestDecidedAt: t('17T09:00:00'), requestDecidedByName: 'Bina' },
    { _id: 'b2', customerName: '', createdAt: t('01T08:00:00'), requestDecision: 'rejected', requestDecidedAt: t('16T10:00:00') },
    // back-dated, but it ARRIVED (its first recorded status) inside the two weeks
    { _id: 'b3', customerName: 'Late typed', createdAt: t('01T08:00:00'), statusHistory: [{ status: 'pending', at: t('15T08:00:00') }] },
  ], since);
  assert.deepEqual(ev.map((e) => e.text), ['New booking request from Amina K.', 'Request from Amina K. confirmed by Bina', 'Request from a client declined', 'New booking request from Late typed']);
  assert.equal(ev[0].refId, 'b1');
});

test('chat: one line per conversation — its newest message, the client waiting or the team answering', () => {
  const ev = chatEvents(
    [
      { conversationId: 'c1', senderType: 'client', createdAt: t('17T08:00:00') },
      { conversationId: 'c1', senderType: 'staff', createdAt: t('17T08:12:00') },
      { conversationId: 'c2', senderType: 'client', createdAt: t('17T09:00:00') },
      { conversationId: 'c3', senderType: 'system', createdAt: t('17T09:30:00') },
    ],
    [{ _id: 'c1', clientName: 'Bridal Enquiry' }, { _id: 'c2', clientName: 'Rizwana S.' }, { _id: 'c3', clientName: 'X' }],
  );
  assert.deepEqual(ev.map((e) => e.text).sort(), ['Client chat answered — Bridal Enquiry', 'Rizwana S. wrote in client chat']);
});

test('a case: its newest step (status with its tag, a call by whom, a note), or that it was opened', () => {
  const ev = caseEvents([
    { _id: 'k1', caseNumber: 'C-1028', status: 'in_progress', customerName: 'Fathima', createdAt: t('01T00:00:00'), activities: [{ type: 'call', at: t('10T00:00:00'), byName: 'Bina' }, { type: 'status', at: t('17T08:00:00'), text: 'in_progress' }] },
    { _id: 'k2', caseNumber: 'C-1029', status: 'open', title: 'Late arrival complaint', createdAt: t('17T07:00:00'), activities: [] },
    { _id: 'k3', caseNumber: 'C-1030', status: 'open', customerName: 'Devi', createdAt: t('01T00:00:00'), activities: [{ type: 'call', at: t('16T07:00:00'), byName: 'Asha' }] },
    { _id: 'k4', caseNumber: 'C-0001', status: 'closed', createdAt: t('01T00:00:00'), activities: [{ type: 'note', at: t('02T00:00:00') }] },
  ], since);
  assert.deepEqual(ev.map((e) => [e.text, e.tag]), [
    ['Case C-1028 updated to', 'In Progress'],
    ['Case C-1029 opened — Late arrival complaint', 'Open'],
    ['Case C-1030: Devi called by Asha', ''],
  ]);
});

test('reviews handed in, with the recommend score when given', () => {
  const ev = reviewEvents([{ _id: 'r1', brideName: 'Nasrin', nps: 9, submittedAt: t('17T06:00:00') }, { _id: 'r2', brideName: '', submittedAt: t('16T06:00:00') }, { _id: 'r3', brideName: 'Old', submittedAt: t('01T00:00:00') }], since);
  assert.deepEqual(ev.map((e) => e.text), ['Nasrin sent her review (would recommend: 9/10)', 'A bride sent her review']);
});

test('the feed: newest first, at most the limit, times as ISO', () => {
  const f = mergeFeed([[{ kind: 'a', at: t('17T08:00:00') }, { kind: 'b', at: t('17T10:00:00') }], [{ kind: 'c', at: t('17T09:00:00') }, { kind: 'bad', at: 'nonsense' }]], 2);
  assert.deepEqual(f.map((e) => e.kind), ['b', 'c']);
  assert.equal(f[0].at, '2026-11-17T10:00:00.000Z');
});

test('a trial line: the package (or look) tried, the client, day and time, the artists — never the phone', () => {
  const l = trialLine({ _id: 't1', trialNumber: 'TR-1', clientName: 'Fathima P.', phone: '9876543210', trialDate: '2026-11-18', startTime: '10:30', status: 'scheduled', trialItems: [{ packageName: '' , lookLabel: 'Bridal Trial' }], assignedStaff: [{ artistName: 'Anu' }, { artistName: '' }], crmOwnerName: 'Bina' });
  assert.deepEqual(l, { id: 't1', trialNumber: 'TR-1', clientName: 'Fathima P.', what: 'Bridal Trial', date: '2026-11-18', startTime: '10:30', status: 'scheduled', artists: ['Anu'], owner: 'Bina' });
  assert.equal(trialLine({ _id: 't2', clientName: 'X', trialDate: '2026-11-19' }).what, 'Trial');
});
