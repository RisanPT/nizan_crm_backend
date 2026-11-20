// A booking's care (utils/crmCare.js): node --test tests/crmCare.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMedical, eventDaysOf, hasMark, isOnBookingTeam, isWork, isWorkDay, mayReadCare, setMark, worksBetween } from '../utils/crmCare.js';

const b = (extra = {}) => ({ _id: 'b1', status: 'confirmed', customerName: 'Asha', ...extra });

test('a booking\'s work days: its dates (and its packages\' dates), else its first day', () => {
  assert.deepEqual(eventDaysOf(b({ selectedDates: ['2026-11-20', '2026-11-19', '2026-11-20'] })), ['2026-11-19', '2026-11-20']);
  assert.deepEqual(eventDaysOf(b({ bookingItems: [{ selectedDates: ['2026-11-22'] }], selectedDates: ['2026-11-21'] })), ['2026-11-21', '2026-11-22']);
  assert.deepEqual(eventDaysOf(b({ serviceStart: new Date('2026-11-19T20:00:00Z') })), ['2026-11-20'], 'an instant is its IST day');
  assert.deepEqual(eventDaysOf(b()), []);
});

test('work: not a request still pending, nor cancelled / rejected / lost / a draft', () => {
  assert.equal(isWork(b()), true);
  assert.equal(isWork(b({ status: 'Completed' })), true);
  for (const s of ['pending', 'Cancelled ', 'rejected', 'lost', 'draft']) assert.equal(isWork(b({ status: s })), false, s);
});

test('the works of a stretch of days: one per booking and day, earliest first', () => {
  const rows = worksBetween(
    [
      b({ _id: 'x', customerName: 'Zara', selectedDates: ['2026-11-18', '2026-11-25'] }),
      b({ _id: 'y', customerName: 'Anu', selectedDates: ['2026-11-18'] }),
      b({ _id: 'z', status: 'cancelled', selectedDates: ['2026-11-19'] }),
    ],
    '2026-11-16',
    '2026-11-22'
  );
  assert.deepEqual(rows.map((r) => `${r.booking._id}:${r.day}`), ['y:2026-11-18', 'x:2026-11-18']);
});

test('a tick: once per day (the first one stays), untick removes it; only the booking\'s own days', () => {
  const user = { _id: 'u1', name: 'Asha' };
  const first = setMark([], '2026-11-20', true, { user, note: ' called ' });
  assert.equal(first.changed, true);
  assert.deepEqual([first.marks[0].byName, first.marks[0].note], ['Asha', 'called']);
  const again = setMark(first.marks, '2026-11-20', true, { user: { _id: 'u2', name: 'Bina' } });
  assert.deepEqual([again.changed, again.marks.length, again.marks[0].byName], [false, 1, 'Asha']);
  assert.equal(hasMark(again.marks, '2026-11-20'), true);
  const off = setMark(again.marks, '2026-11-20', false);
  assert.deepEqual([off.changed, off.marks.length], [true, 0]);
  assert.equal(setMark([], '2026-11-20', false).changed, false);
  assert.equal(isWorkDay(b({ selectedDates: ['2026-11-20'] }), '2026-11-20'), true);
  assert.equal(isWorkDay(b({ selectedDates: ['2026-11-20'] }), '2026-11-21'), false);
  assert.equal(isWorkDay(b({ selectedDates: ['2026-11-20'] }), 'nonsense'), false);
});

test('medical: conditions from the list (in its order), "other" needs a note, unknown ones are refused', () => {
  assert.deepEqual(cleanMedical({ conditions: ['Skin', 'allergy'], note: ' latex ' }), { conditions: ['allergy', 'skin'], note: 'latex' });
  assert.match(cleanMedical({ conditions: ['other'] }).error, /other condition/);
  assert.deepEqual(cleanMedical({ conditions: ['other'], note: 'asthma' }).conditions, ['other']);
  assert.match(cleanMedical({ conditions: ['flu'] }).error, /Unknown condition: flu/);
  assert.deepEqual(cleanMedical({}), { conditions: [], note: '' }, 'clearing is allowed');
});

test('who reads a client\'s medical notes: the CRM side, and the people working the booking — not sales or accounts', () => {
  const booking = b({ assignedStaff: [{ employeeId: 'e1' }], bookingItems: [{ assignedStaff: [{ employeeId: { _id: 'e2' } }] }] });
  assert.equal(isOnBookingTeam(booking, 'e1'), true);
  assert.equal(isOnBookingTeam(booking, 'e2'), true, 'on a package item');
  assert.equal(isOnBookingTeam(booking, 'e3'), false);
  assert.equal(isOnBookingTeam(booking, null), false);
  assert.equal(mayReadCare({ viewer: 'member', booking }), true);
  assert.equal(mayReadCare({ viewer: 'leadership', booking }), true);
  assert.equal(mayReadCare({ viewer: 'none', employeeId: 'e2', booking }), true, 'an artist on the booking');
  assert.equal(mayReadCare({ viewer: 'none', employeeId: 'e9', booking }), false, 'anyone else');
});
