// End-to-end check of the GPS km report upload + comparison, against a THROWAWAY local
// MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else, and
// drops its database first):
//
//   mkdir -p /tmp/gps-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/gps-e2e --fork --logpath /tmp/gps-e2e/log
//   node tests/e2e/gps-km.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/gps_km_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const imp = (p) => import(new URL(`../../${p}`, import.meta.url)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Vehicle = await imp('models/Vehicle.js');
const Booking = await imp('models/Booking.js');
const DayTrip = await imp('models/DayTrip.js');
const GpsKmReading = await imp('models/GpsKmReading.js');
const gpsKmRoutes = await imp('routes/gpsKmRoutes.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('../../middleware/errorMiddleware.js', import.meta.url));

// mounted the way server.js does it: its own, larger body limit
const app = express();
app.use(sanitizeErrorResponses);
app.use('/api/fleet/gps-km', express.json({ limit: '4mb' }), gpsKmRoutes);
app.use(express.json());
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/fleet/gps-km`;

const api = async (method, path, token, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 7).join('\n      ')}`);
  }
};

// ── people, vehicles, trips ─────────────────────────────────────────────────
const U = {};
const mkUser = async (key, role, extra = {}) => {
  const user = await User.create({ name: `User ${key}`, email: `${key}@e2e.test`, password: 'secret123', role, ...extra });
  U[key] = { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await mkUser('fleet', 'fleet_manager');
await mkUser('admin', 'admin');
await mkUser('artist', 'artist');
await mkUser('driverUser', 'driver');

const ravi = await Employee.create({ name: 'Ravi' });
// the CRM writes the plate with spaces; the GPS report with hyphens
const innova = await Vehicle.create({ name: 'Innova', registrationNumber: 'KL 57 Y 6100' });
const tempo = await Vehicle.create({ name: 'Tempo', registrationNumber: 'KL 01 ZZ 0001' });

const ist = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
let seq = 0;
const trip = (vehicle, day, startKm, endKm, extra = {}) =>
  Booking.collection.insertOne({
    bookingNumber: `BK-${++seq}`, customerName: `Client ${seq}`, driverId: ravi._id, vehicleId: vehicle._id,
    tripStatus: 'completed', startKm, endKm, tripStartedAt: ist(day, '09:00'), tripCompletedAt: ist(day, '11:00'),
    travelDistanceKm: 0, createdAt: new Date(), updatedAt: new Date(), ...extra,
  });

await trip(innova, '2026-10-22', 1000, 1040);
await trip(innova, '2026-10-22', 1040, 1070); // 70 km that day
await trip(innova, '2026-10-23', 2000, 2060); // 60 km
await trip(innova, '2026-10-24', 3000, 3130); // 130 km
await trip(tempo, '2026-10-23', 10, 60); // the Tempo is not in the report
await trip(innova, '2026-10-29', 100, 90); // odometer went backwards → not a distance
await Booking.collection.insertOne({ // still running: no end km yet
  bookingNumber: 'BK-open', driverId: ravi._id, vehicleId: innova._id, tripStatus: 'in_progress', startKm: 5000, endKm: null, tripStartedAt: ist('2026-10-25', '09:00'),
});
// the stored route for 22 Oct says the way home is 28 km
await DayTrip.create({ driverId: ravi._id, dayKey: '2026-10-22', legs: [{ kind: 'out', km: 40 }, { kind: 'return', km: 28 }], plannedKm: 68 });

// the report, shaped like the vendor's file (plate with hyphens, distance with many decimals)
const row = (date, km, extra = {}) => ({ registrationNumber: 'KL-57-Y-6100', date, distanceKm: km, runningHours: 1, stopHours: 22, idleHours: 1, startAddress: ' Kozhikode', endAddress: ' Kozhikode', ...extra });
const report = [
  row('2026-10-20', 0),
  row('2026-10-22', 99.95811233929385),
  row('2026-10-23', 128.75167308108024),
  row('2026-10-24', 100),
  row('2026-10-28', 559.1230885201172),
];

// ── access ──────────────────────────────────────────────────────────────────
await check('no token → 401, an artist → 403, a driver → 403', async () => {
  assert.equal((await api('POST', '/upload', null, { rows: report })).status, 401);
  assert.equal((await api('POST', '/upload', U.artist.token, { rows: report })).status, 403);
  assert.equal((await api('GET', '/compare', U.driverUser.token)).status, 403);
});

await check('an empty report is refused', async () => {
  const r = await api('POST', '/upload', U.fleet.token, { rows: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /no rows/);
});

await check('a report where nothing is usable is refused, with the reasons', async () => {
  const r = await api('POST', '/upload', U.fleet.token, { rows: [{ registrationNumber: 'KL-57-Y-6100', date: 'garbage', distanceKm: 5 }] });
  assert.equal(r.status, 400);
  assert.equal(r.body.skipped, 1);
  assert.match(r.body.problems[0], /not a date/);
});

// ── upload ──────────────────────────────────────────────────────────────────
await check('a report is saved, and the plate is matched to the CRM vehicle', async () => {
  const r = await api('POST', '/upload', U.fleet.token, { fileName: '866221071468727-02 Nov 2026.xlsx', rows: [...report, { ...row('bad'), distanceKm: 1 }] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.rows, 5);
  assert.equal(r.body.created, 5);
  assert.equal(r.body.updated, 0);
  assert.equal(r.body.skipped, 1);
  assert.equal(r.body.from, '2026-10-20');
  assert.equal(r.body.to, '2026-10-28');
  assert.deepEqual(r.body.vehicles.map((v) => [v.registrationNumber, v.vehicleName, v.days]), [['KL-57-Y-6100', 'Innova', 5]]);
  assert.equal(await GpsKmReading.countDocuments(), 5);
});

await check('uploading the same report again changes nothing', async () => {
  const r = await api('POST', '/upload', U.admin.token, { fileName: 'again.xlsx', rows: report });
  assert.equal(r.status, 201);
  assert.equal(r.body.created, 0);
  assert.equal(r.body.updated, 0);
  assert.equal(r.body.unchanged, 5);
  assert.equal(await GpsKmReading.countDocuments(), 5);
});

await check('an overlapping report updates the days it corrects and adds the new ones', async () => {
  const r = await api('POST', '/upload', U.fleet.token, { fileName: 'corrected.xlsx', rows: [row('2026-10-24', 105), row('2026-10-25', 0)] });
  assert.equal(r.body.created, 1);
  assert.equal(r.body.updated, 1);
  const d = await GpsKmReading.findOne({ dayKey: '2026-10-24' });
  assert.equal(d.distanceKm, 105);
  assert.equal(await GpsKmReading.countDocuments(), 6);
  await api('POST', '/upload', U.fleet.token, { fileName: 'restore.xlsx', rows: [row('2026-10-24', 100)] });
});

await check('a report bigger than the usual 100 kb body limit gets in', async () => {
  const many = Array.from({ length: 1500 }, (_, i) => ({
    registrationNumber: 'MH-12-XX-9999', date: new Date(Date.UTC(2020, 0, 1) + i * 86400000).toISOString().slice(0, 10), distanceKm: 10 + (i % 7),
    startAddress: 'A reasonably long address, Kozhikode, Kerala, India '.repeat(2),
  }));
  assert.ok(JSON.stringify(many).length > 150_000);
  const r = await api('POST', '/upload', U.fleet.token, { fileName: 'big.xlsx', rows: many });
  assert.equal(r.status, 201, JSON.stringify(r.body).slice(0, 200));
  assert.equal(r.body.created, 1500);
  await GpsKmReading.deleteMany({ regKey: 'MH12XX9999' });
});

// ── comparison ──────────────────────────────────────────────────────────────
await check('with no dates it opens on the most recent year of the latest upload', async () => {
  // the latest upload so far is the 1500-day one
  const r = await api('GET', '/compare', U.fleet.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.defaulted, true);
  assert.equal(r.body.to, r.body.uploads[0].to);
  const days = (new Date(r.body.to) - new Date(r.body.from)) / 86400000;
  assert.ok(days <= 365, `${days} days`);
  assert.ok(r.body.uploads[0].fileName);
});

const cmp = async (qs = '?from=2026-10-20&to=2026-10-31') => (await api('GET', `/compare${qs}`, U.fleet.token)).body;

await check('each day is judged against the driver\'s odometer', async () => {
  const r = await cmp();
  const day = (d) => r.days.find((x) => x.date === d && x.registrationNumber === 'KL 57 Y 6100');
  // 22 Oct: GPS 99.96; 70 km on the odometer + the 28 km way home from the stored route
  assert.equal(day('2026-10-22').status, 'ok');
  assert.equal(day('2026-10-22').driverKm, 70);
  assert.equal(day('2026-10-22').returnLegKm, 28);
  assert.equal(day('2026-10-22').returnLegSource, 'route');
  assert.equal(day('2026-10-22').trips.length, 2);
  // 23 Oct: GPS 128.75 vs 60 entered, no route known
  assert.equal(day('2026-10-23').status, 'driver_low');
  assert.equal(day('2026-10-24').status, 'driver_high');
  // 28 Oct: 559 km on the tracker, no trip at all
  assert.equal(day('2026-10-28').status, 'no_trip');
  assert.equal(day('2026-10-28').gpsKm, 559.12);
});

await check('the backwards odometer and the unfinished trip count for nothing', async () => {
  const r = await cmp();
  assert.ok(!r.days.some((d) => d.date === '2026-10-29'));
  assert.ok(!r.days.some((d) => d.date === '2026-10-25' && d.status !== 'parked' && d.driverKm));
});

await check('the vehicle and totals', async () => {
  const r = await cmp();
  const v = r.vehicles.find((x) => x.registrationNumber === 'KL 57 Y 6100');
  assert.equal(v.comparedDays, 3);
  assert.equal(v.noTripDays, 1);
  assert.equal(v.unloggedKm, 559.1);
  assert.ok(v.accuracyPct > 0 && v.accuracyPct < 100);
  assert.equal(r.totals.reviewDays, 3); // low, high, no trip
  assert.equal(r.tolerance.percent, 10);
});

await check('a vehicle with trips but no GPS rows is listed apart', async () => {
  const r = await cmp();
  assert.deepEqual(r.vehiclesWithoutGps.map((v) => [v.registrationNumber, v.trips, v.driverKm]), [['KL 01 ZZ 0001', 1, 50]]);
  assert.ok(!r.days.some((d) => d.registrationNumber === 'KL 01 ZZ 0001'));
});

await check('the driver is judged only on his own days, with an accuracy', async () => {
  const r = await cmp();
  assert.equal(r.drivers.length, 1);
  assert.equal(r.drivers[0].name, 'Ravi');
  assert.equal(r.drivers[0].comparedDays, 3);
});

await check('a date range is respected, and a bad one is refused', async () => {
  const one = await cmp('?from=2026-10-23&to=2026-10-23');
  assert.deepEqual(one.days.map((d) => d.date), ['2026-10-23']);
  assert.equal((await api('GET', '/compare?from=2026-10-31&to=2026-10-01', U.fleet.token)).status, 400);
  assert.equal((await api('GET', '/compare?from=2024-01-01&to=2026-10-01', U.fleet.token)).status, 400);
});

await check('one vehicle can be asked for', async () => {
  const r = await cmp(`?from=2026-10-20&to=2026-10-31&vehicleId=${tempo._id}`);
  assert.equal(r.vehicles.length, 0);
  assert.equal(r.vehiclesWithoutGps.length, 1);
});

await check('a plate the CRM does not know is reported rather than lost', async () => {
  await api('POST', '/upload', U.fleet.token, { fileName: 'other.xlsx', rows: [{ registrationNumber: 'MH-12-XX-9999', date: '2026-10-22', distanceKm: 33 }] });
  const r = await cmp();
  assert.deepEqual(r.unmatchedGps.map((u) => [u.registrationNumber, u.gpsKm]), [['MH-12-XX-9999', 33]]);
});

await check('after a normal upload the default window is that upload\'s own days', async () => {
  await api('POST', '/upload', U.fleet.token, { fileName: 'oct.xlsx', rows: report });
  const r = await api('GET', '/compare', U.fleet.token);
  assert.equal(r.body.from, '2026-10-20');
  assert.equal(r.body.to, '2026-10-28');
  assert.deepEqual(r.body.uploads.map((u) => u.fileName).slice(0, 2), ['oct.xlsx', 'other.xlsx']);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
