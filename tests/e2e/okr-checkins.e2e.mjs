// End-to-end check of OKR key-result check-ins and the per-objective `access` flags, against
// a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything
// else, and drops its database first):
//
//   mkdir -p /tmp/okr-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/okr-e2e --fork --logpath /tmp/okr-e2e/log
//   node tests/e2e/okr-checkins.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/okr_checkins_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const imp = (p) => import(new URL(`../../${p}`, import.meta.url)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Department = await imp('models/Department.js');
const Project = await imp('models/Project.js');
const OKR = await imp('models/OKR.js');
const okrRoutes = await imp('routes/okrRoutes.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('../../middleware/errorMiddleware.js', import.meta.url));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/okrs', okrRoutes);
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
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 7).join('\n      ')}`);
  }
};

// ── people ──────────────────────────────────────────────────────────────────
const dept = {};
for (const n of ['Marketing', 'IT']) dept[n] = await Department.create({ key: n.toLowerCase(), name: n });
const emp = {};
for (const n of ['mktHead', 'itHead', 'pm', 'anu', 'owner']) emp[n] = await Employee.create({ name: n });

const U = {};
const mkUser = async (key, role, extra = {}) => {
  const user = await User.create({ name: `User ${key}`, email: `${key}@e2e.test`, password: 'secret123', role, ...extra });
  U[key] = { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await mkUser('admin', 'admin');
await mkUser('mktHead', 'marketing', { isDepartmentHead: true, departmentId: dept.Marketing._id, employeeId: emp.mktHead._id });
await mkUser('itHead', 'it', { isDepartmentHead: true, departmentId: dept.IT._id, employeeId: emp.itHead._id });
await mkUser('pm', 'crm', { employeeId: emp.pm._id });
await mkUser('anu', 'crm', { employeeId: emp.anu._id });
await mkUser('owner', 'crm', { employeeId: emp.owner._id });
const T = (k) => U[k].token;

// a project whose manager decides, and one saved before that setting existed (everyone on it edits)
const managed = await Project.create({
  name: 'Managed', managerId: emp.pm._id, members: [emp.anu._id], targetDepartment: 'Marketing',
  departments: [{ name: 'Marketing', role: 'owner', status: 'accepted' }], editMode: 'managed',
});
const legacy = (await Project.collection.insertOne({
  name: 'Legacy', managerId: emp.pm._id, members: [emp.anu._id], targetDepartment: 'Marketing', status: 'active', createdAt: new Date(), updatedAt: new Date(),
})).insertedId;

const kr = (title, current, target) => ({ title, currentValue: current, targetValue: target, unit: '%' });

// ── check-ins ───────────────────────────────────────────────────────────────
console.log('\n── check-ins are remembered ──');
let O;
await check('a check-in that changes the numbers is logged with who and when; repeating the same numbers logs nothing', async () => {
  const r = await api('POST', '/okrs', T('admin'), {
    objective: 'Grow bookings', level: 'company',
    keyResults: [{ ...kr('Revenue', 0, 100), checkIns: [{ value: 99, by: 'forged' }] }, kr('Conversion', 0, 25)],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  O = r.body;
  assert.deepEqual(O.keyResults[0].checkIns, [], 'whatever the client sends for the log is dropped');
  const k = O.keyResults[0].id;
  const a = await api('PATCH', `/okrs/${O._id}/key-results/${k}`, T('admin'), { currentValue: 30 });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const log = () => api('GET', `/okrs/${O._id}`, T('admin')).then((x) => x.body.keyResults[0].checkIns);
  let c = await log();
  assert.equal(c.length, 1);
  assert.equal(c[0].value, 30);
  assert.equal(c[0].by, 'User admin');
  assert.ok(Date.now() - new Date(c[0].at).getTime() < 60_000);
  await api('PATCH', `/okrs/${O._id}/key-results/${k}`, T('admin'), { currentValue: 30 });
  assert.equal((await log()).length, 1, 'the same numbers again is not a new report');
  await api('PATCH', `/okrs/${O._id}/key-results/${k}`, T('admin'), { completed: true });
  c = await log();
  assert.equal(c.length, 2);
  assert.equal(c[1].completed, true);
  await api('PATCH', `/okrs/${O._id}/key-results/${k}`, T('admin'), { currentValue: 40, completed: false });
  assert.deepEqual((await log()).map((x) => x.value), [30, 30, 40]);
});
await check('saving the WHOLE objective keeps every key result\'s history, ignores a forged one, and a new key result starts empty', async () => {
  const seen = (await api('GET', `/okrs/${O._id}`, T('admin'))).body;
  const keyResults = [{ ...seen.keyResults[0], checkIns: [{ value: 1, by: 'forged' }] }, seen.keyResults[1], kr('Brand new', 0, 10)];
  const r = await api('PUT', `/okrs/${O._id}`, T('admin'), { objective: 'Grow bookings v2', keyResults, expectedUpdatedAt: seen.updatedAt });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.keyResults[0].checkIns.map((c) => c.value), [30, 30, 40]);
  assert.equal(r.body.keyResults[0].checkIns[0].by, 'User admin');
  assert.deepEqual(r.body.keyResults[2].checkIns, []);
  // and a key result removed then re-added is a different key result
  const gone = await api('PUT', `/okrs/${O._id}`, T('admin'), { keyResults: [r.body.keyResults[0]] });
  assert.equal(gone.body.keyResults.length, 1);
  assert.equal(gone.body.keyResults[0].checkIns.length, 3);
});
await check('the log keeps the latest 100 reports', async () => {
  const k = O.keyResults[0].id;
  for (let i = 1; i <= 105; i += 1) await api('PATCH', `/okrs/${O._id}/key-results/${k}`, T('admin'), { currentValue: i });
  const log = (await api('GET', `/okrs/${O._id}`, T('admin'))).body.keyResults[0].checkIns;
  assert.equal(log.length, 100);
  assert.equal(log.at(-1).value, 105);
  assert.equal(log[0].value, 6, 'the oldest dropped off');
});

// ── access ──────────────────────────────────────────────────────────────────
console.log('\n── what each person may do, per objective ──');
let companyOkr;
let deptOkr;
let managedOkr;
let legacyOkr;
await check('fixtures: a company objective (headed by "owner"), a Marketing one, one on each kind of project', async () => {
  companyOkr = (await api('POST', '/okrs', T('admin'), { objective: 'Company goal', level: 'company', projectHeadId: String(emp.owner._id), keyResults: [kr('k', 0, 10)] })).body;
  deptOkr = (await api('POST', '/okrs', T('admin'), { objective: 'Marketing goal', level: 'department', department: 'Marketing', keyResults: [kr('k', 0, 10)] })).body;
  managedOkr = (await api('POST', '/okrs', T('pm'), { objective: 'On the managed project', projectId: String(managed._id), keyResults: [kr('k', 0, 10)] })).body;
  assert.ok(managedOkr._id, JSON.stringify(managedOkr));
  legacyOkr = (await OKR.create({ projectId: legacy, department: 'Marketing', objective: 'On the legacy project', keyResults: [kr('k', 0, 10)] })).toObject();
  legacyOkr._id = String(legacyOkr._id);
});
const accessOf = async (who, id) => (await api('GET', '/okrs', T(who))).body.find((o) => o._id === id)?.access;

await check('an administrator may do everything', async () => {
  for (const o of [companyOkr, deptOkr, managedOkr, legacyOkr]) assert.deepEqual(await accessOf('admin', String(o._id)), { canManage: true, canCheckIn: true });
});
await check('a company objective: only leadership manages it; the person it names may report on it; nobody else', async () => {
  assert.deepEqual(await accessOf('owner', companyOkr._id), { canManage: false, canCheckIn: true });
  assert.deepEqual(await accessOf('mktHead', companyOkr._id), { canManage: false, canCheckIn: false });
  assert.deepEqual(await accessOf('anu', companyOkr._id), { canManage: false, canCheckIn: false });
});
await check('a department objective: its head manages it; another department cannot even see it', async () => {
  assert.deepEqual(await accessOf('mktHead', deptOkr._id), { canManage: true, canCheckIn: true });
  assert.equal(await accessOf('itHead', deptOkr._id), undefined, 'not in the IT head\'s list');
  assert.equal((await api('GET', `/okrs/${deptOkr._id}`, T('itHead'))).status, 403);
});
await check('on a project whose manager decides: the manager manages; a member only reports', async () => {
  assert.deepEqual(await accessOf('pm', managedOkr._id), { canManage: true, canCheckIn: true });
  assert.deepEqual(await accessOf('anu', managedOkr._id), { canManage: false, canCheckIn: true });
  assert.deepEqual(await accessOf('mktHead', managedOkr._id), { canManage: true, canCheckIn: true }, 'the owning department\'s head manages it');
});
await check('on a project from before that setting: everyone on it manages (as it always was)', async () => {
  assert.deepEqual(await accessOf('anu', String(legacyOkr._id)), { canManage: true, canCheckIn: true });
});
await check('what the flags say is what the server then does', async () => {
  assert.equal((await api('PUT', `/okrs/${managedOkr._id}`, T('anu'), { objective: 'hijack' })).status, 403);
  assert.equal((await api('PATCH', `/okrs/${managedOkr._id}/key-results/${managedOkr.keyResults[0].id}`, T('anu'), { currentValue: 5 })).status, 200);
  assert.equal((await api('PATCH', `/okrs/${companyOkr._id}/key-results/${companyOkr.keyResults[0].id}`, T('anu'), { currentValue: 5 })).status, 403);
  assert.equal((await api('PATCH', `/okrs/${companyOkr._id}/key-results/${companyOkr.keyResults[0].id}`, T('owner'), { currentValue: 5 })).status, 200);
});
await check('every response that returns an objective carries the caller\'s access', async () => {
  assert.ok((await api('GET', `/okrs/${managedOkr._id}`, T('anu'))).body.access, 'GET by id');
  const put = await api('PUT', `/okrs/${managedOkr._id}`, T('pm'), { description: 'x' });
  assert.deepEqual(put.body.access, { canManage: true, canCheckIn: true });
  const patch = await api('PATCH', `/okrs/${managedOkr._id}/key-results/${managedOkr.keyResults[0].id}`, T('anu'), { currentValue: 6 });
  assert.deepEqual(patch.body.access, { canManage: false, canCheckIn: true });
  assert.deepEqual(managedOkr.access, { canManage: true, canCheckIn: true }, 'POST');
});

// ── done ────────────────────────────────────────────────────────────────────
console.log(failures.length ? `\n✖ ${pass} passed, ${failures.length} failed:\n  - ${failures.join('\n  - ')}` : `\n✔ ${pass} passed, 0 failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
