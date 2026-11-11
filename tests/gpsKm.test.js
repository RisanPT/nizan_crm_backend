// Pure unit tests: node --test tests/gpsKm.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  regKey, cleanGpsRow, cleanGpsRows, judgeDay, toleranceKm, accuracyOf, buildGpsComparison, MAX_DAY_KM,
} from '../utils/gpsKm.js';

// ── vehicle numbers ─────────────────────────────────────────────────────────

test('the same plate typed three ways is one vehicle', () => {
  assert.equal(regKey('KL-57-Y-6100'), 'KL57Y6100');
  assert.equal(regKey('KL 57 Y 6100'), 'KL57Y6100');
  assert.equal(regKey('kl57y6100'), 'KL57Y6100');
});

test('zero padding in a plate is ignored', () => {
  assert.equal(regKey('KL-07-AB-1'), regKey('KL 7 AB 0001'));
  assert.equal(regKey('KL-01-AB-0123'), regKey('KL1AB123'));
});

test('something that is not a plate is just its letters and digits', () => {
  assert.equal(regKey('Innova Crysta #2'), 'INNOVACRYSTA2');
  assert.equal(regKey(null), '');
});

// ── one row ─────────────────────────────────────────────────────────────────

const row = (o = {}) => ({ registrationNumber: 'KL-57-Y-6100', date: '2026-10-29', distanceKm: 23.767842436662626, ...o });

test('a row like the vendor report: distance kept to 2 decimals', () => {
  const { row: r, error } = cleanGpsRow(row({ runningHours: '0.98', stopHours: 22.75, idleHours: '0.00', startAddress: ' Kozhikode, 673574 ' }), { today: '2026-11-02' });
  assert.equal(error, undefined);
  assert.equal(r.regKey, 'KL57Y6100');
  assert.equal(r.dayKey, '2026-10-29');
  assert.equal(r.distanceKm, 23.77);
  assert.equal(r.runningHours, 0.98);
  assert.equal(r.idleHours, 0);
  assert.equal(r.startAddress, 'Kozhikode, 673574');
});

test('"address not found" is not an address', () => {
  assert.equal(cleanGpsRow(row({ startAddress: ' Address not found in databse' })).row.startAddress, '');
});

test('impossible hours are dropped, the row survives', () => {
  const { row: r } = cleanGpsRow(row({ runningHours: 99, stopHours: -2, idleHours: 'x' }));
  assert.equal(r.runningHours, null);
  assert.equal(r.stopHours, null);
  assert.equal(r.idleHours, null);
});

test('rows that cannot be right are refused, with a reason', () => {
  const bad = (o) => cleanGpsRow(row(o), { today: '2026-11-02' }).error;
  assert.match(bad({ registrationNumber: '  ' }), /vehicle number/);
  assert.match(bad({ date: '2026-02-30' }), /not a date/);
  assert.match(bad({ date: '29/10/2026' }), /not a date/);
  assert.match(bad({ date: '2026-11-20' }), /future/);
  assert.match(bad({ date: '2009-01-01' }), /long ago/);
  assert.match(bad({ distanceKm: 'abc' }), /not a number/);
  assert.match(bad({ distanceKm: -3 }), /negative/);
  assert.match(bad({ distanceKm: MAX_DAY_KM + 1 }), /more than a vehicle can cover/);
});

test('tomorrow is allowed (the GPS day can be ahead of the server clock), a week ahead is not', () => {
  assert.equal(cleanGpsRow(row({ date: '2026-11-03' }), { today: '2026-11-02' }).error, undefined);
  assert.ok(cleanGpsRow(row({ date: '2026-11-09' }), { today: '2026-11-02' }).error);
});

test('thousands separators and text numbers are read', () => {
  assert.equal(cleanGpsRow(row({ distanceKm: '1,234.5' })).row.distanceKm, 1234.5);
});

// ── a whole upload ──────────────────────────────────────────────────────────

test('an upload: bad rows are counted and explained, never silently dropped', () => {
  const out = cleanGpsRows([row(), row({ date: 'nope' }), row({ date: '2026-10-28', distanceKm: 559.1 })], { today: '2026-11-02' });
  assert.equal(out.rows.length, 2);
  assert.equal(out.skipped, 1);
  assert.deepEqual(out.problems, ['Row 2: "nope" is not a date']);
});

test('the same vehicle and day twice → the later row wins', () => {
  const out = cleanGpsRows([row({ distanceKm: 10 }), row({ registrationNumber: 'kl 57 y 6100', distanceKm: 12 })], { today: '2026-11-02' });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].distanceKm, 12);
  assert.equal(out.duplicates, 1);
});

