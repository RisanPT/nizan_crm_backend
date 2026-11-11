// End-to-end check of a project's COST: asked for when the project is added, approved by the finance head before
// the project can start, changed afterwards only with a reason (and approved again), and visible only to those who may
// see money.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else, and
// drops its database first):
//
//   mkdir -p /tmp/cost-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/cost-e2e --fork --logpath /tmp/cost-e2e/log
//   node tests/e2e/project-cost.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/project_cost_e2e');
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
const fin = await person('fin', 'finance_head', { dept: 'Finance', head: true }); // the finance head
const accounts = await person('acc', 'accounts', { dept: 'Accounts' }); // Accounts: sees, does not decide
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // a project manager
const mhead = await person('mhead', 'crm', { dept: 'Marketing', head: true });
const staff = await person('staff', 'crm', { dept: 'Marketing' }); // proposes a project
const member = await person('member', 'crm', { dept: 'Marketing' }); // on a project, not running it
const ceo = await person('ceo', 'ceo');
await Department.create({ key: 'marketing', name: 'Marketing', head: mhead.emp });
await Department.create({ key: 'finance', name: 'Finance', head: fin.emp });
await Department.create({ key: 'accounts', name: 'Accounts', head: null });
await User.updateOne({ _id: fin.id }, { departmentId: (await Department.findOne({ key: 'finance' }))._id });
await User.updateOne({ _id: mhead.id }, { departmentId: (await Department.findOne({ key: 'marketing' }))._id });

const get = (id, token) => api('GET', `/projects/${id}`, token);
const put = (id, token, body) => api('PUT', `/projects/${id}`, token, body);
const putCost = (id, token, body) => api('PUT', `/projects/${id}/cost`, token, body);
const decide = (id, token, body) => api('POST', `/projects/${id}/cost/decision`, token, body);
const pending = (token) => api('GET', '/projects/cost/pending', token);
const notes = (userId, type) => Notification.find({ recipient: userId, type }).lean();
const mk = (token, extra = {}) =>
  api('POST', '/projects', token, { name: 'Website redesign', targetDepartment: 'Marketing', managerId: mira.emp, budget: 100000, ...extra });

// ── asking for the cost ─────────────────────────────────────────────────────
await check('a project cannot be added without an estimated cost', async () => {
  for (const body of [{ budget: undefined }, { budget: 0 }, { budget: '' }, { budget: null, costPlan: [] }]) {
    const r = await mk(boss.token, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.code, 'COST_REQUIRED');
  }
  assert.equal((await mk(boss.token, { budget: 'lots' })).body.code, 'COST_INVALID');
  assert.equal(await Project.countDocuments(), 0, 'nothing was made');
});

