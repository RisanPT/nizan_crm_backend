// End-to-end check of MANPOWER REQUESTS: a project asks for more people and HR sorts it out — with someone on staff (their
// department's head must let them go when the department is not already on the project), a new hire (a hiring plan is raised)
// or a contractor — or declines. A seat that costs money has to fit the project's approved budget.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else, and drops
// its database first):
//
//   mkdir -p /tmp/manpower-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/manpower-e2e --fork --logpath /tmp/manpower-e2e/log
//   node tests/e2e/project-manpower.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/project_manpower_e2e');
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
const HiringPlan = await imp('models/HiringPlan.js');
const LeaveRequest = await imp('models/LeaveRequest.js');
const ProjectAllocation = await imp('models/ProjectAllocation.js');
const AdminExpense = await imp('models/AdminExpense.js');
const ManpowerRequest = await imp('models/ManpowerRequest.js');
const Notification = await imp('models/Notification.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/projects', await imp('routes/projectRoutes.js'));
app.use('/api/manpower', await imp('routes/manpowerRoutes.js'));
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
const fin = await person('fin', 'finance_head', { dept: 'Finance', head: true });
const hrHead = await person('hrhead', 'crm', { dept: 'HR', head: true });
const hrStaff = await person('hrstaff', 'crm', { dept: 'HR' });
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // the project manager
const mhead = await person('mhead', 'crm', { dept: 'Marketing', head: true });
const member = await person('member', 'crm', { dept: 'Marketing' }); // on the project, not running it
const outsider = await person('outsider', 'crm', { dept: 'Sales' });
const ithead = await person('ithead', 'crm', { dept: 'IT', head: true });
const ceo = await person('ceo', 'ceo');
// people HR can choose from
const dev1 = await person('dev1', 'crm', { dept: 'IT' }); // IT is on the project: no release needed
const dev2 = await person('dev2', 'crm', { dept: 'IT' });
const sam = await person('sam', 'crm', { dept: 'Sales' }); // Sales is not: their head must let them go
const shead = await person('shead', 'crm', { dept: 'Sales', head: true });
const lena = await person('lena', 'crm', { dept: 'Sales' });
// IT staff nobody has touched: tests that need a person who is simply free use these
const pool = [];
for (let i = 0; i < 10; i += 1) pool.push(await person(`fresh${i}`, 'crm', { dept: 'IT' }));
const idOf = (v) => String(v?._id ?? v);
await Department.create({ key: 'marketing', name: 'Marketing', head: mhead.emp });
await Department.create({ key: 'it', name: 'IT', head: ithead.emp });
await Department.create({ key: 'sales', name: 'Sales', head: shead.emp });
await Department.create({ key: 'hr', name: 'HR', head: hrHead.emp });
await Department.create({ key: 'finance', name: 'Finance', head: fin.emp });
const dept = async (key) => (await Department.findOne({ key }))._id;
for (const [p, key] of [[mhead, 'marketing'], [hrHead, 'hr'], [hrStaff, 'hr'], [ithead, 'it'], [shead, 'sales'], [fin, 'finance']]) await User.updateOne({ _id: p.id }, { departmentId: await dept(key) });
for (const [p, key] of [[sam, 'sales'], [lena, 'sales'], [dev1, 'it'], [dev2, 'it'], [shead, 'sales']]) await Employee.updateOne({ _id: p.emp }, { departmentId: await dept(key) });

const notes = (userId, type) => Notification.find({ recipient: userId, type }).lean();
const ask = (pid, token, body = {}) =>
  api('POST', `/projects/${pid}/manpower`, token, { roleTitle: 'UI designer', headcount: 2, startDate: '2026-12-01', endDate: '2027-02-28', allocationPercent: 50, reason: 'Scope grew', ...body });
const handle = (id, token, lines, extra = {}) => api('POST', `/manpower/${id}/handle`, token, { lines, ...extra });
const list = (token, q = '') => api('GET', `/manpower${q}`, token);
const internal = (p, extra = {}) => ({ type: 'internal', employeeId: p.emp, ...extra });