test('only the first 20 problems are listed, all are counted', () => {
  const out = cleanGpsRows(Array.from({ length: 30 }, () => row({ distanceKm: 'x' })));
  assert.equal(out.skipped, 30);
  assert.equal(out.problems.length, 20);
});

// ── judging a day ───────────────────────────────────────────────────────────

test('tolerance: 10% of the GPS km, but never less than 5 km', () => {
  assert.equal(toleranceKm(20), 5);
  assert.equal(toleranceKm(100), 10);
  assert.equal(toleranceKm(559), 55.9);
});

test('the way home is added to what the driver entered', () => {
  // GPS 100; odometer 70 + 28 home = 98 → 2 km apart → ok
  const j = judgeDay({ gpsKm: 100, driverKm: 70, returnLegKm: 28 });
  assert.equal(j.expectedKm, 98);
  assert.equal(j.diffKm, 2);
  assert.equal(j.status, 'ok');
  // the same day without knowing the way home looks like 30 km unrecorded
  assert.equal(judgeDay({ gpsKm: 100, driverKm: 70 }).status, 'driver_low');
});

test('bands: the edge counts as a match, one step past is not', () => {
  assert.equal(judgeDay({ gpsKm: 100, driverKm: 90 }).status, 'ok'); // exactly 10
  assert.equal(judgeDay({ gpsKm: 100, driverKm: 89 }).status, 'driver_low'); // 11
  assert.equal(judgeDay({ gpsKm: 100, driverKm: 110 }).status, 'ok');
  assert.equal(judgeDay({ gpsKm: 100, driverKm: 111 }).status, 'driver_high');
  assert.equal(judgeDay({ gpsKm: 20, driverKm: 25 }).status, 'ok'); // short day: 5 km allowed
  assert.equal(judgeDay({ gpsKm: 20, driverKm: 26 }).status, 'driver_high');
});

test('percentage is of the GPS figure; null when the GPS shows nothing', () => {
  assert.equal(judgeDay({ gpsKm: 200, driverKm: 150 }).diffPct, 25);
  assert.equal(judgeDay({ gpsKm: 0, driverKm: 0 }).diffPct, null);
});

test('a tracker that shows (almost) no movement is not evidence against the driver', () => {
  assert.equal(judgeDay({ gpsKm: 0, driverKm: 40 }).status, 'no_gps');
  assert.equal(judgeDay({ gpsKm: 0.4, driverKm: 40 }).status, 'no_gps');
  // …but a short logged trip with a still tracker is just a short day
  assert.equal(judgeDay({ gpsKm: 0, driverKm: 2 }).status, 'ok');
});

test('accuracy: differences in either direction both count against it', () => {
  // +70 on 130 and −30 on 100, +2 on 100 → 102 off over 330 km → 69.1%
  const rows = [
    { status: 'ok', gpsKm: 100, diffKm: 2 },
    { status: 'driver_low', gpsKm: 130, diffKm: 70 },
    { status: 'driver_high', gpsKm: 100, diffKm: -30 },
    { status: 'no_trip', gpsKm: 560, diffKm: null }, // not a comparison
  ];
  assert.equal(accuracyOf(rows), 69.1);
  assert.equal(accuracyOf([{ status: 'no_trip', gpsKm: 50 }]), null);
  assert.equal(accuracyOf([]), null);
  assert.equal(accuracyOf([{ status: 'driver_low', gpsKm: 10, diffKm: 40 }]), 0); // never negative
});

// ── the whole comparison ────────────────────────────────────────────────────

const V1 = { id: 'v1', name: 'Innova', registrationNumber: 'KL 57 Y 6100' };
const V2 = { id: 'v2', name: 'Dzire', registrationNumber: 'KL-11-AB-1234' };
const V3 = { id: 'v3', name: 'Tempo', registrationNumber: 'KL-01-ZZ-0001' };

const gps = (reg, dayKey, distanceKm, extra = {}) => ({
  regKey: regKey(reg), registrationNumber: reg, dayKey, distanceKm, runningHours: 2, stopHours: 20, idleHours: 0, startAddress: 'A', endAddress: 'B', ...extra,
});
let n = 0;
const trip = (vehicleId, dayKey, startKm, endKm, o = {}) => ({
  bookingId: `b${++n}`, bookingNumber: `BK-${n}`, customerName: 'Client', vehicleId, driverId: 'd1', driverName: 'Ravi',
  startKm, endKm, dayKey, at: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), travelDistanceKm: 0, ...o, // later trips are later
});

