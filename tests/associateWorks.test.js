// Pure unit tests: node --test tests/associateWorks.test.js
// The Associate Works report: which works an associate did (a booking they are assigned to, on the booking or on an item), the days they
// are on, and the fee Accounts recorded for them — joined, never typed twice.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../utils/associateWorks.js';

const ASHA = { id: 'e1', name: 'Asha', phone: '9000000001' };
const BINU = { id: 'e2', name: 'Binu', phone: '9000000002' };
const staff = (employeeId, roleType = 'assistant', role = '') => ({ employeeId, roleType, role, artistName: 'x' });
let n = 0;
const booking = (extra = {}) => ({ _id: `b${++n}`, bookingNumber: `2611${1000 + n}`, customerName: `Bride ${n}`, service: 'Bridal', status: 'confirmed', serviceStart: '2026-11-10T05:00:00Z', selectedDates: [], bookingItems: [], assignedStaff: [], district: 'Kozhikode', region: 'Calicut', ...extra });
const payout = (employeeId, bookingId, amount, status = 'pending') => ({ employeeId, bookingId, amount, status });

test('a booking-level assignment is a work; the associate is on every day of the booking', () => {
  const b = booking({ selectedDates: ['2026-11-10', '2026-11-11'], assignedStaff: [staff('e1', 'assistant', 'Hair')] });
  const rows = A.workRows({ bookings: [b], associates: [ASHA, BINU] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].associateName, 'Asha');
  assert.equal(rows[0].days, 2);
  assert.equal(rows[0].role, 'Hair');
  assert.equal(rows[0].firstDay, '2026-11-10');
  assert.deepEqual(rows[0].services, ['Bridal']);
  assert.equal(rows[0].place, 'Kozhikode, Calicut');
});

test('an item-level assignment counts only that item\'s dates and service', () => {
  const b = booking({
    selectedDates: ['2026-11-10', '2026-11-11', '2026-11-12'],
    bookingItems: [
      { service: 'Reception', selectedDates: ['2026-11-12'], assignedStaff: [staff('e1')] },
      { service: 'Wedding', selectedDates: ['2026-11-10', '2026-11-11'], assignedStaff: [staff('e2')] },
    ],
  });
  const rows = A.workRows({ bookings: [b], associates: [ASHA, BINU] });
  const asha = rows.find((r) => r.associateId === 'e1');
  const binu = rows.find((r) => r.associateId === 'e2');
  assert.deepEqual([asha.days, asha.services], [1, ['Reception']]);
  assert.deepEqual([binu.days, binu.services], [2, ['Wedding']]);
});

test('an item with no dates inherits the booking\'s; a booking with no dates is one day', () => {
  const b = booking({ selectedDates: ['2026-11-10', '2026-11-11'], bookingItems: [{ service: 'Wedding', selectedDates: [], assignedStaff: [staff('e1')] }] });
  assert.equal(A.workRows({ bookings: [b], associates: [ASHA] })[0].days, 2);
  const single = booking({ assignedStaff: [staff('e1')] });
  assert.equal(A.workRows({ bookings: [single], associates: [ASHA] })[0].days, 1);
});

test('on both the booking and an item: one row, services and days merged once, a lead beats an assistant', () => {
  const b = booking({
    selectedDates: ['2026-11-10', '2026-11-11'],
    assignedStaff: [staff('e1', 'assistant')],
    bookingItems: [{ service: 'Reception', selectedDates: ['2026-11-11'], assignedStaff: [staff('e1', 'lead')] }],
  });
  const rows = A.workRows({ bookings: [b], associates: [ASHA] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].roleType, 'lead');
  assert.equal(rows[0].days, 2, '10 and 11 — the 11th is not counted twice');
  assert.deepEqual(rows[0].services, ['Reception']);
});