// a project: ₹1,00,000 approved, Marketing owns it, IT works on it
const pid = await (async () => {
  const r = await api('POST', '/projects', boss.token, { name: 'Website redesign', targetDepartment: 'Marketing', managerId: mira.emp, budget: 100000, departments: ['IT'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await api('POST', `/projects/${r.body._id}/cost/decision`, fin.token, { decision: 'approve' })).status, 200);
  await Project.updateOne({ _id: r.body._id }, { $push: { members: member.emp }, status: 'active' });
  return r.body._id;
})();

// ── asking ──────────────────────────────────────────────────────────────────
let req1;
await check('the project manager asks for people: it is filed, and HR (not the asker, not an admin) is told', async () => {
  const r = await ask(pid, mira.token, { urgency: 'urgent' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  req1 = r.body;
  assert.equal(req1.status, 'submitted');
  assert.equal(req1.headcount, 2);
  assert.equal(req1.seatsLeft, 2);
  assert.equal(req1.projectName, 'Website redesign');
  assert.equal(req1.department, 'Marketing');
  for (const hr of [hrHead, hrStaff]) {
    const told = await notes(hr.id, 'manpower_request');
    assert.equal(told.length, 1, hr.name);
    assert.match(told[0].title, /^Urgent: 2 UI designer needed for Website redesign/);
    assert.equal(told[0].link, '/manpower');
  }
  assert.equal((await notes(mira.id, 'manpower_request')).length, 0);
  assert.equal((await notes(boss.id, 'manpower_request')).length, 0);
  assert.equal((await notes(outsider.id, 'manpower_request')).length, 0);
});

await check('the project\'s feed says people were asked for', async () => {
  const p = await api('GET', `/projects/${pid}`, mira.token);
  assert.ok(p.body.activity.some((e) => e.text === '2 UI designers asked of HR'));
});

await check('the owning head may ask; a member, an outsider and the CEO may not', async () => {
  assert.equal((await ask(pid, mhead.token, { headcount: 1 })).status, 201);
  for (const who of [member, outsider, ceo, hrStaff]) {
    const r = await ask(pid, who.token, { headcount: 1 });
    assert.equal(r.status, 403, who.name);
  }
});

await check('the lead of a department that works on the project may ask too', async () => {
  assert.equal((await ask(pid, ithead.token, { headcount: 1, roleTitle: 'QA' })).status, 201);
});

await check('what is missing or wrong is named', async () => {
  assert.equal((await ask(pid, mira.token, { roleTitle: '' })).body.code, 'ROLE_REQUIRED');
  assert.equal((await ask(pid, mira.token, { headcount: 0 })).body.code, 'HEADCOUNT_INVALID');
  assert.equal((await ask(pid, mira.token, { startDate: undefined })).body.code, 'DATES_REQUIRED');
  assert.equal((await ask(pid, mira.token, { startDate: '2026-12-10', endDate: '2026-12-01' })).body.code, 'DATES_INVALID');
  assert.equal((await ask(pid, mira.token, { allocationPercent: 0 })).body.code, 'ALLOCATION_INVALID');
  assert.equal((await ask(pid, mira.token, { reason: '' })).body.code, 'REASON_REQUIRED');
  assert.equal((await ask(pid, mira.token, { estimatedCost: 'lots' })).body.code, 'COST_INVALID');
});

await check('a project that is not there, or is cancelled or only a proposal, takes no requests', async () => {
  assert.equal((await ask(new mongoose.Types.ObjectId().toString(), mira.token)).status, 404);
  assert.equal((await ask('nope', mira.token)).status, 404);
  const idea = await api('POST', '/projects', member.token, { name: 'An idea', targetDepartment: 'Marketing', budget: 5000 });
  assert.equal((await ask(idea.body._id, member.token)).body.code, 'PROJECT_CLOSED');
});

await check('a cost estimate that does not fit the project budget is said at once', async () => {
  const r = await ask(pid, mira.token, { headcount: 1, estimatedCost: 150000 });
  assert.equal(r.status, 201);
  assert.equal(r.body.budget.short, true);
  assert.equal(r.body.budget.shortfall, 50000);
  const fine = await ask(pid, mira.token, { headcount: 1, estimatedCost: 20000 });
  assert.equal(fine.body.budget.short, false);
  await ManpowerRequest.deleteMany({ _id: { $in: [r.body.id, fine.body.id] } });
});

// ── who sees what ───────────────────────────────────────────────────────────
await check('HR sees every request, and may handle it', async () => {
  const r = await list(hrStaff.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 3);
  assert.ok(r.body.every((x) => x.access.canHandle === true));
});

await check('whoever asked sees theirs and can take it back, but cannot handle it; the project manager sees all of the project\'s', async () => {
  const mine = (await list(ithead.token)).body;
  assert.equal(mine.length, 1, 'the IT lead asked for one');
  assert.equal(mine[0].roleTitle, 'QA');
  assert.equal(mine[0].access.canHandle, false);
  assert.equal(mine[0].access.canCancel, true);
  const managed = (await list(mira.token)).body;
  assert.equal(managed.length, 3, 'she runs the project');
  assert.ok(managed.every((x) => x.access.canCancel === true && x.access.canHandle === false));
});

await check('the owning head sees their department\'s requests; a stranger sees none', async () => {
  assert.equal((await list(mhead.token)).body.length, 3, 'all of Marketing\'s project\'s requests');
  assert.equal((await list(outsider.token)).body.length, 0);
  assert.equal((await list(member.token)).body.length, 0);
  assert.equal((await api('GET', '/manpower')).status, 401);
});

await check('open requests come urgent first', async () => {
  const r = (await list(hrHead.token, '?scope=open')).body;
  assert.equal(r[0].urgency, 'urgent');
});

// ── HR covers seats ─────────────────────────────────────────────────────────
await check('only HR handles a request', async () => {
  for (const who of [mira, mhead, member, outsider, ithead]) assert.equal((await handle(req1.id, who.token, [internal(dev1)])).status, 403, who.name);
});

await check('a person from a department already on the project is placed at once: allocation, member, and the project says so', async () => {
  const r = await handle(req1.id, hrStaff.token, [internal(dev1)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'in_progress');
  assert.equal(r.body.seatsLeft, 1);
  assert.equal(r.body.hrOwnerName, 'hrstaff');
  assert.equal(r.body.lines[0].state, 'assigned');
  assert.equal(r.body.lines[0].percent, 50, 'the request\'s share of their time by default');
  const a = await ProjectAllocation.findOne({ projectId: pid, employeeId: dev1.emp });
  assert.ok(a);
  assert.equal(a.percent, 50);
  assert.equal(a.role, 'UI designer');
  assert.ok((await Project.findById(pid)).members.map(String).includes(dev1.emp));
  const feed = (await api('GET', `/projects/${pid}`, mira.token)).body.activity.map((e) => e.text);
  assert.ok(feed.includes('dev1 joined the project as UI designer (50% of their time)'));
});

await check('the asker is told what HR did', async () => {
  const told = await notes(mira.id, 'manpower_update');
  assert.ok(told.some((t) => /HR is on your request/.test(t.title) && t.body.includes('dev1')));
});

await check('a person from another department needs their head to let them go: the head is asked, nothing is placed yet', async () => {
  const r = await handle(req1.id, hrStaff.token, [internal(sam)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const line = r.body.lines.find((l) => l.employeeId === sam.emp);
  assert.equal(line.state, 'awaiting_release');
  assert.equal(r.body.status, 'in_progress');
  assert.equal(await ProjectAllocation.countDocuments({ employeeId: sam.emp }), 0);
  assert.ok(!(await Project.findById(pid)).members.map(String).includes(sam.emp));
  const told = await notes(shead.id, 'manpower_release');
  assert.equal(told.length, 1);
  assert.match(told[0].title, /HR asks to place sam on Website redesign/);
  assert.equal(r.body.seatsLeft, 0);
});

await check('the head sees the line waiting for them; HR and the asker see it is waiting', async () => {
  const mine = (await list(shead.token)).body;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].access.releasable.length, 1);
  assert.equal((await list(hrStaff.token)).body.find((x) => x.id === req1.id).access.releasable.length, 0);
});

await check('only that department\'s head can answer', async () => {
  const line = (await ManpowerRequest.findById(req1.id)).lines.find((l) => l.state === 'awaiting_release');
  for (const who of [mhead, ithead, hrStaff, mira, outsider]) {
    assert.equal((await api('POST', `/manpower/${req1.id}/lines/${line._id}/release`, who.token, { approve: true })).status, 403, who.name);
  }
  assert.equal((await api('POST', `/manpower/${req1.id}/lines/${line._id}/release`, shead.token, {})).status, 400, 'say yes or no');
});

await check('saying no needs a reason, and frees the seat', async () => {
  const line = (await ManpowerRequest.findById(req1.id)).lines.find((l) => l.state === 'awaiting_release');
  const noWhy = await api('POST', `/manpower/${req1.id}/lines/${line._id}/release`, shead.token, { approve: false });
  assert.equal(noWhy.status, 400);
  assert.equal(noWhy.body.code, 'NOTE_REQUIRED');
  const r = await api('POST', `/manpower/${req1.id}/lines/${line._id}/release`, shead.token, { approve: false, note: 'Needed for the festive season' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.lines.find((l) => l.id === String(line._id)).state, 'refused');
  assert.equal(r.body.seatsLeft, 1, 'the seat is open again');
  assert.equal(r.body.status, 'in_progress');
  assert.equal(await ProjectAllocation.countDocuments({ employeeId: sam.emp }), 0);
  const told = await notes(hrStaff.id, 'manpower_update');
  assert.ok(told.some((t) => /sam cannot be released/.test(t.title) && /festive season/.test(t.body)));
});

await check('HR tries another person; their head lets them go: placed, and the request is fulfilled', async () => {
  const r = await handle(req1.id, hrStaff.token, [internal(lena)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const line = r.body.lines.find((l) => l.employeeId === lena.emp);
  assert.equal(line.state, 'awaiting_release');
  const ok = await api('POST', `/manpower/${req1.id}/lines/${line.id}/release`, shead.token, { approve: true, note: 'Fine from January' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'fulfilled');
  assert.equal(ok.body.seatsLeft, 0);
  assert.ok(await ProjectAllocation.findOne({ projectId: pid, employeeId: lena.emp }));
  assert.ok((await Project.findById(pid)).members.map(String).includes(lena.emp));
  assert.ok((await notes(mira.id, 'manpower_update')).some((t) => /lena was released/.test(t.title)));
});

await check('a request that is fulfilled is closed to more handling; an answer is given once', async () => {
  assert.equal((await handle(req1.id, hrStaff.token, [internal(dev2)])).body.code, 'NOT_OPEN');
  const line = (await ManpowerRequest.findById(req1.id)).lines.find((l) => idOf(l.employeeId) === lena.emp);
  assert.equal((await api('POST', `/manpower/${req1.id}/lines/${line._id}/release`, shead.token, { approve: true })).body.code, 'NOT_WAITING');
});
await check('the project\'s team: who, how much, when — for those on the project; no money in it', async () => {
  const t = await api('GET', `/projects/${pid}/team`, member.token);
  assert.equal(t.status, 200);
  assert.deepEqual(t.body.map((a) => a.employeeName).sort(), ['dev1', 'lena']);
  assert.ok(t.body.every((a) => a.percent === 50 && a.role === 'UI designer'));
  assert.equal(JSON.stringify(t.body).includes('cost'), false);
  assert.equal((await api('GET', `/projects/${pid}/team`, hrStaff.token)).status, 200);
  assert.equal((await api('GET', `/projects/${pid}/team`, outsider.token)).status, 403);
});

await check('the team shows what is upcoming, active or over by its dates', async () => {
  const today = new Date();
  const d = (offset) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset));
  const proj = await mkProject('Dated team');
  for (const [name, from, to] of [['past', -20, -5], ['now', -5, 5], ['later', 5, 20]]) {
    await ProjectAllocation.create({ projectId: proj, employeeId: new mongoose.Types.ObjectId(), employeeName: name, role: 'x', percent: 50, from: d(from), to: d(to) });
  }
  await ProjectAllocation.create({ projectId: proj, employeeId: new mongoose.Types.ObjectId(), employeeName: 'stopped', role: 'x', percent: 50, from: d(-5), to: d(5), status: 'ended' });
  const t = (await api('GET', `/projects/${proj}/team`, boss.token)).body;
  assert.deepEqual(Object.fromEntries(t.map((a) => [a.employeeName, a.state])), { past: 'ended', now: 'active', later: 'upcoming', stopped: 'ended' });
});

async function mkProject(name, { limit = 100000, approve = true } = {}) {
  const r = await api('POST', '/projects', boss.token, { name, targetDepartment: 'Marketing', managerId: mira.emp, budget: limit, departments: ['IT'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (approve) {
    assert.equal((await api('POST', `/projects/${r.body._id}/cost/decision`, fin.token, { decision: 'approve' })).status, 200);
    await Project.updateOne({ _id: r.body._id }, { status: 'active' });
  }
  return r.body._id;
}

// ── conflicts: people's time and leave ──────────────────────────────────────
await check('someone already committed elsewhere is flagged — HR may assign anyway', async () => {
  const proj = await mkProject('Busy test');
  await ProjectAllocation.create({ projectId: proj, employeeId: dev2.emp, employeeName: 'dev2', role: 'x', percent: 70, from: new Date(Date.UTC(2026, 11, 1)), to: new Date(Date.UTC(2027, 1, 28)) });
  const r = (await ask(proj, mira.token, { headcount: 1 })).body;
  const refused = await handle(r.id, hrStaff.token, [internal(dev2)]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'MANPOWER_CONFLICT');
  assert.equal(refused.body.load, 70);
  assert.equal(refused.body.percent, 50);
  assert.match(refused.body.message, /70% of their time/);
  assert.equal((await ManpowerRequest.findById(r.id)).lines.length, 0, 'nothing was done');
  const ok = await handle(r.id, hrStaff.token, [internal(dev2)], { assignAnyway: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'fulfilled');
});

await check('someone on leave then is flagged too', async () => {
  const proj = await mkProject('Leave test');
  await LeaveRequest.create({ employeeId: dev1.emp, fromDate: new Date(Date.UTC(2026, 11, 10)), toDate: new Date(Date.UTC(2026, 11, 20)), status: 'approved' });
  const r = (await ask(proj, mira.token, { headcount: 1, startDate: '2026-12-15', endDate: '2026-12-31', allocationPercent: 10 })).body;
  const refused = await handle(r.id, hrStaff.token, [internal(dev1)]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'MANPOWER_CONFLICT');
  assert.equal(refused.body.onLeave, true);
  assert.match(refused.body.message, /on leave/);
});

await check('leave that is not approved, or outside the window, does not count', async () => {
  const proj = await mkProject('Leave test two');
  await LeaveRequest.create({ employeeId: dev2.emp, fromDate: new Date(Date.UTC(2027, 5, 1)), toDate: new Date(Date.UTC(2027, 5, 10)), status: 'approved' });
  await LeaveRequest.create({ employeeId: dev2.emp, fromDate: new Date(Date.UTC(2026, 11, 1)), toDate: new Date(Date.UTC(2026, 11, 31)), status: 'pending' });
  const r = (await ask(proj, mira.token, { headcount: 1, allocationPercent: 5 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [internal(dev2)])).status, 409, 'dev2 still has 70% from the earlier test, with +5% = 75%: not busy');
});

const decemberToFebruary = { from: new Date(Date.UTC(2026, 11, 1)), to: new Date(Date.UTC(2027, 1, 28)) };

await check('a new hire who is booked elsewhere is flagged too, unless HR says go ahead', async () => {
  const proj = await mkProject('Hire busy');
  const r = (await ask(proj, mira.token, { headcount: 1, allocationPercent: 60 })).body;
  const done = await handle(r.id, hrStaff.token, [{ type: 'hire', seats: 1 }]);
  assert.equal(done.status, 200);
  const line = done.body.lines[0].id;
  const joiner = pool[8];
  await ProjectAllocation.create({ projectId: proj, employeeId: joiner.emp, employeeName: 'fresh8', role: 'x', percent: 70, ...decemberToFebruary });
  const refused = await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, hrStaff.token, { employeeId: joiner.emp });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'MANPOWER_CONFLICT');
  assert.equal(refused.body.load, 70);
  assert.equal(await ProjectAllocation.countDocuments({ projectId: proj, employeeId: joiner.emp }), 1, 'nothing was placed');
  const ok = await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, hrStaff.token, { employeeId: joiner.emp, assignAnyway: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.status, 'fulfilled');
});

await check('an allocation that was ended early frees the person', async () => {
  const proj = await mkProject('Ended early');
  const p = pool[9];
  await ProjectAllocation.create({ projectId: proj, employeeId: p.emp, employeeName: 'fresh9', role: 'x', percent: 90, status: 'ended', ...decemberToFebruary });
  const r = (await ask(proj, mira.token, { headcount: 1, allocationPercent: 50 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [internal(p)])).status, 200, 'not busy: the 90% is over');
  const seen = (await api('GET', '/manpower/availability?from=2026-12-01&to=2027-02-28&percent=50&q=fresh9', hrStaff.token)).body;
  assert.equal(seen.length, 1);
  assert.equal(seen[0].load, 50, 'only the new 50% counts');
});

await check('a person cannot be put on the same request twice; more seats than asked for are refused', async () => {
  const proj = await mkProject('Seats test');
  const r = (await ask(proj, mira.token, { headcount: 2, allocationPercent: 5 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [internal(pool[0])])).status, 200);
  const dup = await handle(r.id, hrStaff.token, [internal(pool[0])]);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'ALREADY_ON_REQUEST');
  const twice = await handle(r.id, hrStaff.token, [internal(pool[1]), internal(pool[1])]);
  assert.equal(twice.body.code, 'ALREADY_ON_REQUEST', 'the same person twice in one go');
  const many = await handle(r.id, hrStaff.token, [internal(pool[1]), internal(pool[2])]);
  assert.equal(many.status, 409);
  assert.equal(many.body.code, 'NO_SEATS_LEFT');
  assert.equal(many.body.seatsLeft, 1);
});

await check('one mistake in a batch means nothing is done', async () => {
  const proj = await mkProject('Batch test');
  const r = (await ask(proj, mira.token, { headcount: 2, allocationPercent: 5 })).body;
  const bad = await handle(r.id, hrStaff.token, [internal(pool[3]), { type: 'internal', employeeId: new mongoose.Types.ObjectId().toString() }]);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'EMPLOYEE_INVALID');
  const after = await ManpowerRequest.findById(r.id);
  assert.equal(after.lines.length, 0);
  assert.equal(after.status, 'submitted');
  assert.equal(await ProjectAllocation.countDocuments({ projectId: proj }), 0);
});

await check('a bad line is refused with a reason', async () => {
  const proj = await mkProject('Bad lines');
  const r = (await ask(proj, mira.token, { headcount: 3, allocationPercent: 5 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [])).body.code, 'LINES_REQUIRED');
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'magic' }])).body.code, 'LINE_TYPE_INVALID');
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'internal', employeeId: 'x' }])).body.code, 'EMPLOYEE_INVALID');
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: '' }])).body.code, 'VENDOR_REQUIRED');
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'hire', seats: 0 }])).body.code, 'SEATS_INVALID');
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'hire', cost: 'x' }])).body.code, 'COST_INVALID');
  assert.equal((await handle(r.id, hrStaff.token, [internal(dev1, { percent: 3 })])).body.code, 'ALLOCATION_INVALID');
  await Employee.updateOne({ _id: sam.emp }, { status: 'inactive' });
  assert.equal((await handle(r.id, hrStaff.token, [internal(sam)])).body.code, 'EMPLOYEE_INVALID', 'someone who left is not on the staff list');
  await Employee.updateOne({ _id: sam.emp }, { status: 'active' });
});

