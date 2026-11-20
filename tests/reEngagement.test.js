// Past clients due a re-touch (utils/reEngagement.js): node --test tests/reEngagement.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { reEngagementCutoff, reEngagementList } from '../utils/reEngagement.js';

const now = new Date('2026-11-17T12:00:00+05:30');
const d = (s) => new Date(`${s}T10:00:00+05:30`);

test('one row per client — the same phone written two ways is one client — with their last event and how many bookings', () => {
  const rows = reEngagementList(
    [
      { _id: 'b1', customerName: 'Asha', phone: '+91 98950 00001', service: 'Bridal', bookingDate: d('2025-01-10') },
      { _id: 'b2', customerName: 'Asha K', phone: '9895000001', service: 'Reception', bookingDate: d('2025-03-02') },
      { _id: 'b3', customerName: 'Bina', phone: '9895000002', bookingDate: d('2024-12-01') },
    ],
    { cutoff: d('2026-05-17'), now }
  );
  assert.deepEqual(rows.map((r) => [r.phoneKey, r.customerName, r.bookings, String(r.lastBookingId)]), [
    ['9895000002', 'Bina', 1, 'b3'],
    ['9895000001', 'Asha K', 2, 'b2'],
  ], 'the longest-waiting first; the latest booking names the client');
  assert.equal(rows[1].phone, '9895000001', 'the phone as last written');
  assert.equal(rows[1].service, 'Reception');
  assert.equal(rows[1].monthsSince, 20);
});

test('a client with any event after the cutoff is not due; the event (serviceStart) wins over the booking date', () => {
  const rows = reEngagementList(
    [
      { _id: 'b1', phone: '9895000001', bookingDate: d('2025-01-10') },
      { _id: 'b2', phone: '9895000001', bookingDate: d('2026-08-01') },
      { _id: 'b3', phone: '9895000002', bookingDate: d('2025-01-01'), serviceStart: d('2026-09-01') },
    ],
    { cutoff: d('2026-05-17'), now }
  );
  assert.deepEqual(rows, []);
});

test('no phone or no date: left out (not a crash, not a client)', () => {
  assert.deepEqual(reEngagementList([{ _id: 'x', phone: '', bookingDate: d('2020-01-01') }, { _id: 'y', phone: '9895000003' }], { cutoff: now, now }), []);
});

test('the cutoff: months back from now, 1 to 60, 6 when not given', () => {
  assert.equal(reEngagementCutoff(undefined, now).months, 6);
  assert.equal(reEngagementCutoff('0', now).months, 6, '0 is no answer');
  assert.equal(reEngagementCutoff(999, now).months, 60);
  assert.equal(reEngagementCutoff(-3, now).months, 1);
  const { cutoff } = reEngagementCutoff(6, now);
  assert.equal(cutoff.toISOString().slice(0, 10), '2026-05-17');
});
