import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DURATION_MIN, DEFAULT_TRAVEL_MIN, EXCLUDED_STATUSES, HANDLING_MIN, clashesWith, driverProblems, haversineKm, isBlocking,
  istTime, paperWarnings, runsOn, statusOf, travelBetween, vehicleProblem, workWindows,
} from '../utils/fleetAvailability.js';

const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
const booking = (over = {}) => ({
  _id: 'b1', bookingNumber: 'BK-1', customerName: 'Asha', status: 'confirmed',
  selectedDates: ['2026-10-30'], serviceStart: at('2026-10-30', '09:00'), serviceEnd: at('2026-10-30', '13:00'),
  ...over,
});
const hhmm = (d) => istTime(d);

// ── the times a work takes its team out ──
test('a one-day booking: that day, from its start to its end (IST)', () => {
  const [w, ...rest] = workWindows(booking());
  assert.equal(rest.length, 0);
  assert.deepEqual([w.day, hhmm(w.start), hhmm(w.end)], ['2026-10-30', '09:00', '13:00']);
});

test('a multi-day booking: the same times on each day, not one long block', () => {
  const ws = workWindows(booking({ selectedDates: ['2026-10-30', '2026-10-31', '2026-11-01'], serviceEnd: at('2026-11-01', '13:00') }));
  assert.deepEqual(ws.map((w) => [w.day, hhmm(w.start), hhmm(w.end)]), [
    ['2026-10-30', '09:00', '13:00'], ['2026-10-31', '09:00', '13:00'], ['2026-11-01', '09:00', '13:00'],
  ]);
  assert.equal(ws[0].end.getTime() < ws[1].start.getTime(), true, 'the nights are free');
});

test('package times win over the booking\'s, per day; a day with several packages is one window', () => {
  const ws = workWindows(booking({
    selectedDates: ['2026-10-30', '2026-10-31'],
    bookingItems: [
      { selectedDates: ['2026-10-30'], startTime: '06:00', endTime: '10:00' },
      { selectedDates: ['2026-10-30'], startTime: '16:00', endTime: '20:30' },
      { selectedDates: ['2026-10-31'], startTime: '', endTime: '' },
    ],
  }));
  assert.deepEqual(ws.map((w) => [w.day, hhmm(w.start), hhmm(w.end)]), [
    ['2026-10-30', '06:00', '20:30'], ['2026-10-31', '09:00', '13:00'],
  ]);
});

test('a package with no dates of its own runs on all the booking\'s days', () => {
  const ws = workWindows(booking({ selectedDates: ['2026-10-30', '2026-10-31'], bookingItems: [{ startTime: '07:00', endTime: '09:00' }] }));
  assert.deepEqual(ws.map((w) => [w.day, hhmm(w.start), hhmm(w.end)]), [['2026-10-30', '07:00', '09:00'], ['2026-10-31', '07:00', '09:00']]);
});

test('an end that is not after the start lasts the default 4 hours', () => {
  assert.equal(DEFAULT_DURATION_MIN, 240);
  const [w] = workWindows(booking({ serviceEnd: at('2026-10-30', '08:00') }));
  assert.deepEqual([hhmm(w.start), hhmm(w.end)], ['09:00', '13:00']);
});

test('an old booking with no dates list runs on the IST day of its start', () => {
  const [w] = workWindows(booking({ selectedDates: [], serviceStart: at('2026-10-30', '23:30'), serviceEnd: at('2026-10-30', '23:59') }));
  assert.equal(w.day, '2026-10-30', 'a late-evening start is still that IST day');
  assert.deepEqual(workWindows(booking({ selectedDates: ['junk', '30/10/2026'] })).map((x) => x.day), ['2026-10-30']);
});

test('nothing to go on gives no windows, never throws', () => {
  assert.deepEqual(workWindows(null), []);
  assert.deepEqual(workWindows({}), []);
});

test('which days a work runs on', () => {
  const ws = workWindows(booking({ selectedDates: ['2026-10-30', '2026-11-01'] }));
  assert.equal(runsOn(ws, '2026-10-30'), true);
  assert.equal(runsOn(ws, '2026-10-31'), false);
});

// ── how long it takes to get from one venue to the next ──
test('unknown places: a flat 90 minutes', () => {
  assert.equal(DEFAULT_TRAVEL_MIN, 90);
  assert.deepEqual(travelBetween(null, { lat: 1, lng: 1 }), { minutes: 90, known: false });
  assert.deepEqual(travelBetween({ lat: 1, lng: 1 }, undefined), { minutes: 90, known: false });
  assert.deepEqual(travelBetween({ lat: NaN, lng: 1 }, { lat: 1, lng: 1 }), { minutes: 90, known: false });
});