// ── a new hire ──────────────────────────────────────────────────────────────
await check('a hire raises a hiring plan for the owning department, and waits until the person joins', async () => {
  const proj = await mkProject('Hire test');
  const r = (await ask(proj, mira.token, { headcount: 2, roleTitle: 'Video editor', skills: 'Premiere, After Effects', reason: 'A big launch film', estimatedCost: 60000 })).body;
  const done = await handle(r.id, hrStaff.token, [{ type: 'hire', seats: 2, cost: 60000 }]);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.status, 'in_progress', 'a hire is not done until they join');
  assert.equal(done.body.lines[0].state, 'hiring');
  const plan = await HiringPlan.findById(done.body.lines[0].hiringPlanId);
  assert.ok(plan);
  assert.equal(plan.designation, 'Video editor');
  assert.equal(plan.department, 'Marketing');
  assert.equal(plan.openings, 2);
  assert.equal(plan.status, 'raised');
  assert.match(plan.businessJustification, /A big launch film/);
  assert.match(plan.businessJustification, /Hire test/);
  assert.equal(plan.requiredSkills, 'Premiere, After Effects');

  const line = done.body.lines[0].id;
  assert.equal((await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, mira.token, { employeeId: dev1.emp })).status, 403, 'HR places the new hire');
  const first = await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, hrStaff.token, { employeeId: lena.emp, percent: 100, assignAnyway: true });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.lines[0].state, 'hiring', 'one of two is here');
  assert.equal(first.body.lines[0].filled, 1);
  assert.equal(first.body.status, 'in_progress');
  const dup = await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, hrStaff.token, { employeeId: lena.emp });
  assert.equal(dup.body.code, 'ALREADY_ON_REQUEST');
  const second = await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, hrStaff.token, { employeeId: sam.emp, assignAnyway: true });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.lines[0].state, 'assigned');
  assert.equal(second.body.status, 'fulfilled');
  assert.equal(await ProjectAllocation.countDocuments({ projectId: proj }), 2);
  const again = await api('POST', `/manpower/${r.id}/lines/${line}/allocate`, hrStaff.token, { employeeId: dev1.emp });
  assert.equal(again.body.code, 'NOT_HIRING');
});