let first;
await check('with a cost it is made, waiting for the finance head, and cannot start yet', async () => {
  const r = await mk(boss.token, { status: 'active', estimatedValue: 500000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  first = r.body;
  assert.equal(first.costStatus, 'pending');
  assert.equal(first.status, 'planning', 'asked to be active, but held until the cost is approved');
  assert.equal(first.cost.budget, 100000);
  assert.equal(first.cost.approvedBudget, 0);
  assert.equal(first.cost.estimatedValue, 500000);
});

await check('a breakdown sets the total, whatever amount was typed beside it', async () => {
  const r = await mk(boss.token, {
    budget: 1,
    costPlan: [{ category: 'manpower', amount: 60000 }, { category: 'tools', amount: '15,500' }, { category: 'travel', amount: '' }],
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.cost.budget, 75500);
  assert.deepEqual(r.body.cost.plan.map((l) => l.category), ['manpower', 'tools']);
});

await check('the finance head is told; no admin, and not the person who asked', async () => {
  const told = await notes(fin.id, 'project_cost_request');
  assert.ok(told.length >= 1);
  assert.match(told[0].body, /₹1,00,000/);
  assert.equal(told[0].link, '/project-budgets');
  assert.equal((await notes(boss.id, 'project_cost_request')).length, 0, 'admins are only sent the month-end summary');
});

await check('the activity feed says the cost was sent', async () => {
  const r = await get(first._id, mira.token);
  assert.ok(r.body.activity.some((e) => e.text.includes('Estimated cost ₹1,00,000 sent to the finance head')));
});

// ── the finance head decides ────────────────────────────────────────────────
await check('the project cannot be started before the finance head approves its cost', async () => {
  const r = await put(first._id, mira.token, { status: 'active' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'BUDGET_NOT_APPROVED');
  assert.equal((await get(first._id, mira.token)).body.status, 'planning');
});

await check('Finance sees what is waiting; Accounts sees it too, but cannot decide; a manager cannot see it at all', async () => {
  const mine = await pending(fin.token);
  assert.equal(mine.status, 200);
  const row = mine.body.find((p) => p.id === first._id);
  assert.ok(row);
  assert.equal(row.budget, 100000);
  assert.equal(row.isChange, false);
  assert.equal(row.department, 'Marketing');
  assert.equal(row.managerName, 'mira');
  assert.equal((await pending(accounts.token)).status, 200);
  assert.equal((await decide(first._id, accounts.token, { decision: 'approve' })).status, 403);
  assert.equal((await pending(mira.token)).status, 403);
  assert.equal((await pending(member.token)).status, 403);
});

await check('only the finance head decides — not the project manager, the department head or the CEO', async () => {
  for (const who of [mira, mhead, ceo, member]) {
    assert.equal((await decide(first._id, who.token, { decision: 'approve' })).status, 403, who.name);
  }
});

await check('an approval for a different amount needs a reason; a return needs one too', async () => {
  const a = await decide(first._id, fin.token, { decision: 'approve', approvedAmount: 80000 });
  assert.equal(a.status, 400);
  assert.equal(a.body.code, 'NOTE_REQUIRED');
  assert.equal((await decide(first._id, fin.token, { decision: 'return' })).body.code, 'NOTE_REQUIRED');
  assert.equal((await decide(first._id, fin.token, { decision: 'approve', approvedAmount: 0, note: 'zero' })).body.code, 'AMOUNT_INVALID');
  assert.equal((await decide(first._id, fin.token, { decision: 'maybe' })).body.code, 'DECISION_REQUIRED');
  assert.equal((await get(first._id, mira.token)).body.costStatus, 'pending', 'nothing was decided');
});

await check('sent back: the manager is told, and revising it sends it to the finance head again', async () => {
  const r = await decide(first._id, fin.token, { decision: 'return', note: 'Split out the vendor cost' });
  assert.equal(r.status, 200);
  assert.equal(r.body.costStatus, 'returned');
  assert.equal(r.body.cost.note, 'Split out the vendor cost');
  const told = await notes(mira.id, 'project_cost_decision');
  assert.ok(told.some((t) => /sent back/i.test(t.title) && t.body.includes('Split out the vendor cost')));
  assert.equal((await put(first._id, mira.token, { status: 'active' })).status, 409, 'still cannot start');
  assert.equal((await pending(fin.token)).body.find((p) => p.id === first._id), undefined, 'it is with the manager now');

  const before = (await notes(fin.id, 'project_cost_request')).length;
  const revised = await putCost(first._id, mira.token, { costPlan: [{ category: 'vendors', amount: 40000 }, { category: 'manpower', amount: 70000 }] });
  assert.equal(revised.status, 200, JSON.stringify(revised.body));
  assert.equal(revised.body.costStatus, 'pending');
  assert.equal(revised.body.cost.budget, 110000);
  assert.equal(revised.body.cost.note, '', 'the old note is cleared');
  assert.equal((await notes(fin.id, 'project_cost_request')).length, before + 1);
});

await check('approved for a different amount, with the reason; the amount asked for is kept beside it', async () => {
  const r = await decide(first._id, fin.token, { decision: 'approve', approvedAmount: 95000, note: 'Tools are already licensed' });
  assert.equal(r.status, 200);
  assert.equal(r.body.costStatus, 'approved');
  assert.equal(r.body.cost.budget, 110000);
  assert.equal(r.body.cost.approvedBudget, 95000);
  assert.equal(r.body.cost.note, 'Tools are already licensed');
  const told = await notes(mira.id, 'project_cost_decision');
  assert.ok(told.some((t) => /approved/i.test(t.title) && t.body.includes('₹95,000')));
  assert.ok((await get(first._id, mira.token)).body.activity.some((e) => e.text === 'Cost approved: ₹95,000 (asked ₹1,10,000)'));
});

await check('a decision is taken once', async () => {
  const r = await decide(first._id, fin.token, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NOT_WAITING');
});

await check('once approved the project can start', async () => {
  assert.equal((await put(first._id, mira.token, { status: 'active' })).status, 200);
  assert.equal((await get(first._id, mira.token)).body.status, 'active');
});

// ── changing it afterwards ──────────────────────────────────────────────────
await check('after approval a change needs a reason', async () => {
  const r = await putCost(first._id, mira.token, { budget: 150000 });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'CHANGE_NEEDS_REASON');
  assert.equal((await get(first._id, mira.token)).body.cost.budget, 110000);
});

await check('a change is logged, goes back to the finance head, and the approved amount stays the limit meanwhile', async () => {
  const before = (await notes(fin.id, 'project_cost_request')).length;
  const r = await putCost(first._id, mira.token, { budget: 150000, reason: 'Scope grew: two more landing pages' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.costStatus, 'pending');
  assert.equal(r.body.cost.budget, 150000);
  assert.equal(r.body.cost.approvedBudget, 95000, 'spending is still held to what was approved');
  assert.equal(r.body.status, 'active', 'the project is not stopped while it waits');
  assert.equal(r.body.cost.changes.length, 1);
  assert.equal(r.body.cost.changes[0].reason, 'Scope grew: two more landing pages');
  assert.equal(r.body.cost.changes[0].byName, 'mira');
  assert.ok(r.body.cost.changes[0].lines.some((l) => l.startsWith('Estimated cost ₹1,10,000 → ₹1,50,000')));
  const told = await notes(fin.id, 'project_cost_request');
  assert.equal(told.length, before + 1);
  assert.match(told[told.length - 1].title, /change/i);
});

await check('Finance sees it as a CHANGE, with the reason and what moved', async () => {
  const row = (await pending(fin.token)).body.find((p) => p.id === first._id);
  assert.equal(row.isChange, true);
  assert.equal(row.approvedBudget, 95000);
  assert.equal(row.budget, 150000);
  assert.equal(row.changeReason, 'Scope grew: two more landing pages');
  assert.ok(row.changeLines.length >= 1);
});

await check('saving the same figures again changes nothing and does not bother Finance', async () => {
  const before = (await notes(fin.id, 'project_cost_request')).length;
  const r = await putCost(first._id, mira.token, { budget: 150000 });
  assert.equal(r.status, 200);
  assert.equal(r.body.cost.changes.length, 1);
  assert.equal((await notes(fin.id, 'project_cost_request')).length, before);
});

await check('approving the change moves the limit', async () => {
  const r = await decide(first._id, fin.token, { decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.body.cost.approvedBudget, 150000);
  assert.equal(r.body.costStatus, 'approved');
});

await check('a save of the project itself never changes its cost', async () => {
  const r = await put(first._id, mira.token, { budget: 1, description: 'now with copy' });
  assert.equal(r.status, 200);
  assert.equal(r.body.description, 'now with copy');
  assert.equal(r.body.cost.budget, 150000);
});

await check('who may change the cost: the manager and the owning head; not Finance, a member, the CEO', async () => {
  assert.equal((await putCost(first._id, mhead.token, { budget: 150000 })).status, 200);
  assert.equal((await putCost(first._id, boss.token, { budget: 150000 })).status, 200);
  for (const who of [fin, member, ceo, staff]) assert.equal((await putCost(first._id, who.token, { budget: 160000, reason: 'try' })).status, 403, who.name);
});

// ── who sees the money ──────────────────────────────────────────────────────
await check('those who run the project and the overseers see the amounts; a member sees only where it stands', async () => {
  await Project.updateOne({ _id: first._id }, { $push: { members: member.emp } });
  for (const who of [mira, mhead, boss, ceo]) {
    const r = await get(first._id, who.token);
    assert.equal(r.status, 200, who.name);
    assert.equal(r.body.cost.budget, 150000, who.name);
    assert.equal(r.body.access.canSeeCost, true, who.name);
  }
  const m = await get(first._id, member.token);
  assert.equal(m.status, 200);
  assert.equal(m.body.cost, null);
  assert.equal(m.body.costStatus, 'approved');
  for (const k of ['budget', 'approvedBudget', 'estimatedValue', 'costPlan', 'costChanges', 'costDecisionNote']) {
    assert.equal(m.body[k], undefined, `${k} must not leak to a member`);
  }
  assert.equal(m.body.access.canSeeCost, false);
  assert.equal(m.body.access.canEditCost, false);
});

await check('the project LIST keeps the amounts from those who may not see them, too', async () => {
  const r = await api('GET', '/projects', member.token);
  const p = r.body.find((x) => x._id === first._id);
  assert.ok(p);
  assert.equal(p.cost, null);
  assert.equal(p.budget, undefined);
  const full = (await api('GET', '/projects', mira.token)).body.find((x) => x._id === first._id);
  assert.equal(full.cost.budget, 150000);
});

await check('the access summary says who may decide', async () => {
  const r = await mk(boss.token);
  const id = r.body._id;
  assert.equal((await get(id, boss.token)).body.access.canDecideCost, true);
  assert.equal((await get(id, mira.token)).body.access.canDecideCost, false);
  await decide(id, fin.token, { decision: 'approve' });
  assert.equal((await get(id, boss.token)).body.access.canDecideCost, false, 'nothing is waiting any more');
});

// ── a proposal ──────────────────────────────────────────────────────────────
let proposal;
await check('a staff proposal carries a cost, but Finance is asked only after the department head has approved it', async () => {
  const before = (await notes(fin.id, 'project_cost_request')).length;
  const r = await api('POST', '/projects', staff.token, { name: 'Bridal expo stall', targetDepartment: 'Marketing', budget: 60000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  proposal = r.body;
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.costStatus, 'pending');
  assert.equal((await notes(fin.id, 'project_cost_request')).length, before, 'not yet');
  assert.equal((await pending(fin.token)).body.find((p) => p.id === proposal._id), undefined, 'not in Finance\'s list yet');
  const early = await decide(proposal._id, fin.token, { decision: 'approve' });
  assert.equal(early.status, 409);
  assert.equal(early.body.code, 'PROPOSAL_FIRST');
});

await check('a proposal needs a cost too', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'No cost', targetDepartment: 'Marketing' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'COST_REQUIRED');
});

await check('the department head approves the proposal — then Finance is asked, and the cost is in its list', async () => {
  const before = (await notes(fin.id, 'project_cost_request')).length;
  assert.equal((await api('POST', `/projects/${proposal._id}/approve`, mhead.token, {})).status, 200);
  assert.equal((await notes(fin.id, 'project_cost_request')).length, before + 1);
  const row = (await pending(fin.token)).body.find((p) => p.id === proposal._id);
  assert.ok(row);
  assert.equal(row.budget, 60000);
  assert.equal((await decide(proposal._id, fin.token, { decision: 'approve' })).status, 200);
});

await check('a proposal the department head turns down never reaches Finance', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'Another idea', targetDepartment: 'Marketing', budget: 5000 });
  await api('POST', `/projects/${r.body._id}/reject`, mhead.token, { note: 'not now' });
  assert.equal((await pending(fin.token)).body.find((p) => p.id === r.body._id), undefined);
  const late = await decide(r.body._id, fin.token, { decision: 'approve' });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'PROJECT_CANCELLED');
  assert.equal((await get(r.body._id, boss.token)).body.access.canDecideCost, false);
});

// ── separation of duties ────────────────────────────────────────────────────
await check('the finance head cannot sign off a cost they asked for themselves — an administrator can', async () => {
  const r = await api('POST', '/projects', fin.token, { name: 'Finance dashboard', targetDepartment: 'Finance', managerId: fin.emp, budget: 20000 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const own = await decide(r.body._id, fin.token, { decision: 'approve' });
  assert.equal(own.status, 403);
  assert.equal(own.body.code, 'OWN_REQUEST');
  assert.equal((await decide(r.body._id, boss.token, { decision: 'approve' })).status, 200);
});

// ── a project from before costs existed ─────────────────────────────────────
await check('a project with no cost keeps running; asking for one sends it to Finance without stopping it', async () => {
  const legacy = await Project.create({
    name: 'Old project', targetDepartment: 'Marketing', managerId: mira.emp, status: 'active',
    departments: [{ name: 'Marketing', role: 'owner', status: 'accepted' }],
  });
  const r = await get(legacy._id, mira.token);
  assert.equal(r.body.costStatus, 'none');
  assert.equal(r.body.cost.budget, 0);
  assert.equal((await put(legacy._id, mira.token, { priority: 'high' })).status, 200);
  assert.equal((await put(legacy._id, mira.token, { status: 'on-hold' })).status, 200);
  assert.equal((await put(legacy._id, mira.token, { status: 'active' })).status, 200, 'a legacy project is not held up');
  const asked = await putCost(legacy._id, mira.token, { budget: 40000 });
  assert.equal(asked.status, 200);
  assert.equal(asked.body.costStatus, 'pending');
  assert.equal(asked.body.status, 'active');
  assert.ok((await pending(fin.token)).body.some((p) => p.id === String(legacy._id)));
});

// ── the rest of the access rules ────────────────────────────────────────────
await check('a bad cost is refused with a reason, and the project is left alone', async () => {
  const r = await mk(boss.token);
  const id = r.body._id;
  assert.equal((await putCost(id, boss.token, { budget: 0 })).body.code, 'COST_REQUIRED');
  assert.equal((await putCost(id, boss.token, { budget: 'x' })).body.code, 'COST_INVALID');
  assert.equal((await get(id, boss.token)).body.cost.budget, 100000);
});

await check('a project that is not there is a 404, not a crash', async () => {
  const ghost = new mongoose.Types.ObjectId().toString();
  assert.equal((await putCost(ghost, boss.token, { budget: 5 })).status, 404);
  assert.equal((await decide(ghost, fin.token, { decision: 'approve' })).status, 404);
});

await check('no sign-in, no access', async () => {
  assert.equal((await api('GET', '/projects/cost/pending')).status, 401);
  assert.equal((await api('PUT', `/projects/${first._id}/cost`, undefined, { budget: 1 })).status, 401);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