test('a driver is not a work; someone who is not an associate is not listed; dead bookings are not works', () => {
  const asDriver = booking({ assignedStaff: [staff('e1', 'driver')] });
  const stranger = booking({ assignedStaff: [staff('zz')] });
  const dead = ['cancelled', 'Canceled', 'REJECTED', 'lost'].map((status) => booking({ status, assignedStaff: [staff('e1')] }));
  assert.equal(A.workRows({ bookings: [asDriver, stranger, ...dead], associates: [ASHA] }).length, 0);
  assert.equal(A.workRows({ bookings: [booking({ status: 'completed', assignedStaff: [staff('e1')] })], associates: [ASHA] }).length, 1);
});

test('a driver listed on a package item is not a work either', () => {
  const b = booking({ bookingItems: [{ service: 'Wedding', selectedDates: ['2026-11-10'], assignedStaff: [staff('e1', 'driver')] }] });
  assert.equal(A.workRows({ bookings: [b], associates: [ASHA] }).length, 0);
  assert.equal(A.assignmentOf(b, 'e1'), null);
  // …but the same person as an assistant on that item is
  const b2 = booking({ bookingItems: [{ service: 'Wedding', selectedDates: ['2026-11-10'], assignedStaff: [staff('e1', 'driver'), staff('e1', 'assistant')] }] });
  assert.equal(A.workRows({ bookings: [b2], associates: [ASHA] }).length, 1);
});

test('fee = the associate\'s payouts on that booking; cancelled ones and other bookings\' payouts are left out; paid / owed split', () => {
  const b = booking({ assignedStaff: [staff('e1')] });
  const other = booking({ assignedStaff: [staff('e1')] });
  const rows = A.workRows({
    bookings: [b, other],
    associates: [ASHA],
    payouts: [payout('e1', b._id, 1500, 'paid'), payout('e1', b._id, 500, 'approved'), payout('e1', b._id, 300, 'pending'), payout('e1', b._id, 999, 'cancelled'), payout('e2', b._id, 777, 'paid')],
  });
  const r = rows.find((x) => x.bookingId === b._id);
  assert.deepEqual([r.fee, r.paid, r.owed, r.payout], [2300, 1500, 800, 'owed']);
  const none = rows.find((x) => x.bookingId === other._id);
  assert.deepEqual([none.fee, none.paid, none.owed, none.payout], [0, 0, 0, 'none']);
});

test('all paid → "paid"; money adds in paise without drifting', () => {
  const b = booking({ assignedStaff: [staff('e1')] });
  const r = A.workRows({ bookings: [b], associates: [ASHA], payouts: [payout('e1', b._id, 0.1, 'paid'), payout('e1', b._id, 0.2, 'paid')] })[0];
  assert.equal(r.fee, 0.3);
  assert.equal(r.payout, 'paid');
});

test('a viewer who may not see money gets the works and no figures', () => {
  const b = booking({ assignedStaff: [staff('e1')] });
  const rows = A.workRows({ bookings: [b], associates: [ASHA], payouts: [payout('e1', b._id, 1000, 'paid')], canSeeFees: false });
  assert.deepEqual([rows[0].fee, rows[0].paid, rows[0].owed, rows[0].payout], [null, null, null, null]);
  const s = A.summarize(rows);
  assert.deepEqual([s.works, s.fee, s.paid, s.owed, s.noFee], [1, null, null, null, null]);
  // a payout filter has no meaning without money: it keeps everything
  assert.equal(A.filterRows(rows, { payout: 'paid' }).length, 1);
});