await check('an allocation that is not a hire is refused; so is an unknown person', async () => {
  const proj = await mkProject('Allocate test');
  const r = (await ask(proj, mira.token, { headcount: 2, allocationPercent: 5 })).body;
  const both = await handle(r.id, hrStaff.token, [internal(pool[4]), { type: 'hire', seats: 1 }]);
  assert.equal(both.status, 200);
  const internalLine = both.body.lines.find((l) => l.type === 'internal').id;
  const hireLine = both.body.lines.find((l) => l.type === 'hire').id;
  assert.equal((await api('POST', `/manpower/${r.id}/lines/${internalLine}/allocate`, hrStaff.token, { employeeId: pool[5].emp })).status, 404);
  assert.equal((await api('POST', `/manpower/${r.id}/lines/${hireLine}/allocate`, hrStaff.token, { employeeId: 'nope' })).body.code, 'EMPLOYEE_INVALID');
});

// ── a contractor ────────────────────────────────────────────────────────────
await check('a contractor covers a seat at once, with what it costs', async () => {
  const proj = await mkProject('Contract test');
  const r = (await ask(proj, mira.token, { headcount: 1, roleTitle: 'Photographer' })).body;
  const done = await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Lens & Co', cost: 25000 }]);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.lines[0].state, 'assigned');
  assert.equal(done.body.lines[0].vendorName, 'Lens & Co');
  assert.equal(done.body.lines[0].cost, 25000);
  assert.equal(done.body.status, 'fulfilled');
  assert.equal(await ProjectAllocation.countDocuments({ projectId: proj }), 0, 'a contractor is not a staff allocation');
});

