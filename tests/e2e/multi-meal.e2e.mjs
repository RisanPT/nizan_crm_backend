// End-to-end check of ONE FOOD ENTRY COVERING SEVERAL MEALS (a long trip: breakfast + lunch + dinner on
// one bill) and of the travel distance Accounts sees beside it.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/meal-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/meal-e2e --fork --logpath /tmp/meal-e2e/log
//   node tests/e2e/multi-meal.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/multi_meal_e2e');
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
const FoodAllowance = await imp('models/FoodAllowance.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/expenses', await imp('routes/expenseRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

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
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

// ── people ──────────────────────────────────────────────────────────────────
const emp = (name, extra = {}) => Employee.create({ name, type: 'in-house', artistRole: 'artist', phone: '9895000001', category: 'creative', department: 'Creative', role: 'Makeup Artist', ...extra });
const asha = await emp('Asha');
const beena = await emp('Beena');
const mkUser = async (key, role, employeeId) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role, employeeId });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const ashaU = await mkUser('asha', 'artist', asha._id);
const beenaU = await mkUser('beena', 'artist', beena._id);
const accounts = await mkUser('accounts', 'accounts');

// 12 Nov 2026 (IST): a far wedding for Asha + Beena; 13 Nov: two works for Asha (morning + evening)
const ist = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
const staff = (e, roleType) => ({ employeeId: e._id, artistName: e.name, roleType });
const work = (num, day, from, to, extra = {}) =>
  Booking.create({ bookingNumber: num, customerName: `Bride ${num}`, service: 'Bridal', bookingDate: ist(day, '00:00'), serviceStart: ist(day, from), serviceEnd: ist(day, to), totalPrice: 50000, status: 'confirmed', address: 'Venue', ...extra });
const far = await work('W-FAR', '2026-11-12', '17:00', '21:00', { travelDistanceKm: 287, assignedStaff: [staff(asha, 'lead'), staff(beena, 'assistant')] });
const am = await work('W-AM', '2026-11-13', '08:00', '11:00', { travelDistanceKm: 40, assignedStaff: [staff(asha, 'lead')] });
const pm = await work('W-PM', '2026-11-13', '18:00', '21:00', { travelDistanceKm: 0, assignedStaff: [staff(asha, 'lead')] });

for (const [meal, amountPerHead] of [['breakfast', 100], ['lunch', 150], ['dinner', 150]]) await FoodAllowance.create({ meal, amountPerHead });

const food = (token, body) => api('POST', '/expenses', token, { category: 'food', workType: 'bridal', ...body });
const mine = (id) => Expense.findById(id).lean();

