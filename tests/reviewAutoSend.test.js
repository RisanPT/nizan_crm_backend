// Day-after-the-event review auto-send, with the models and TeamN Chat stubbed out:
// no database, no network.   node --test tests/reviewAutoSend.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Review from '../models/Review.js';
import Booking from '../models/Booking.js';
import {
  MAX_ATTEMPTS,
  classifyResult,
  eventTiming,
  formatWorkDate,
  lastEventDay,
  runReviewAutoSend,
} from '../services/reviewAutoSend.js';

const mongoose = Review.base;
const oid = () => new mongoose.Types.ObjectId();

// 6 Nov 2026, 10:05 IST
const NOW = new Date('2026-11-06T04:35:00.000Z');

const chain = (value) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
};

const stub = (t, target, name, impl) => {
  const original = target[name];
  target[name] = impl;
  t.after(() => {
    target[name] = original;
  });
};

const withEnv = (t, vars) => {
  const before = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
};

const review = (over = {}) => ({
  _id: oid(),
  token: 'tok123',
  booking: oid(),
  bookingNumber: 'NB-1234',
  brideName: 'Anjali Menon',
  weddingDate: new Date('2026-11-04T18:30:00.000Z'), // 5 Nov IST
  customerPhone: '9876543210',
  status: 'pending',
  autoSendStatus: '',
  autoSendAttempts: 0,
  createdAt: new Date('2026-11-05T12:00:00.000Z'),
  ...over,
});

// Wires the stubs for one run. `reviews` are the due ones; returns what the
// run did: the sends made and the final $set per review id.
const setup = (t, reviews, { booking = { status: 'Completed' }, claim = true } = {}) => {
  const bookingFor = (r) => ({ _id: r.booking, phone: '', customerName: '', selectedDates: ['2026-11-05'], ...booking });
  withEnv(t, { REVIEW_AUTO_SEND_FROM: '2026-11-05', TEAMN_CHAT_KEY: 'tnm_test' });
  const byId = new Map(reviews.map((r) => [String(r._id), r]));
  const finals = new Map();
  let findQuery = null;
  stub(t, Review, 'find', (q) => {
    findQuery = q;
    return chain(reviews.map((r) => ({ _id: r._id, autoSendStatus: r.autoSendStatus, booking: r.booking })));
  });
  stub(t, Review, 'findOneAndUpdate', async (filter, update) => {
    if (!claim) return null;
    const r = byId.get(String(filter._id));
    r.autoSendStatus = 'sending';
    r.autoSendAttempts += update.$inc.autoSendAttempts;
    return r;
  });
  stub(t, Review, 'updateOne', async (filter, update) => {
    finals.set(String(filter._id), update.$set);
  });
  stub(t, Booking, 'find', () => chain(booking ? reviews.map(bookingFor) : []));
  return { finals, query: () => findQuery };
};

const okSend = (calls) => async (payload) => {
  calls.push(payload);
  return { status: 200, body: { ok: true, duplicate: false, message_id: 'wamid.1', channel: 'crm' } };
};

test('formatWorkDate gives the long IST date the template expects', () => {
  assert.equal(formatWorkDate(new Date('2026-11-03T20:00:00.000Z')), '4 November 2026');
});

test("the event's last day is the latest selected date, else the booking date", () => {
  assert.equal(lastEventDay({ selectedDates: ['2026-12-14'], bookingItems: [{ selectedDates: ['2026-12-15'] }] }), '2026-12-15');
  assert.equal(lastEventDay({ selectedDates: ['2026-12-15', '2026-12-14'] }), '2026-12-15');
  // No selected dates: the booking date, as an IST day (18:30Z = midnight IST).
  assert.equal(lastEventDay({ selectedDates: [], bookingDate: new Date('2026-11-10T18:30:00.000Z') }), '2026-11-11');
  assert.equal(lastEventDay({}), null);
});

