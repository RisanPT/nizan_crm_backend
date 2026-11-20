// The CRM figures (utils/crmStats.js) and NPS (utils/nps.js): node --test tests/crmStats.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingsByPhone, caseStats, chatEpisodes, chatStats, kpisOf, measure, median, pct, reEngagementStats, requestStats, reviewStats, trialStats } from '../utils/crmStats.js';
import { npsOf } from '../utils/nps.js';

const at = (s) => new Date(`2026-11-${s}+05:30`); // at('10T09:00:00')
const win = { start: at('01T00:00:00'), end: at('30T23:59:59.999') };
const A = 'u-asha';
const B = 'u-bina';

test('median, percentage: nothing to go on is null, not 0', () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(pct(1, 3), 33.3);
  assert.equal(pct(0, 0), null);
  assert.equal(pct(0, 4), 0);
});

test('NPS: % promoters − % detractors; no answers is no score', () => {
  assert.deepEqual(npsOf([10, 9, 8, 6, 0, null, '']), { nps: 0, promoters: 2, passives: 1, detractors: 2, responses: 5 });
  assert.equal(npsOf([10, 10, 7]).nps, 67);
  assert.equal(npsOf([null, undefined]).nps, null);
});

const req = (arrived, decided, decision, extra = {}) => ({
  statusHistory: [{ status: 'pending', at: at(arrived) }],
  createdAt: at('01T00:00:00'),
  requestDecidedAt: decided ? at(decided) : null,
  requestDecision: decision ?? '',
  ...extra,
});

test('requests: received in the period, decided in the period, handling time from arrival — credited to the owner', () => {
  const rows = [
    req('10T09:00:00', '10T15:00:00', 'confirmed', { crmOwnerId: A, decidedOwnerId: A, requestDecidedBy: B }),
    req('10T09:00:00', '12T09:00:00', 'rejected', { crmOwnerId: B, decidedOwnerId: B, requestDecidedBy: B }),
    req('11T09:00:00', null, null, { crmOwnerId: A }),
    // arrived last month, decided this month: decided counts, received does not
    { statusHistory: [{ at: new Date('2026-10-31T20:00:00+05:30') }], requestDecidedAt: at('01T08:00:00'), requestDecision: 'confirmed', requestDecidedBy: A },
  ];
  const team = requestStats(rows, win, { slaHours: 24 });
  assert.deepEqual(team, { received: 3, decided: 3, confirmed: 2, confirmRate: 66.7, medianHours: 12, withinSlaPct: 66.7 });
  const asha = requestStats(rows, win, { slaHours: 24, memberId: A });
  assert.deepEqual([asha.received, asha.decided, asha.medianHours], [2, 2, 9], 'Asha owned one she did not press the button on, and decided an unowned one');
  assert.equal(requestStats([], win, { slaHours: 24 }).medianHours, null);
});

const msg = (c, type, t, by = null) => ({ conversationId: c, senderType: type, createdAt: at(t), senderId: by });

test('chat waits: back-to-back client messages are one wait; the first staff reply ends it; system messages do nothing', () => {
  const eps = chatEpisodes([
    msg('c1', 'client', '10T09:00:00'),
    msg('c1', 'client', '10T09:05:00'),
    msg('c1', 'system', '10T09:06:00'),
    msg('c1', 'staff', '10T09:30:00', A),
    msg('c1', 'staff', '10T09:31:00', B),
    msg('c1', 'client', '10T10:00:00'),
    msg('c2', 'staff', '10T08:00:00', B), // staff first: no wait
    msg('c2', 'client', '10T11:00:00'), // never answered
  ]);
  assert.deepEqual(
    eps.map((e) => [e.conversationId, e.clientAt.toISOString().slice(11, 16), e.replyAt?.toISOString().slice(11, 16) ?? null, e.replierId]),
    [
      ['c1', '03:30', '04:00', A],
      ['c1', '04:30', null, null],
      ['c2', '05:30', null, null],
    ]
  );
});

