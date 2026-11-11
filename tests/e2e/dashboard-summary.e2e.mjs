// End-to-end check of the Combined Accounts Dashboard summary: the new daily series and previous-period comparison,
// and that the totals did not move from the version before them (the original controller is copied in beside this
// script's run as controllers/_accountingOriginal.js — see the header of the run below).
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else, drops
// its database first):
//
//   mkdir -p /tmp/dash-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/dash-e2e --fork --logpath /tmp/dash-e2e/log
//   cp /tmp/acc.orig.js controllers/_accountingOriginal.js     # the controller as it was before the series was added (optional)
//   node tests/e2e/dashboard-summary.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import mongoose from 'mongoose';

await mongoose.connect('mongodb://127.0.0.1:27099/dash_summary_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const M = {};
for (const n of ['Collection', 'Booking', 'Trial', 'AdminExpense', 'Salary', 'HraRecord', 'Expense', 'ArtistPayout', 'FuelExpense', 'Purchase', 'Subscription', 'SalesReturn', 'CashTransaction', 'ChartOfAccount']) M[n] = await imp(`models/${n}.js`);
const { getDashboardSummary } = await import(new URL('controllers/accountingController.js', root));
const original = existsSync(new URL('controllers/_accountingOriginal.js', root)) ? await import(new URL('controllers/_accountingOriginal.js', root)) : null;
const { istDayOf } = await import(new URL('utils/dayBuckets.js', root));

const call = async (fn, query, user = { role: 'admin', permissions: [] }) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await fn({ query, user }, res);
  return res;
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

// ── dates: this IST month and the one before ─────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const today = istDayOf(new Date());
const [ty, tm, td] = today.split('-').map(Number);
const monthFirst = `${ty}-${pad(tm)}-01`;
const monthLast = `${ty}-${pad(tm)}-${pad(new Date(Date.UTC(ty, tm, 0)).getUTCDate())}`;
const prevY = tm === 1 ? ty - 1 : ty;
const prevM = tm === 1 ? 12 : tm - 1;
const prevFirst = `${prevY}-${pad(prevM)}-01`;
const prevDay2 = `${prevY}-${pad(prevM)}-02`;
const at = (day, h = 10) => new Date(`${day}T${pad(h)}:00:00+05:30`);
const oid = () => new mongoose.Types.ObjectId();

const inc = await M.ChartOfAccount.collection.insertOne({ code: 'I-1', name: 'Misc income', nature: 'income', status: 'active' });
const exp = await M.ChartOfAccount.collection.insertOne({ code: 'E-1', name: 'Misc expense', nature: 'expense', status: 'active' });
await M.Collection.collection.insertMany([
  { status: 'verified', date: at(monthFirst), bookingId: oid(), amount: 35000 },
  { status: 'verified', date: at(today), bookingId: oid(), amount: 5000 },
  { status: 'verified', date: at(today), bookingId: null, amount: 777 }, // a trial-only collection: not counted
  { status: 'pending', date: at(monthFirst), bookingId: oid(), amount: 1000 },
  { status: 'verified', date: at(prevFirst), bookingId: oid(), amount: 10000 },
  { status: 'verified', date: at(prevDay2), bookingId: oid(), amount: 7000 },
]);
await M.Booking.collection.insertMany([
  { status: 'confirmed', createdAt: at(monthFirst), advanceAmount: 3000 },
  { status: 'confirmed', createdAt: at(monthFirst, 15), advanceAmount: 3000 },
  { status: 'confirmed', createdAt: at(today), advanceAmount: 3000 },
  { status: 'pending', createdAt: at(today), advanceAmount: 9999 }, // pending bookings do not count
  { status: 'confirmed', createdAt: at(prevFirst), advanceAmount: 3000 },
]);
// (a trial's date is a 'YYYY-MM-DD' string; a cancelled trial's fee is not counted)
await M.Trial.collection.insertMany([
  { trialDate: monthFirst, status: 'scheduled', trialItems: [{ price: 1500 }] },
  { trialDate: monthFirst, status: 'cancelled', trialItems: [{ price: 7777 }] },
  { trialDate: prevFirst, status: 'completed', trialItems: [{ price: 1000 }, { price: 500 }] },
]);
await M.AdminExpense.collection.insertMany([
  { status: 'approved', source: 'manual', date: at(monthFirst), amount: 4000 },
  { status: 'approved', source: 'manual', date: at(prevFirst), amount: 2000 },
  { status: 'pending', source: 'manual', date: at(today), amount: 900 },
]);
await M.Salary.collection.insertMany([
  { status: 'paid', paymentDate: at(today), netAmount: 12000, month: tm, year: ty },
  { status: 'paid', netAmount: 8000, month: tm, year: ty }, // no payment date: counted on the 15th
]);
await M.Expense.collection.insertMany([
  { status: 'verified', date: at(monthFirst), amount: 1203 },
  { status: 'pending', date: at(today), amount: 100 },
]);
await M.ArtistPayout.collection.insertOne({ status: 'paid', paidAt: at(today), amount: 5000 });
await M.FuelExpense.collection.insertMany([{ status: 'approved', date: at(monthFirst), totalAmount: 800 }, { status: 'pending', date: at(today), totalAmount: 50 }]);
await M.Purchase.collection.insertOne({ date: at(monthFirst), total: 1000, gstAmount: 180 });
await M.Subscription.collection.insertOne({ status: 'active', cost: 1200, billingCycle: 'monthly' });
await M.SalesReturn.collection.insertOne({ status: 'approved', date: at(today), amount: 300 });
await M.HraRecord.collection.insertOne({ status: 'paid', date: at(monthFirst), amount: 400 });
await M.CashTransaction.collection.insertMany([
  { type: 'in', date: at(today), amount: 2000, account: inc.insertedId },
  { type: 'out', date: at(monthFirst), amount: 500, account: exp.insertedId },
]);

const fresh = await call(getDashboardSummary, {});
const sum = (arr, k) => Math.round(arr.reduce((s, d) => s + d[k], 0) * 100) / 100;
const daysInMonth = new Date(Date.UTC(ty, tm, 0)).getUTCDate();

if (original) {
  // The original controller compared a trial's date (a text day) as a Date range, so it never counted trial fees.
  // That is the ONE intended difference: income is higher by exactly the trial fees, everything else is identical.
  const sameButTrials = async (q) => {
    const a = (await call(getDashboardSummary, q)).body;
    const b = (await call(original.getDashboardSummary, q)).body;
    const trial = a.income.items.find((i) => i.key === 'trial_fees');
    assert.equal(b.income.items.find((i) => i.key === 'trial_fees').amount, 0, 'the old code counted no trial fees');
    for (const k of ['expense', 'pending', 'cashBank', 'receivables', 'payables']) assert.deepEqual(a[k], b[k], `"${k}" changed`);
    assert.deepEqual(
      a.income.items.filter((i) => i.key !== 'trial_fees'),
      b.income.items.filter((i) => i.key !== 'trial_fees'),
      'the other income lines changed',
    );
    assert.equal(a.income.total, Math.round((b.income.total + trial.amount) * 100) / 100);
    assert.equal(a.net, Math.round((b.net + trial.amount) * 100) / 100);
    return trial;
  };
  await check('only the trial fees differ from the version before (they used to be lost)', async () => {
    const t = await sameButTrials({});
    assert.equal(t.amount, 1500);
    assert.equal(t.count, 1, 'a cancelled trial is not counted');
  });
  await check('...also for a whole past month and a custom range', async () => {
    assert.equal((await sameButTrials({ from: prevFirst, to: monthFirst })).amount, 1500 + 1500);
    assert.equal((await sameButTrials({ from: prevFirst, to: prevDay2 })).amount, 1500);
  });
} else {
  console.log('  (no controllers/_accountingOriginal.js: the before/after comparison is skipped)');
}

await check('the figures themselves are right', async () => {
  const b = fresh.body;
  const line = (g, key) => b[g].items.find((i) => i.key === key);
  assert.equal(line('income', 'collections').amount, 40000, 'two verified collections tied to a booking');
  assert.equal(line('income', 'advances').amount, 9000);
  assert.equal(line('income', 'advances').count, 3);
  assert.equal(line('income', 'trial_fees').amount, 1500);
  assert.equal(line('income', 'other_income').amount, 2000);
  assert.equal(b.income.total, 52500);
  assert.equal(line('expense', 'salaries').amount, 20000);
  assert.equal(line('expense', 'artist_payouts').amount, 5000);
  assert.equal(line('expense', 'vendor_bills').amount, 1180);
});

await check('the series has a point for every day of the month, in order', async () => {
  const s = fresh.body.series;
  assert.equal(s.length, daysInMonth);
  assert.equal(s[0].date, monthFirst);
  assert.equal(s[s.length - 1].date, monthLast);
  assert.deepEqual(s.map((d) => d.date), [...s.map((d) => d.date)].sort());
  assert.equal(new Set(s.map((d) => d.date)).size, daysInMonth);
});

await check('the days add back up to the income and expense totals, and the entry counts to the entries', async () => {
  const b = fresh.body;
  assert.equal(sum(b.series, 'income'), b.income.total);
  // (the subscription estimate is shared over the days in paise, so a few paise can differ)
  assert.ok(Math.abs(sum(b.series, 'expense') - b.expense.total) < 0.5, `expense ${sum(b.series, 'expense')} vs ${b.expense.total}`);
  // entries: collections 2 + advances 3 + trial 1 + cash in 1 = 7
  assert.equal(b.series.reduce((s, d) => s + d.incomeCount, 0), 7);
});

await check('money lands on the day it happened (IST)', async () => {
  const s = Object.fromEntries(fresh.body.series.map((d) => [d.date, d]));
  if (monthFirst !== today) {
    // 1st: collection 35000 + 2 advances 6000 + trial 1500
    assert.equal(s[monthFirst].income, 42500);
    assert.equal(s[monthFirst].incomeCount, 4);
  }
  const todayIncome = 5000 + 3000 + 2000 + (monthFirst === today ? 42500 : 0);
  assert.equal(s[today].income, todayIncome);
  // days after today have nothing
  for (const d of fresh.body.series) if (d.date > today) assert.equal(d.income, 0);
});

await check('this month so far is compared with the SAME days of last month', async () => {
  const p = fresh.body.previous;
  assert.equal(p.mode, 'month');
  assert.equal(p.from, prevFirst);
  assert.equal(p.days, td);
  // last month's days 1..today: collection 10000 + advance 3000 + trial fees 1500 (day 1), collection 7000 (day 2, once today is the 2nd or later)
  const expectIncome = 10000 + 3000 + 1500 + (td >= 2 ? 7000 : 0);
  assert.equal(p.income, expectIncome);
  assert.equal(p.expense >= 2000, true, 'the admin expense on day 1');
  assert.equal(p.net, Math.round((p.income - p.expense) * 100) / 100);
});

await check('the percentages are worked out from this month UP TO TODAY, not from future-dated money', async () => {
  const p = fresh.body.previous;
  const fallbackSalaryDay = 15;
  // the salary with no payment date counts on the 15th: in the month's total, but not "so far" before the 15th
  const wholeMonthExpense = fresh.body.expense.total;
  if (td < fallbackSalaryDay) assert.ok(p.currentExpense < wholeMonthExpense, 'the 15th-dated salary is not yet "so far"');
  assert.equal(p.currentIncome, fresh.body.income.total, 'all the income so far is on or before today');
  assert.equal(p.currentNet, Math.round((p.currentIncome - p.currentExpense) * 100) / 100);
});

await check('a whole past month is compared with the month before it, and "so far" is the whole month', async () => {
  const r = await call(getDashboardSummary, { from: prevFirst, to: `${prevY}-${pad(prevM)}-${pad(new Date(Date.UTC(prevY, prevM, 0)).getUTCDate())}` });
  assert.equal(r.code, 200);
  assert.equal(r.body.previous.mode, 'month');
  assert.equal(r.body.previous.currentIncome, r.body.income.total);
  assert.equal(r.body.income.total, 21500, 'collections 17000 + advance 3000 + a trial fee of 1500 in the past month');
});

await check('a custom range is compared with the equal stretch just before it', async () => {
  const r = await call(getDashboardSummary, { from: monthFirst, to: monthFirst });
  assert.equal(r.code, 200);
  // one day, the 1st: part of the month → the "month" rule gives the 1st of last month
  assert.equal(r.body.previous.from, prevFirst);
  assert.equal(r.body.previous.to, prevFirst);
});

await check('a period that has not started has no comparison', async () => {
  const ny = tm === 12 ? ty + 1 : ty;
  const nm = tm === 12 ? 1 : tm + 1;
  const r = await call(getDashboardSummary, { from: `${ny}-${pad(nm)}-01`, to: `${ny}-${pad(nm)}-28` });
  assert.equal(r.code, 200);
  assert.equal(r.body.previous, null);
  assert.equal(r.body.series.length, 28);
});

await check('refused: a range that ends before it starts, and someone with no finance access', async () => {
  assert.equal((await call(getDashboardSummary, { from: monthLast, to: monthFirst })).code, 400);
  assert.equal((await call(getDashboardSummary, {}, { role: 'artist', permissions: [] })).code, 403);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
process.exit(failures.length === 0 ? 0 : 1);