test('a review goes out the morning after the event, never before or weeks later', () => {
  const from = '2026-11-11';
  assert.equal(eventTiming('2026-11-12', '2026-11-13', from), 'send'); // ended yesterday
  assert.equal(eventTiming('2026-11-13', '2026-11-13', from), 'wait'); // event is today
  assert.equal(eventTiming('2026-12-25', '2026-11-13', from), 'wait'); // booked for later
  assert.equal(eventTiming('2026-11-10', '2026-11-13', from), 'stale'); // before go-live
  assert.equal(eventTiming('2026-11-11', '2026-11-19', from), 'stale'); // 8 days ago
  assert.equal(eventTiming('2026-11-12', '2026-11-19', from), 'send'); // 7 days ago
  assert.equal(eventTiming(null, '2026-11-13', from), 'stale');
});

test('the feature is off without REVIEW_AUTO_SEND_FROM or the TeamN Chat key', async (t) => {
  let sends = 0;
  const send = async () => (sends += 1);
  withEnv(t, { REVIEW_AUTO_SEND_FROM: undefined, TEAMN_CHAT_KEY: 'tnm_test' });
  assert.match((await runReviewAutoSend({ now: NOW, send, gapMs: 0 })).stopped, /REVIEW_AUTO_SEND_FROM/);
  process.env.REVIEW_AUTO_SEND_FROM = 'not-a-date';
  assert.match((await runReviewAutoSend({ now: NOW, send, gapMs: 0 })).stopped, /REVIEW_AUTO_SEND_FROM/);
  process.env.REVIEW_AUTO_SEND_FROM = '2026-11-05';
  delete process.env.TEAMN_CHAT_KEY;
  assert.match((await runReviewAutoSend({ now: NOW, send, gapMs: 0 })).stopped, /TEAMN_CHAT_KEY/);
  assert.equal(sends, 0);
});

test('sends the review_request template with the right values and records it', async (t) => {
  const r = review();
  const { finals, query } = setup(t, [r]);
  const calls = [];
  const summary = await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });

  assert.equal(summary.sent, 1);
  assert.deepEqual(calls[0], {
    template: 'review_request',
    channel: 'crm',
    phone: '919876543210',
    customerName: 'Anjali Menon',
    reference: 'NB-1234',
    bodyParams: ['Anjali Menon', '5 November 2026'],
    buttonParams: ['tok123'],
    sentBy: 'CRM auto',
  });
  const set = finals.get(String(r._id));
  assert.equal(set.autoSendStatus, 'sent');
  assert.equal(set.autoMessageId, 'wamid.1');

  // Only pending, never-hand-sent reviews made since go-live are looked at.
  const q = query();
  assert.equal(q.status, 'pending');
  assert.equal(q.manualSentAt, null);
  assert.equal(q.createdAt.$gte.toISOString(), '2026-11-04T18:30:00.000Z'); // 5 Nov IST
});

test('a booking marked Completed before its event waits for the day after it', async (t) => {
  const calls = [];
  // Booked for 25 Dec and marked Completed early by mistake.
  const early = review();
  const s = setup(t, [early], { booking: { status: 'Completed', selectedDates: ['2026-12-25'] } });
  const summary = await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });
  assert.equal(calls.length, 0);
  assert.equal(summary.waiting, 1);
  assert.equal(s.finals.has(String(early._id)), false); // untouched: tried again on 26 Dec
});

test("a wedding and reception on two days waits until after the second day", async (t) => {
  const calls = [];
  const r = review();
  setup(t, [r], {
    booking: { status: 'Completed', selectedDates: ['2026-11-05'], bookingItems: [{ selectedDates: ['2026-11-06'] }] },
  });
  const summary = await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 }); // 6 Nov
  assert.equal(calls.length, 0);
  assert.equal(summary.waiting, 1);
});

test('an old booking re-saved after go-live is never sent', async (t) => {
  const calls = [];
  const old = review();
  const s = setup(t, [old], { booking: { status: 'Completed', selectedDates: ['2026-08-14'] } });
  await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });
  assert.equal(calls.length, 0);
  assert.equal(s.finals.get(String(old._id)).autoSendStatus, 'skipped');
  assert.match(s.finals.get(String(old._id)).autoSendError, /before go-live or more than 7 days ago/);
});

