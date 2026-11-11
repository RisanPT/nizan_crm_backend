// End-to-end check of managing EXPENSE HEADS (the Administrative Expenses form's "Expense Head" list):
// add / rename / re-group / flag / archive / restore / delete, with the rules that keep the books safe.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/heads-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/heads-e2e --fork --logpath /tmp/heads-e2e/log
//   node tests/e2e/expense-heads.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/expense_heads_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const AdminExpense = await imp('models/AdminExpense.js');
const ChartOfAccount = await imp('models/ChartOfAccount.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/accounting', await imp('routes/accountingRoutes.js'));
app.use('/api/admin-expenses', await imp('routes/adminExpenseRoutes.js'));
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

const mk = async (key, role) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const accounts = await mk('accounts', 'accounts');
const admin = await mk('boss', 'admin');
const sales = await mk('sales', 'sales');

// the built-in chart (the real seed), so the seeded heads exist exactly as in production
assert.equal((await api('POST', '/accounting/accounts/seed', accounts.token)).status, 200);

const heads = (token = accounts.token, q = '') => api('GET', `/admin-expenses/heads${q}`, token).then((r) => r.body);
const byCode = (list, code) => list.find((h) => h.code === code);
const addHead = (body, token = accounts.token) => api('POST', '/admin-expenses/heads', token, body);
const editHead = (id, body, token = accounts.token) => api('PUT', `/admin-expenses/heads/${id}`, token, body);
const delHead = (id, token = accounts.token) => api('DELETE', `/admin-expenses/heads/${id}`, token);

let courier;
let lunch;

// ── reading ─────────────────────────────────────────────────────────────────
await check('the list keeps its shape and the seeded heads keep their flags', async () => {
  const list = await heads();
  assert.ok(list.length >= 20);
  const drp = byCode(list, 'DRP-01');
  assert.deepEqual([drp.label, drp.jobLinked, drp.recurring, drp.foreign, drp.system, drp.status], ['Drapist Expenses', true, false, false, true, 'active']);
  assert.equal(byCode(list, 'RNT-01').recurring, true);
  assert.equal(byCode(list, 'SUB-01').foreign, true);
  assert.ok(byCode(list, '5010'), 'the 5xxx ledgers are heads too, as before');
});

// ── adding ──────────────────────────────────────────────────────────────────
await check('Accounts adds a head: a code is made from the name, it is an expense ledger, it shows in the form list', async () => {
  const r = await addHead({ name: '  Courier   Charges ', group: 'Operating Expense', recurring: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.code, r.body.label, r.body.recurring, r.body.jobLinked, r.body.system, r.body.used], ['COU-01', 'Courier Charges', true, false, false, 0]);
  courier = r.body;
  const acc = await ChartOfAccount.findById(courier.id).lean();
  assert.deepEqual([acc.nature, acc.accountType, acc.isSystem, acc.status], ['expense', 'indirect_expense', false, 'active']);
  assert.ok(byCode(await heads(sales.token), 'COU-01'), 'everyone who files an expense sees it');
});

await check('the next head with a similar name gets the next number', async () => {
  const r = await addHead({ name: 'Courier Packaging' });
  assert.equal(r.status, 201);
  assert.equal(r.body.code, 'COU-02');
  assert.equal(r.body.group, 'Operating Expense', 'a default group');
});

