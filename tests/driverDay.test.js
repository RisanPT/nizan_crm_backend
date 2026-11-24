// Pure unit tests (no database): node --test tests/driverDay.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { daysOf, driverDayChange, leadIdsOf, planDriverDay, withDriverEntry } from '../utils/driverDay.js';

const NIHALA = 'a1';
const OTHER_ARTIST = 'a2';
const D1 = 'd1';
const D2 = 'd2';
const V1 = 'v1';

const lead = (employeeId) => ({ employeeId, artistName: employeeId, roleType: 'lead' });
const asst = (employeeId) => ({ employeeId, artistName: employeeId, roleType: 'assistant' });
const drv = (employeeId) => ({ employeeId, artistName: employeeId, roleType: 'driver' });

const work = (id, { day = '2026-11-20', at = '09:00', staff = [lead(NIHALA)], ...rest } = {}) => ({
  _id: id,
  bookingNumber: id,
  customerName: `Client ${id}`,
  status: 'confirmed',
  selectedDates: [day],
  serviceStart: new Date(`${day}T${at}:00+05:30`),
  serviceEnd: new Date(`${day}T${at}:00+05:30`),
  assignedStaff: staff,
  bookingItems: [],
  driverId: null,
  vehicleId: null,
  tripStatus: 'unassigned',
  ...rest,
});

const plan = (booking, before, candidates) =>
  planDriverDay({ booking, change: driverDayChange({ before, after: booking }), candidates });
const ids = (list) => list.map((u) => u.booking._id).sort();

test("Nihala's three works: a driver on one goes to the other two", () => {
  const w1 = work('w1', { driverId: D1, vehicleId: V1 });
  const p = plan(w1, { driverId: null }, [w1, work('w2', { at: '12:00' }), work('w3', { at: '16:00' })]);
  assert.deepEqual(ids(p.update), ['w2', 'w3']);
  for (const u of p.update) {
    assert.deepEqual(u.to, { driverId: D1, vehicleId: V1 });
    assert.equal(u.otherDriver, false);
  }
  assert.deepEqual(p.skipped, []);
});

test('works on another day, of another artist, or cancelled are not touched', () => {
  const w1 = work('w1', { driverId: D1 });
  const p = plan(w1, null, [
    work('nextDay', { day: '2026-11-21' }),
    work('otherArtist', { staff: [lead(OTHER_ARTIST)] }),
    work('cancelled', { status: 'cancelled' }),
    work('postponed', { status: 'Postponed' }),
    work('assistantOnly', { staff: [lead(OTHER_ARTIST), asst(NIHALA)] }),
  ]);
  assert.deepEqual(p.update, []);
  assert.deepEqual(p.skipped, []);
});

test('the IST day decides: 23:30 IST on the 20th is the 20th even though it is the 20th 18:00 UTC', () => {
  const w1 = work('w1', { driverId: D1 });
  const late = work('late', { selectedDates: [], serviceStart: new Date('2026-11-20T18:00:00Z') });
  assert.deepEqual(daysOf(late), ['2026-11-20']);
  const early = work('early', { selectedDates: [], serviceStart: new Date('2026-11-20T19:00:00Z') }); // 00:30 IST on the 21st
  assert.deepEqual(daysOf(early), ['2026-11-21']);
  assert.deepEqual(ids(plan(w1, null, [late, early]).update), ['late']);
});

test('a work that already has a different driver is flagged for confirmation', () => {
  const w1 = work('w1', { driverId: D1 });
  const p = plan(w1, null, [work('w2', { driverId: D2 }), work('w3')]);
  assert.deepEqual(ids(p.update), ['w2', 'w3']);
  assert.equal(p.update.find((u) => u.booking._id === 'w2').otherDriver, true);
  assert.equal(p.update.find((u) => u.booking._id === 'w3').otherDriver, false);
});

test("changing the day's driver moves the works that had the old one, without asking", () => {
  const w1 = work('w1', { driverId: D2 });
  const p = plan(w1, { driverId: D1 }, [work('w2', { driverId: D1 }), work('w3', { driverId: D2 })]);
  assert.deepEqual(ids(p.update), ['w2']);
  assert.equal(p.update[0].otherDriver, false);
});

test('removing the driver removes it from the works that had the same driver only', () => {
  const w1 = work('w1', { driverId: null, vehicleId: null });
  const p = plan(w1, { driverId: D1, vehicleId: V1 }, [
    work('w2', { driverId: D1, vehicleId: V1 }),
    work('w3', { driverId: D2, vehicleId: 'v9' }),
    work('w4'),
  ]);
  assert.deepEqual(ids(p.update), ['w2']);
  assert.deepEqual(p.update[0].to, { driverId: '', vehicleId: '' });
});