test('summary and per-associate lines add up; most works first; last work day', () => {
  const b1 = booking({ serviceStart: '2026-11-03T05:00:00Z', assignedStaff: [staff('e1')], selectedDates: ['2026-11-03', '2026-11-04'] });
  const b2 = booking({ serviceStart: '2026-11-20T05:00:00Z', assignedStaff: [staff('e1'), staff('e2')] });
  const rows = A.workRows({ bookings: [b1, b2], associates: [ASHA, BINU], payouts: [payout('e1', b1._id, 1000, 'paid'), payout('e1', b2._id, 400, 'pending'), payout('e2', b2._id, 250, 'paid')] });
  const s = A.summarize(rows);
  assert.deepEqual([s.associates, s.works, s.days, s.fee, s.paid, s.owed, s.noFee], [2, 3, 4, 1650, 1250, 400, 0]);
  const lines = A.byAssociate(rows);
  assert.deepEqual(lines.map((l) => [l.name, l.works, l.days, l.fee, l.paid, l.owed, l.lastDay]), [['Asha', 2, 3, 1400, 1000, 400, '2026-11-20'], ['Binu', 1, 1, 250, 250, 0, '2026-11-20']]);
  assert.equal(lines.reduce((t, l) => t + l.fee, 0), s.fee, 'the lines add back to the total');
});

test('a work with no payout is counted as "no fee yet"', () => {
  const b = booking({ assignedStaff: [staff('e1')] });
  const rows = A.workRows({ bookings: [b], associates: [ASHA] });
  assert.equal(A.summarize(rows).noFee, 1);
});

test('filters: one associate, one payout state; search by client, booking number, associate, service or place; latest first', () => {
  const b1 = booking({ customerName: 'Anjali', serviceStart: '2026-11-03T05:00:00Z', assignedStaff: [staff('e1')] });
  const b2 = booking({ customerName: 'Meera', serviceStart: '2026-11-20T05:00:00Z', service: 'Party', assignedStaff: [staff('e1'), staff('e2')], district: 'Kochi' });
  const rows = A.workRows({ bookings: [b1, b2], associates: [ASHA, BINU], payouts: [payout('e1', b1._id, 100, 'paid')] });
  assert.equal(A.filterRows(rows, { associateId: 'e2' }).length, 1);
  assert.deepEqual(A.filterRows(rows, { payout: 'paid' }).map((r) => r.customerName), ['Anjali']);
  assert.equal(A.filterRows(rows, { payout: 'none' }).length, 2);
  assert.equal(A.searchRows(rows, 'anjali').length, 1);
  assert.equal(A.searchRows(rows, b2.bookingNumber).length, 2);
  assert.equal(A.searchRows(rows, 'binu party').length, 1);
  assert.equal(A.searchRows(rows, 'kochi').length, 2);
  assert.equal(A.searchRows(rows, '  ').length, 3);
  assert.deepEqual(A.sortRows(rows).map((r) => r.customerName), ['Meera', 'Meera', 'Anjali']);
  assert.deepEqual(A.sortRows(rows).slice(0, 2).map((r) => r.associateName), ['Asha', 'Binu'], 'same day → by name');
});

test('money paid to associates that is not on a listed work is reported beside the totals', () => {
  const b = booking({ assignedStaff: [staff('e1')] });
  const rows = A.workRows({ bookings: [b], associates: [ASHA] });
  const e = A.elsewhere({ rows, payouts: [payout('e1', b._id, 500), payout('e1', null, 300), payout('e1', 'b-out-of-period', 200), payout('e1', 'b-x', 50, 'cancelled')] });
  assert.deepEqual(e, { count: 2, amount: 500 });
});

test('nothing at all is empty, not a crash', () => {
  assert.deepEqual(A.workRows({ bookings: [], associates: [ASHA] }), []);
  assert.deepEqual(A.byAssociate([]), []);
  assert.deepEqual(A.summarize([]), { associates: 0, works: 0, days: 0, fee: 0, paid: 0, owed: 0, noFee: 0 });
  assert.deepEqual(A.elsewhere({ rows: [], payouts: [] }), { count: 0, amount: 0 });
  assert.equal(A.assignmentOf(booking(), 'e1'), null);
  assert.equal(A.workRows({ bookings: [booking({ serviceStart: 'garbage', assignedStaff: [staff('e1')] })], associates: [ASHA] })[0].firstDay, '');
});
