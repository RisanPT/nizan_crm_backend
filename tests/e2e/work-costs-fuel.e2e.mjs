// End-to-end check of FUEL (and every other category) on the Accounts cost-per-work report:
// what is under a work is totalled per category, and what is NOT tied to a work is listed
// (with the reason) instead of vanishing into one "not placed" number.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/wc-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/wc-e2e --fork --logpath /tmp/wc-e2e/log
//   node tests/e2e/work-costs-fuel.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/work_costs_fuel_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const Expense = await imp('models/Expense.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/expenses', await imp('routes/expenseRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const api = async (method, path, token) => {
  const res = await fetch(`${base}${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {} });
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
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

// ── people, works, spend ────────────────────────────────────────────────────
const emp = (name) => Employee.create({ name, type: 'in-house', artistRole: 'artist', phone: '9895000001', category: 'creative', department: 'Creative', role: 'Makeup Artist' });
const asha = await emp('Asha');
const beena = await emp('Beena');
const mkUser = async (key, role, employeeId) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role, employeeId });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const accounts = await mkUser('accounts', 'accounts');
const ashaU = await mkUser('asha', 'artist', asha._id);

const ist = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
const staff = (e) => ({ employeeId: e._id, artistName: e.name, roleType: 'lead' });
const work = (num, day, extra = {}) =>
  Booking.create({ bookingNumber: num, customerName: `Bride ${num}`, service: 'Bridal', bookingDate: ist(day, '00:00'), serviceStart: ist(day, '09:00'), serviceEnd: ist(day, '13:00'), totalPrice: 50000, status: 'confirmed', address: 'Venue', ...extra });
const w1 = await work('W-ONE', '2026-11-12', { assignedStaff: [staff(asha)] });
const w2 = await work('W-TWO', '2026-11-13', { assignedStaff: [staff(beena)] });

const spend = (employee, extra) => Expense.create({ employeeId: employee._id, workType: 'bridal', status: 'verified', ...extra });
// tied to W-ONE: fuel 800 + 200, travel 300 | tied to W-TWO: fuel 500 | NOT tied: fuel 650 (Asha), stay 1200 (Beena)
await spend(asha, { category: 'fuel', amount: 800, bookingId: w1._id, date: ist('2026-11-12', '08:00') });
await spend(asha, { category: 'fuel', amount: 200, bookingId: w1._id, date: ist('2026-11-12', '15:00'), status: 'pending' });
await spend(asha, { category: 'travel', amount: 300, bookingId: w1._id, date: ist('2026-11-12', '08:30') });
await spend(beena, { category: 'fuel', amount: 500, bookingId: w2._id, date: ist('2026-11-13', '08:00') });
await spend(asha, { category: 'fuel', amount: 650, date: ist('2026-11-12', '07:00'), notes: 'petrol for the drive' });
await spend(beena, { category: 'stay', amount: 1200, date: ist('2026-11-13', '22:00') });
// a rejected bill must not count anywhere (status filter default is pending + verified)
await spend(asha, { category: 'fuel', amount: 9999, bookingId: w1._id, date: ist('2026-11-12', '09:00'), status: 'rejected' });

const url = '/expenses/work-costs?from=2026-11-12&to=2026-11-13';

await check('each work carries its fuel (and the other kinds) separately', async () => {
  const r = await api('GET', url, accounts.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const one = r.body.items.find((w) => w.bookingId === String(w1._id));
  assert.equal(one.fuel, 1000);
  assert.equal(one.travel, 300);
  assert.equal(one.total, 1300);
  assert.equal(r.body.items.find((w) => w.bookingId === String(w2._id)).fuel, 500);
});

await check('totals.byCategory is what sits under works — fuel included, rejected left out', async () => {
  const { totals } = (await api('GET', url, accounts.token)).body;
  assert.deepEqual(totals.byCategory, { food: 0, travel: 300, stay: 0, materials: 0, fuel: 1500, other: 0 });
  assert.equal(totals.total, 1800);
});

await check('what is not tied to a work is totalled per category AND listed with its reason', async () => {
  const { totals, unplaced, unplacedTruncated } = (await api('GET', url, accounts.token)).body;
  assert.deepEqual(totals.unplacedByCategory, { food: 0, travel: 0, stay: 1200, materials: 0, fuel: 650, other: 0 });
  assert.equal(totals.unplaced, 1850);
  assert.equal(totals.unplacedCount, 2);
  assert.equal(unplacedTruncated, false);
  assert.equal(unplaced.length, 2);
  const fuel = unplaced.find((l) => l.category === 'fuel');
  assert.equal(fuel.amount, 650);
  assert.equal(fuel.artist, 'Asha');
  assert.equal(fuel.notes, 'petrol for the drive');
  assert.match(fuel.reason, /Not tied to a work/);
  assert.equal(fuel.counted, true);
  assert.ok(fuel.expenseId && fuel.employeeId);
});

await check('the artist filter narrows works, totals and the unplaced list together', async () => {
  const r = await api('GET', `${url}&employeeId=${asha._id}`, accounts.token);
  assert.equal(r.body.totals.byCategory.fuel, 1000);
  assert.equal(r.body.totals.unplacedByCategory.fuel, 650);
  assert.equal(r.body.totals.unplacedByCategory.stay, 0);
  assert.deepEqual(r.body.unplaced.map((l) => l.artist), ['Asha']);
});

await check('every status filter is honoured by the unplaced list', async () => {
  const r = await api('GET', `${url}&status=rejected`, accounts.token);
  assert.equal(r.body.unplaced.length, 0);
  assert.equal(r.body.totals.byCategory.fuel, 9999);
});

await check('export carries the unplaced list too, and a page of works does not hide it', async () => {
  const e = (await api('GET', `${url}&export=1`, accounts.token)).body;
  assert.equal(e.unplaced.length, 2);
  assert.equal(e.totals.byCategory.fuel, 1500);
  const p = (await api('GET', `${url}&limit=1&page=2`, accounts.token)).body;
  assert.equal(p.items.length, 1);
  assert.equal(p.unplaced.length, 2, 'the unplaced list does not depend on the page of works');
  assert.equal(p.totals.byCategory.fuel, 1500, 'totals are over every work, not just this page');
});

await check('an artist cannot read it', async () => {
  const r = await api('GET', url, ashaU.token);
  assert.equal(r.status, 403);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
