// End-to-end check of what a project's Overview screen needs from the server: the ACTIVITY feed on one
// project, and RESEND for a department invitation that has not been answered (who may, once per wait,
// not once answered, and who is told).
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/overview-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/overview-e2e --fork --logpath /tmp/overview-e2e/log
//   node tests/e2e/project-overview.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/project_overview_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Department = await imp('models/Department.js');
const Project = await imp('models/Project.js');
const Notification = await imp('models/Notification.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/projects', await imp('routes/projectRoutes.js'));
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
let n = 0;
const person = async (key, role, { dept = '', head = false } = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: dept });
  const user = await User.create({
    name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, isDepartmentHead: head,
  });
  return { id: String(user._id), emp: String(emp._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};

const boss = await person('boss', 'admin');
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // the project manager
const marketingHead = await person('mhead', 'crm', { dept: 'Marketing', head: true });
const accountsHead = await person('ahead', 'crm', { dept: 'Accounts', head: true });
const stranger = await person('stranger', 'crm', { dept: 'Sales' });

for (const [key, name, headPerson] of [
  ['marketing', 'Marketing', marketingHead],
  ['accounts', 'Accounts', accountsHead],
  ['finance', 'Finance', null],
  ['hr', 'HR', null],
]) {
  await Department.create({ key, name, head: headPerson ? headPerson.emp : null });
}

const get = (id, token) => api('GET', `/projects/${id}`, token);
// the "estimated cost sent to the finance head" lines belong to project-cost.e2e.mjs; this file is about the rest of the feed
const feedOf = (r) => r.body.activity.map((e) => e.text).filter((t) => !t.startsWith('Estimated cost') && !t.startsWith('Cost '));
const resend = (id, dept, token) => api('POST', `/projects/${id}/departments/${encodeURIComponent(dept)}/resend`, token);

const made = await api('POST', '/projects', boss.token, {
  budget: 50000,
  name: 'Lifestyle brand at 2030',
  targetDepartment: 'Marketing',
  managerId: mira.emp,
  departments: ['Accounts', 'Finance', 'HR'],
});
assert.equal(made.status, 201, JSON.stringify(made.body));
const pid = made.body._id;
// its cost is approved (that flow has its own test), so it can be started and its status changes are what is looked at here
await Project.updateOne({ _id: pid }, { costStatus: 'approved', approvedBudget: 50000 });

// ── the feed ────────────────────────────────────────────────────────────────
await check('a new project: created (by whom), then ONE line for the three invitations', async () => {
  const r = await get(pid, mira.token);
  assert.equal(r.status, 200);
  assert.deepEqual(feedOf(r), ['Project created', 'Invitations sent to 3 departments']);
  assert.equal(r.body.activity[0].by, 'boss');
  assert.ok(!Number.isNaN(Date.parse(r.body.activity[0].at)));
});

await check('the create response already carries the feed', async () => {
  assert.deepEqual(feedOf(made), ['Project created', 'Invitations sent to 3 departments']);
});

await check('the project LIST does not carry it (nor the stored raw events)', async () => {
  const r = await api('GET', '/projects', boss.token);
  assert.equal(r.status, 200);
  const p = r.body.find((x) => x._id === pid);
  assert.ok(p);
  assert.equal(p.activity, undefined);
});

await check('a status change is recorded once, by whom; saving other fields adds nothing', async () => {
  assert.equal((await api('PUT', `/projects/${pid}`, mira.token, { status: 'active' })).status, 200);
  assert.equal((await api('PUT', `/projects/${pid}`, mira.token, { status: 'active', priority: 'high' })).status, 200);
  assert.equal((await api('PUT', `/projects/${pid}`, mira.token, { description: 'x' })).status, 200);
  const r = await get(pid, mira.token);
  const moved = r.body.activity.filter((e) => e.text.startsWith('Project moved to'));
  assert.deepEqual(moved.map((e) => e.text), ['Project moved to Active']);
  assert.equal(moved[0].by, 'mira');
});

await check('"on-hold" reads "On hold"', async () => {
  assert.equal((await api('PUT', `/projects/${pid}`, mira.token, { status: 'on-hold' })).status, 200);
  assert.ok(feedOf(await get(pid, mira.token)).includes('Project moved to On hold'));
  assert.equal((await api('PUT', `/projects/${pid}`, mira.token, { status: 'planning' })).status, 200);
});

await check('a project saved before any of this (no activity, no departments) still shows its first line', async () => {
  const legacy = await Project.collection.insertOne({
    name: 'Old project', targetDepartment: 'Marketing', managerId: new mongoose.Types.ObjectId(mira.emp),
    status: 'active', createdAt: new Date('2025-01-02T10:00:00Z'), updatedAt: new Date('2025-01-02T10:00:00Z'),
  });
  const r = await get(String(legacy.insertedId), boss.token);
  assert.equal(r.status, 200);
  assert.deepEqual(feedOf(r), ['Project created']);
});

// ── resend ──────────────────────────────────────────────────────────────────
const remindersFor = (user) => Notification.find({ recipient: user.id, title: /^Reminder:/ }).lean();

await check('the manager reminds Accounts: its head is told, and the feed says so', async () => {
  const r = await resend(pid, 'Accounts', mira.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(feedOf(r).includes('Reminder sent to Accounts'));
  const line = r.body.activity.find((e) => e.text === 'Reminder sent to Accounts');
  assert.equal(line.by, 'mira');
  const told = await remindersFor(accountsHead);
  assert.equal(told.length, 1);
  assert.match(told[0].body, /Lifestyle brand at 2030/);
  assert.equal(told[0].link, `/projects/${pid}`);
});

await check('the same department again straight away: 429 with the wait, nobody is told twice', async () => {
  const r = await resend(pid, 'accounts', mira.token); // any spelling of the name
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'REMINDED_RECENTLY');
  assert.match(r.body.message, /Accounts was reminded a moment ago.*30 minutes/);
  assert.equal((await remindersFor(accountsHead)).length, 1);
});

await check('the wait is per department: Finance can be reminded now', async () => {
  assert.equal((await resend(pid, 'Finance', mira.token)).status, 200);
});

await check('…and Accounts again once the wait has passed', async () => {
  await Project.updateOne({ _id: pid, 'departments.name': 'Accounts' }, { $set: { 'departments.$.remindedAt': new Date(Date.now() - 31 * 60000) } });
  assert.equal((await resend(pid, 'Accounts', mira.token)).status, 200);
  assert.equal((await remindersFor(accountsHead)).length, 2);
});

await check('the head of the OWNING department may remind; so may an admin', async () => {
  assert.equal((await resend(pid, 'HR', marketingHead.token)).status, 200);
  await Project.updateOne({ _id: pid, 'departments.name': 'HR' }, { $set: { 'departments.$.remindedAt': null } });
  assert.equal((await resend(pid, 'HR', boss.token)).status, 200);
});

await check('the invited head itself and an outsider may not (403), whatever the department', async () => {
  assert.equal((await resend(pid, 'Accounts', accountsHead.token)).status, 403);
  assert.equal((await resend(pid, 'Finance', stranger.token)).status, 403);
  assert.equal((await resend(pid, 'Finance', null)).status, 401);
});

await check('no such project / not an invited department / the owner: 404', async () => {
  assert.equal((await resend(new mongoose.Types.ObjectId().toString(), 'Accounts', boss.token)).status, 404);
  assert.equal((await resend(pid, 'Legal', boss.token)).status, 404);
  assert.equal((await resend(pid, 'Marketing', boss.token)).status, 404);
});

await check('a department that has answered cannot be reminded (409), and its answer is in the feed', async () => {
  const accepted = await api('POST', `/projects/${pid}/departments/Accounts/respond`, accountsHead.token, { accept: true });
  assert.equal(accepted.status, 200);
  const line = accepted.body.activity.find((e) => e.text === 'Accounts joined the project');
  assert.ok(line, JSON.stringify(accepted.body.activity));
  assert.equal(line.by, 'ahead');
  const r = await resend(pid, 'Accounts', mira.token);
  assert.equal(r.status, 409);
  assert.match(r.body.message, /already joined/);

  const declined = await api('POST', `/projects/${pid}/departments/Finance/respond`, boss.token, { accept: false });
  assert.equal(declined.status, 200);
  assert.ok(feedOf(declined).includes('Finance declined the invitation'));
  assert.match((await resend(pid, 'Finance', mira.token)).body.message, /already declined/);
});

await check('the feed stays oldest first', async () => {
  const r = await get(pid, boss.token);
  const times = r.body.activity.map((e) => Date.parse(e.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(r.body.activity[0].text, 'Project created');
});

// ── a proposal's decision ───────────────────────────────────────────────────
await check('approving or rejecting a proposal is recorded in the feed', async () => {
  const mk = async (name) => {
    const p = await api('POST', '/projects', stranger.token, { name, targetDepartment: 'Marketing', budget: 10000 });
    assert.equal(p.status, 201, JSON.stringify(p.body));
    assert.equal(p.body.status, 'proposed');
    assert.equal(p.body.activity[0].text, 'Project proposed');
    return p.body._id;
  };
  const a = await mk('Proposal A');
  const approved = await api('POST', `/projects/${a}/approve`, marketingHead.token, {});
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(feedOf(approved), ['Project proposed', 'Project approved']);
  assert.equal(approved.body.activity[1].by, 'mhead');

  const b = await mk('Proposal B');
  const rejected = await api('POST', `/projects/${b}/reject`, marketingHead.token, { note: 'Not this year' });
  assert.equal(rejected.status, 200);
  assert.deepEqual(feedOf(rejected), ['Project proposed', 'Project not approved']);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
server.close();
process.exit(failures.length === 0 ? 0 : 1);
