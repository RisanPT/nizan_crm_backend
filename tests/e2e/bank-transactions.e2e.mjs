// End-to-end check of an account's STATEMENT (Finance → Bank & Cash Balance → transactions): each row
// says what it was for (who, which work, category, notes), carries the balance after it, can be filtered,
// paged and exported — and the older app's call still gets what it expects.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/bt-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/bt-e2e --fork --logpath /tmp/bt-e2e/log
//   node tests/e2e/bank-transactions.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/bank_transactions_e2e');
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
const Collection = await imp('models/Collection.js');
const FuelExpense = await imp('models/FuelExpense.js');
const Vehicle = await imp('models/Vehicle.js');
const AdminExpense = await imp('models/AdminExpense.js');
const CashTransaction = await imp('models/CashTransaction.js');
const JournalEntry = await imp('models/JournalEntry.js');
const ChartOfAccount = await imp('models/ChartOfAccount.js');
const BankAccount = await imp('models/BankAccount.js');
const { postDoc } = await import(new URL('services/posting.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/accounting', await imp('routes/accountingRoutes.js'));
app.use('/api/bank-accounts', await imp('routes/bankAccountRoutes.js'));
app.use('/api/reports', await imp('routes/reportRoutes.js'));
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
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 10).join('\n      ')}`);
  }
};

// ── the books, an account, people and works ─────────────────────────────────
const mkUser = async (key, role, employeeId) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role, employeeId });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const accounts = await mkUser('Meera', 'accounts');
const sales = await mkUser('sales', 'sales');
assert.equal((await api('POST', '/accounting/accounts/seed', accounts.token)).status, 200);

const ist = (day, hhmm = '12:00') => new Date(`${day}T${hhmm}:00+05:30`);
const cashRes = await api('POST', '/bank-accounts', accounts.token, { name: 'Cash in hand', kind: 'cash', balance: 10000, asOf: '2026-10-31' });
const cash = await BankAccount.findById(cashRes.body._id).lean();
const bankRes = await api('POST', '/bank-accounts', accounts.token, { name: 'Axis current', kind: 'bank', bankName: 'AXIS BANK', accountNumber: '9988773928', balance: 50000, asOf: '2026-10-31' });
const bank = await BankAccount.findById(bankRes.body._id).lean();
const money = { moneyAccount: cash._id, ledgerAccount: cash.ledger };

const emp = (name, extra = {}) => Employee.create({ name, type: 'in-house', artistRole: 'artist', phone: '9895000001', category: 'creative', department: 'Creative', role: 'Makeup Artist', ...extra });
const asha = await emp('Asha');
const driver = await emp('Rasal', { artistRole: undefined, role: 'Driver', department: 'Fleet' });
const w1 = await Booking.create({
  bookingNumber: 'BK-100', customerName: 'Megha', service: 'Bridal', bookingDate: ist('2026-11-08', '00:00'), serviceStart: ist('2026-11-08', '09:00'), serviceEnd: ist('2026-11-08', '13:00'),
  totalPrice: 50000, status: 'confirmed', address: 'Venue', assignedStaff: [{ employeeId: asha._id, artistName: 'Asha', roleType: 'lead' }],
});
const car = await Vehicle.create({ name: 'Innova', registrationNumber: 'KL-11-AB-1234' }).catch(async (e) => {
  // the vehicle model may ask for more — fill what it names
  const more = Object.fromEntries(Object.keys(e.errors ?? {}).map((k) => [k, 'x']));
  return Vehicle.create({ name: 'Innova', registrationNumber: 'KL-11-AB-1234', ...more });
});

const post = async (model, doc) => {
  const r = await postDoc(model, doc.toObject());
  assert.equal(r.status, 'posted', `${model} did not post: ${JSON.stringify(r)}`);
};

// BEFORE any balance was entered (20 Oct) — its balance cannot be known
await post('Collection', await Collection.create({ employeeId: asha._id, bookingId: w1._id, amount: 700, date: ist('2026-10-20'), verifiedAt: ist('2026-10-20'), status: 'verified', paymentMode: 'cash', ...money }));
// after the 31 Oct balance of 10,000:
const coll = await Collection.create({ employeeId: asha._id, bookingId: w1._id, amount: 25000, date: ist('2026-11-06'), verifiedAt: ist('2026-11-06'), verifiedBy: accounts.user._id, status: 'verified', paymentMode: 'upi', paymentRef: 'UTR-778', notes: 'balance payment', ...money });
await post('Collection', coll);
const food = await Expense.create({ employeeId: asha._id, bookingId: w1._id, category: 'food', meal: 'lunch', amount: 1400, loggedAmount: 1517, approvalNote: 'over the meal limit', date: ist('2026-11-08', '13:30'), verifiedAt: ist('2026-11-08', '18:00'), verifiedBy: accounts.user._id, status: 'verified', paymentMode: 'cash', notes: 'afternoon fd 4 person', ...money });
await post('Expense', food);
const fuel = await Expense.create({ employeeId: asha._id, category: 'fuel', amount: 500, date: ist('2026-11-09', '08:00'), verifiedAt: ist('2026-11-09', '10:00'), status: 'verified', paymentMode: 'cash', ...money });
await post('Expense', fuel);
const fleet = await FuelExpense.create({ vehicleId: car._id, driverId: driver._id, category: 'fuel', date: ist('2026-11-09', '11:00'), totalAmount: 2000, liters: 20, station: 'HP Kollam', status: 'approved', paymentMode: 'cash', ...money });
await post('FuelExpense', fleet);
const admin = await AdminExpense.create({ title: 'Courier to client', department: 'Administration', category: 'office', expenseHead: 'OFF-01', vendor: 'DTDC', amount: 300, date: ist('2026-11-10'), paymentMethod: 'cash', paidByName: 'Meera', status: 'approved', createdBy: accounts.user._id, ...money });
await post('AdminExpense', admin);
// a transfer: cash → bank (out of this account, into the other)
const transfer = await CashTransaction.create({ type: 'transfer', date: ist('2026-11-11'), amount: 5000, notes: 'deposit', createdByName: 'Meera', ...money, toMoneyAccount: bank._id, toLedgerAccount: bank.ledger });
await post('CashTransaction', transfer);
// a voucher keyed by hand: no record behind it
const charges = await ChartOfAccount.findOne({ code: 'OFF-01' }).lean();
await JournalEntry.create({ date: ist('2026-11-11', '15:00'), voucherNo: 'JV/2026-27/0001', voucherType: 'journal', narration: 'Cash short', status: 'posted', lines: [{ account: charges._id, debit: 99, credit: 0 }, { account: cash.ledger, debit: 0, credit: 99 }] });

const tx = (qs = '', token = accounts.token, id = cash._id) => api('GET', `/bank-accounts/${id}/transactions${qs}`, token);
const byKind = (rows, kind, pred = () => true) => rows.find((r) => r.kind === kind && pred(r));
const detail = (row, label) => row.details.find((d) => d.label === label)?.value;

await check('a page of the statement: newest first, each with the balance after it, opening and closing', async () => {
  const r = await tx('?page=1&limit=20');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.equal(b.opening, 10000, 'the balance entered for 31 Oct');
  assert.equal(b.totalItems, 7, 'the 20 Oct entry is before the balance, so it is not part of it');
  assert.deepEqual(b.rows.map((x) => x.out || -x.in), [99, 5000, 300, 2000, 500, 1400, -25000]);
  assert.deepEqual(b.rows.map((x) => x.balance), [25701, 25800, 30800, 31100, 33100, 33600, 35000]);
  assert.equal(b.closing, 25701);
  assert.deepEqual(b.totals, { in: 25000, out: 9299, net: 15701, count: 7 });
  assert.equal(b.truncated, false);
  // …and it is the account's live balance
  const list = await api('GET', '/bank-accounts', accounts.token);
  assert.equal(list.body.accounts.find((a) => a._id === String(cash._id)).currentBalance, 25701);
});

await check('an artist expense says who, which work, what, the logged and approved amounts and why', async () => {
  const rows = (await tx('?page=1&limit=20')).body.rows;
  const e = byKind(rows, 'artist_expense', (r) => r.category === 'food');
  assert.equal(e.kindLabel, 'Artist expense');
  assert.equal(e.particulars, 'Artist expense · Food');
  assert.deepEqual([e.person.name, e.person.role], ['Asha', 'Artist']);
  assert.deepEqual([e.client, e.bookingNumber, e.title], ['Megha', 'BK-100', 'Megha']);
  assert.equal(e.subtitle, 'Asha · BK-100');
  assert.deepEqual([e.out, e.loggedAmount], [1400, 1517]);
  assert.equal(e.notes, 'afternoon fd 4 person');
  assert.equal(detail(e, 'Artist'), 'Asha');
  assert.equal(detail(e, 'Client / work'), 'Megha');
  assert.equal(detail(e, 'Meal'), 'Lunch');
  assert.equal(detail(e, 'Logged amount'), '₹1,517');
  assert.equal(detail(e, 'Approved amount'), '₹1,400');
  assert.equal(detail(e, 'Why it was reduced'), 'over the meal limit');
  assert.equal(detail(e, 'Approved by'), 'Meera');
  assert.equal(detail(e, 'Work date'), '8 Nov 2026');
  assert.match(detail(e, 'Spent on'), /^8 Nov 2026, 1:30 PM$/);
  assert.match(detail(e, 'Voucher'), /^PAY\//);
  assert.match(detail(e, 'Posted to'), /^FOO-01 · /, 'the expense head it was booked to');
});

await check('an expense with no work to belong to says so', async () => {
  const rows = (await tx('?page=1&limit=20')).body.rows;
  const e = byKind(rows, 'artist_expense', (r) => r.category === 'fuel');
  assert.equal(e.title, 'Not tied to a work');
  assert.equal(detail(e, 'Client / work'), 'Not tied to a work');
  assert.equal(e.loggedAmount, null);
  assert.equal(detail(e, 'Logged amount'), undefined, 'not reduced: one amount');
});

await check('a collection says the client, the booking, who collected it, how and the reference', async () => {
  const rows = (await tx('?page=1&limit=20')).body.rows;
  const c = byKind(rows, 'collection');
  assert.equal(c.particulars, 'Collection · Booking');
  assert.deepEqual([c.client, c.bookingNumber, c.person.name, c.person.role], ['Megha', 'BK-100', 'Asha', 'Collected by']);
  assert.equal(c.in, 25000);
  assert.equal(c.reference, 'UTR-778');
  assert.equal(detail(c, 'Payment mode'), 'UPI');
  assert.equal(detail(c, 'Reference'), 'UTR-778');
  assert.equal(detail(c, 'Verified by'), 'Meera');
  assert.equal(detail(c, 'Notes'), 'balance payment');
  assert.equal(detail(c, 'Service'), 'Bridal');
});

await check('fleet, admin expense, a transfer and a hand-keyed voucher each read as what they are', async () => {
  const rows = (await tx('?page=1&limit=20')).body.rows;
  const f = byKind(rows, 'fleet');
  assert.equal(f.particulars, 'Fleet · Fuel');
  assert.equal(f.person.name, 'Rasal');
  assert.match(detail(f, 'Vehicle'), /Innova · KL-11-AB-1234/);
  assert.equal(detail(f, 'Station'), 'HP Kollam');
  const a = byKind(rows, 'admin_expense');
  assert.equal(a.title, 'Courier to client');
  assert.match(a.particulars, /^Admin expense · /);
  assert.equal(detail(a, 'Vendor'), 'DTDC');
  const t = byKind(rows, 'transfer');
  assert.equal(t.kindLabel, 'Transfer');
  assert.equal(t.out, 5000);
  assert.equal(detail(t, 'To account'), 'Axis current');
  const j = byKind(rows, 'journal');
  assert.equal(j.title, 'Cash short');
  assert.equal(j.voucherNo, 'JV/2026-27/0001');
  assert.match(detail(j, 'Posted to'), /^OFF-01/);
});

await check('the transfer shows on the other account as money in', async () => {
  const r = await tx('?page=1&limit=20', accounts.token, bank._id);
  assert.equal(r.body.totalItems, 1);
  assert.deepEqual([r.body.rows[0].in, r.body.rows[0].kind, r.body.rows[0].balance], [5000, 'transfer', 55000]);
});

await check('filters: money in / out, a category, a person, free text — and the facets to choose from', async () => {
  const all = (await tx('?page=1&limit=20')).body;
  assert.deepEqual(all.facets.groups.map((g) => g.key).sort(), ['admin_expense:OFF-01', 'artist_expense:food', 'artist_expense:fuel', 'collection:booking', 'fleet:fuel', 'journal', 'transfer']);
  assert.ok(all.facets.people.some((p) => p.name === 'Asha' && p.count === 3));
  const ashaKey = all.facets.people.find((p) => p.name === 'Asha').key;

  assert.equal((await tx('?page=1&direction=in')).body.totalItems, 1);
  assert.equal((await tx('?page=1&direction=out')).body.totalItems, 6);
  const fuelOnly = (await tx('?page=1&group=artist_expense:fuel')).body;
  assert.deepEqual([fuelOnly.totalItems, fuelOnly.rows[0].out], [1, 500]);
  assert.deepEqual(fuelOnly.totals, { in: 0, out: 500, net: -500, count: 1 }, 'totals follow the filter');
  assert.equal(fuelOnly.allTotals.count, 7, '…and the unfiltered totals are still there');
  assert.equal(fuelOnly.rows[0].balance, 33100, 'the balance is the ACCOUNT\'s balance after it, filter or not');
  assert.equal((await tx(`?page=1&person=${encodeURIComponent(ashaKey)}`)).body.totalItems, 3);
  assert.equal((await tx('?page=1&search=megha')).body.totalItems, 2, 'the collection and the food expense');
  assert.equal((await tx('?page=1&search=DTDC')).body.totalItems, 0, 'vendor is in the details, not searched');
  assert.equal((await tx('?page=1&search=courier')).body.totalItems, 1);
  assert.equal((await tx('?page=1&search=UTR-778')).body.totalItems, 1);
  assert.equal((await tx('?page=1&search=JV/2026')).body.totalItems, 1);
});

await check('paging: page 2 of 3 by 3, and every match with export=1', async () => {
  const p2 = (await tx('?page=2&limit=3')).body;
  assert.deepEqual([p2.page, p2.limit, p2.totalItems, p2.totalPages, p2.rows.length], [2, 3, 7, 3, 3]);
  assert.deepEqual(p2.rows.map((x) => x.out), [2000, 500, 1400]);
  const ex = (await tx('?export=1&direction=out')).body;
  assert.equal(ex.rows.length, 6);
  assert.equal(ex.rows[0].out, 99, 'newest first');
});

await check('a date range reaches before the balance: that row has no known balance, the rest are worked out', async () => {
  const r = (await tx('?page=1&limit=20&from=2026-10-01&to=2026-11-08')).body;
  assert.deepEqual(r.range, { from: '2026-10-01', to: '2026-11-08' });
  assert.equal(r.since, null);
  assert.deepEqual(r.rows.map((x) => [x.in || -x.out, x.balance]), [[-1400, 33600], [25000, 35000], [700, null]]);
  assert.equal(r.opening, null, 'no balance had been entered before 1 Oct');
  assert.equal(r.closing, 33600);
  const nov = (await tx('?page=1&limit=20&from=2026-11-07&to=2026-11-09')).body;
  assert.equal(nov.opening, 35000, 'what it held going into 7 Nov');
  assert.deepEqual(nov.rows.map((x) => x.balance), [31100, 33100, 33600]);
});

await check('a new manual balance starts a new stretch: the default view begins after it', async () => {
  const r = await api('POST', `/bank-accounts/${cash._id}/balance`, accounts.token, { balance: 30000, asOf: '2026-11-10', note: 'cash count' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const now = (await tx('?page=1&limit=20')).body;
  assert.equal(now.opening, 30000);
  assert.deepEqual(now.rows.map((x) => [x.out, x.balance]), [[99, 24901], [5000, 25000]]);
  // the whole of November still reads, each stretch against the balance in force then
  const month = (await tx('?page=1&limit=20&from=2026-11-01&to=2026-11-30')).body;
  assert.deepEqual(month.rows.map((x) => x.balance), [24901, 25000, 30800, 31100, 33100, 33600, 35000]);
  assert.equal(month.opening, 10000);
});

await check('the older app\'s call (no page) still gets every row, oldest first, with what it reads', async () => {
  const r = (await tx('')).body;
  assert.ok(Array.isArray(r.rows));
  assert.equal(r.page, undefined);
  assert.deepEqual(r.rows.map((x) => x.out), [5000, 99], 'oldest first');
  for (const k of ['date', 'voucherNo', 'narration', 'source', 'in', 'out', 'balance']) assert.ok(k in r.rows[0], k);
  assert.deepEqual([r.opening, r.closing], [30000, 24901]);
  assert.ok(r.since);
});

await check('the accounts list says what each held at the end of last month', async () => {
  const old = (await api('POST', '/bank-accounts', accounts.token, { name: 'Old box', kind: 'cash', balance: 500, asOf: '2020-01-01' })).body;
  const fresh = (await api('POST', '/bank-accounts', accounts.token, { name: 'New box', kind: 'cash', balance: 900, asOf: new Date().toISOString() })).body;
  // ₹100 came into the old box TODAY: it is in the live balance, but not in last month's
  const oldDoc = await BankAccount.findById(old._id).lean();
  await JournalEntry.create({ date: new Date(), voucherNo: 'JV/TODAY', voucherType: 'journal', narration: 'found in the drawer', status: 'posted', lines: [{ account: oldDoc.ledger, debit: 100, credit: 0 }, { account: charges._id, debit: 0, credit: 100 }] });
  const list = (await api('GET', '/bank-accounts', accounts.token)).body;
  assert.match(list.previous.asOf, /^\d{4}-\d{2}-\d{2}$/);
  const of = (id) => list.accounts.find((a) => a._id === id);
  assert.equal(of(old._id).currentBalance, 600);
  assert.equal(of(old._id).previousBalance, 500, 'what it held at the END OF LAST MONTH — before today\'s ₹100');
  assert.equal(of(fresh._id).previousBalance, null, 'its first balance is from this month: nothing to compare with');
  assert.equal(list.previous.total, null, 'so the total cannot be compared either');
});

await check('the month-end review\'s cash & bank are the accounts\' balances (the Finance dashboard agrees with Bank balances)', async () => {
  // money posted on the bank ledger BEFORE its balance was entered from the statement: that balance already holds it — the review
  // used to add it again (every cash / bank ledger from day one)
  const axis = await BankAccount.findById(bank._id).lean();
  await JournalEntry.create({ date: ist('2026-10-15'), voucherNo: 'JV/OLD', voucherType: 'journal', narration: 'before the statement balance', status: 'posted', lines: [{ account: axis.ledger, debit: 99999, credit: 0 }, { account: charges._id, debit: 0, credit: 99999 }] });
  const list = (await api('GET', '/bank-accounts', accounts.token)).body;
  const [y, m] = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7).split('-').map(Number);
  const now = await api('GET', `/reports/month-end?year=${y}&month=${m}`, accounts.token);
  assert.equal(now.status, 200, now.text);
  const c = now.body.cashFlow;
  assert.deepEqual([c.bankBalance, c.cashBalance, c.totalLiquid, c.cashSource, c.cashMissing], [list.bankTotal, list.cashTotal, list.totalBalance, 'accounts', 0], 'this month: the live balances, exactly');
  // a past month: each account's balance at its end — what the statement says its closing was
  const oct = (await api('GET', '/reports/month-end?year=2026&month=10', accounts.token)).body.cashFlow;
  let bankEnd = 0;
  let cashEnd = 0;
  let missing = 0;
  for (const a of (await api('GET', '/bank-accounts', accounts.token)).body.accounts.filter((x) => x.active)) {
    const st = (await api('GET', `/bank-accounts/${a._id}/transactions?from=2026-10-01&to=2026-10-31&page=1`, accounts.token)).body;
    if (st.closing === null || st.closing === undefined) {
      missing += 1;
      continue;
    }
    if (a.kind === 'cash') cashEnd += st.closing;
    else bankEnd += st.closing;
  }
  assert.deepEqual([oct.bankBalance, oct.cashBalance, oct.cashMissing], [Math.round(bankEnd * 100) / 100, Math.round(cashEnd * 100) / 100, missing]);
  assert.ok(oct.cashMissing >= 1, 'an account whose first balance is from this month had none at the end of October');
  assert.equal(oct.bankBalance < 99999, true, 'the October entry before the statement balance is not counted twice');
});

await check('only finance staff; a bad range or direction is refused; an unknown account is 404', async () => {
  assert.equal((await tx('?page=1', sales.token)).status, 403);
  assert.equal((await tx('?page=1&from=2026-11-20&to=2026-11-01')).status, 400);
  assert.equal((await tx('?page=1&direction=up')).status, 400);
  assert.equal((await api('GET', `/bank-accounts/${new mongoose.Types.ObjectId()}/transactions?page=1`, accounts.token)).status, 404);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