// ── the budget ──────────────────────────────────────────────────────────────
await check('a seat that costs more than the project has left is refused until its cost is raised and approved', async () => {
  const proj = await mkProject('Budget test');
  const r = (await ask(proj, mira.token, { headcount: 1, roleTitle: 'Producer' })).body;
  const tooMuch = await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Big Agency', cost: 150000 }]);
  assert.equal(tooMuch.status, 409);
  assert.equal(tooMuch.body.code, 'NEEDS_BUDGET');
  assert.equal(tooMuch.body.shortfall, 50000);
  assert.equal(tooMuch.body.available, 100000);
  assert.match(tooMuch.body.message, /raise the project's cost first/);
  assert.equal((await ManpowerRequest.findById(r.id)).lines.length, 0);
  // the manager raises the cost, the finance head approves it, and it goes through
  assert.equal((await api('PUT', `/projects/${proj}/cost`, mira.token, { budget: 200000, reason: 'A producer is needed' })).status, 200);
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Big Agency', cost: 150000 }])).body.code, 'NEEDS_BUDGET', 'not until Finance approves it');
  assert.equal((await api('POST', `/projects/${proj}/cost/decision`, fin.token, { decision: 'approve' })).status, 200);
  const ok = await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Big Agency', cost: 150000 }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

await check('the same rupees are not promised twice: what other requests have taken counts', async () => {
  const proj = await mkProject('Double budget');
  const a = (await ask(proj, mira.token, { headcount: 1 })).body;
  const b = (await ask(proj, mira.token, { headcount: 1 })).body;
  assert.equal((await handle(a.id, hrStaff.token, [{ type: 'contract', vendorName: 'One', cost: 80000 }])).status, 200);
  const second = await handle(b.id, hrStaff.token, [{ type: 'contract', vendorName: 'Two', cost: 30000 }]);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'NEEDS_BUDGET');
  assert.equal(second.body.available, 20000);
  assert.equal(second.body.shortfall, 10000);
  assert.equal((await handle(b.id, hrStaff.token, [{ type: 'contract', vendorName: 'Two', cost: 20000 }])).status, 200, 'exactly what is left fits');
});

await check('seats added to the same request in two goes count each other', async () => {
  const proj = await mkProject('Two goes');
  const r = (await ask(proj, mira.token, { headcount: 2 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'One', cost: 60000 }])).status, 200);
  const second = await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Two', cost: 60000 }]);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'NEEDS_BUDGET');
  assert.equal(second.body.available, 40000);
  assert.equal(second.body.shortfall, 20000);
});

