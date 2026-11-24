// No database: the models' query methods are replaced with in-memory fakes.
//   node --test tests/driverDayService.test.js
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Employee from '../models/Employee.js';
import { applyDriverDay, prepareDriverDay } from '../services/driverDay.js';

// Anything not faked fails at once instead of waiting for a connection that never comes.
mongoose.set('bufferCommands', false);

const oid = () => new mongoose.Types.ObjectId();
const NIHALA = oid();
const D1 = oid();
const D2 = oid();
const V1 = oid();

const work = (n, extra = {}) => ({
  _id: oid(),
  bookingNumber: n,
  customerName: `Client ${n}`,
  status: 'confirmed',
  selectedDates: ['2026-11-20'],
  serviceStart: new Date('2026-11-20T09:00:00+05:30'),
  serviceEnd: new Date('2026-11-20T12:00:00+05:30'),
  assignedStaff: [{ employeeId: NIHALA, artistName: 'Nihala', roleType: 'lead' }],
  bookingItems: [],
  driverId: null,
  vehicleId: null,
  tripStatus: 'unassigned',
  ...extra,
});

const query = (rows) => ({ select: () => ({ lean: async () => rows }) });

const fakeDb = (rows) => {
  const writes = [];
  mock.method(Booking, 'find', () => query(rows));
  mock.method(Employee, 'find', () =>
    query([
      { _id: D1, name: 'Ravi' },
      { _id: D2, name: 'Sajan' },
    ]),
  );
  mock.method(Employee, 'findById', () => query({ _id: D1, name: 'Ravi', phone: '9000000000' }));
  mock.method(Booking, 'updateOne', async (filter, update) => {
    writes.push({ filter, update });
    return { matchedCount: 1 };
  });
  return writes;
};

test.afterEach(() => mock.restoreAll());

test('a different driver on her other work → 409 DRIVER_DAY_CONFLICT, nothing written', async () => {
  const w2 = work('W2', { driverId: D2, driverName: 'Sajan' });
  const writes = fakeDb([w2]);
  const edited = work('W1', { driverId: D1, vehicleId: V1 });
  const r = await prepareDriverDay({ before: { driverId: null }, after: edited, confirmed: false });
  assert.equal(r.pending, null);
  assert.equal(r.conflict.code, 'DRIVER_DAY_CONFLICT');
  assert.equal(r.conflict.driverName, 'Ravi');
  assert.deepEqual(r.conflict.works.map((w) => [w.bookingNumber, w.currentDriverName]), [['W2', 'Sajan']]);
  assert.match(r.conflict.message, /#W2 · Client W2 has Sajan/);
  assert.equal(writes.length, 0);
});

test('confirmed → the other works get the driver, vehicle, trip status and driver staff entry', async () => {
  const w2 = work('W2', { driverId: D2 });
  const w3 = work('W3', { serviceStart: new Date('2026-11-20T15:00:00+05:30') });
  const writes = fakeDb([w2, w3]);
  const edited = work('W1', {
    driverId: D1,
    vehicleId: V1,
    travelMode: 'Innova (KL-11)',
    assignedStaff: [
      { employeeId: NIHALA, artistName: 'Nihala', roleType: 'lead' },
      { employeeId: D1, artistName: 'Ravi', roleType: 'driver', phone: '9000000000' },
    ],
  });
  const { conflict, pending } = await prepareDriverDay({ before: { driverId: null }, after: edited, confirmed: true });
  assert.equal(conflict, null);
  const result = await applyDriverDay({ saved: edited, pending });

  assert.deepEqual(result.assigned.map((a) => a.bookingNumber).sort(), ['W2', 'W3']);
  assert.equal(result.assigned.find((a) => a.bookingNumber === 'W2').previousDriverName, 'Sajan');
  assert.equal(result.driverName, 'Ravi');
  assert.equal(writes.length, 2);
  for (const { filter, update } of writes) {
    assert.ok(filter.tripStatus.$nin.includes('in_progress')); // never under a running trip
    const set = update.$set;
    assert.equal(String(set.driverId), String(D1));
    assert.equal(String(set.vehicleId), String(V1));
    assert.equal(set.tripStatus, 'assigned');
    assert.equal(set.travelMode, 'Innova (KL-11)');
    assert.deepEqual(set.assignedStaff.map((s) => s.roleType), ['lead', 'driver']);
    assert.equal(String(set.assignedStaff[1].employeeId), String(D1));
    assert.match(set.artistTripOtp, /^\d{4}$/);
  }
});

test('a new booking is not held up: works with another driver are left alone and reported', async () => {
  const w2 = work('W2', { driverId: D2 });
  const w3 = work('W3');
  const writes = fakeDb([w2, w3]);
  const edited = work('NEW', { _id: undefined, driverId: D1 });
  const { conflict, pending } = await prepareDriverDay({ before: null, after: edited, confirmed: false, skipOtherDrivers: true });
  assert.equal(conflict, null);
  const result = await applyDriverDay({ saved: { ...edited, _id: oid() }, pending });
  assert.deepEqual(result.assigned.map((a) => a.bookingNumber), ['W3']);
  assert.deepEqual(result.skipped.map((s) => [s.bookingNumber, s.reason]), [['W2', 'other_driver']]);
  assert.equal(writes.length, 1);
});

test('a trip that started between planning and writing is reported, not changed', async () => {
  fakeDb([work('W2')]);
  mock.method(Booking, 'updateOne', async () => ({ matchedCount: 0 }));
  const edited = work('W1', { driverId: D1 });
  const { pending } = await prepareDriverDay({ before: null, after: edited, confirmed: false });
  const result = await applyDriverDay({ saved: edited, pending });
  assert.deepEqual(result.assigned, []);
  assert.deepEqual(result.skipped.map((s) => [s.bookingNumber, s.reason]), [['W2', 'trip_started']]);
});

test('no driver change → no lookups at all', async () => {
  const find = mock.method(Booking, 'find', () => query([]));
  const edited = work('W1', { driverId: D1 });
  const r = await prepareDriverDay({ before: { driverId: D1 }, after: edited, confirmed: false });
  assert.deepEqual(r, { conflict: null, pending: null });
  assert.equal(find.mock.callCount(), 0);
  assert.equal(await applyDriverDay({ saved: edited, pending: null }), null);
});