test('chat figures: reply time of the answered, in time of the waits whose fate is known, unanswered past the hours', () => {
  const eps = [
    { conversationId: 'c1', clientAt: at('10T09:00:00'), replyAt: at('10T09:30:00'), replierId: A },
    { conversationId: 'c2', clientAt: at('10T09:00:00'), replyAt: at('10T12:00:00'), replierId: B },
    { conversationId: 'c3', clientAt: at('10T09:00:00'), replyAt: null, replierId: null }, // left waiting
    { conversationId: 'c4', clientAt: at('20T09:50:00'), replyAt: null, replierId: null }, // 10 minutes old: fate unknown
  ];
  const now = at('20T10:00:00');
  const team = chatStats(eps, win, { slaMins: 60, unansweredHours: 4, now });
  assert.deepEqual(team, { conversations: 4, waits: 4, answered: 2, medianReplyMins: 105, withinSlaPct: 33.3, unanswered: 1 });
  const asha = chatStats(eps, win, { slaMins: 60, unansweredHours: 4, now, memberId: A, assigneeOf: (c) => (c === 'c3' ? A : '') });
  assert.deepEqual([asha.waits, asha.answered, asha.medianReplyMins, asha.unanswered], [2, 1, 30, 1], 'her reply, and the chat she holds that was left waiting');
  assert.equal(chatStats([], win, { slaMins: 60, unansweredHours: 4, now }).withinSlaPct, null);
});

test('reviews: sent and answered in the period, response rate of those sent, NPS and rating of those answered', () => {
  const rows = [
    { booking: 'b1', sentAt: at('02T10:00:00'), submittedAt: at('03T10:00:00'), nps: 10, overall: 5 },
    { booking: 'b2', sentAt: at('02T10:00:00'), submittedAt: null },
    { booking: 'b3', sentAt: new Date('2026-10-20T10:00:00+05:30'), submittedAt: at('04T10:00:00'), nps: 3, overall: 2, complaint: true },
  ];
  const team = reviewStats(rows, win);
  assert.deepEqual(team, { sent: 2, submitted: 2, responseRate: 50, nps: 0, npsResponses: 2, promoters: 1, detractors: 1, avgRating: 3.5, complaints: 1 });
  const asha = reviewStats(rows, win, { memberId: A, ownerOf: (b) => (b === 'b1' ? A : B) });
  assert.deepEqual([asha.sent, asha.submitted, asha.nps], [1, 1, 100]);
});

test('cases: opened, resolved (on time by the due time), closed is not resolved, resolution rate of those opened', () => {
  const rows = [
    { kind: 'complaint', status: 'resolved', ownerId: A, createdAt: at('05T10:00:00'), dueAt: at('07T10:00:00'), resolvedAt: at('07T10:00:00') },
    { kind: 'follow_up', status: 'resolved', ownerId: B, createdAt: at('05T10:00:00'), dueAt: at('06T10:00:00'), resolvedAt: at('08T10:00:00') },
    { kind: 'complaint', status: 'closed', ownerId: A, createdAt: at('05T10:00:00'), dueAt: at('06T10:00:00'), closedAt: at('06T10:00:00') },
    { kind: 'complaint', status: 'open', ownerId: A, createdAt: at('09T10:00:00'), dueAt: at('11T10:00:00') },
  ];
  assert.deepEqual(caseStats(rows, win), { opened: 4, complaints: 3, resolved: 2, closed: 1, resolutionRate: 50, onTimePct: 50, avgResolveHours: 60 });
  assert.deepEqual(caseStats(rows, win, { memberId: A }), { opened: 3, complaints: 3, resolved: 1, closed: 1, resolutionRate: 33.3, onTimePct: 100, avgResolveHours: 48 });
});

test('trials: converted by link or by a booking within the window; still-maturing ones wait; ones for an existing booking do not count', () => {
  const byPhone = bookingsByPhone([
    { phone: '+91 98950 00001', createdAt: at('20T10:00:00') }, // 10 days after the 10th's trial
    { phone: '9895000002', createdAt: new Date('2027-02-01T10:00:00+05:30') }, // too late
  ]);
  const t = (phone, trialDate, status, extra = {}) => ({ phone, trialDate, status, ...extra });
  const rows = [
    t('9895000001', '2026-11-10', 'completed', { crmOwnerId: A }),
    t('9895000002', '2026-09-01', 'completed', { crmOwnerId: A }), // window closed, not converted
    t('9895000003', '2026-11-12', 'completed', { crmOwnerId: B }), // maturing
    t('9895000004', '2026-11-12', 'completed', { convertedBookingId: 'bk' }),
    t('9895000005', '2026-11-12', 'completed', { bookingId: 'parent' }),
    t('9895000006', '2026-11-14', 'scheduled'),
    t('9895000007', '2026-11-14', 'cancelled'),
  ];
  const now = at('25T10:00:00');
  assert.deepEqual(trialStats(rows, byPhone, { conversionDays: 60, now }), { scheduled: 6, completed: 5, alreadyBooked: 1, converted: 2, maturing: 1, conversionPct: 66.7 });
  assert.deepEqual(trialStats(rows, byPhone, { conversionDays: 60, now, memberId: A }).conversionPct, 50);
});

