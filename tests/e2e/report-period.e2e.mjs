// End-to-end check of the DATES a downloaded report is for — against a THROWAWAY local MongoDB (a mongod on 127.0.0.1:27099; refuses
// anything else and drops its own database first):
//
//   mkdir -p /tmp/rp-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/rp-e2e --fork --logpath /tmp/rp-e2e/log
//   node tests/e2e/report-period.e2e.mjs
//
// GET /api/goals/report (Target vs Actual, day by day) takes the same.
// GET /api/reports/finance (collections + expenses as CSV/PDF) and GET /api/reports/financial-analyst (JSON) take `from` + `to` (IST days,
// both inclusive) as well as the older month/year. Checks: what is on the edges of a range is in or out as it should be; a bad range is
// refused; the older forms still give what they always gave; the file names the dates.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/report_period_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'report_period_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Collection = await imp('models/Collection.js');
const Expense = await imp('models/Expense.js');
const Booking = await imp('models/Booking.js');
const Lead = await imp('models/Lead.js');
const Goal = await imp('models/Goal.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/reports', await imp('routes/reportRoutes.js'));
app.use('/api/goals', await imp('routes/goalRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const raw = async (path, token) => {
  const res = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type') ?? '', disposition: res.headers.get('content-disposition') ?? '', buf, text: buf.toString('utf8') };
};
const json = async (path, token) => {
  const r = await raw(path, token);
  let body = {};
  try { body = JSON.parse(r.text); } catch { /* not json */ }
  return { ...r, body };
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

const emp = await Employee.create({ name: 'Asha' });
const boss = await User.create({ name: 'boss', email: 'boss@e2e.test', password: 'secret123', role: 'admin', employeeId: emp._id });
const token = jwt.sign({ id: String(boss._id) }, process.env.JWT_SECRET);

// IST instants: noon on a day is safely inside it; just after midnight and just before midnight IST are the edges
const at = (day, time = '12:00:00') => new Date(`${day}T${time}+05:30`);
const insert = (Model, doc) => Model.collection.insertOne({ createdAt: new Date(), updatedAt: new Date(), ...doc });
const cols = [
  ['2026-10-31', '23:59:59', 100, 'before'],
  ['2026-11-01', '00:00:01', 200, 'first'],
  ['2026-11-10', '12:00:00', 300, 'middle'],
  ['2026-11-17', '23:59:59', 400, 'last'],
  ['2026-11-18', '00:00:01', 500, 'after'],
];
for (const [d, t, amount, notes] of cols) await insert(Collection, { employeeId: emp._id, amount, date: at(d, t), status: 'verified', notes, type: 'payment' });
await insert(Expense, { employeeId: emp._id, amount: 50, date: at('2026-11-17', '08:00:00'), status: 'approved', category: 'Fuel', notes: 'e-last' });
await insert(Expense, { employeeId: emp._id, amount: 60, date: at('2026-11-18', '08:00:00'), status: 'approved', category: 'Fuel', notes: 'e-after' });

const notesIn = (csv) => ['before', 'first', 'middle', 'last', 'after', 'e-last', 'e-after'].filter((n) => csv.includes(n));

console.log('The finance report (collections + expenses)');
await check('a range: the first day and the last day are IN to the last second, the day before and after are OUT', async () => {
  const r = await raw('/reports/finance?from=2026-11-01&to=2026-11-17&format=csv', token);
  assert.equal(r.status, 200, r.text);
  assert.match(r.type, /text\/csv/);
  assert.deepEqual(notesIn(r.text), ['first', 'middle', 'last', 'e-last']);
});
await check('the file is named by its dates', async () => {
  const r = await raw('/reports/finance?from=2026-11-01&to=2026-11-17&format=csv', token);
  assert.match(r.disposition, /Finance_Report_2026-11-01_to_2026-11-17\.csv/);
  const p = await raw('/reports/finance?from=2026-11-01&to=2026-11-17', token);
  assert.match(p.type, /application\/pdf/);
  assert.match(p.disposition, /Finance_Report_2026-11-01_to_2026-11-17\.pdf/);
  assert.equal(p.buf.subarray(0, 4).toString(), '%PDF');
  const one = await raw('/reports/finance?from=2026-11-10&to=2026-11-10&format=csv', token);
  assert.match(one.disposition, /Finance_Report_2026-11-10\.csv/);
  assert.deepEqual(notesIn(one.text), ['middle']);
});
await check('one day is a range of one', async () => {
  const r = await raw('/reports/finance?from=2026-11-17&to=2026-11-17&format=csv', token);
  assert.deepEqual(notesIn(r.text), ['last', 'e-last']);
});
await check('the older month + year is read as before, by IST days, with its old file name', async () => {
  const r = await raw('/reports/finance?month=11&year=2026&format=csv', token);
  assert.equal(r.status, 200);
  assert.deepEqual(notesIn(r.text), ['first', 'middle', 'last', 'after', 'e-last', 'e-after']);
  assert.match(r.disposition, /Finance_Report_11_2026\.csv/);
});
await check('a range wins over a month', async () => {
  const r = await raw('/reports/finance?from=2026-11-10&to=2026-11-10&month=11&year=2026&format=csv', token);
  assert.deepEqual(notesIn(r.text), ['middle']);
});
await check('an artist is still narrowed to, with a range', async () => {
  const other = await Employee.create({ name: 'Meera' });
  await insert(Collection, { employeeId: other._id, amount: 999, date: at('2026-11-10'), status: 'verified', notes: 'meera', type: 'payment' });
  const all = await raw('/reports/finance?from=2026-11-01&to=2026-11-17&format=csv', token);
  assert.ok(all.text.includes('meera'));
  const mine = await raw(`/reports/finance?from=2026-11-01&to=2026-11-17&format=csv&employeeId=${emp._id}`, token);
  assert.equal(mine.text.includes('meera'), false);
  assert.ok(mine.text.includes('middle'));
});
await check('a bad range is refused with a reason, not turned into something else', async () => {
  for (const [q, code] of [
    ['from=2026-11-17&to=2026-11-01', 'RANGE_REVERSED'],
    ['from=2026-11-01', 'RANGE_INVALID'],
    ['from=soon&to=later', 'RANGE_INVALID'],
    ['from=2019-01-01&to=2026-11-17', 'RANGE_TOO_LONG'],
    ['', 'PERIOD_REQUIRED'],
    ['month=13&year=2026', 'PERIOD_REQUIRED'],
  ]) {
    const r = await json(`/reports/finance?${q}&format=csv`, token);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, code, q);
    assert.ok(r.body.message.length > 10, q);
  }
});
await check('nobody signed out gets it', async () => {
  assert.equal((await raw('/reports/finance?from=2026-11-01&to=2026-11-17&format=csv')).status, 401);
});

console.log('The financial analyst report');
const mkBooking = (day, extra = {}) =>
  insert(Booking, { service: 'Bridal', customerName: `C ${day}`, phone: `99999${day.slice(8, 10)}0000`, district: 'Kochi', totalPrice: 10000, advanceAmount: 2000, discountAmount: 0, status: 'confirmed', bookingDate: at(day), createdBy: boss._id, ...extra });
for (const d of ['2026-10-31', '2026-11-01', '2026-11-10', '2026-11-17', '2026-11-18', '2026-11-20']) await mkBooking(d);
await mkBooking('2026-11-10', { customerName: 'Cancelled one', status: 'cancelled', phone: '9888800000', internalRemarks: 'Clash' });
await insert(Lead, { name: 'L1', source: 'Instagram', leadDate: at('2026-11-05') });
await insert(Lead, { name: 'L2', source: 'Reference', leadDate: at('2026-11-12') });
await insert(Lead, { name: 'L3', source: 'Instagram', leadDate: at('2026-11-25') });
await insert(Collection, { employeeId: emp._id, amount: 700, date: at('2026-11-12'), status: 'verified', notes: 'analyst', type: 'payment' });

await check('a range: bookings, enquiries and cash for those days only, and it says which days', async () => {
  const r = await json('/reports/financial-analyst?from=2026-11-01&to=2026-11-17', token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.sales.totals.totalBookings, 3, 'the 1st, the 10th and the 17th');
  assert.equal(r.body.sales.totals.totalCancellations, 1);
  assert.equal(r.body.sales.enquiries, 2);
  assert.equal(r.body.sales.leadSource.Instagram, 1);
  // collections dated in the range: 200 (the first second of the 1st) + 300 + 400 (the last second of the 17th) + 999 (Meera's) + 700; 100 and 500 are outside
  assert.equal(r.body.finance.cashCollected, 200 + 300 + 400 + 999 + 700);
  assert.deepEqual(r.body.period, { from: '2026-11-01', to: '2026-11-17', days: 17, label: '1 Nov – 17 Nov 2026', custom: true });
  assert.equal(r.body.month, '2026-11');
});
await check('"forward" bookings are the same number of days after the range', async () => {
  const r = await json('/reports/financial-analyst?from=2026-11-01&to=2026-11-17', token);
  // 18 Nov .. 4 Dec: the 18th and the 20th
  assert.equal(r.body.sales.forwardBookings.count, 2);
  assert.equal(r.body.sales.forwardBookings.value, 20000);
});
await check('the month form is read as always, by IST days, forward = next month', async () => {
  const r = await json('/reports/financial-analyst?month=2026-11', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.sales.totals.totalBookings, 5, '1st, 10th, 17th, 18th, 20th');
  assert.equal(r.body.month, '2026-11');
  assert.deepEqual([r.body.period.from, r.body.period.to, r.body.period.custom], ['2026-11-01', '2026-11-30', false]);
  assert.equal(r.body.sales.forwardBookings.count, 0, 'nothing in December');
  const oct = await json('/reports/financial-analyst?month=2026-10', token);
  assert.equal(oct.body.sales.totals.totalBookings, 1, '31 Oct only');
  assert.equal(oct.body.sales.forwardBookings.count, 5);
});
await check('new vs repeat clients look back from the start of the range', async () => {
  await mkBooking('2026-09-15', { phone: '99999100000', customerName: 'Earlier' }); // the 10th's client (same number) booked before
  const r = await json('/reports/financial-analyst?from=2026-11-10&to=2026-11-10', token);
  assert.equal(r.body.customerRelations.repeatClients, 1);
  assert.equal(r.body.customerRelations.newClients, 0);
});
await check('a bad range is refused', async () => {
  for (const [q, code] of [['from=2026-11-17&to=2026-11-01', 'RANGE_REVERSED'], ['from=2026-11-01', 'RANGE_INVALID'], ['from=2019-01-01&to=2026-11-17', 'RANGE_TOO_LONG']]) {
    const r = await json(`/reports/financial-analyst?${q}`, token);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, code, q);
  }
});

