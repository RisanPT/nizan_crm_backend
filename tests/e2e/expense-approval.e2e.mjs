// End-to-end check of APPROVING an artist expense for LESS than was logged: the approved amount is
// what the books post, what the Bank & Cash account is reduced by and what every report adds up; the
// logged amount stays on record beside it.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/appr-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/appr-e2e --fork --logpath /tmp/appr-e2e/log
//   node tests/e2e/expense-approval.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/expense_approval_e2e');
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
const JournalEntry = await imp('models/JournalEntry.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/accounting', await imp('routes/accountingRoutes.js'));
app.use('/api/bank-accounts', await imp('routes/bankAccountRoutes.js'));
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

// ── people, the books, the cash account ─────────────────────────────────────
const asha = await Employee.create({ name: 'Asha', type: 'in-house', artistRole: 'artist', phone: '9895000001', category: 'creative', department: 'Creative', role: 'Makeup Artist' });
const mkUser = async (key, role, employeeId) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role, employeeId });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const accounts = await mkUser('accounts', 'accounts');
const ashaU = await mkUser('asha', 'artist', asha._id);
assert.equal((await api('POST', '/accounting/accounts/seed', accounts.token)).status, 200);

const OPENING = 10000;
const cash = (await api('POST', '/bank-accounts', accounts.token, { name: 'Cash in hand', kind: 'cash', balance: OPENING, asOf: '2026-11-01' })).body;
assert.ok(cash._id ?? cash.id, JSON.stringify(cash));
const cashId = cash._id ?? cash.id;
const balance = async () => (await api('GET', '/bank-accounts', accounts.token)).body.accounts?.find((a) => (a._id ?? a.id) === cashId)?.currentBalance
  ?? (await api('GET', '/bank-accounts', accounts.token)).body.find?.((a) => (a._id ?? a.id) === cashId)?.currentBalance;

const ist = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
const work = await Booking.create({
  bookingNumber: 'W-1', customerName: 'Bride One', service: 'Bridal', bookingDate: ist('2026-11-12', '00:00'),
  serviceStart: ist('2026-11-12', '09:00'), serviceEnd: ist('2026-11-12', '13:00'), totalPrice: 50000, status: 'confirmed', address: 'Venue',
  assignedStaff: [{ employeeId: asha._id, artistName: 'Asha', roleType: 'lead' }],
});
const log = (category, amount, extra = {}) => Expense.create({ employeeId: asha._id, category, amount, workType: 'bridal', date: ist('2026-11-12', '12:00'), ...extra });
const A = await log('food', 1517, { meal: 'lunch', bookingId: work._id });
const B = await log('travel', 300);
const C = await log('fuel', 500);
const D = await log('fuel', 800, { bookingId: work._id });

const approve = (e, body, token = accounts.token) =>
  api('PUT', `/expenses/${e._id}/verify`, token, { status: 'verified', verifiedBy: String(accounts.user._id), verifiedAt: '2026-11-16T10:00:00+05:30', moneyAccountId: cashId, paymentMode: 'cash', ...body });
const vouchers = (e) => JournalEntry.find({ 'source.model': 'Expense', 'source.id': e._id }).lean();
const fresh = (e) => Expense.findById(e._id).lean();