await check('what has already been spent on the project counts too — approved and still waiting alike', async () => {
  const proj = await mkProject('Spent already');
  await AdminExpense.create({ title: 'Shoot', amount: 70000, status: 'approved', projectId: proj });
  await AdminExpense.create({ title: 'Props', amount: 10000, status: 'pending', projectId: proj });
  await AdminExpense.create({ title: 'Turned down', amount: 99000, status: 'rejected', projectId: proj });
  const r = (await ask(proj, mira.token, { headcount: 1 })).body;
  const refused = await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Late', cost: 30000 }]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'NEEDS_BUDGET');
  assert.equal(refused.body.available, 20000);
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'contract', vendorName: 'Late', cost: 20000 }])).status, 200);
});

await check('a seat that costs nothing (a person on staff) needs no budget', async () => {
  const proj = await mkProject('Staff needs no budget', { limit: 1000 });
  const r = (await ask(proj, mira.token, { headcount: 1, allocationPercent: 5 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [internal(pool[5])])).status, 200);
});

await check('a project with no approved budget cannot take a paid seat', async () => {
  const proj = await mkProject('No budget yet', { approve: false });
  const r = (await ask(proj, mira.token, { headcount: 1 })).body;
  const refused = await handle(r.id, hrStaff.token, [{ type: 'hire', cost: 5000 }]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'NEEDS_BUDGET');
  assert.match(refused.body.message, /no approved budget yet/);
  assert.equal((await handle(r.id, hrStaff.token, [{ type: 'hire' }])).status, 200, 'a hire with no cost named is not blocked');
});