const scenario = () => {
  const returnLegs = new Map([['d1|2026-10-22', { km: 28 }]]);
  return buildGpsComparison({
    from: '2026-10-20',
    to: '2026-10-31',
    vehicles: [V1, V2, V3],
    readings: [
      gps('KL-57-Y-6100', '2026-10-20', 0),
      gps('KL-57-Y-6100', '2026-10-22', 100),
      gps('KL-57-Y-6100', '2026-10-23', 130),
      gps('KL-57-Y-6100', '2026-10-24', 100),
      gps('KL-57-Y-6100', '2026-10-26', 0.2),
      gps('KL-57-Y-6100', '2026-10-28', 560),
      gps('KL-11-AB-1234', '2026-10-22', 50),
      gps('MH-12-XX-9999', '2026-10-22', 30),
      gps('MH-12-XX-9999', '2026-10-23', 12.5),
    ],
    trips: [
      trip('v1', '2026-10-22', 1000, 1040), // two trips = 70 km
      trip('v1', '2026-10-22', 1040, 1070),
      trip('v1', '2026-10-23', 2000, 2060),
      trip('v1', '2026-10-24', 3000, 3130),
      trip('v1', '2026-10-25', 4000, 4020), // no GPS row, inside the report's days
      trip('v1', '2026-10-26', 5000, 5040), // tracker shows 0.2 km
      trip('v1', '2026-10-30', 6000, 6020), // after the report's last day: not comparable
      trip('v2', '2026-10-22', 100, 120, { driverId: 'd3', driverName: 'Anil' }), // two drivers share the Dzire
      trip('v2', '2026-10-22', 120, 145, { driverId: 'd2', driverName: 'Sunil' }),
      trip('v3', '2026-10-23', 10, 60), // the Tempo has no GPS at all
      { ...trip('v1', '2026-10-27', 0, 0), startKm: null, endKm: null }, // an unreadable trip counts for nothing
    ],
    returnLegs,
  });
};

test('days are judged: matched, under-entered, over-entered, nothing logged, no data', () => {
  const r = scenario();
  const byDay = Object.fromEntries(r.days.filter((d) => d.vehicleId === 'v1').map((d) => [d.date, d]));
  assert.equal(byDay['2026-10-22'].status, 'ok');
  assert.equal(byDay['2026-10-22'].driverKm, 70);
  assert.equal(byDay['2026-10-22'].returnLegKm, 28);
  assert.equal(byDay['2026-10-22'].returnLegSource, 'route');
  assert.equal(byDay['2026-10-22'].diffKm, 2);
  assert.equal(byDay['2026-10-23'].status, 'driver_low');
  assert.equal(byDay['2026-10-23'].diffKm, 70);
  assert.equal(byDay['2026-10-24'].status, 'driver_high');
  assert.equal(byDay['2026-10-24'].diffKm, -30);
  assert.equal(byDay['2026-10-28'].status, 'no_trip');
  assert.equal(byDay['2026-10-28'].driverKm, null);
  assert.equal(byDay['2026-10-25'].status, 'no_gps');
  assert.equal(byDay['2026-10-25'].reason, 'missing');
  assert.equal(byDay['2026-10-26'].status, 'no_gps');
  assert.equal(byDay['2026-10-26'].reason, 'zero');
});

test('a parked day, a day outside the report and an unreadable trip produce no row', () => {
  const dates = scenario().days.filter((d) => d.vehicleId === 'v1').map((d) => d.date);
  assert.ok(!dates.includes('2026-10-20'), 'parked');
  assert.ok(!dates.includes('2026-10-30'), 'after the last day of the report');
  assert.ok(!dates.includes('2026-10-27'), 'a trip without readings');
});