test('waits on a booking not completed; skips legacy bookings and missing phones', async (t) => {
  const calls = [];
  // Not completed (yet): left alone, it may still be marked completed.
  const notDone = review();
  let s = setup(t, [notDone], { booking: { status: 'Confirmed' } });
  const waited = await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });
  assert.equal(waited.waiting, 1);
  assert.equal(s.finals.has(String(notDone._id)), false);

  const noPhone = review({ customerPhone: '' });
  s = setup(t, [noPhone]);
  await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });
  assert.equal(s.finals.get(String(noPhone._id)).autoSendError, 'No valid phone number');

  const legacy = review();
  s = setup(t, [legacy], { booking: { status: 'completed', legacyBooking: true } });
  await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });
  assert.equal(s.finals.get(String(legacy._id)).autoSendStatus, 'skipped');

  assert.equal(calls.length, 0);
});

test('a review another run already claimed is not sent again', async (t) => {
  setup(t, [review()], { claim: false });
  const calls = [];
  const summary = await runReviewAutoSend({ now: NOW, send: okSend(calls), gapMs: 0 });
  assert.equal(calls.length, 0);
  assert.equal(summary.sent, 0);
});

test('a duplicate answer from TeamN Chat counts as already sent', async (t) => {
  const r = review();
  const { finals } = setup(t, [r]);
  const summary = await runReviewAutoSend({
    now: NOW,
    send: async () => ({
      status: 200,
      body: { ok: true, duplicate: true, message_id: 'wamid.first', sent_at: '2026-11-05T04:30:02.000Z' },
    }),
    gapMs: 0,
  });
  assert.equal(summary.duplicate, 1);
  assert.equal(finals.get(String(r._id)).autoSendStatus, 'sent');
  assert.equal(finals.get(String(r._id)).autoSentAt.toISOString(), '2026-11-05T04:30:02.000Z');
});

test('a key or template problem stops the run and retries tomorrow', async (t) => {
  const a = review();
  const b = review();
  const { finals } = setup(t, [a, b]);
  const calls = [];
  const summary = await runReviewAutoSend({
    now: NOW,
    send: async (p) => {
      calls.push(p);
      return { status: 422, body: { ok: false, error: 'Template not approved' } };
    },
    gapMs: 0,
  });
  assert.equal(calls.length, 1); // b was never tried
  assert.equal(finals.get(String(a._id)).autoSendStatus, 'retry');
  assert.equal(finals.has(String(b._id)), false);
  assert.equal(summary.stopped, 'Template not approved');
});

test('opted-out clients are skipped and bad data fails without stopping the run', async (t) => {
  const optedOut = review();
  const bad = review();
  const fine = review();
  const { finals } = setup(t, [optedOut, bad, fine]);
  const answers = [
    { status: 409, body: { ok: false, error: 'opted_out', detail: 'The customer has opted out.' } },
    { status: 400, body: { ok: false, error: 'body_params[1] is missing' } },
    { status: 200, body: { ok: true, message_id: 'wamid.3' } },
  ];
  const summary = await runReviewAutoSend({ now: NOW, send: async () => answers.shift(), gapMs: 0 });
  assert.equal(finals.get(String(optedOut._id)).autoSendStatus, 'skipped');
  assert.equal(finals.get(String(bad._id)).autoSendStatus, 'failed');
  assert.equal(finals.get(String(fine._id)).autoSendStatus, 'sent');
  assert.deepEqual([summary.skipped, summary.failed, summary.sent], [1, 1, 1]);
});

test('temporary errors retry until the attempt limit, then fail', () => {
  const refused = { status: 502, body: { ok: false, error: 'WhatsApp refused' } };
  assert.deepEqual(classifyResult(refused, 1), { kind: 'retry', stopRun: false, error: 'WhatsApp refused' });
  assert.equal(classifyResult(refused, MAX_ATTEMPTS).kind, 'failed');
  assert.equal(classifyResult({ status: 504, body: { ok: false, error: 'timeout' } }, 1).stopRun, true);
  assert.equal(classifyResult({ status: 401, body: { ok: false, error: 'key' } }, 1).stopRun, true);
});
