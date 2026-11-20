// End-to-end check of TASK COSTS against a project's budget — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run
// against anything else and drops its own database first):
//
//   mkdir -p /tmp/taskcost-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/taskcost-e2e --fork --logpath /tmp/taskcost-e2e/log
//   node tests/e2e/task-cost.e2e.mjs
//
// The method: a project whose cost the finance head approved (₹1,00,000) → tasks get a planned cost (an amount, or hours × a rate); only leaf tasks
// count and a phase shows their sum → a task that would take the plan above the budget is refused unless it carries a budget increase for the finance
// head (the same approve / return flow as any cost change); tasks inside a pending request do not raise another; nothing that does not ADD to the plan
// is ever held up; only those who may see money see task costs, only those who run the project set them.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/task_cost_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'task_cost_e2e', 'SAFETY: not our own database');
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

// ── people ──────────────────────────────────────────────────────────────────
let n = 0;
const person = async (key, role, { dept = '', head = false } = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: dept });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, isDepartmentHead: head });
  return { id: String(user._id), emp: String(emp._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await person('boss', 'admin');
const fin = await person('fin', 'finance_head', { dept: 'Finance', head: true });
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // the project manager
const mhead = await person('mhead', 'crm', { dept: 'Marketing', head: true }); // head of the owning department
const member = await person('member', 'crm', { dept: 'Marketing' }); // on the project, has a task, does not run it
const outsider = await person('outsider', 'crm', { dept: 'Marketing' }); // not on the project
await Department.create({ key: 'marketing', name: 'Marketing', head: mhead.emp });
await Department.create({ key: 'finance', name: 'Finance', head: fin.emp });
await User.updateOne({ _id: fin.id }, { departmentId: (await Department.findOne({ key: 'finance' }))._id });
await User.updateOne({ _id: mhead.id }, { departmentId: (await Department.findOne({ key: 'marketing' }))._id });

const notes = (userId, type) => Notification.find({ recipient: userId, type }).lean();
const project = async (token, extra = {}) => {
  const r = await api('POST', '/projects', token, { name: 'Website redesign', targetDepartment: 'Marketing', managerId: mira.emp, members: [member.emp], budget: 100000, editMode: 'managed', ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const approve = (id, amount, note) => api('POST', `/projects/${id}/cost/decision`, fin.token, { decision: 'approve', ...(amount ? { approvedAmount: amount } : {}), ...(note ? { note } : {}) });
const getP = (id, token) => api('GET', `/projects/${id}`, token);
const mkTask = (token, pid, extra = {}) => api('POST', '/it-tasks', token, { projectId: pid, title: 'A task', ...extra });
const putTask = (token, id, body) => api('PUT', `/it-tasks/${id}`, token, body);
const list = (token, pid) => api('GET', `/it-tasks?projectId=${pid}`, token);
const plan = async (pid, token = boss.token) => (await getP(pid, token)).body.cost?.taskPlan;
const stored = (id) => ITTask.findById(id).lean();
const count = (pid) => ITTask.countDocuments({ projectId: pid });

// the project every test below uses: ₹1,00,000, approved
const P = await project(boss.token);
const pid = P._id;
await check('a first request still waiting is "asked for", not "approved" — the plan is held against it', async () => {
  const pl = await plan(pid);
  assert.equal(pl.ceiling, 100000);
  assert.equal(pl.awaiting, true);
});
await check('setup: the project\'s ₹1,00,000 is approved', async () => {
  const r = await approve(pid);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.costStatus, 'approved');
  assert.equal(r.body.cost.approvedBudget, 100000);
  assert.equal(r.body.cost.taskPlan.awaiting, false, 'approved: nothing is waiting any more');
});

console.log('Giving a task a cost');
let phase;
let leafA;
let leafB;
await check('a task\'s cost is an amount: stored, and counted in the plan', async () => {
  const ph = await mkTask(mira.token, pid, { title: 'Design phase' });
  phase = ph.body;
  const r = await mkTask(mira.token, pid, { title: 'Wireframes', parentTaskId: phase._id, costMode: 'amount', costAmount: '30,000' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  leafA = r.body;
  assert.deepEqual([leafA.costMode, leafA.costAmount, leafA.plannedCost], ['amount', 30000, 30000]);
  const pl = await plan(pid);
  assert.equal(pl.planned, 30000);
  assert.equal(pl.ceiling, 100000);
  assert.equal(pl.level, 'ok');
});
await check('or hours × a rate, and a change of hours moves the cost with it', async () => {
  const r = await mkTask(mira.token, pid, { title: 'Build', parentTaskId: phase._id, estimatedHours: 20, costMode: 'rate', costRate: 500 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  leafB = r.body;
  assert.deepEqual([leafB.costMode, leafB.costRate, leafB.plannedCost], ['rate', 500, 10000]);
  assert.equal((await plan(pid)).planned, 40000);
  // only the hours are sent: the cost follows
  const e = await putTask(mira.token, leafB._id, { estimatedHours: 30 });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.plannedCost, 15000);
  assert.equal((await stored(leafB._id)).plannedCost, 15000);
  assert.equal((await plan(pid)).planned, 45000);
});
await check('a phase is counted by its leaves only, with the split by department and the unpriced ones', async () => {
  await mkTask(mira.token, pid, { title: 'Unpriced' });
  const pl = await plan(pid);
  assert.equal(pl.planned, 45000, 'the phase itself adds nothing');
  assert.deepEqual([pl.leaves, pl.priced, pl.unpriced], [3, 2, 1]);
  assert.deepEqual(pl.byDepartment, [{ name: 'Marketing', planned: 45000, tasks: 3 }]);
});
await check('a client cannot set the planned cost itself', async () => {
  const r = await mkTask(mira.token, pid, { title: 'Forged', plannedCost: 99999999 });
  assert.equal(r.status, 201);
  assert.equal(r.body.plannedCost, 0);
  const e = await putTask(mira.token, r.body._id, { title: 'Forged again', plannedCost: 88888888 });
  assert.equal(e.body.plannedCost, 0);
  assert.equal((await plan(pid)).planned, 45000);
});
await check('a task that gains its first sub-task gives its own cost up to it', async () => {
  const a = (await mkTask(mira.token, pid, { title: 'Content', costMode: 'amount', costAmount: 5000 })).body;
  assert.equal((await plan(pid)).planned, 50000);
  const c = await mkTask(mira.token, pid, { title: 'Copy', parentTaskId: a._id, costMode: 'amount', costAmount: 2000 });
  assert.equal(c.status, 201, JSON.stringify(c.body));
  assert.deepEqual([(await stored(a._id)).costMode, (await stored(a._id)).plannedCost], ['', 0], 'the parent\'s own cost is gone');
  assert.equal((await plan(pid)).planned, 47000, '₹5,000 off, ₹2,000 on');
  // and a cost cannot be put back on a task that has sub-tasks
  const again = await putTask(mira.token, a._id, { costMode: 'amount', costAmount: 9000 });
  assert.equal(again.status, 400);
  assert.equal(again.body.code, 'TASK_COST_PARENT');
  assert.equal((await stored(a._id)).plannedCost, 0);
});
await check('moving a task under a leaf also makes that leaf give its cost up', async () => {
  const x = (await mkTask(mira.token, pid, { title: 'Leaf X', costMode: 'amount', costAmount: 3000 })).body;
  const y = (await mkTask(mira.token, pid, { title: 'Leaf Y' })).body;
  assert.equal((await plan(pid)).planned, 50000);
  const m = await putTask(mira.token, y._id, { parentTaskId: x._id });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal((await stored(x._id)).plannedCost, 0);
  assert.equal((await plan(pid)).planned, 47000);
});
await check('every wrong cost is refused and nothing is saved', async () => {
  const before = await count(pid);
  for (const bad of [{ costMode: 'sideways' }, { costMode: 'amount', costAmount: -5 }, { costMode: 'amount', costAmount: 'lots' }, { costMode: 'rate', costRate: -1, estimatedHours: 5 }]) {
    const r = await mkTask(mira.token, pid, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.code, 'TASK_COST_INVALID', JSON.stringify(bad));
  }
  assert.equal(await count(pid), before);
});

console.log('Who sees it and who sets it');
await ITTask.updateOne({ _id: leafA._id }, { assignedTo: member.emp });
await check('those who run the project and admins see task costs; everyone else sees none', async () => {
  const find = (r) => r.body.find((t) => t._id === leafA._id);
  for (const who of [mira, mhead, boss]) {
    const r = await list(who.token, pid);
    assert.equal(r.status, 200, who.name);
    assert.equal(find(r).plannedCost, 30000, who.name);
  }
  const m = await list(member.token, pid);
  assert.equal(m.status, 200);
  const t = find(m);
  assert.ok(t, 'a member still sees the task');
  for (const k of ['costMode', 'costAmount', 'costRate', 'plannedCost']) assert.ok(!(k in t), `${k} must not reach a member`);
});
await check('the project\'s cost numbers (and the plan) are hidden from a member too', async () => {
  const r = await getP(pid, member.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.cost, null);
  assert.ok(!JSON.stringify(r.body).includes('taskPlan'));
  const l = await api('GET', '/projects', member.token);
  assert.ok(!JSON.stringify(l.body).includes('taskPlan'));
});
await check('what a member gets back from saving a task carries no cost either', async () => {
  const r = await putTask(member.token, leafA._id, { percentComplete: 40, status: 'in-progress' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const k of ['costMode', 'costAmount', 'costRate', 'plannedCost']) assert.ok(!(k in r.body), k);
  assert.equal((await stored(leafA._id)).plannedCost, 30000, 'the cost is untouched by a progress update');
});
await check('the person a task is given to cannot change its cost', async () => {
  const r = await putTask(member.token, leafA._id, { costMode: 'amount', costAmount: 1 });
  assert.equal(r.status, 403);
  assert.equal((await stored(leafA._id)).plannedCost, 30000);
});
await check('a person who runs nothing cannot add a priced task, and an outsider cannot see the project\'s tasks', async () => {
  assert.equal((await list(outsider.token, pid)).status, 403);
  assert.equal((await mkTask(member.token, pid, { costMode: 'amount', costAmount: 100 })).status, 403);
});
await check('the head of the owning department and the admin may set costs; the finance head only reads', async () => {
  assert.equal((await mkTask(mhead.token, pid, { title: 'By the head', costMode: 'amount', costAmount: 100 })).status, 201);
  assert.equal((await mkTask(boss.token, pid, { title: 'By the admin', costMode: 'amount', costAmount: 100 })).status, 201);
  const r = await putTask(fin.token, leafA._id, { costMode: 'amount', costAmount: 5 });
  assert.ok([403].includes(r.status), `finance head got ${r.status}`);
  assert.equal((await stored(leafA._id)).plannedCost, 30000);
});
await check('bulk updates take no cost or hours (one task at a time), but still take a status', async () => {
  for (const updates of [{ costAmount: 5 }, { estimatedHours: 4 }, { plannedCost: 7 }, { costMode: 'amount' }]) {
    const r = await api('POST', '/it-tasks/bulk-update', mira.token, { taskIds: [leafA._id], updates });
    assert.equal(r.status, 400, JSON.stringify(updates));
    assert.equal(r.body.code, 'TASK_COST_ONE_AT_A_TIME');
  }
  const ok = await api('POST', '/it-tasks/bulk-update', mira.token, { taskIds: [leafA._id], updates: { status: 'in-progress' } });
  assert.equal(ok.status, 200);
});

// the plan so far: leafA 30,000 + leafB 15,000 + the head's 100 + the admin's 100 + Copy 2,000 = 47,200
const PLAN_NOW = 47200;
console.log('The guardrail');
await check('the plan so far is what we think it is', async () => {
  const pl = await plan(pid);
  assert.equal(pl.planned, PLAN_NOW);
  assert.equal(pl.level, 'ok');
});
let held;
await check('a task that would take the plan above the approved budget is refused, with the numbers, and not created', async () => {
  const before = await count(pid);
  const r = await mkTask(mira.token, pid, { title: 'Vendor build', costMode: 'amount', costAmount: 70000 });
  assert.equal(r.status, 409, JSON.stringify(r.body));
  held = r.body;
  assert.equal(held.code, 'TASK_COST_OVER_BUDGET');
  assert.equal(held.plan.planned, PLAN_NOW + 70000);
  assert.equal(held.plan.ceiling, 100000);
  assert.equal(held.plan.over, PLAN_NOW + 70000 - 100000);
  assert.equal(held.plan.canRequest, true);
  assert.match(held.message, /₹1,17,200/);
  assert.equal(await count(pid), before, 'nothing was written');
  assert.equal((await Project.findById(pid).lean()).costStatus, 'approved', 'and no request was sent on its own');
});
await check('exactly the budget fits', async () => {
  const room = 100000 - PLAN_NOW;
  const r = await mkTask(mira.token, pid, { title: 'Exactly the rest', costMode: 'amount', costAmount: room });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pl = await plan(pid);
  assert.equal(pl.planned, 100000);
  assert.equal(pl.level, 'warn', 'at the ceiling is not over');
  await ITTask.deleteOne({ _id: r.body._id });
});
await check('raising an hours-based cost past the budget is held the same way', async () => {
  const r = await putTask(mira.token, leafB._id, { estimatedHours: 200 }); // 200 h × 500 = 100,000
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'TASK_COST_OVER_BUDGET');
  assert.equal((await stored(leafB._id)).plannedCost, 15000, 'unchanged');
  assert.equal((await stored(leafB._id)).estimatedHours, 30, 'the hours were not saved either');
});
await check('a budget increase needs a reason after approval, and nothing is saved without it', async () => {
  const before = await count(pid);
  const r = await mkTask(mira.token, pid, { title: 'Vendor build', costMode: 'amount', costAmount: 70000, budgetIncrease: {} });
  assert.equal(r.status, 400, JSON.stringify(r.body));
  assert.equal(r.body.code, 'CHANGE_NEEDS_REASON');
  assert.equal(await count(pid), before);
  assert.equal((await Project.findById(pid).lean()).costStatus, 'approved');
});
await check('a budget that does not cover the tasks is refused', async () => {
  const before = await count(pid);
  const r = await mkTask(mira.token, pid, { title: 'Vendor build', costMode: 'amount', costAmount: 70000, budgetIncrease: { reason: 'Vendor work', amount: 110000 } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'INCREASE_TOO_LOW');
  assert.equal(await count(pid), before);
});
await check('only those who run the project can ask for the increase', async () => {
  const r = await mkTask(fin.token, pid, { costMode: 'amount', costAmount: 70000, budgetIncrease: { reason: 'Vendor work' } });
  assert.ok([403].includes(r.status), `finance head got ${r.status}`);
  assert.equal((await Project.findById(pid).lean()).costStatus, 'approved');
});
let raised;
await check('with a reason the task is saved AND the increase goes to the finance head, the old budget staying the limit', async () => {
  const r = await mkTask(mira.token, pid, { title: 'Vendor build', costMode: 'amount', costAmount: 70000, budgetIncrease: { reason: 'Vendor build was not in the first estimate', amount: 120000 } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  raised = r.body;
  assert.equal(raised.plannedCost, 70000);
  assert.deepEqual([raised.costRequest.sent, raised.costRequest.amount, raised.costRequest.status], [true, 120000, 'pending']);
  const p = await Project.findById(pid).lean();
  assert.equal(p.costStatus, 'pending');
  assert.equal(p.budget, 120000);
  assert.equal(p.approvedBudget, 100000, 'the old approved budget is still the limit');
  assert.equal(p.costChanges.at(-1).reason, 'Vendor build was not in the first estimate');
  assert.ok(p.costChanges.at(-1).lines.length >= 1);
  const told = await notes(fin.id, 'project_cost_request');
  assert.match(told.at(-1).title, /Budget change waiting/);
});
await check('Finance sees the request with the tasks behind it', async () => {
  const r = await api('GET', '/projects/cost/pending', fin.token);
  const row = r.body.find((x) => x.id === pid);
  assert.ok(row, 'the project is in the list');
  assert.equal(row.isChange, true);
  assert.equal(row.budget, 120000);
  assert.equal(row.approvedBudget, 100000);
  assert.equal(row.taskPlanned, 117200);
  assert.ok(row.taskCount >= 1);
  assert.equal(row.changeReason, 'Vendor build was not in the first estimate');
  // the tasks behind the figure, the biggest first, each with the phase it hangs under
  assert.ok(Array.isArray(row.taskLines) && row.taskLines.length >= 2);
  assert.deepEqual([row.taskLines[0].title, row.taskLines[0].planned], ['Vendor build', 70000]);
  const wf = row.taskLines.find((l) => l.title === 'Wireframes');
  assert.deepEqual([wf.planned, wf.phase], [30000, 'Design phase']);
  assert.equal(row.taskLines.some((l) => l.title === 'Design phase'), false, 'a phase is its tasks\' total, not a line of its own');
  assert.equal(row.taskLinesMore, 0);
});
await check('while it waits, tasks inside the request do not raise another; past it they are held again', async () => {
  const pl = await plan(pid);
  assert.equal(pl.ceiling, 120000);
  assert.equal(pl.awaiting, true);
  assert.equal(pl.level, 'warn');
  const inside = await mkTask(mira.token, pid, { title: 'A small one', costMode: 'amount', costAmount: 200 });
  assert.equal(inside.status, 201, JSON.stringify(inside.body));
  assert.equal(inside.body.costRequest, undefined, 'no new request');
  const past = await mkTask(mira.token, pid, { title: 'Too much', costMode: 'amount', costAmount: 50000 });
  assert.equal(past.status, 409);
  await ITTask.deleteOne({ _id: inside.body._id });
});
await check('the finance head approves LESS than asked: the plan is over, and only adding to it is held', async () => {
  const r = await approve(pid, 110000, 'The vendor work is capped');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cost.approvedBudget, 110000);
  const pl = await plan(pid);
  assert.equal(pl.planned, 117200);
  assert.equal(pl.level, 'over');
  assert.equal(pl.over, 7200);
  // a progress update on an over-plan project is never held up
  const prog = await putTask(mira.token, raised._id, { status: 'in-progress', percentComplete: 10 });
  assert.equal(prog.status, 200, JSON.stringify(prog.body));
  // a change that adds nothing is fine; one that takes cost out is fine; one that adds is held
  assert.equal((await putTask(mira.token, raised._id, { title: 'Vendor build (renamed)' })).status, 200);
  assert.equal((await putTask(mira.token, raised._id, { costMode: 'amount', costAmount: 66000 })).status, 200, 'taking cost out, though still over');
  assert.equal((await plan(pid)).planned, 113200);
  const more = await putTask(mira.token, raised._id, { costMode: 'amount', costAmount: 67000 });
  assert.equal(more.status, 409, 'adding to a plan that is over is held again');
  assert.equal((await stored(raised._id)).plannedCost, 66000);
});
await check('deleting a task takes its cost out of the plan, whatever the level', async () => {
  const before = (await plan(pid)).planned;
  const r = await api('DELETE', `/it-tasks/${raised._id}`, mira.token);
  assert.equal(r.status, 200);
  assert.equal((await plan(pid)).planned, before - 66000);
  assert.equal((await plan(pid)).level, 'ok');
});

console.log('Projects that have no ceiling, and the project list');
await check('a project from before costs existed has no ceiling: any task cost is fine', async () => {
  const legacy = await Project.create({ name: 'Old one', targetDepartment: 'Marketing', managerId: mira.emp, createdBy: boss.id, status: 'active', costStatus: 'none', editMode: 'managed' });
  const r = await mkTask(mira.token, String(legacy._id), { title: 'Big', costMode: 'amount', costAmount: 9_000_000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const pl = (await getP(String(legacy._id), boss.token)).body.cost.taskPlan;
  assert.deepEqual([pl.planned, pl.ceiling, pl.level], [9000000, 0, 'none']);
});
await check('a first request that waits is the ceiling until it is decided', async () => {
  const second = await project(boss.token, { name: 'Second', budget: 50000 }); // pending, nothing approved
  const ok = await mkTask(mira.token, second._id, { costMode: 'amount', costAmount: 50000 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const over = await mkTask(mira.token, second._id, { costMode: 'amount', costAmount: 1 });
  assert.equal(over.status, 409);
  // asking for more while it is still the first request needs no reason (nothing was approved yet) and just updates the request
  const raise = await mkTask(mira.token, second._id, { costMode: 'amount', costAmount: 5000, budgetIncrease: {} });
  assert.equal(raise.status, 201, JSON.stringify(raise.body));
  const p = await Project.findById(second._id).lean();
  assert.equal(p.budget, 55000);
  assert.equal(p.costStatus, 'pending');
  assert.equal(p.costChanges.length, 0, 'not a change after approval, so not in that history');
});
await check('with a breakdown, the extra goes on an "other" line so the lines still add up', async () => {
  const third = await project(boss.token, { name: 'Third', budget: 1, costPlan: [{ category: 'manpower', amount: 60000 }, { category: 'tools', amount: 40000 }] });
  assert.equal((await approve(third._id)).status, 200);
  const r = await mkTask(mira.token, third._id, { costMode: 'amount', costAmount: 130000, budgetIncrease: { reason: 'Bigger than thought' } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const p = await Project.findById(third._id).lean();
  assert.equal(p.budget, 130000);
  assert.equal(p.costPlan.reduce((s, l) => s + l.amount, 0), 130000);
  assert.deepEqual(p.costPlan.at(-1), { category: 'other', amount: 30000, note: 'Task plan' });
  assert.equal(p.approvedBudget, 100000);
});
await check('the project list carries the plan for those who may see money', async () => {
  const l = await api('GET', '/projects', mira.token);
  const row = l.body.find((x) => x._id === pid);
  assert.equal(typeof row.cost.taskPlan.planned, 'number');
  assert.equal(row.cost.taskPlan.ceiling, 110000);
});

console.log('A project where anyone on it may edit tasks (the older "open" mode)');
const Q = await project(boss.token, { name: 'Open project', editMode: 'open' });
await approve(Q._id);
let qt;
await check('a member may add and edit tasks, but not set what they cost', async () => {
  const plain = await mkTask(member.token, Q._id, { title: 'Member task' });
  assert.equal(plain.status, 201, JSON.stringify(plain.body));
  qt = plain.body;
  const priced = await mkTask(member.token, Q._id, { title: 'Priced by a member', costMode: 'amount', costAmount: 10 });
  assert.equal(priced.status, 403);
  assert.equal(priced.body.code, 'TASK_COST_FORBIDDEN');
  const edit = await putTask(member.token, qt._id, { title: 'Renamed', costAmount: 10, costMode: 'amount' });
  assert.equal(edit.status, 403);
  assert.equal(edit.body.code, 'TASK_COST_FORBIDDEN');
});
await check('an echo of the cost a member was never given changes nothing', async () => {
  const e = await putTask(member.token, qt._id, { title: 'Renamed again', costMode: '', costAmount: 0, costRate: 0 });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal((await stored(qt._id)).title, 'Renamed again');
});
await check('a member who raises the hours of an hours-based task past the budget is refused WITHOUT being told any amount', async () => {
  const t = (await mkTask(mira.token, Q._id, { title: 'By the hour', estimatedHours: 10, costMode: 'rate', costRate: 1000 })).body;
  assert.equal(t.plannedCost, 10000);
  const r = await putTask(member.token, t._id, { estimatedHours: 500 }); // 500,000 > 100,000
  assert.equal(r.status, 409, JSON.stringify(r.body));
  assert.equal(r.body.code, 'TASK_COST_OVER_BUDGET');
  assert.equal(r.body.plan, undefined);
  assert.ok(!/₹|\d{4}/.test(r.body.message), `no amounts in: ${r.body.message}`);
  assert.equal((await stored(t._id)).estimatedHours, 10);
  // and a member cannot send a budget increase either
  const asked = await putTask(member.token, t._id, { estimatedHours: 500, budgetIncrease: { reason: 'please' } });
  assert.equal(asked.status, 403);
  assert.equal((await Project.findById(Q._id).lean()).costStatus, 'approved');
});

console.log('Asking for more before many priced tasks are made (the plan wizard)');
const raise = (token, id, body) => api('POST', `/projects/${id}/cost/raise`, token, body);
const W = await project(boss.token, { name: 'Wizard project', budget: 100000 });
await approve(W._id);
await check('the manager asks for a bigger total with a reason: the old budget stays the limit, the finance head is told', async () => {
  const told = (await notes(fin.id, 'project_cost_request')).length;
  const r = await raise(mira.token, W._id, { amount: '1,50,000', reason: 'Four more vendors than planned' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.costStatus, 'pending');
  assert.equal(r.body.cost.budget, 150000);
  assert.equal(r.body.cost.approvedBudget, 100000);
  const p = await Project.findById(W._id).lean();
  assert.equal(p.costChanges.at(-1).reason, 'Four more vendors than planned');
  assert.equal((await notes(fin.id, 'project_cost_request')).length, told + 1);
});
await check('then every task of the plan fits inside the request, and the first one past it is held', async () => {
  for (const cost of [60000, 50000, 40000]) {
    const t = await mkTask(mira.token, W._id, { title: `Part ${cost}`, costMode: 'amount', costAmount: cost });
    assert.equal(t.status, 201, JSON.stringify(t.body));
  }
  assert.equal((await plan(W._id)).planned, 150000);
  assert.equal((await plan(W._id)).ceiling, 150000);
  assert.equal((await mkTask(mira.token, W._id, { costMode: 'amount', costAmount: 1 })).status, 409);
});
await check('asking again while it waits just raises the request again, and needs no new reason', async () => {
  const r = await raise(mira.token, W._id, { amount: 180000 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cost.budget, 180000);
  assert.equal(r.body.cost.approvedBudget, 100000);
});
await check('a total that is not more than the current one, or not an amount, is refused', async () => {
  const before = (await Project.findById(W._id).lean()).budget;
  for (const [body, code] of [[{ amount: 180000, reason: 'Same' }, 'NOT_MORE'], [{ amount: 90000, reason: 'Less' }, 'NOT_MORE'], [{ amount: 0, reason: 'x y z' }, 'AMOUNT_INVALID'], [{ amount: 'lots', reason: 'x y z' }, 'AMOUNT_INVALID'], [{ reason: 'x y z' }, 'AMOUNT_INVALID']]) {
    const r = await raise(mira.token, W._id, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, code, JSON.stringify(body));
  }
  assert.equal((await Project.findById(W._id).lean()).budget, before);
});
await check('after approval it needs a reason, and nothing changes without one', async () => {
  const A = await project(boss.token, { name: 'Needs a reason', budget: 100000 });
  await approve(A._id);
  const r = await raise(mira.token, A._id, { amount: 130000 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'CHANGE_NEEDS_REASON');
  const p = await Project.findById(A._id).lean();
  assert.deepEqual([p.costStatus, p.budget], ['approved', 100000]);
});
await check('a project with a breakdown puts the extra on an "other" line so the lines still add up', async () => {
  const B = await project(boss.token, { name: 'Breakdown', budget: 1, costPlan: [{ category: 'manpower', amount: 70000 }, { category: 'tools', amount: 30000 }] });
  await approve(B._id);
  const r = await raise(mira.token, B._id, { amount: 125000, reason: 'More tools' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const p = await Project.findById(B._id).lean();
  assert.equal(p.costPlan.reduce((sum, l) => sum + l.amount, 0), 125000);
  assert.deepEqual(p.costPlan.at(-1), { category: 'other', amount: 25000, note: 'Task plan' });
});
await check('a project with no budget yet has nothing to raise', async () => {
  const legacy = await Project.create({ name: 'Old', targetDepartment: 'Marketing', managerId: mira.emp, createdBy: boss.id, status: 'active', costStatus: 'none', editMode: 'managed' });
  const r = await raise(mira.token, String(legacy._id), { amount: 50000, reason: 'Because' });
  assert.deepEqual([r.status, r.body.code], [400, 'NO_BUDGET_YET']);
});
await check('only those who run the project may ask: not a member, not the finance head, not an outsider, not a stranger', async () => {
  const body = { amount: 400000, reason: 'Because' };
  for (const who of [member, fin, outsider]) assert.equal((await raise(who.token, W._id, body)).status, 403, who.name);
  assert.equal((await raise(null, W._id, body)).status, 401);
  assert.equal((await raise(mira.token, new mongoose.Types.ObjectId().toString(), body)).status, 404);
  assert.equal((await Project.findById(W._id).lean()).budget, 180000);
});
await check('the admin and the owning department\'s head may', async () => {
  assert.equal((await raise(boss.token, W._id, { amount: 190000 })).status, 200);
  assert.equal((await raise(mhead.token, W._id, { amount: 195000 })).status, 200);
});

console.log('The finance head looks at the project and the tasks behind its budget — and only looks');
let looked;
await check('a finance head who is on no project opens one that has a cost: read-only, with the task costs', async () => {
  looked = await project(boss.token, { name: 'Looked at' });
  await ITTask.create({ projectId: looked._id, title: 'Venue booking', plannedCost: 42000, costMode: 'amount', costAmount: 42000, createdBy: boss.id });
  const r = await getP(looked._id, fin.token);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.access.role, 'viewer');
  assert.deepEqual([r.body.access.canSeeCost, r.body.access.canEditCost, r.body.access.canCreateTasks, r.body.access.canEditAllTasks], [true, false, false, false]);
  assert.equal(r.body.access.canDecideCost, true, 'while the cost waits, they can decide it from there');
  assert.equal(r.body.cost.taskPlan.planned, 42000);
  assert.equal(r.body.cost.taskPlan.awaiting, true);
  assert.ok((await api('GET', '/projects', fin.token)).body.some((x) => x._id === looked._id), 'it is in their list');
  const tasks = await list(fin.token, looked._id);
  assert.equal(tasks.status, 200);
  assert.equal(tasks.body.find((t) => t.title === 'Venue booking').plannedCost, 42000);
});
await check('...and they can change nothing there: no task made, edited or removed, no cost changed', async () => {
  const t = await ITTask.findOne({ projectId: looked._id });
  const before = await count(looked._id);
  assert.equal((await mkTask(fin.token, looked._id, { title: 'Sneaky' })).status, 403);
  assert.equal((await putTask(fin.token, String(t._id), { title: 'Changed', costMode: 'amount', costAmount: 1 })).status, 403);
  assert.equal((await api('DELETE', `/it-tasks/${t._id}`, fin.token)).status, 403);
  assert.equal((await api('PUT', `/projects/${looked._id}/cost`, fin.token, { budget: 5, reason: 'x' })).status, 403);
  assert.equal(await count(looked._id), before);
  const same = await stored(t._id);
  assert.deepEqual([same.title, same.plannedCost], ['Venue booking', 42000]);
});
await check('they decide from there: approve, and the project and its tasks are then held against the amount', async () => {
  const r = await approve(looked._id, 60000, 'Within the event budget');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const again = await getP(looked._id, fin.token);
  assert.deepEqual([again.body.costStatus, again.body.cost.approvedBudget, again.body.access.canDecideCost], ['approved', 60000, false]);
  assert.equal(again.body.cost.taskPlan.awaiting, false);
  assert.equal(again.body.cost.taskPlan.ceiling, 60000);
});
await check('a project that is open to edit, has no cost, or is only a proposal stays out of their sight', async () => {
  const open = await project(boss.token, { name: 'Open one' });
  await Project.updateOne({ _id: open._id }, { editMode: 'open' });
  assert.equal((await getP(open._id, fin.token)).status, 403, 'open: anyone who sees it could edit it');
  const none = await project(boss.token, { name: 'No cost' });
  await Project.updateOne({ _id: none._id }, { costStatus: 'none' });
  assert.equal((await getP(none._id, fin.token)).status, 403);
  const proposal = await project(boss.token, { name: 'Just a proposal' });
  await Project.updateOne({ _id: proposal._id }, { status: 'proposed' });
  assert.equal((await getP(proposal._id, fin.token)).status, 403, 'the owning department\'s head decides a proposal first');
  const listed = (await api('GET', '/projects', fin.token)).body.map((x) => x._id);
  for (const p of [open, none, proposal]) assert.equal(listed.includes(p._id), false, p.name);
});
await check('only the finance head: Accounts and an outsider do not get this view', async () => {
  const acc = await person('acc', 'accounts', { dept: 'Accounts' }); // Accounts may see costs where they are asked, but is not the finance head
  for (const who of [outsider, acc]) assert.equal((await getP(looked._id, who.token)).status, 403, who.name);
  assert.equal((await api('GET', '/projects', acc.token)).body.some((x) => x._id === looked._id), false);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