test('the same place: just the handling time', () => {
  const p = { lat: 11.2588, lng: 75.7804 };
  assert.deepEqual(travelBetween(p, p), { minutes: HANDLING_MIN, known: true });
});

test('Calicut to Kochi is hours, not the flat default', () => {
  const calicut = { lat: 11.2588, lng: 75.7804 };
  const kochi = { lat: 9.9312, lng: 76.2673 };
  assert.ok(haversineKm(calicut, kochi) > 140 && haversineKm(calicut, kochi) < 170);
  const t = travelBetween(calicut, kochi);
  assert.equal(t.known, true);
  assert.ok(t.minutes > 300 && t.minutes < 380, `${t.minutes}`);
  assert.equal(travelBetween(kochi, calicut).minutes, t.minutes, 'the same both ways');
});

// ── clashes ──
const other = (b, over) => ({ booking: b, windows: workWindows({ ...b, ...over }) });
const flat = (minutes, known = true) => () => ({ minutes, known });

test('overlapping times on the same day: OVERLAP, with the other work\'s details', () => {
  const mine = workWindows(booking({ _id: 'me', serviceStart: at('2026-10-30', '11:00'), serviceEnd: at('2026-10-30', '15:00') }));
  const [c, ...more] = clashesWith(mine, other(booking({ _id: 'b9', bookingNumber: 'BK-9', customerName: 'Beena' })), flat(90));
  assert.equal(more.length, 0);
  assert.deepEqual([c.kind, c.day, hhmm(c.start), hhmm(c.end), c.with], ['overlap', '2026-10-30', '09:00', '13:00', { bookingId: 'b9', bookingNumber: 'BK-9', customerName: 'Beena' }]);
});

test('one inside the other is an overlap too', () => {
  const mine = workWindows(booking({ serviceStart: at('2026-10-30', '10:00'), serviceEnd: at('2026-10-30', '11:00') }));
  assert.equal(clashesWith(mine, other(booking()), flat(90))[0].kind, 'overlap');
});

test('back to back (one ends when the next starts) is not an overlap, but is TIGHT', () => {
  const mine = workWindows(booking({ serviceStart: at('2026-10-30', '13:00'), serviceEnd: at('2026-10-30', '16:00') }));
  const [c] = clashesWith(mine, other(booking()), flat(60));
  assert.deepEqual([c.kind, c.gapMinutes, c.neededMinutes, c.estimated], ['tight', 0, 60, false]);
});

test('enough time to drive between them is fine', () => {
  const mine = workWindows(booking({ serviceStart: at('2026-10-30', '15:00'), serviceEnd: at('2026-10-30', '18:00') }));
  assert.deepEqual(clashesWith(mine, other(booking()), flat(90)), [], '2 h gap, 90 min needed');
  assert.equal(clashesWith(mine, other(booking()), flat(121))[0].kind, 'tight', '2 h gap, 121 min needed');
  assert.equal(clashesWith(mine, other(booking()), flat(120)).length, 0, 'exactly enough');
});

test('it works whichever work is earlier', () => {
  const earlier = workWindows(booking({ serviceStart: at('2026-10-30', '05:00'), serviceEnd: at('2026-10-30', '08:30') }));
  const [c] = clashesWith(earlier, other(booking()), flat(60));
  assert.deepEqual([c.kind, c.gapMinutes], ['tight', 30]);
});

test('a drive time that was only guessed says so', () => {
  const mine = workWindows(booking({ serviceStart: at('2026-10-30', '13:30'), serviceEnd: at('2026-10-30', '16:00') }));
  assert.equal(clashesWith(mine, other(booking()), flat(90, false))[0].estimated, true);
});

test('different days never clash', () => {
  const mine = workWindows(booking({ selectedDates: ['2026-10-31'], serviceStart: at('2026-10-31', '09:00'), serviceEnd: at('2026-10-31', '13:00') }));
  assert.deepEqual(clashesWith(mine, other(booking()), flat(90)), []);
});

test('a multi-day work clashes only on the day it overlaps, once per day', () => {
  const mine = workWindows(booking({ selectedDates: ['2026-10-29', '2026-10-30', '2026-10-31'], serviceEnd: at('2026-10-31', '13:00') }));
  const cs = clashesWith(mine, other(booking({ selectedDates: ['2026-10-30'] })), flat(90));
  assert.deepEqual(cs.map((c) => [c.day, c.kind]), [['2026-10-30', 'overlap']]);
});

