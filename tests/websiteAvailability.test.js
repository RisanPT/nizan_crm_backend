// Pure unit tests (no database): node --test tests/websiteAvailability.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDayStatuses,
  dayRange,
  isAllowedMonth,
  monthRange,
  statusFor,
} from '../utils/websiteAvailability.js';

const range = (from, to) => ({ start: new Date(`${from}T00:00:00Z`), end: new Date(`${to}T00:00:00Z`) });
const defaults = { morning: 3, evening: 3 };

test('statusFor: full / few / available', () => {
  assert.equal(statusFor(0, 3), 'full');
  assert.equal(statusFor(2, 3), 'few');
  assert.equal(statusFor(3, 3), 'available');
  assert.equal(statusFor(5, 0), 'full'); // no capacity at all
});

test('empty day is available in both halves', () => {
  const days = buildDayStatuses({ ...range('2026-12-01', '2026-12-02'), defaults, todayIso: '2026-11-16' });
  assert.deepEqual(days['2026-12-01'], {
    status: 'available',
    morning: { status: 'available' },
    evening: { status: 'available' },
  });
});

test('bookings fill the right half; cancelled ones do not count', () => {
  const at = new Date('2026-12-01T00:00:00Z');
  const days = buildDayStatuses({
    ...range('2026-12-01', '2026-12-02'),
    defaults,
    todayIso: '2026-11-16',
    bookings: [
      { bookingDate: at, eventSlot: 'Muhurtham', status: 'confirmed' },
      { bookingDate: at, eventSlot: 'Morning event', status: 'pending' },
      { bookingDate: at, eventSlot: 'Morning', status: 'confirmed' },
      { bookingDate: at, eventSlot: 'Evening reception', status: 'confirmed' },
      { bookingDate: at, eventSlot: 'Evening', status: 'cancelled' },
    ],
  });
  const d = days['2026-12-01'];
  assert.equal(d.morning.status, 'full');
  assert.equal(d.evening.status, 'few'); // 2 of 3 left
  assert.equal(d.status, 'few'); // 2 of 6 left in total
});

test('holds count, full-day hold uses both halves', () => {
  const days = buildDayStatuses({
    ...range('2026-12-02', '2026-12-03'),
    defaults: { morning: 1, evening: 1 },
    todayIso: '2026-11-16',
    holds: [{ dateStr: '2026-12-02', slot: 'Full day' }],
  });
  assert.equal(days['2026-12-02'].status, 'full');
});

test('override capacity, blocked date and past days', () => {
  const days = buildDayStatuses({
    ...range('2026-11-15', '2026-11-19'),
    defaults,
    todayIso: '2026-11-16',
    overrides: [{ date: new Date('2026-11-17T00:00:00Z'), morning: 0, evening: 10 }],
    blockedDates: [new Date('2026-11-18T00:00:00Z')],
  });
  assert.equal(days['2026-11-15'].status, 'past');
  assert.equal(days['2026-11-16'].status, 'available'); // today is still bookable
  assert.equal(days['2026-11-17'].morning.status, 'full');
  assert.equal(days['2026-11-17'].evening.status, 'available');
  assert.equal(days['2026-11-18'].status, 'blocked');
  assert.equal(Object.keys(days).length, 4);
});

test('output carries no counts', () => {
  const days = buildDayStatuses({ ...range('2026-12-01', '2026-12-02'), defaults, todayIso: '2026-11-16' });
  assert.doesNotMatch(JSON.stringify(days), /capacity|booked|available":\s*\d/);
});

test('month and day parsing', () => {
  assert.equal(monthRange('2026-13'), null);
  assert.equal(monthRange('2026-12').end.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(dayRange('2026-02-31'), null);
  assert.equal(dayRange('2026-12-05').start.toISOString(), '2026-12-05T00:00:00.000Z');
});

test('only current month to 18 months ahead is allowed', () => {
  assert.equal(isAllowedMonth('2026-10', '2026-11-16'), false);
  assert.equal(isAllowedMonth('2026-11', '2026-11-16'), true);
  assert.equal(isAllowedMonth('2028-05', '2026-11-16'), true);
  assert.equal(isAllowedMonth('2028-06', '2026-11-16'), false);
});