test('the vehicle follows the driver; a vehicle-only change moves only the works with this driver', () => {
  const w1 = work('w1', { driverId: D1, vehicleId: 'v2' });
  const p = plan(w1, { driverId: D1, vehicleId: V1 }, [
    work('w2', { driverId: D1, vehicleId: V1 }),
    work('w3', { driverId: D2, vehicleId: V1 }),
    work('w4'),
  ]);
  assert.deepEqual(ids(p.update), ['w2']);
  assert.deepEqual(p.update[0].to, { driverId: D1, vehicleId: 'v2' });
});

test('with no vehicle chosen, the other works keep their own vehicle', () => {
  const w1 = work('w1', { driverId: D1, vehicleId: null });
  const p = plan(w1, null, [work('w2', { vehicleId: 'v7' })]);
  assert.deepEqual(p.update[0].to, { driverId: D1, vehicleId: 'v7' });
});

test('a multi-day work and a work whose trip has started are reported, not changed', () => {
  const w1 = work('w1', { driverId: D1 });
  const p = plan(w1, null, [
    work('wedding', { selectedDates: ['2026-11-20', '2026-11-21'] }),
    work('rolling', { driverId: D2, tripStatus: 'in_progress' }),
  ]);
  assert.deepEqual(p.update, []);
  assert.deepEqual(
    p.skipped.map((s) => [s.booking._id, s.reason]).sort(),
    [['rolling', 'trip_started'], ['wedding', 'multi_day']],
  );
});

test('a multi-day edited work spreads to her single-day works on each of its days', () => {
  const wedding = work('wedding', { selectedDates: ['2026-11-20', '2026-11-21'], driverId: D1 });
  const p = plan(wedding, null, [work('a', { day: '2026-11-20' }), work('b', { day: '2026-11-21' }), work('c', { day: '2026-11-22' })]);
  assert.deepEqual(ids(p.update), ['a', 'b']);
});

test('nothing happens when the driver and vehicle did not change, or the edited work is cancelled', () => {
  const w1 = work('w1', { driverId: D1, vehicleId: V1 });
  assert.equal(driverDayChange({ before: { driverId: D1, vehicleId: V1 }, after: w1 }), null);
  assert.equal(driverDayChange({ before: { driverId: null }, after: work('x') }), null);
  const cancelled = work('w1', { driverId: D1, status: 'cancelled' });
  assert.deepEqual(plan(cancelled, null, [work('w2')]).update, []);
});

test('multi-artist booking: each lead artist pulls in her works; assistants do not', () => {
  const w1 = work('w1', { driverId: D1, staff: [lead(NIHALA), lead(OTHER_ARTIST), asst('a3')] });
  const p = plan(w1, null, [
    work('n', { staff: [lead(NIHALA)] }),
    work('o', { staff: [lead(OTHER_ARTIST)] }),
    work('asst', { staff: [lead('a9'), asst('a3')] }),
  ]);
  assert.deepEqual(ids(p.update), ['n', 'o']);
});

test('lead artists: per-package staff count; a lone unmarked artist counts as lead', () => {
  assert.deepEqual(leadIdsOf({ assignedStaff: [], bookingItems: [{ assignedStaff: [lead(NIHALA), drv(D1)] }] }), [NIHALA]);
  assert.deepEqual(leadIdsOf({ assignedStaff: [asst(NIHALA), drv(D1)] }), [NIHALA]);
  assert.deepEqual(leadIdsOf({ assignedStaff: [asst(NIHALA), asst(OTHER_ARTIST)] }), []);
});

test('the driver entry in the staff lists is replaced, added, or removed', () => {
  const entry = drv(D1);
  const replaced = withDriverEntry({ assignedStaff: [lead(NIHALA), drv(D2)], bookingItems: [{ assignedStaff: [drv(D2)] }, { assignedStaff: [lead(NIHALA)] }] }, entry);
  assert.deepEqual(replaced.assignedStaff.map((s) => s.employeeId), [NIHALA, D1]);
  assert.deepEqual(replaced.items[0].map((s) => s.employeeId), [D1]);
  assert.equal(replaced.items[1], null);

  const added = withDriverEntry({ assignedStaff: [lead(NIHALA)] }, entry);
  assert.deepEqual(added.assignedStaff.map((s) => s.employeeId), [NIHALA, D1]);

  const removed = withDriverEntry({ assignedStaff: [lead(NIHALA), drv(D1)] }, null);
  assert.deepEqual(removed.assignedStaff.map((s) => s.employeeId), [NIHALA]);
});