test('on one day, an overlap is reported rather than a tight gap with the same work', () => {
  const mine = workWindows(booking({ bookingItems: [{ selectedDates: ['2026-10-30'], startTime: '06:00', endTime: '07:00' }, { selectedDates: ['2026-10-30'], startTime: '12:00', endTime: '14:00' }] }));
  const cs = clashesWith(mine, other(booking()), flat(90));
  assert.equal(cs.length, 1);
  assert.equal(cs[0].kind, 'overlap');
});

// ── unavailable ──
test('the one word for a vehicle or driver', () => {
  assert.equal(statusOf([]), 'free');
  assert.equal(statusOf([{ kind: 'tight' }]), 'tight');
  assert.equal(statusOf([{ kind: 'tight' }, { kind: 'overlap' }]), 'busy');
  assert.equal(statusOf([{ kind: 'overlap' }, { kind: 'unavailable' }]), 'unavailable');
  assert.equal(statusOf([{ kind: 'warning' }]), 'free', 'a warning alone leaves it free');
});

test('a vehicle that is not running is unavailable, in plain words', () => {
  assert.equal(vehicleProblem({ name: 'Innova', status: 'running' }), null);
  assert.equal(vehicleProblem({ name: 'Innova' }), null);
  assert.deepEqual(vehicleProblem({ name: 'Innova', status: 'under_service' }), { kind: 'unavailable', reason: 'Innova is under service' });
  assert.equal(vehicleProblem({ name: 'Tempo', status: 'accident' }).reason, 'Tempo is out after an accident');
  assert.equal(vehicleProblem({ name: 'Dzire', status: 'complaint' }).reason, 'Dzire has a complaint open');
  assert.equal(vehicleProblem({ name: '', status: 'other' }).reason, 'This vehicle is marked unavailable');
});

test('a driver on leave on a day the work runs is unavailable; leave on other days is not', () => {
  const leaves = [{ fromDay: '2026-10-29', toDay: '2026-10-31', halfDay: 'none' }];
  assert.deepEqual(driverProblems({ employee: { name: 'Ravi' }, leaves, days: ['2026-10-30'] }), [{ kind: 'unavailable', day: '2026-10-30', reason: 'Ravi is on leave on 2026-10-30' }]);
  assert.deepEqual(driverProblems({ employee: { name: 'Ravi' }, leaves, days: ['2026-11-02'] }), []);
  assert.equal(driverProblems({ employee: { name: 'Ravi' }, leaves, days: ['2026-10-31', '2026-11-01'] }).length, 1, 'only the day it touches');
});

test('a half-day leave is a warning, not a block', () => {
  const r = driverProblems({ employee: { name: 'Ravi' }, leaves: [{ fromDay: '2026-10-30', toDay: '2026-10-30', halfDay: 'first' }], days: ['2026-10-30'] });
  assert.deepEqual(r.map((p) => p.kind), ['warning']);
  assert.equal(isBlocking(r[0]), false);
});

test('an inactive driver is unavailable', () => {
  assert.deepEqual(driverProblems({ employee: { name: 'Ravi', status: 'inactive' }, days: [] }), [{ kind: 'unavailable', reason: 'Ravi is no longer active' }]);
});

test('only overlaps and unavailability stop an assignment', () => {
  assert.equal(isBlocking({ kind: 'overlap' }), true);
  assert.equal(isBlocking({ kind: 'unavailable' }), true);
  assert.equal(isBlocking({ kind: 'tight' }), false);
  assert.equal(isBlocking({ kind: 'warning' }), false);
});

test('overdue insurance, pollution and tax are warnings; maintenance, completed or future ones are not', () => {
  const day = '2026-10-30';
  const r = (serviceType, due, status = 'pending') => ({ serviceType, dueDate: new Date(due), status });
  const w = paperWarnings([r('Insurance', '2026-10-12T00:00:00Z'), r('Pollution', '2026-10-29T00:00:00Z'), r('Tax', '2026-11-05T00:00:00Z'), r('Maintenance', '2026-09-01T00:00:00Z'), r('Insurance', '2026-01-01T00:00:00Z', 'completed'), { serviceType: 'Tax', status: 'pending' }], day);
  assert.deepEqual(w.map((x) => x.reason), ['Insurance was due on 2026-10-12', 'Pollution was due on 2026-10-29']);
  assert.ok(w.every((x) => x.kind === 'warning'));
  assert.deepEqual(paperWarnings(undefined, day), []);
});

test('bookings that are not happening commit nothing', () => {
  for (const s of ['cancelled', 'canceled', 'rejected', 'lost', 'postponed']) assert.equal(EXCLUDED_STATUSES.has(s), true, s);
  for (const s of ['confirmed', 'pending', 'completed']) assert.equal(EXCLUDED_STATUSES.has(s), false, s);
});