await check('a refused seat gives its money back', async () => {
  const proj = await mkProject('Refunded budget');
  const a = (await ask(proj, mira.token, { headcount: 1 })).body;
  const b = (await ask(proj, mira.token, { headcount: 1 })).body;
  const taken = await handle(a.id, hrStaff.token, [{ type: 'contract', vendorName: 'One', cost: 90000 }]);
  assert.equal(taken.status, 200);
  assert.equal((await handle(b.id, hrStaff.token, [{ type: 'contract', vendorName: 'Two', cost: 50000 }])).status, 409);
  await ManpowerRequest.updateOne({ _id: a.id, 'lines.vendorName': 'One' }, { $set: { 'lines.$.state': 'refused' } });
  assert.equal((await handle(b.id, hrStaff.token, [{ type: 'contract', vendorName: 'Two', cost: 50000 }])).status, 200);
});

// ── declining and taking back ───────────────────────────────────────────────
await check('HR declines with a reason, and the asker is told', async () => {
  const proj = await mkProject('Decline test');
  const r = (await ask(proj, mira.token, { headcount: 1 })).body;
  const noWhy = await api('POST', `/manpower/${r.id}/decline`, hrStaff.token, {});
  assert.equal(noWhy.status, 400);
  assert.equal(noWhy.body.code, 'NOTE_REQUIRED');
  assert.equal((await api('POST', `/manpower/${r.id}/decline`, mira.token, { note: 'no' })).status, 403);
  const done = await api('POST', `/manpower/${r.id}/decline`, hrStaff.token, { note: 'Nobody is free until March' });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'declined');
  assert.equal(done.body.decisionNote, 'Nobody is free until March');
  const told = await notes(mira.id, 'manpower_update');
  assert.ok(told.some((t) => /HR cannot cover/.test(t.title) && t.body === 'Nobody is free until March'));
  assert.equal((await handle(r.id, hrStaff.token, [internal(dev1)])).body.code, 'NOT_OPEN');
  assert.equal((await api('POST', `/manpower/${r.id}/decline`, hrStaff.token, { note: 'again' })).body.code, 'NOT_OPEN');
});

await check('a request that is partly covered cannot be declined as a whole', async () => {
  const proj = await mkProject('Partial decline');
  const r = (await ask(proj, mira.token, { headcount: 2, allocationPercent: 5 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [internal(pool[6])])).status, 200);
  const refused = await api('POST', `/manpower/${r.id}/decline`, hrStaff.token, { note: 'cannot do the rest' });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, 'ALREADY_PARTLY_STAFFED');
});