test('days come newest first', () => {
  const dates = scenario().days.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

test('a plate typed differently in the report still reaches the CRM vehicle', () => {
  // CRM "KL 57 Y 6100" vs report "KL-57-Y-6100"
  assert.ok(scenario().days.some((d) => d.vehicleId === 'v1'));
});

test('the vehicle summary and its accuracy', () => {
  const v = scenario().vehicles.find((x) => x.vehicleId === 'v1');
  assert.equal(v.gpsKm, 890.2); // 0 + 100 + 130 + 100 + 0.2 + 560
  assert.equal(v.comparedDays, 3);
  assert.equal(v.okDays, 1);
  assert.equal(v.lowDays, 1);
  assert.equal(v.highDays, 1);
  assert.equal(v.noTripDays, 1);
  assert.equal(v.noGpsDays, 2);
  assert.equal(v.unloggedKm, 560);
  assert.equal(v.netDiffKm, 42);
  assert.equal(v.accuracyPct, 69.1);
});

test('totals', () => {
  const t = scenario().totals;
  assert.equal(t.comparedDays, 4); // three Innova days + the Dzire's
  assert.equal(t.reviewDays, 5);
  assert.equal(t.unloggedKm, 560);
  assert.equal(t.noGpsDays, 2);
  assert.equal(t.noTripDays, 1);
});

test('a driver is only judged on days he had the vehicle to himself', () => {
  const r = scenario();
  assert.deepEqual(r.drivers.map((d) => d.driverId), ['d1']);
  const d1 = r.drivers[0];
  assert.equal(d1.comparedDays, 3); // not the Dzire day Anil and Sunil shared
  assert.equal(d1.accuracyPct, 69.1);
  const shared = r.days.find((d) => d.vehicleId === 'v2');
  assert.equal(shared.driverId, '');
  assert.deepEqual(shared.driverNames.sort(), ['Anil', 'Sunil']);
  assert.equal(shared.driverKm, 45);
});

test('the Dzire day: 45 km entered vs 50 on GPS is within the 5 km allowance', () => {
  assert.equal(scenario().days.find((d) => d.vehicleId === 'v2').status, 'ok');
});

test('a vehicle with trips but nothing in the report is listed apart, not as a day-by-day failure', () => {
  const r = scenario();
  assert.deepEqual(r.vehiclesWithoutGps.map((v) => [v.vehicleId, v.trips, v.driverKm]), [['v3', 1, 50]]);
  assert.ok(!r.days.some((d) => d.vehicleId === 'v3'));
});

test('a plate the CRM does not know is reported, not lost', () => {
  assert.deepEqual(scenario().unmatchedGps, [{ registrationNumber: 'MH-12-XX-9999', days: 2, gpsKm: 42.5 }]);
});

test('worst accuracy first, so the people to talk to are at the top', () => {
  const r = scenario();
  const accs = r.vehicles.map((v) => v.accuracyPct ?? 101);
  assert.deepEqual(accs, [...accs].sort((a, b) => a - b));
});

test('without a stored route the way home comes from the work\'s own distance', () => {
  const r = buildGpsComparison({
    from: '2026-10-23', to: '2026-10-23', vehicles: [V1],
    readings: [gps('KL-57-Y-6100', '2026-10-23', 130)],
    trips: [trip('v1', '2026-10-23', 2000, 2060, { travelDistanceKm: 68 })],
  });
  const d = r.days[0];
  assert.equal(d.returnLegKm, 68);
  assert.equal(d.returnLegSource, 'booking');
  assert.equal(d.status, 'ok'); // 60 + 68 = 128 vs 130
});

test('a day with no trips has no way home to add', () => {
  const r = buildGpsComparison({
    from: '2026-10-28', to: '2026-10-28', vehicles: [V1],
    readings: [gps('KL-57-Y-6100', '2026-10-28', 560)], trips: [],
  });
  assert.equal(r.days[0].returnLegKm, 0);
  assert.equal(r.days[0].returnLegSource, 'none');
});

test('two drivers on one vehicle-day: each one\'s last trip brings its own way home', () => {
  const r = buildGpsComparison({
    from: '2026-10-22', to: '2026-10-22', vehicles: [V2],
    readings: [gps('KL-11-AB-1234', '2026-10-22', 100)],
    trips: [
      trip('v2', '2026-10-22', 0, 20, { travelDistanceKm: 10 }),
      trip('v2', '2026-10-22', 20, 40, { driverId: 'd2', driverName: 'Sunil', travelDistanceKm: 15 }),
    ],
  });
  assert.equal(r.days[0].returnLegKm, 25);
});

test('a driver who changed vehicles is charged ONE way home, on the vehicle of his last trip', () => {
  const returnLegs = new Map([['d1|2026-10-22', { km: 30 }]]);
  const r = buildGpsComparison({
    from: '2026-10-22', to: '2026-10-22', vehicles: [V1, V2],
    readings: [gps('KL-57-Y-6100', '2026-10-22', 50), gps('KL-11-AB-1234', '2026-10-22', 80)],
    trips: [trip('v1', '2026-10-22', 0, 50), trip('v2', '2026-10-22', 500, 550)],
    returnLegs,
  });
  const v1 = r.days.find((d) => d.vehicleId === 'v1');
  const v2 = r.days.find((d) => d.vehicleId === 'v2');
  assert.equal(v1.returnLegKm, 0);
  assert.equal(v2.returnLegKm, 30);
  assert.equal(v1.status, 'ok'); // 50 vs 50
  assert.equal(v2.status, 'ok'); // 80 vs 50 + 30
});

test('nothing uploaded → an empty, well-formed answer', () => {
  const r = buildGpsComparison({ from: '2026-10-01', to: '2026-10-31', vehicles: [V1], readings: [], trips: [] });
  assert.deepEqual(r.days, []);
  assert.equal(r.totals.accuracyPct, null);
  assert.equal(r.totals.comparedDays, 0);
});