console.log('The sales goals report');
await Goal.create({ metric: 'bookings', periodType: 'day', periodStart: '2026-11-10', value: 2, setBy: boss._id });
await Goal.create({ metric: 'bookings', periodType: 'day', periodStart: '2026-11-12', value: 3, setBy: boss._id });
await Goal.create({ metric: 'bookings', periodType: 'day', periodStart: '2026-11-20', value: 9, setBy: boss._id }); // outside the range below
await Goal.create({ metric: 'bookings', periodType: 'month', periodStart: '2026-11-01', value: 40, setBy: boss._id });
const metric = (body, key) => body.metrics.find((m) => m.key === key);
await check('a range: actuals for those days, a row for each day, and the target is what the days in it were given', async () => {
  const r = await json('/goals/report?from=2026-11-01&to=2026-11-17&basis=event', token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.granularity, 'range');
  assert.deepEqual(r.body.period, { start: '2026-11-01', end: '2026-11-17', days: 17 });
  assert.equal(r.body.days.length, 17);
  assert.deepEqual([r.body.days[0].day, r.body.days.at(-1).day], ['2026-11-01', '2026-11-17']);
  const b = metric(r.body, 'bookings');
  assert.equal(b.actual, 3, 'the 1st, the 10th, the 17th — a cancelled one and the 18th are not');
  assert.equal(b.target, 5, 'day goals 2 + 3; the 9 on the 20th and the month\'s 40 are not this stretch\'s');
  assert.equal(b.pct, 60);
  assert.equal(metric(r.body, 'revenue').actual, 30000);
  assert.equal(metric(r.body, 'revenue').target, null, 'no revenue goal set for any of those days');
  assert.equal(metric(r.body, 'revenue').pct, null);
  // the days add up to the totals
  assert.equal(r.body.days.reduce((n, d) => n + d.bookings, 0), 3);
  assert.deepEqual(r.body.days.find((d) => d.day === '2026-11-10').targets.bookings, 2);
});
await check('a day outside every goal has no target at all', async () => {
  const r = await json('/goals/report?from=2026-11-14&to=2026-11-16&basis=event', token);
  assert.equal(metric(r.body, 'bookings').target, null);
  assert.equal(metric(r.body, 'bookings').actual, 0);
});
await check('the day / week / month form is untouched', async () => {
  const r = await json('/goals/report?granularity=month&date=2026-11-10&basis=event', token);
  assert.equal(r.status, 200);
  assert.equal(r.body.granularity, 'month');
  assert.equal(metric(r.body, 'bookings').actual, 5);
  assert.equal(metric(r.body, 'bookings').target, 40, 'the month\'s own goal');
});
await check('a bad range is refused; more than a year is too long for this one', async () => {
  for (const [q, code] of [['from=2026-11-17&to=2026-11-01', 'RANGE_REVERSED'], ['from=2026-11-01', 'RANGE_INVALID'], ['from=2025-01-01&to=2026-11-17', 'RANGE_TOO_LONG']]) {
    const r = await json(`/goals/report?${q}`, token);
    assert.equal(r.status, 400, q);
    assert.equal(r.body.code, code, q);
  }
  assert.equal((await json('/goals/report?from=2025-11-18&to=2026-11-17&basis=event', token)).status, 200, 'exactly a year is fine');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