await check('a job-linked head is a direct cost in a job group; the code can be chosen', async () => {
  const r = await addHead({ name: 'Hair Extensions', jobLinked: true, code: 'hex-01' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual([r.body.code, r.body.jobLinked, r.body.group], ['HEX-01', true, 'Direct / Job Expense']);
  assert.equal((await ChartOfAccount.findById(r.body.id).lean()).accountType, 'direct_expense');
});

await check('refused: no name, a name already used (active or archived), a bad or taken code', async () => {
  assert.equal((await addHead({ name: '   ' })).status, 400);
  const dup = await addHead({ name: 'courier charges' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.message, /already a head with that name \(COU-01\)/);
  assert.equal((await addHead({ name: 'Something New', code: 'a b' })).status, 400);
  assert.equal((await addHead({ name: 'Something New', code: 'x' })).status, 400, 'too short');
  const taken = await addHead({ name: 'Something New', code: 'FOO-01' });
  assert.equal(taken.status, 400);
  assert.match(taken.body.message, /already used by another account/);
  assert.equal((await addHead({ name: 'Another Cash', code: '1000' })).status, 400, 'a code of ANY ledger is taken');
});

await check('only Accounts / admin may manage heads', async () => {
  assert.equal((await addHead({ name: 'Sneaky' }, sales.token)).status, 403);
  assert.equal((await editHead(courier.id, { name: 'x' }, sales.token)).status, 403);
  assert.equal((await delHead(courier.id, sales.token)).status, 403);
  assert.equal((await addHead({ name: 'Admin Made' }, admin.token)).status, 201);
  assert.equal((await api('GET', '/admin-expenses/heads?all=1', sales.token)).body.some((h) => h.status === 'archived' || 'used' in h && h.used > 0), false, '?all=1 is for approvers: others get the normal list');
});

// ── editing ─────────────────────────────────────────────────────────────────
await check('rename, re-group and change the flags', async () => {
  const r = await editHead(courier.id, { name: 'Courier & Postage', group: 'Logistics', recurring: false, foreign: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.label, r.body.group, r.body.recurring, r.body.foreign, r.body.code], ['Courier & Postage', 'Logistics', false, true, 'COU-01']);
  assert.equal(byCode(await heads(), 'COU-01').label, 'Courier & Postage');
});

await check('a built-in head can be renamed and its flags changed — the flags it did not touch are kept', async () => {
  const rent = byCode(await heads(), 'RNT-01'); // recurring from the built-in list
  const r = await editHead(rent.id, { name: 'Office Rent', foreign: false });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.label, r.body.recurring, r.body.system], ['Office Rent', true, true], 'still recurring after the first edit');
  const off = await editHead(rent.id, { recurring: false });
  assert.equal(off.body.recurring, false, 'and it can be switched off');
  const drp = byCode(await heads(), 'DRP-01');
  assert.equal((await editHead(drp.id, { group: 'Direct / Job Expense' })).body.jobLinked, true);
});

await check('the name must stay unique', async () => {
  const r = await editHead(courier.id, { name: 'Food Expense' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /FOO-01/);
  assert.equal((await editHead(courier.id, { name: 'courier & postage' })).status, 200, 'its own name in other letters is fine');
});

await check('the code changes only while nothing uses it, and never on a built-in head', async () => {
  assert.equal((await editHead(courier.id, { code: 'cpg-01' })).body.code, 'CPG-01');
  const foo = byCode(await heads(), 'FOO-01');
  const sys = await editHead(foo.id, { code: 'FOOD-9' });
  assert.equal(sys.status, 400);
  assert.match(sys.body.message, /built-in/);
});

// ── using a head ────────────────────────────────────────────────────────────
await check('an expense can be filed under the new head, and the head now shows how many use it', async () => {
  const r = await api('POST', '/admin-expenses', accounts.token, { title: 'Courier May', department: 'Accounts', category: 'other', expenseHead: 'CPG-01', amount: 250, date: '2026-11-01', paymentMethod: 'cash' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  lunch = r.body._id;
  const list = await heads(accounts.token, '?all=1');
  assert.equal(byCode(list, 'CPG-01').used, 1);
  assert.equal(byCode(list, 'COU-02').used, 0);
});

await check('a head in use cannot change its code or be deleted — it is archived instead', async () => {
  assert.equal((await editHead(courier.id, { code: 'ZZZ-01' })).status, 400);
  const del = await delHead(courier.id);
  assert.equal(del.status, 400);
  assert.match(del.body.message, /1 expense uses this head — archive it instead/);
});

await check('archive hides it from the form but not from the manager; old expenses keep it and stay editable', async () => {
  const r = await editHead(courier.id, { status: 'archived' });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'archived');
  assert.equal(byCode(await heads(), 'CPG-01'), undefined, 'gone from the form list');
  assert.equal(byCode(await heads(accounts.token, '?all=1'), 'CPG-01').status, 'archived');
  // a NEW expense cannot use it…
  const n = await api('POST', '/admin-expenses', accounts.token, { title: 'x', department: 'Accounts', category: 'other', expenseHead: 'CPG-01', amount: 5, date: '2026-11-01', paymentMethod: 'cash' });
  assert.equal(n.status, 400);
  // …but the old one can still be edited while it keeps the head
  const e = await api('PUT', `/admin-expenses/${lunch}`, accounts.token, { expenseHead: 'CPG-01', notes: 'edited', amount: 260 });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.expenseHead, 'CPG-01');
});

await check('restore brings it back; a name taken by an ARCHIVED head says so', async () => {
  await editHead(courier.id, { status: 'archived' });
  const dup = await addHead({ name: 'Courier & Postage' });
  assert.equal(dup.status, 400);
  assert.match(dup.body.message, /archived head.*Restore it instead/);
  assert.equal((await editHead(courier.id, { status: 'active' })).body.status, 'active');
  assert.ok(byCode(await heads(), 'CPG-01'));
});

// ── deleting ────────────────────────────────────────────────────────────────
await check('an unused head can be deleted for good; the ledger goes with it', async () => {
  const r = await addHead({ name: 'Temporary Head' });
  const del = await delHead(r.body.id);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(await ChartOfAccount.findById(r.body.id), null);
  assert.equal(byCode(await heads(accounts.token, '?all=1'), r.body.code), undefined);
  assert.equal((await delHead(r.body.id)).status, 404, 'already gone');
});

await check('a built-in head is never deleted (archive only)', async () => {
  const foo = byCode(await heads(), 'FOO-01');
  const del = await delHead(foo.id);
  assert.equal(del.status, 400);
  assert.match(del.body.message, /built-in/);
  assert.equal((await editHead(foo.id, { status: 'archived' })).status, 200);
  assert.equal((await editHead(foo.id, { status: 'active' })).status, 200);
});

await check('only expense heads are managed here: an asset ledger id is "not found"', async () => {
  const cash = await ChartOfAccount.findOne({ code: '1000' }).lean();
  assert.equal((await editHead(String(cash._id), { name: 'x' })).status, 404);
  assert.equal((await delHead(String(cash._id))).status, 404);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