await check('approving for less: the approved amount counts and the logged one is kept with the reason', async () => {
  const r = await approve(A, { approvedAmount: 1400, approvalNote: 'over the meal limit' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'verified');
  assert.equal(r.body.amount, 1400);
  assert.equal(r.body.loggedAmount, 1517);
  assert.equal(r.body.approvalNote, 'over the meal limit');
  const stored = await fresh(A);
  assert.deepEqual([stored.amount, stored.loggedAmount], [1400, 1517]);
});

await check('only the approved amount is posted: debit the head, credit the cash account — and the balance drops by it', async () => {
  const v = await vouchers(A);
  assert.equal(v.length, 1);
  const lines = v[0].lines;
  assert.equal(lines.reduce((a, l) => a + l.debit, 0), 1400);
  assert.equal(lines.reduce((a, l) => a + l.credit, 0), 1400);
  assert.equal(await balance(), OPENING - 1400, 'not 1,517');
});

await check('approving in full (no amount sent, as older apps do) keeps the logged figure and no original', async () => {
  const r = await approve(B, {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, 300);
  assert.equal(r.body.loggedAmount ?? null, null);
  assert.equal(await balance(), OPENING - 1400 - 300);
});

await check('an approved amount above what was logged, zero or not a number is refused — nothing is posted', async () => {
  for (const approvedAmount of [501, 0, -1, 'abc']) {
    const r = await approve(C, { approvedAmount });
    assert.equal(r.status, 400, `approvedAmount ${approvedAmount}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.message, /approved amount/i, 'says why, in the approver\'s words');
  }
  const stored = await fresh(C);
  assert.deepEqual([stored.status, stored.amount, stored.loggedAmount], ['pending', 500, null]);
  assert.equal((await vouchers(C)).length, 0);
  assert.equal(await balance(), OPENING - 1400 - 300);
});

await check('approving again replaces the voucher (not a second one) and is judged against what was LOGGED', async () => {
  const r = await approve(A, { approvedAmount: 1500, approvalNote: 'second look' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.amount, r.body.loggedAmount], [1500, 1517]);
  const v = await vouchers(A);
  assert.equal(v.length, 1, 'one voucher per expense');
  assert.equal(v[0].lines.reduce((a, l) => a + l.debit, 0), 1500);
  assert.equal(await balance(), OPENING - 1500 - 300);
  assert.equal((await approve(A, { approvedAmount: 1600 })).status, 400, 'cannot go above the 1,517 that was logged');
});

await check('the lists add up what was approved: verified = 1,500 + 300; pending is what is still logged', async () => {
  const r = await api('GET', '/expenses?page=1&limit=20&summary=1', accounts.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = r.body.summary.byStatus;
  assert.equal(s.verified.amount, 1800);
  assert.equal(s.pending.amount, 1300, 'C 500 + D 800 not yet approved');
  const row = r.body.items.find((e) => e._id === String(A._id));
  assert.equal(row.amount, 1500);
  assert.equal(row.loggedAmount, 1517);
});

await check('cost per work counts the approved amount, not the logged one', async () => {
  assert.equal((await approve(D, { approvedAmount: 600 })).status, 200);
  const r = await api('GET', '/expenses/work-costs?from=2026-11-12&to=2026-11-12', accounts.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.items.find((w) => w.bookingId === String(work._id));
  assert.equal(row.fuel, 600);
  assert.equal(row.food, 1500);
  assert.equal(r.body.totals.byCategory.fuel, 600);
});

await check('Accounts editing the amount back up to what was logged clears the "reduced" mark; below it keeps it', async () => {
  let r = await api('PUT', `/expenses/${A._id}`, accounts.token, { amount: 1450 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.amount, r.body.loggedAmount], [1450, 1517]);
  assert.equal((await vouchers(A))[0].lines.reduce((a, l) => a + l.debit, 0), 1450, 'the voucher follows the edit');
  r = await api('PUT', `/expenses/${A._id}`, accounts.token, { amount: 1517 });
  assert.equal(r.body.loggedAmount ?? null, null);
  assert.equal(r.body.approvalNote, '');
});

await check('rejecting an approved, reduced expense pays nothing and brings the logged amount back', async () => {
  await approve(A, { approvedAmount: 1000 });
  const r = await api('PUT', `/expenses/${A._id}/verify`, accounts.token, { status: 'rejected', verifiedBy: String(accounts.user._id) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'rejected');
  assert.equal(r.body.amount, 1517);
  assert.equal(r.body.loggedAmount ?? null, null);
  assert.equal((await vouchers(A)).length, 0, 'the voucher is taken back');
  assert.equal(await balance(), OPENING - 300 - 600, 'only B (300) and D (600) are spent now');
});

await check('an artist cannot approve their own expense', async () => {
  const r = await approve(C, { approvedAmount: 100 }, ashaU.token);
  assert.equal(r.status, 403);
  assert.equal((await fresh(C)).status, 'pending');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