test('re-engagement: calls in the period; a case belongs to the period of its FIRST contact; won if marked or the client booked in time', () => {
  const byPhone = bookingsByPhone([{ phone: '9895000001', createdAt: new Date('2026-12-15T10:00:00+05:30') }]);
  const call = (t, by = A, type = 'call') => ({ type, at: at(t), by });
  const rows = [
    { phone: '9895000001', ownerId: A, activities: [call('10T10:00:00'), call('12T10:00:00', A, 'whatsapp'), { type: 'note', at: at('12T11:00:00'), by: A }] }, // books next month: won
    { phone: '9895000002', ownerId: A, outcome: 'won', activities: [call('11T10:00:00')] },
    { phone: '9895000003', ownerId: B, activities: [call('11T10:00:00', B)] },
    { phone: '9895000004', ownerId: B, activities: [{ type: 'call', at: new Date('2026-10-30T10:00:00+05:30'), by: B }, call('02T10:00:00', B)] }, // first contact last month
  ];
  assert.deepEqual(reEngagementStats(rows, byPhone, win, { winDays: 90 }), { calls: 5, contacted: 3, won: 2, winRate: 66.7 });
  assert.deepEqual(reEngagementStats(rows, byPhone, win, { winDays: 90, memberId: B }), { calls: 2, contacted: 1, won: 0, winRate: 0 });
  assert.equal(reEngagementStats(rows, byPhone, win, { winDays: 20 }).won, 1, 'booked 65 days after: past a 20-day window');
});

const ctx = (extra = {}) => ({
  settings: { requestSlaHours: 24, chatResponseSlaMins: 60, chatUnansweredHours: 4, trialConversionDays: 60, reEngagementWinDays: 90 },
  trackingSince: at('15T00:00:00'),
  now: at('25T00:00:00'),
  assigneeOf: () => '',
  ownerOf: () => '',
  ...extra,
});
const empty = { requests: [], episodes: [], confirmations: [], reviews: [], cases: [], trials: [], reEngagement: [], reCases: [], byPhone: new Map() };

test('a period that ended before the records began: the tracked figures are "—", the rest are real', () => {
  const october = { start: new Date('2026-10-01T00:00:00+05:30'), end: new Date('2026-10-31T23:59:59.999+05:30') };
  const data = { ...empty, confirmations: [{ createdAt: new Date('2026-10-05T10:00:00+05:30'), sentBy: A }] };
  const team = measure(data, october, ctx());
  assert.equal(team.requests.received, null);
  assert.equal(team.cases.opened, null);
  assert.equal(team.reEngagement.calls, null);
  assert.equal(team.reviews.sent, 0, 'reviews are known for the past, team-wide');
  assert.equal(team.chats.waits, 0);
  assert.equal(team.confirmations.sent, 1);
  const asha = measure(data, october, ctx({ memberId: A }));
  assert.equal(asha.reviews.sent, null, 'per person, who owned a review\'s booking was not recorded then');
  assert.equal(asha.trials.completed, null);
  assert.equal(asha.confirmations.sent, 1);
  // a period that reaches past the start is measured (the app marks it "partial")
  assert.equal(measure(data, win, ctx()).requests.received, 0);
});

test('a period counts the trials held in it (IST days), not every trial loaded', () => {
  const trials = [
    { phone: '1', trialDate: '2026-10-31', status: 'completed' },
    { phone: '2', trialDate: '2026-11-01', status: 'completed' },
    { phone: '3', trialDate: '2026-11-30', status: 'completed' },
    { phone: '4', trialDate: '2026-12-01', status: 'completed' },
  ];
  assert.equal(measure({ ...empty, trials }, win, ctx()).trials.completed, 2);
});

test('the KPI cards: value, the previous period, how many records, which way is good', () => {
  const cur = measure(empty, win, ctx());
  const k = kpisOf(cur, { ...cur, requests: { ...cur.requests, received: 4 } });
  assert.deepEqual(k.requestsReceived, { value: 0, prev: 4, n: 0, unit: 'count', better: 'up' });
  assert.deepEqual(k.chatMedianReplyMins, { value: null, prev: null, n: 0, unit: 'mins', better: 'down' });
  assert.equal(kpisOf(cur, null).nps.prev, null);
});
