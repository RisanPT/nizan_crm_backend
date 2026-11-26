// End-to-end check of WHO IS ON A PROJECT — its manager and its team — and changing them:
//   the server checks the people (the manager from the owning department; team members active and from the departments on the
//   project); the people concerned are told (made manager, added, taken off; HR when a placement ends); every change after creation is
//   a line of the project's activity; someone with work on the project (open tasks, an HR placement) is taken off only once the caller
//   confirms — their open tasks can be unassigned and the placement ends; the lead of another department on the project changes only
//   their own department's people (never the manager).
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/project-team.e2e.mjs
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound key is blanked (the code loads the real .env, which never overrides a set variable)
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'META_ACCESS_TOKEN', 'DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/project_team_e2e');
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
const ITTask = await imp('models/ITTask.js');
const ProjectAllocation = await imp('models/ProjectAllocation.js');
const Notification = await imp('models/Notification.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
assert.equal(process.env.ORS_API_KEY, '', 'SAFETY: nothing re-loaded the real .env over the blanked keys');

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/projects', await imp('routes/projectRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const api = async (method, path, who, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) },
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
    console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

// ── people ──────────────────────────────────────────────────────────────────
let n = 0;
const person = async (name, role, { dept = '', head = false, status = 'active' } = {}) => {
  n += 1;
  const emp = await Employee.create({ name, department: dept, status, phone: `90000000${String(n).padStart(2, '0')}` });
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, isDepartmentHead: head });
  return { id: String(user._id), emp: String(emp._id), name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await person('Boss', 'admin');
const mira = await person('Mira', 'crm', { dept: 'Marketing' }); // the project manager
const arun = await person('Arun', 'crm', { dept: 'Marketing' });
const chitra = await person('Chitra', 'crm', { dept: 'Marketing' });
const old = await person('Old Hand', 'crm', { dept: 'Marketing', status: 'inactive' });
const fhead = await person('Fiona', 'crm', { dept: 'Finance', head: true }); // heads Finance, which works on the project
const bindu = await person('Bindu', 'crm', { dept: 'Finance' });
const farah = await person('Farah', 'crm', { dept: 'Finance' });
const dev = await person('Dev', 'crm', { dept: 'Sales' }); // Sales is not on the project
const hrHead = await person('Hana', 'crm', { dept: 'HR', head: true });
await Department.create({ key: 'marketing', name: 'Marketing' });
await Department.create({ key: 'finance', name: 'Finance', head: fhead.emp });
await Department.create({ key: 'sales', name: 'Sales' });
await Department.create({ key: 'hr', name: 'HR', head: hrHead.emp });
for (const [p, key] of [[fhead, 'finance'], [hrHead, 'hr']]) await User.updateOne({ _id: p.id }, { departmentId: (await Department.findOne({ key }))._id });

const notes = (who, type = 'project_team') => Notification.find({ recipient: who.id, type }).sort({ createdAt: 1 }).lean();
const team = async (pid) => {
  const p = await Project.findById(pid).lean();
  return { manager: String(p.managerId), members: p.members.map(String).sort(), activity: p.activity.filter((a) => a.kind === 'team').map((a) => a.text) };
};
const create = (who, body) =>
  api('POST', '/projects', who, {
    name: 'Winter campaign',
    targetDepartment: 'Marketing',
    departments: ['Finance'],
    budget: 50000,
    startDate: '2026-12-01',
    endDate: '2026-12-20',
    ...body,
  });

let pid;

console.log('\n— a new project —');
await check('the server checks the people: manager from the owning department, team active and from the departments on it', async () => {
  const fromFinance = await create(boss, { managerId: bindu.emp });
  assert.deepEqual([fromFinance.status, fromFinance.body.code], [400, 'TEAM_MANAGER_OUTSIDE']);
  assert.match(fromFinance.body.message, /Bindu is not in Marketing/);
  const outsider = await create(boss, { managerId: mira.emp, members: [dev.emp] });
  assert.deepEqual([outsider.status, outsider.body.code], [400, 'TEAM_MEMBER_OUTSIDE']);
  assert.match(outsider.body.message, /Dev is not in the departments on this project \(Marketing and Finance\)/);
  const gone = await create(boss, { managerId: mira.emp, members: [old.emp] });
  assert.deepEqual([gone.status, gone.body.code], [400, 'TEAM_INACTIVE']);
  const nobody = await create(boss, { managerId: '64b000000000000000000000' });
  assert.deepEqual([nobody.status, nobody.body.code], [400, 'TEAM_UNKNOWN']);
  assert.equal(await Project.countDocuments(), 0, 'nothing was saved');
});

await check('created: the manager and the team hear they are on it; the members never list the manager twice', async () => {
  const r = await create(boss, { managerId: mira.emp, members: [arun.emp, mira.emp, bindu.emp] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  pid = r.body._id;
  const t = await team(pid);
  assert.equal(t.manager, mira.emp);
  assert.deepEqual(t.members, [arun.emp, bindu.emp].sort());
  assert.deepEqual(t.activity, [], 'a new project\'s people are on its team card, not in the activity');
  assert.match((await notes(mira))[0].title, /^You now manage Winter campaign$/);
  assert.equal((await notes(mira))[0].link, `/projects/${pid}`);
  assert.match((await notes(arun))[0].title, /^You're on the team of Winter campaign$/);
  assert.equal((await notes(bindu)).length, 1);
  assert.equal((await notes(boss)).length, 0, 'not the person who made the change');
});

console.log('\n— Edit team —');
await check('the manager adds people: they hear of it, and the activity says who joined', async () => {
  const r = await api('PUT', `/projects/${pid}/team`, mira, { members: [arun.emp, bindu.emp, chitra.emp] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await team(pid)).activity, ['Chitra joined the team']);
  assert.equal((await notes(chitra)).length, 1);
  assert.equal((await notes(arun)).length, 1, 'those already on it are not told again');
});

await check('nobody else outside the project\'s running may change it; a cancelled project\'s team stays', async () => {
  const member = await api('PUT', `/projects/${pid}/team`, arun, { members: [arun.emp] });
  assert.equal(member.status, 403, 'a member');
  assert.match(member.body.message, /^Only the project manager, the head of Marketing or the lead of a department on the project can change its team\.$/);
  assert.equal((await api('PUT', `/projects/${pid}/team`, dev, { members: [] })).status, 403, 'an outsider');
  const other = await create(boss, { name: 'Old idea', managerId: mira.emp });
  await Project.updateOne({ _id: other.body._id }, { status: 'cancelled' });
  assert.equal((await api('PUT', `/projects/${other.body._id}/team`, boss, { members: [arun.emp] })).status, 409);
});

await check('taking off someone with work on the project: asked first, nothing changes until confirmed', async () => {
  await ITTask.create({ projectId: pid, title: 'Shoot plan', assignedTo: chitra.emp, status: 'in-progress' });
  await ITTask.create({ projectId: pid, title: 'Moodboard', assignedTo: chitra.emp, status: 'completed' });
  await ProjectAllocation.create({ projectId: pid, employeeId: chitra.emp, employeeName: 'Chitra', percent: 50, from: new Date(Date.now() - 864e5), to: new Date(Date.now() + 30 * 864e5) });
  const r = await api('PUT', `/projects/${pid}/team`, mira, { members: [arun.emp, bindu.emp] });
  assert.deepEqual([r.status, r.body.code], [409, 'TEAM_REMOVAL_HAS_WORK']);
  assert.match(r.body.message, /^Chitra still has work on this project/);
  assert.deepEqual(r.body.people.map((p) => [p.name, p.openTasks, p.placement?.percent]), [['Chitra', 1, 50]], 'the finished task does not count');
  assert.ok((await team(pid)).members.includes(chitra.emp), 'still on the team');
});

await check('confirmed with "unassign": her open task loses its assignee, the placement ends, she and HR are told, the activity says so', async () => {
  const r = await api('PUT', `/projects/${pid}/team`, mira, { members: [arun.emp, bindu.emp], confirmRemoval: true, unassignTasks: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(!(await team(pid)).members.includes(chitra.emp));
  assert.equal((await ITTask.findOne({ title: 'Shoot plan' }).lean()).assignedTo, null);
  assert.equal(String((await ITTask.findOne({ title: 'Moodboard' }).lean()).assignedTo), chitra.emp, 'a finished task keeps who did it');
  const placement = await ProjectAllocation.findOne({ employeeId: chitra.emp }).lean();
  assert.equal(placement.status, 'ended');
  assert.ok(placement.to <= new Date(), 'ends today');
  assert.deepEqual((await team(pid)).activity.slice(-1), ['Chitra taken off the team (1 open task unassigned, 1 HR placement ended)']);
  const told = (await notes(chitra)).at(-1);
  assert.match(told.title, /^You were taken off Winter campaign$/);
  assert.match(told.body, /Your 1 open task on it no longer have you as assignee\./);
  const hr = await notes(hrHead, 'manpower_update');
  assert.equal(hr.length, 1);
  assert.match(hr[0].title, /^Chitra taken off Winter campaign$/);
});

await check('confirmed without "unassign": the open tasks stay theirs', async () => {
  await ITTask.create({ projectId: pid, title: 'Copy', assignedTo: arun.emp, status: 'todo' });
  const r = await api('PUT', `/projects/${pid}/team`, mira, { members: [bindu.emp], confirmRemoval: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(String((await ITTask.findOne({ title: 'Copy' }).lean()).assignedTo), arun.emp);
  assert.deepEqual((await team(pid)).activity.slice(-1), ['Arun taken off the team']);
});

console.log('\n— another department\'s lead —');
await check('the head of Finance (on the project) adds and takes off Finance\'s people', async () => {
  const add = await api('PUT', `/projects/${pid}/team`, fhead, { members: [bindu.emp, farah.emp] });
  assert.equal(add.status, 200, JSON.stringify(add.body));
  assert.deepEqual((await team(pid)).members, [bindu.emp, farah.emp].sort());
  assert.equal((await api('PUT', `/projects/${pid}/team`, fhead, { members: [farah.emp] })).status, 200, 'takes off Bindu');
});

await check('…but not anyone else\'s, and never the manager', async () => {
  const mkt = await api('PUT', `/projects/${pid}/team`, fhead, { members: [farah.emp, arun.emp] });
  assert.deepEqual([mkt.status, mkt.body.code], [403, 'TEAM_NOT_YOUR_DEPARTMENT']);
  assert.match(mkt.body.message, /You lead Finance: you can add or take off its people only\. Arun is not in Finance\./);
  const mgr = await api('PUT', `/projects/${pid}/team`, fhead, { managerId: bindu.emp });
  assert.deepEqual([mgr.status, mgr.body.code], [403, 'TEAM_MANAGER_LOCKED']);
});

console.log('\n— handing over —');
await check('the manager hands the project to a colleague: the new manager is told, the activity says so, and the old manager no longer runs it', async () => {
  const r = await api('PUT', `/projects/${pid}/team`, mira, { managerId: chitra.emp });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const t = await team(pid);
  assert.equal(t.manager, chitra.emp);
  assert.deepEqual(t.activity.slice(-2), ['Project manager: Mira → Chitra', 'Mira taken off the team']);
  assert.match((await notes(chitra)).at(-1).title, /^You now manage Winter campaign$/);
  assert.ok(!(await notes(mira)).some((x) => /taken off/.test(x.title)), 'Mira made the change herself: she is not told about it');
  assert.equal((await api('PUT', `/projects/${pid}/team`, mira, { members: [] })).status, 403);
});

console.log('\n— the project form —');
await check('saving the whole project goes through the same checks and the same question', async () => {
  await ITTask.create({ projectId: pid, title: 'Budget sheet', assignedTo: farah.emp, status: 'todo' });
  const outside = await api('PUT', `/projects/${pid}`, chitra, { members: [farah.emp, dev.emp] });
  assert.deepEqual([outside.status, outside.body.code], [400, 'TEAM_MEMBER_OUTSIDE']);
  const ask = await api('PUT', `/projects/${pid}`, chitra, { name: 'Winter campaign 2', members: [] });
  assert.deepEqual([ask.status, ask.body.code], [409, 'TEAM_REMOVAL_HAS_WORK']);
  assert.equal((await Project.findById(pid).lean()).name, 'Winter campaign', 'nothing saved until confirmed');
  const ok = await api('PUT', `/projects/${pid}`, chitra, { name: 'Winter campaign 2', members: [], confirmRemoval: true, unassignTasks: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await Project.findById(pid).lean()).name, 'Winter campaign 2');
  assert.equal((await ITTask.findOne({ title: 'Budget sheet' }).lean()).assignedTo, null);
  // a save that leaves the people as they were asks nothing and adds no activity
  const before = (await team(pid)).activity.length;
  assert.equal((await api('PUT', `/projects/${pid}`, chitra, { priority: 'high', managerId: chitra.emp, members: [] })).status, 200);
  assert.equal((await team(pid)).activity.length, before);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
