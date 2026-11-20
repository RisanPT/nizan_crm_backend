// End-to-end check of EXTENDING A TASK'S DUE DATE — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else and drops its own database first):
//
//   mkdir -p /tmp/ext-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/ext-e2e --fork --logpath /tmp/ext-e2e/log
//   node tests/e2e/task-extension.e2e.mjs
//
// The method: overdue tasks → the project manager extends one (a later day and a reason) → it is written into the task's history, its log and the
// project's activity, and the assignee is told → again and again, the history keeps every one in order → every wrong request is refused and
// leaves the task alone → only those who plan the task may → two people at once cannot both win → editing the date of an overdue task later
// is recorded as an extension too → a client can never write the history itself.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/task_extension_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'task_extension_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Department = await imp('models/Department.js');
const Project = await imp('models/Project.js');
const ITTask = await imp('models/ITTask.js');
const Notification = await imp('models/Notification.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/projects', await imp('routes/projectRoutes.js'));
app.use('/api/it-tasks', await imp('routes/itTaskRoutes.js'));
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

// ── days (IST), relative to today so the test is true on any day ────────────
const IST_MS = 330 * 60 * 1000;
const istToday = new Date(Date.now() + IST_MS).toISOString().slice(0, 10);
const dayOffset = (n) => new Date(Date.parse(`${istToday}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const at = (n) => new Date(`${dayOffset(n)}T00:00:00.000Z`);

// ── people ──────────────────────────────────────────────────────────────────
let n = 0;
const person = async (key, role, { dept = '', head = false } = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: dept });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, isDepartmentHead: head });
  return { id: String(user._id), emp: String(emp._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await person('boss', 'admin');
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // the project manager
const mhead = await person('mhead', 'crm', { dept: 'Marketing', head: true }); // head of the owning department
const member = await person('member', 'crm', { dept: 'Marketing' }); // has the tasks, does not plan them
const outsider = await person('outsider', 'crm', { dept: 'Marketing' }); // not on the project
const ceo = await person('ceo', 'ceo');
await Department.create({ key: 'marketing', name: 'Marketing', head: mhead.emp });
await User.updateOne({ _id: mhead.id }, { departmentId: (await Department.findOne({ key: 'marketing' }))._id });

const project = async (extra = {}) => {
  const r = await api('POST', '/projects', boss.token, { name: 'Website redesign', targetDepartment: 'Marketing', managerId: mira.emp, members: [member.emp], budget: 100000, editMode: 'managed', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const P = await project();
const pid = P._id;
const mkTask = (extra = {}) => ITTask.create({ projectId: pid, title: 'Print banners', status: 'in-progress', percentComplete: 20, assignedTo: member.emp, deadline: at(-5), startDate: at(-20), ...extra });
const extend = (token, id, body) => api('POST', `/it-tasks/${id}/extend`, token, body);
const put = (token, id, body) => api('PUT', `/it-tasks/${id}`, token, body);
const stored = (id) => ITTask.findById(id).lean();
const notes = (userId) => Notification.find({ recipient: userId, type: 'task_deadline_extended' }).lean();
const day = (d) => new Date(d).toISOString().slice(0, 10);

console.log('Extending an overdue task');
let t1;
await check('the project manager extends an overdue task: a later day and a reason', async () => {
  t1 = await mkTask();
  const r = await extend(mira.token, t1._id, { newDeadline: dayOffset(3), reason: '  Client sent   the files late ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(day(r.body.deadline), dayOffset(3));
  const e = r.body.extensions;
  assert.equal(e.length, 1);
  assert.equal(e[0].byName, 'mira');
  assert.equal(day(e[0].from), dayOffset(-5));
  assert.equal(day(e[0].to), dayOffset(3));
  assert.equal(e[0].days, 8);
  assert.equal(e[0].overdueDays, 5, 'it was five days overdue');
  assert.equal(e[0].reason, 'Client sent the files late');
  assert.equal(e[0].viaEdit, false);
  assert.equal(String(e[0].by), mira.id);
  assert.ok(Date.now() - new Date(e[0].at).getTime() < 60000);
  const row = await stored(t1._id);
  assert.equal(day(row.deadline), dayOffset(3));
  assert.equal(day(row.startDate), dayOffset(-20), 'nothing else about the task moved');
  assert.equal(row.status, 'in-progress');
});
await check('the task\'s log gets a line that says how long, from when to when, how late it was, and why', async () => {
  const row = await stored(t1._id);
  const line = row.activityLogs.at(-1);
  assert.equal(line.type, 'extension');
  assert.equal(line.author, 'mira');
  assert.match(line.message, /^Due date extended by 8 days: \d+ \w+ \d{4} → \d+ \w+ \d{4} \(it was 5 days overdue\)\. Reason: Client sent the files late$/);
});
await check('the project\'s activity says it too', async () => {
  const r = await api('GET', `/projects/${pid}`, mira.token);
  const line = r.body.activity.find((a) => a.kind === 'deadline');
  assert.ok(line, JSON.stringify(r.body.activity));
  assert.match(line.text, /Print banners.* extended by 8 days to .*\(it was 5 days overdue\)/);
  assert.equal(line.by, 'mira');
});
await check('the person it is given to is told, with who, from when to when and why — and not the person who did it', async () => {
  const told = await notes(member.id);
  assert.equal(told.length, 1);
  assert.match(told[0].title, /Due date extended: Print banners/);
  assert.match(told[0].body, /mira moved it from .* to .* — Client sent the files late/);
  assert.equal(told[0].link, `/projects/${pid}`);
  assert.equal((await notes(mira.id)).length, 0);
});
await check('a second and third extension are kept in order, each starting where the last ended', async () => {
  const a = await extend(mhead.token, t1._id, { newDeadline: dayOffset(10), reason: 'Printer is booked' });
  assert.equal(a.status, 200, JSON.stringify(a.body));
  const b = await extend(boss.token, t1._id, { newDeadline: dayOffset(12), reason: 'Waiting for sign-off' });
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const e = b.body.extensions;
  assert.deepEqual(e.map((x) => x.byName), ['mira', 'mhead', 'boss']);
  assert.deepEqual(e.map((x) => x.days), [8, 7, 2]);
  assert.deepEqual(e.map((x) => x.overdueDays), [5, 0, 0], 'only the first was late when it was extended');
  assert.equal(day(e[1].from), day(e[0].to));
  assert.equal(day(e[2].from), day(e[1].to));
  assert.equal(day(b.body.deadline), dayOffset(12));
  assert.equal((await stored(t1._id)).activityLogs.filter((l) => l.type === 'extension').length, 3);
});
await check('everybody on the project reads the whole history, with the count', async () => {
  const r = await api('GET', `/it-tasks?projectId=${pid}`, member.token);
  const t = r.body.find((x) => x._id === String(t1._id));
  assert.equal(t.extensions.length, 3);
  assert.deepEqual(t.extensions.map((x) => x.reason), ['Client sent the files late', 'Printer is booked', 'Waiting for sign-off']);
});
await check('a task that is not overdue yet can be extended too, with no overdue days', async () => {
  const t = await mkTask({ title: 'Not late', deadline: at(4) });
  const r = await extend(mira.token, t._id, { newDeadline: dayOffset(9), reason: 'Scope grew' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.extensions[0].days, r.body.extensions[0].overdueDays], [5, 0]);
  assert.doesNotMatch((await stored(t._id)).activityLogs.at(-1).message, /overdue/);
});

console.log('What is refused');
await check('every wrong request is refused in plain words and leaves the task exactly as it was', async () => {
  const t = await mkTask({ title: 'Untouched' });
  const before = JSON.stringify(await stored(t._id));
  const toldBefore = (await notes(member.id)).length;
  const cases = [
    [{ newDeadline: dayOffset(3), reason: '' }, 400, 'REASON_REQUIRED'],
    [{ newDeadline: dayOffset(3), reason: ' ab ' }, 400, 'REASON_REQUIRED'],
    [{ newDeadline: dayOffset(3) }, 400, 'REASON_REQUIRED'],
    [{ reason: 'Because' }, 400, 'DATE_REQUIRED'],
    [{ newDeadline: 'soon', reason: 'Because' }, 400, 'DATE_REQUIRED'],
    [{ newDeadline: dayOffset(-5), reason: 'Because' }, 400, 'NOT_LATER'],
    [{ newDeadline: dayOffset(-9), reason: 'Because' }, 400, 'NOT_LATER'],
    [{ newDeadline: dayOffset(4000), reason: 'Because' }, 400, 'TOO_FAR'],
    [{}, 400, 'DATE_REQUIRED'],
  ];
  for (const [body, status, code] of cases) {
    const r = await extend(mira.token, t._id, body);
    assert.equal(r.status, status, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, code, JSON.stringify(body));
    assert.ok(r.body.message.length > 10);
  }
  assert.equal(JSON.stringify(await stored(t._id)), before);
  assert.equal((await notes(member.id)).length, toldBefore, 'and nobody was told about any of them');
});
await check('a task with no due date has nothing to extend; a finished one cannot be', async () => {
  const none = await mkTask({ title: 'No date', deadline: undefined });
  const a = await extend(mira.token, none._id, { newDeadline: dayOffset(3), reason: 'Because' });
  assert.deepEqual([a.status, a.body.code], [400, 'NO_DEADLINE']);
  const done = await mkTask({ title: 'Done', status: 'closed', percentComplete: 100 });
  const b = await extend(mira.token, done._id, { newDeadline: dayOffset(3), reason: 'Because' });
  assert.deepEqual([b.status, b.body.code], [409, 'TASK_DONE']);
  const full = await mkTask({ title: 'Full', status: 'in-progress', percentComplete: 100 });
  assert.equal((await extend(mira.token, full._id, { newDeadline: dayOffset(3), reason: 'Because' })).body.code, 'TASK_DONE');
  assert.equal((await stored(done._id)).extensions.length, 0);
});
await check('a task that is not there is a 404; no sign-in gets nothing', async () => {
  assert.equal((await extend(mira.token, new mongoose.Types.ObjectId().toString(), { newDeadline: dayOffset(3), reason: 'x y z' })).status, 404);
  assert.equal((await extend(null, t1._id, { newDeadline: dayOffset(30), reason: 'Because' })).status, 401);
});

console.log('Who may');
await check('only those who plan the task: not the person it is given to, not someone outside, not the CEO', async () => {
  const t = await mkTask({ title: 'Guarded' });
  const body = { newDeadline: dayOffset(3), reason: 'Because' };
  const mine = await extend(member.token, t._id, body);
  assert.deepEqual([mine.status, mine.body.code], [403, 'TASK_FORBIDDEN']);
  assert.equal((await extend(outsider.token, t._id, body)).status, 403);
  assert.equal((await extend(ceo.token, t._id, body)).status, 403);
  const row = await stored(t._id);
  assert.equal(row.extensions.length, 0);
  assert.equal(day(row.deadline), dayOffset(-5));
});
await check('the admin and the owning department\'s head may, and are named in the history', async () => {
  const t = await mkTask({ title: 'By others' });
  assert.equal((await extend(boss.token, t._id, { newDeadline: dayOffset(1), reason: 'Admin call' })).status, 200);
  assert.equal((await extend(mhead.token, t._id, { newDeadline: dayOffset(2), reason: 'Head call' })).status, 200);
  assert.deepEqual((await stored(t._id)).extensions.map((e) => e.byName), ['boss', 'mhead']);
});

console.log('Two at once');
await check('two people extending the same task at the same moment: one is written down, the other is told to look again', async () => {
  const t = await mkTask({ title: 'Race' });
  const [a, b] = await Promise.all([
    extend(mira.token, t._id, { newDeadline: dayOffset(5), reason: 'My reason' }),
    extend(mhead.token, t._id, { newDeadline: dayOffset(6), reason: 'Other reason' }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], JSON.stringify([a.body, b.body]));
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.code, 'DEADLINE_CHANGED');
  const row = await stored(t._id);
  assert.equal(row.extensions.length, 1, 'exactly one extension was recorded');
  assert.equal(row.activityLogs.filter((l) => l.type === 'extension').length, 1);
});

console.log('The same thing through an ordinary edit');
await check('moving the due date of an OVERDUE task later is written down as an extension too, with the reason when one is given', async () => {
  const t = await mkTask({ title: 'Edit door' });
  const r = await put(mira.token, t._id, { deadline: `${dayOffset(7)}T00:00:00.000Z`, extensionReason: 'Moved with the printer' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = (await stored(t._id)).extensions;
  assert.equal(e.length, 1);
  assert.deepEqual([e[0].viaEdit, e[0].days, e[0].overdueDays, e[0].reason, e[0].byName], [true, 12, 5, 'Moved with the printer', 'mira']);
  assert.equal((await stored(t._id)).extensionReason, undefined, 'the reason is not a field of the task');
  assert.equal((await stored(t._id)).activityLogs.at(-1).type, 'extension');
});
await check('without a reason it is still recorded, and says so', async () => {
  const t = await mkTask({ title: 'Edit door 2' });
  await put(mira.token, t._id, { deadline: `${dayOffset(2)}T00:00:00.000Z` });
  const row = await stored(t._id);
  assert.equal(row.extensions[0].reason, '');
  assert.match(row.activityLogs.at(-1).message, /No reason was given\.$/);
});
await check('a client that sends the whole log back with the new date gets the line added, not an error', async () => {
  const t = await mkTask({ title: 'Whole echo', activityLogs: [{ message: 'Started', author: 'x', type: 'note' }] });
  const echo = (await stored(t._id)).activityLogs.map((l) => ({ message: l.message, author: l.author, type: l.type, timestamp: l.timestamp }));
  const r = await put(mira.token, t._id, { deadline: `${dayOffset(3)}T00:00:00.000Z`, activityLogs: echo });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await stored(t._id);
  assert.deepEqual(row.activityLogs.map((l) => l.type), ['note', 'extension']);
  assert.equal(row.extensions.length, 1);
});
await check('but not when it is not an extension: a task not yet late, an earlier day, the same day, no change of date', async () => {
  const early = await mkTask({ title: 'Not late', deadline: at(4) });
  await put(mira.token, early._id, { deadline: `${dayOffset(9)}T00:00:00.000Z` });
  assert.equal((await stored(early._id)).extensions.length, 0, 'moving a future date is planning, not extending');
  const late = await mkTask({ title: 'Late' });
  await put(mira.token, late._id, { deadline: `${dayOffset(-8)}T00:00:00.000Z` });
  assert.equal((await stored(late._id)).extensions.length, 0, 'earlier');
  await put(mira.token, late._id, { deadline: `${dayOffset(-8)}T00:00:00.000Z`, title: 'Late, renamed' });
  assert.equal((await stored(late._id)).extensions.length, 0, 'the same day');
  await put(mira.token, late._id, { title: 'Late, renamed again' });
  assert.equal((await stored(late._id)).extensions.length, 0, 'no date at all');
  const done = await mkTask({ title: 'Finished', status: 'closed', percentComplete: 100 });
  await put(mira.token, done._id, { deadline: `${dayOffset(9)}T00:00:00.000Z` });
  assert.equal((await stored(done._id)).extensions.length, 0, 'a finished task is not extended');
});

console.log('A client cannot write the history');
await check('sending extensions on a create, an edit or a bulk update changes nothing', async () => {
  const forged = [{ byName: 'someone', days: 99, from: at(-1), to: at(98), reason: 'forged' }];
  const c = await api('POST', '/it-tasks', mira.token, { projectId: pid, title: 'Forged create', extensions: forged });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.equal((await stored(c.body._id)).extensions.length, 0);
  const t = await mkTask({ title: 'Forged edit' });
  assert.equal((await put(mira.token, t._id, { title: 'Forged edit 2', extensions: forged })).status, 200);
  assert.equal((await stored(t._id)).extensions.length, 0);
  const bulk = await api('POST', '/it-tasks/bulk-update', mira.token, { taskIds: [t._id], updates: { extensions: forged, status: 'in-progress' } });
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal((await stored(t._id)).extensions.length, 0);
});
await check('the history a task already has survives every later edit and status change', async () => {
  const before = (await stored(t1._id)).extensions.length;
  await put(mira.token, t1._id, { title: 'Print banners (renamed)', status: 'in-progress', percentComplete: 60 });
  await api('POST', '/it-tasks/bulk-update', mira.token, { taskIds: [t1._id], updates: { status: 'code-review' } });
  assert.equal((await stored(t1._id)).extensions.length, before);
  assert.equal(before, 3);
});

console.log('A project where anyone on it may edit tasks (the older "open" mode)');
await check('an edit by a member that extends an overdue task is recorded under their name: the history stays honest', async () => {
  const Q = await project({ name: 'Open project', editMode: 'open' });
  const t = await ITTask.create({ projectId: Q._id, title: 'Open task', status: 'in-progress', assignedTo: member.emp, deadline: at(-3) });
  const r = await put(member.token, t._id, { deadline: `${dayOffset(4)}T00:00:00.000Z`, extensionReason: 'Need more time' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const e = (await stored(t._id)).extensions;
  assert.deepEqual([e.length, e[0].byName, e[0].viaEdit, e[0].overdueDays], [1, 'member', true, 3]);
});
await check('but the CEO, who only looks, cannot extend even where everybody else may edit', async () => {
  const Q = await Project.findOne({ name: 'Open project' }).lean();
  const t = await ITTask.create({ projectId: Q._id, title: 'For the CEO', status: 'in-progress', assignedTo: member.emp, deadline: at(-2) });
  const looks = await api('GET', `/it-tasks?projectId=${Q._id}`, ceo.token);
  assert.equal(looks.status, 200, 'the CEO can see this project, so the refusal below is about extending, not about seeing');
  const r = await extend(ceo.token, t._id, { newDeadline: dayOffset(5), reason: 'Because' });
  // the read-only guard stops the CEO before the controller is reached (the controller also refuses a view-only person, as a second line)
  assert.deepEqual([r.status, r.body.code], [403, 'CEO_READ_ONLY']);
  assert.equal((await stored(t._id)).extensions.length, 0);
  // while a member of the same open project may
  assert.equal((await extend(member.token, t._id, { newDeadline: dayOffset(5), reason: 'Because' })).status, 200);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