await check('whoever asked can take it back before anyone is placed — the HR owner is told if there is one', async () => {
  const proj = await mkProject('Cancel test');
  const r = (await ask(proj, mira.token, { headcount: 1 })).body;
  assert.equal((await api('POST', `/manpower/${r.id}/cancel`, outsider.token, {})).status, 403);
  assert.equal((await api('POST', `/manpower/${r.id}/cancel`, member.token, {})).status, 403);
  const done = await api('POST', `/manpower/${r.id}/cancel`, mira.token, { note: 'Plans changed' });
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'cancelled');
  assert.equal((await api('POST', `/manpower/${r.id}/cancel`, mira.token, {})).body.code, 'NOT_OPEN');
  assert.equal((await handle(r.id, hrStaff.token, [internal(dev1)])).body.code, 'NOT_OPEN');
});

await check('once HR has started covering it, it cannot be taken back', async () => {
  const proj = await mkProject('Cancel late');
  const r = (await ask(proj, mira.token, { headcount: 2, allocationPercent: 5 })).body;
  assert.equal((await handle(r.id, hrStaff.token, [internal(pool[7])])).status, 200);
  const late = await api('POST', `/manpower/${r.id}/cancel`, mira.token, {});
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'ALREADY_PARTLY_STAFFED');
  const owner = await mkProject('Cancel owner');
  const q = (await ask(owner, mira.token, { headcount: 1 })).body;
  assert.equal((await api('POST', `/manpower/${q.id}/cancel`, mhead.token, {})).status, 200, 'the owning head can');
});

await check('when HR owns the request and it is withdrawn, they are told', async () => {
  const proj = await mkProject('Withdrawn');
  const r = (await ask(proj, mira.token, { headcount: 2, allocationPercent: 5 })).body;
  await ManpowerRequest.updateOne({ _id: r.id }, { hrOwner: hrHead.id, hrOwnerName: 'hrhead' });
  const before = (await notes(hrHead.id, 'manpower_update')).length;
  await api('POST', `/manpower/${r.id}/cancel`, mira.token, { note: 'Not needed any more' });
  const told = await notes(hrHead.id, 'manpower_update');
  assert.equal(told.length, before + 1);
  assert.match(told[told.length - 1].title, /Request withdrawn/);
});

// ── HR looks across the staff ───────────────────────────────────────────────
await check('availability: HR sees everyone with how much of their time is taken, free people first', async () => {
  const proj = await mkProject('Availability');
  await ProjectAllocation.create({ projectId: proj, employeeId: dev1.emp, employeeName: 'dev1', role: 'x', percent: 80, from: new Date(Date.UTC(2027, 2, 1)), to: new Date(Date.UTC(2027, 2, 31)) });
  await LeaveRequest.create({ employeeId: dev2.emp, fromDate: new Date(Date.UTC(2027, 2, 5)), toDate: new Date(Date.UTC(2027, 2, 6)), status: 'approved' });
  const r = await api('GET', '/manpower/availability?from=2027-03-01&to=2027-03-31&percent=50', hrStaff.token);
  assert.equal(r.status, 200);
  const byName = Object.fromEntries(r.body.map((e) => [e.name, e]));
  assert.equal(byName.dev1.load, 80);
  assert.equal(byName.dev1.level, 'busy', '80% + 50% is past 100');
  assert.equal(byName.dev2.onLeave, true);
  assert.equal(byName.dev2.level, 'busy');
  assert.equal(byName.lena.load, 0);
  assert.equal(byName.lena.level, 'free');
  assert.ok(byName.lena.openTasks >= 0);
  const firstBusy = r.body.findIndex((e) => e.level === 'busy');
  const lastFree = r.body.map((e) => e.level).lastIndexOf('free');
  assert.ok(lastFree < firstBusy, 'free people come before busy ones');
});

await check('availability can be searched by name and department; only HR may look', async () => {
  assert.deepEqual((await api('GET', '/manpower/availability?q=len', hrStaff.token)).body.map((e) => e.name), ['lena']);
  assert.ok((await api('GET', '/manpower/availability?department=IT', hrStaff.token)).body.every((e) => e.department === 'IT'));
  for (const who of [mira, mhead, member, outsider, ceo]) assert.equal((await api('GET', '/manpower/availability', who.token)).status, 403, who.name);
  assert.equal((await api('GET', '/manpower/availability?from=2027-03-31&to=2027-03-01', hrStaff.token)).status, 400);
});

await check('an urgent request filed later still comes before older ones that are waiting', async () => {
  const proj = await mkProject('Urgency order');
  const older = (await ask(proj, mira.token, { headcount: 1, roleTitle: 'Older and normal' })).body;
  const newer = (await ask(proj, mira.token, { headcount: 1, roleTitle: 'Newer and urgent', urgency: 'urgent' })).body;
  const order = (await list(hrHead.token, '?scope=open')).body.map((x) => x.id);
  assert.ok(order.indexOf(newer.id) < order.indexOf(older.id));
  assert.equal(order[0].length > 0 && (await list(hrHead.token, '?scope=open')).body[0].urgency, 'urgent');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