// ── saving ──────────────────────────────────────────────────────────────────
let trip;
await check('one entry can cover several meals: they are stored in the order of the day, `meal` stays empty', async () => {
  const r = await food(ashaU.token, { amount: 1000, date: ist('2026-11-12', '22:00'), meals: ['dinner', 'breakfast', 'lunch', 'lunch'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.meals, ['breakfast', 'lunch', 'dinner']);
  assert.equal(r.body.meal, '');
  trip = r.body._id;
  const row = await mine(trip);
  assert.deepEqual(row.meals, ['breakfast', 'lunch', 'dinner']);
});

await check('the team limit is for the POOL: 2 heads × (100+150+150) = ₹800; ₹1000 is over by ₹200', async () => {
  const r = await api('GET', '/expenses/meal-preview?at=' + encodeURIComponent(ist('2026-11-12', '22:00').toISOString()) + '&meals=breakfast,lunch,dinner', ashaU.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.meals, ['breakfast', 'lunch', 'dinner']);
  assert.equal(r.body.suggestion.mode, 'single');
  assert.equal(r.body.team.heads, 2);
  assert.equal(r.body.team.allowancePerHead, 400);
  assert.equal(r.body.team.limit, 800);
  assert.equal(r.body.team.alreadySpent, 1000, 'the entry saved above counts');
  assert.deepEqual(r.body.team.meals, ['breakfast', 'lunch', 'dinner']);
});

await check('saving over the pool limit reports it: limitCheck names the meals', async () => {
  const r = await food(beenaU.token, { amount: 300, date: ist('2026-11-12', '10:00'), meals: ['breakfast', 'lunch'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // pool grows: this entry ties breakfast+lunch to the earlier breakfast+lunch+dinner entry → ₹1000 + ₹300 vs ₹800
  assert.equal(r.body.limitCheck.status, 'over');
  assert.deepEqual(r.body.limitCheck.meals, ['breakfast', 'lunch', 'dinner']);
  assert.equal(r.body.limitCheck.meal, 'breakfast+lunch+dinner');
  assert.equal(r.body.limitCheck.allowancePerHead, 400);
  assert.equal(r.body.limitCheck.over, 500);
});

await check('the older way still works: one meal sent as `meal`', async () => {
  const r = await food(ashaU.token, { amount: 90, date: ist('2026-11-13', '09:00'), meal: 'breakfast' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.meal, 'breakfast');
  assert.deepEqual(r.body.meals, ['breakfast']);
});

await check('a non-food expense keeps no meals', async () => {
  const r = await api('POST', '/expenses', ashaU.token, { category: 'travel', amount: 50, date: ist('2026-11-12', '12:00'), meals: ['lunch'], meal: 'lunch' });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.meals, []);
  assert.equal(r.body.meal, '');
});

// ── where it is counted ─────────────────────────────────────────────────────
await check('ONE work that day: the combined entry is counted under it, with the work\'s distance', async () => {
  const r = await api('GET', '/expenses?withWorks=1&page=1&limit=100', accounts.token);
  assert.equal(r.status, 200);
  const list = Array.isArray(r.body) ? r.body : r.body.items;
  const e = list.find((x) => String(x._id) === trip);
  assert.equal(e.allocation.mode, 'single');
  assert.equal(String(e.allocation.shares[0].bookingId), String(far._id));
  assert.equal(e.allocation.shares[0].travelDistanceKm, 287);
  assert.deepEqual(e.allocation.meals, ['breakfast', 'lunch', 'dinner']);
  assert.equal(e.allocation.limit.status, 'over');
  assert.equal(e.allocation.limit.meal, 'breakfast+lunch+dinner');
});

let multi;
await check('SEVERAL works that day: the combined entry goes to the LAST work', async () => {
  const r = await food(ashaU.token, { amount: 600, date: ist('2026-11-13', '14:00'), meals: ['lunch', 'dinner'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  multi = r.body._id;
  const list = (await api('GET', '/expenses?withWorks=1&page=1&limit=100', accounts.token)).body;
  const e = (Array.isArray(list) ? list : list.items).find((x) => String(x._id) === multi);
  assert.equal(e.allocation.mode, 'last');
  assert.equal(String(e.allocation.shares[0].bookingId), String(pm._id));
  assert.match(e.allocation.reason, /Lunch and dinner in one entry — counted under the last work of the day\./);
  // and the one-meal breakfast logged the same day still goes to the MORNING work, as before
  const b = (Array.isArray(list) ? list : list.items).find((x) => x.meal === 'breakfast' && String(x.employeeId?._id ?? x.employeeId) === String(asha._id) && x.allocation?.shares?.[0]?.bookingId && String(x.allocation.shares[0].bookingId) === String(am._id));
  assert.ok(b, 'the single breakfast stays under the morning work');
});

await check('a work that has distance only on an item shows the item\'s (longest) distance', async () => {
  // written raw: the item only needs its distance + staff for this check
  await Booking.collection.updateOne({ _id: pm._id }, { $set: { bookingItems: [{ travelDistanceKm: 50, assignedStaff: [] }, { travelDistanceKm: 65, assignedStaff: [{ employeeId: asha._id, artistName: 'Asha', roleType: 'lead' }] }] } });
  const list = (await api('GET', '/expenses?withWorks=1&page=1&limit=100', accounts.token)).body;
  const e = (Array.isArray(list) ? list : list.items).find((x) => String(x._id) === multi);
  assert.equal(e.allocation.shares[0].travelDistanceKm, 65);
});

await check('the artist\'s preview for several meals on a two-work day suggests the last work', async () => {
  const r = await api('GET', '/expenses/meal-preview?at=' + encodeURIComponent(ist('2026-11-13', '14:00').toISOString()) + '&meals=lunch,dinner', ashaU.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.suggestion.mode, 'last');
  assert.equal(r.body.suggestion.bookingId, String(pm._id));
  assert.equal(r.body.works.length, 2);
  assert.ok(r.body.works.every((w) => typeof w.travelDistanceKm === 'number'));
  assert.equal(r.body.works.find((w) => w.bookingId === String(am._id)).travelDistanceKm, 40);
  assert.equal(r.body.allowance.amountPerHead, 300);
});

await check('the old preview call (`meal=`) still works for one meal', async () => {
  const r = await api('GET', '/expenses/meal-preview?at=' + encodeURIComponent(ist('2026-11-13', '09:00').toISOString()) + '&meal=breakfast', ashaU.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.suggestion.mode, 'time');
  assert.equal(r.body.suggestion.bookingId, String(am._id));
  assert.equal(r.body.team.allowancePerHead, 100);
});

await check('no meal at all is refused', async () => {
  const r = await api('GET', '/expenses/meal-preview?at=' + encodeURIComponent(ist('2026-11-13', '09:00').toISOString()), ashaU.token);
  assert.equal(r.status, 400);
});

// ── editing ─────────────────────────────────────────────────────────────────
await check('editing: a one-meal entry can become a combined one, and back', async () => {
  const one = (await food(ashaU.token, { amount: 100, date: ist('2026-11-12', '08:00'), meal: 'breakfast' })).body;
  let r = await api('PUT', `/expenses/${one._id}`, ashaU.token, { meals: ['breakfast', 'lunch'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.meals, r.body.meal], [['breakfast', 'lunch'], '']);
  r = await api('PUT', `/expenses/${one._id}`, ashaU.token, { meals: ['lunch'] });
  assert.deepEqual([r.body.meals, r.body.meal], [['lunch'], 'lunch']);
  r = await api('PUT', `/expenses/${one._id}`, ashaU.token, { amount: 120 });
  assert.deepEqual([r.body.meals, r.body.meal, r.body.amount], [['lunch'], 'lunch', 120], 'an edit that does not touch meals keeps them');
  r = await api('PUT', `/expenses/${one._id}`, ashaU.token, { category: 'travel' });
  assert.deepEqual([r.body.meals, r.body.meal], [[], ''], 'a meal means nothing once it is not food');
});

// ── Accounts reports ────────────────────────────────────────────────────────
await check('cost per work: the distance, the lines\' meals and the pool row against the allowance', async () => {
  const r = await api('GET', '/expenses/work-costs?from=2026-11-12&to=2026-11-13', accounts.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.items.find((w) => w.bookingId === String(far._id));
  assert.equal(row.travelDistanceKm, 287);
  assert.ok(row.lines.some((l) => l.meals.length === 3));
  const pool = row.allowance.meals.find((m) => m.meals.length === 3);
  assert.equal(pool.meal, 'breakfast+lunch+dinner');
  assert.equal(pool.allowancePerHead, 400);
  assert.equal(pool.allowed, 800);
  assert.equal(pool.status, 'over');
  const pmRow = r.body.items.find((w) => w.bookingId === String(pm._id));
  assert.equal(pmRow.travelDistanceKm, 65);
  assert.equal(pmRow.food, 600);
});

await check('the artist\'s day timeline carries the distance of each work', async () => {
  const r = await api('GET', `/expenses/artist-day?employeeId=${asha._id}&day=2026-11-13`, accounts.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.works.map((w) => w.travelDistanceKm), [40, 65]);
  const last = r.body.works[1];
  assert.ok(last.expenses.some((e) => e.mode === 'last' && e.meals.length === 2));
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
