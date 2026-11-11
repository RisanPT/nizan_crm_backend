// End-to-end check of SPENDING on a project: expenses are charged to a project whose cost the finance head approved,
// approved ones count as spent and pending ones as committed, going past the approved budget needs the finance head (with a
// reason), the people running the project are warned at 80% and told when it goes over, and only those who may see money see it.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else, and drops
// its database first):
//
//   mkdir -p /tmp/spend-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/spend-e2e --fork --logpath /tmp/spend-e2e/log
//   node tests/e2e/project-spend.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/project_spend_e2e');
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
const AdminExpense = await imp('models/AdminExpense.js');
const Notification = await imp('models/Notification.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/projects', await imp('routes/projectRoutes.js'));
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
const acc = await person('acc', 'accounts', { dept: 'Accounts' });
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // the project manager
const mhead = await person('mhead', 'crm', { dept: 'Marketing', head: true }); // head of the owning department
const member = await person('member', 'crm', { dept: 'Marketing' }); // on the project
const outsider = await person('outsider', 'crm', { dept: 'Sales', head: true }); // not on it
await Department.create({ key: 'marketing', name: 'Marketing', head: mhead.emp });
await Department.create({ key: 'finance', name: 'Finance', head: fin.emp });
await Department.create({ key: 'sales', name: 'Sales', head: outsider.emp });
await Department.create({ key: 'accounts', name: 'Accounts', head: null });
const deptId = async (key) => (await Department.findOne({ key }))._id;
await User.updateOne({ _id: mhead.id }, { departmentId: await deptId('marketing') });
await User.updateOne({ _id: fin.id }, { departmentId: await deptId('finance') });
await User.updateOne({ _id: outsider.id }, { departmentId: await deptId('sales') });

const notes = (userId, type) => Notification.find({ recipient: userId, type }).lean();
const get = (id, token) => api('GET', `/projects/${id}`, token);
const spend = (id, token) => api('GET', `/projects/${id}/spend`, token);
const charge = (token, body) => api('POST', '/admin-expenses', token, { title: 'Stock photos', category: 'other', paymentMethod: 'bank_transfer', date: '2026-11-05', ...body });
const verify = (id, token, body) => api('PUT', `/admin-expenses/${id}/verify`, token, body);

// a project whose cost the finance head has approved: ₹1,00,000
const mkProject = async (name, { approve = true, limit = 100000, extra = {} } = {}) => {
  const r = await api('POST', '/projects', boss.token, { name, targetDepartment: 'Marketing', managerId: mira.emp, budget: limit, ...extra });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (approve) {
    const d = await api('POST', `/projects/${r.body._id}/cost/decision`, fin.token, { decision: 'approve' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    await Project.updateOne({ _id: r.body._id }, { $push: { members: member.emp }, status: 'active' });
  }
  return r.body._id;
};

const pid = await mkProject('Website redesign');

// ── charging an expense to a project ────────────────────────────────────────
await check('nothing can be charged to a project before Finance approves its cost', async () => {
  const waiting = await mkProject('Waiting project', { approve: false });
  const r = await charge(mhead.token, { amount: 1000, projectId: waiting });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'PROJECT_NOT_APPROVED');
  assert.equal(await AdminExpense.countDocuments({ projectId: waiting }), 0);
});

await check('a department head files an expense for the project: pending, and counted as committed', async () => {
  const r = await charge(mhead.token, { amount: 20000, projectId: pid, expenseHead: '' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.projectName, 'Website redesign');
  assert.equal(r.body.warning, undefined);
  const p = await get(pid, mira.token);
  assert.equal(p.body.cost.committed, 20000);
  assert.equal(p.body.cost.spent, 0);
});

await check('Accounts approves it: now it is spent, no longer committed', async () => {
  const id = (await AdminExpense.findOne({ projectId: pid }))._id;
  assert.equal((await verify(id, acc.token, { status: 'approved' })).status, 200);
  const p = await get(pid, mira.token);
  assert.equal(p.body.cost.spent, 20000);
  assert.equal(p.body.cost.committed, 0);
});

await check('what Accounts files directly is approved at once and counts as spent', async () => {
  const r = await charge(acc.token, { amount: 10000, projectId: pid, department: 'Marketing' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'approved');
  assert.equal((await get(pid, mira.token)).body.cost.spent, 30000);
});

await check('a rejected expense is not a cost', async () => {
  const r = await charge(mhead.token, { amount: 5000, projectId: pid });
  await verify(r.body._id, acc.token, { status: 'rejected' });
  const p = await get(pid, mira.token);
  assert.equal(p.body.cost.spent, 30000);
  assert.equal(p.body.cost.committed, 0);
});

await check('someone who is not on the project cannot charge to it; Accounts and administrators can charge any', async () => {
  const r = await charge(outsider.token, { amount: 100, projectId: pid });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'PROJECT_FORBIDDEN');
  assert.equal((await charge(boss.token, { amount: 100, projectId: pid, department: 'Marketing' })).status, 201);
  await AdminExpense.deleteMany({ title: 'Stock photos', amount: 100 });
});

await check('a project that is not there, or a bad id, is refused plainly', async () => {
  assert.equal((await charge(mhead.token, { amount: 5, projectId: new mongoose.Types.ObjectId().toString() })).body.code, 'PROJECT_NOT_FOUND');
  assert.equal((await charge(mhead.token, { amount: 5, projectId: 'nope' })).body.code, 'PROJECT_INVALID');
});

await check('a proposal or a cancelled project takes no expenses', async () => {
  const r = await api('POST', '/projects', member.token, { name: 'Just an idea', targetDepartment: 'Marketing', budget: 5000 });
  assert.equal(r.body.status, 'proposed');
  await Project.updateOne({ _id: r.body._id }, { approvedBudget: 5000 }); // even with a limit
  assert.equal((await charge(acc.token, { amount: 5, projectId: r.body._id, department: 'Marketing' })).body.code, 'PROJECT_CLOSED');
});

await check('an expense without a project is untouched by any of this', async () => {
  const r = await charge(acc.token, { amount: 777, department: 'Accounts' });
  assert.equal(r.status, 201);
  assert.equal(r.body.projectId, null);
  assert.equal((await get(pid, mira.token)).body.cost.spent, 30000);
});

// ── who sees the money ──────────────────────────────────────────────────────
await check('the project page: the manager, the owning head and the administrator see what was spent; a member does not', async () => {
  for (const who of [mira, mhead, boss]) assert.equal((await get(pid, who.token)).body.cost.spent, 30000, who.name);
  const m = await get(pid, member.token);
  assert.equal(m.status, 200);
  assert.equal(m.body.cost, null);
  assert.equal(JSON.stringify(m.body).includes('"spent"'), false, 'nothing of it leaks');
});

await check('the project list carries the spending too — for those who may see it', async () => {
  const mine = (await api('GET', '/projects', mira.token)).body.find((p) => p._id === pid);
  assert.equal(mine.cost.spent, 30000);
  const theirs = (await api('GET', '/projects', member.token)).body.find((p) => p._id === pid);
  assert.equal(theirs.cost, null);
});

await check('/spend: the summary, where it went, and the latest expenses', async () => {
  const r = await spend(pid, mira.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.limit, 100000);
  assert.equal(r.body.spent, 30000);
  assert.equal(r.body.available, 70000);
  assert.equal(r.body.usedPercent, 30);
  assert.equal(r.body.level, 'ok');
  assert.ok(Array.isArray(r.body.byDepartment));
  assert.ok(r.body.expenses.length >= 3);
  assert.ok(r.body.expenses.every((e) => e.id && typeof e.amount === 'number' && e.status));
  assert.ok(r.body.expenses.some((e) => e.status === 'rejected'), 'the list shows everything, the totals only what counts');
});

await check('/spend: Finance and the owning head may look; a member and an outsider may not', async () => {
  assert.equal((await spend(pid, fin.token)).status, 200);
  assert.equal((await spend(pid, mhead.token)).status, 200);
  assert.equal((await spend(pid, member.token)).status, 403);
  assert.equal((await spend(pid, outsider.token)).status, 403);
  assert.equal((await api('GET', `/projects/${pid}/spend`)).status, 401);
});

// ── the projects an expense can be charged to ───────────────────────────────
await check('/chargeable: Accounts sees every approved project, with the amounts; the unapproved is not offered', async () => {
  const r = await api('GET', '/projects/chargeable', acc.token);
  assert.equal(r.status, 200);
  const row = r.body.find((p) => p.id === pid);
  assert.equal(row.limit, 100000);
  assert.equal(row.used, 30000);
  assert.equal(row.available, 70000);
  assert.equal(row.level, 'ok');
  assert.equal(r.body.some((p) => p.name === 'Waiting project' || p.name === 'Just an idea'), false);
});

await check('/chargeable: a member sees their project without the amounts; an outsider does not see it at all', async () => {
  const m = (await api('GET', '/projects/chargeable', member.token)).body.find((p) => p.id === pid);
  assert.ok(m);
  assert.equal(m.limit, undefined);
  assert.equal(m.level, 'ok');
  assert.equal((await api('GET', '/projects/chargeable', outsider.token)).body.some((p) => p.id === pid), false);
  assert.equal((await api('GET', '/projects/chargeable', mira.token)).body.find((p) => p.id === pid).limit, 100000, 'the manager sees the amounts');
});

// ── warnings, and going over ────────────────────────────────────────────────
await check('reaching 80%: the people running the project and Finance are told, once', async () => {
  const before = (await notes(mira.id, 'project_budget_alert')).length;
  const r = await charge(acc.token, { amount: 50000, projectId: pid, department: 'Marketing' }); // 30,000 + 50,000 = 80%
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const toMira = await notes(mira.id, 'project_budget_alert');
  assert.equal(toMira.length, before + 1);
  assert.match(toMira[toMira.length - 1].title, /80% of the budget is used/);
  assert.equal((await notes(mhead.id, 'project_budget_alert')).length, 1, 'the owning head too');
  assert.equal((await notes(fin.id, 'project_budget_alert')).length, 1);
  assert.equal((await notes(boss.id, 'project_budget_alert')).length, 0, 'admins get only the month-end summary');
  assert.equal((await spend(pid, mira.token)).body.level, 'warn');
  // more spending at the same level says nothing new
  await charge(acc.token, { amount: 1000, projectId: pid, department: 'Marketing' });
  assert.equal((await notes(mira.id, 'project_budget_alert')).length, before + 1);
});

let over;
await check('a department expense that takes the project over its budget is filed, pending, with the warning', async () => {
  const r = await charge(mhead.token, { amount: 30000, projectId: pid }); // 81,000 + 30,000 = 1,11,000 of 1,00,000
  assert.equal(r.status, 201, JSON.stringify(r.body));
  over = r.body;
  assert.equal(r.body.status, 'pending');
  assert.equal(r.body.warning.code, 'OVER_BUDGET');
  assert.equal(r.body.warning.after, 111000);
  assert.equal(r.body.warning.limit, 100000);
  const told = await notes(fin.id, 'expense_recorded');
  assert.ok(told.some((t) => /over a project's budget/i.test(t.title) && t.body.includes('Website redesign')));
});

await check('going over tells the project\'s people, and Finance', async () => {
  const toMira = await notes(mira.id, 'project_budget_alert');
  assert.ok(toMira.some((t) => /^Over budget: Website redesign/.test(t.title)), 'a pending expense counts as committed: the project is over');
  assert.equal((await spend(pid, mira.token)).body.level, 'over');
});

await check('Accounts cannot approve an expense that goes over the budget — only the finance head', async () => {
  const r = await verify(over._id, acc.token, { status: 'approved' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OVER_BUDGET');
  assert.match(r.body.message, /Only the finance head can approve/);
  assert.equal((await AdminExpense.findById(over._id)).status, 'pending');
});

await check('the finance head needs to say why', async () => {
  const r = await verify(over._id, fin.token, { status: 'approved' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OVER_BUDGET_REASON');
});

await check('approved over the budget, with the reason on the expense', async () => {
  const r = await verify(over._id, fin.token, { status: 'approved', overBudgetReason: 'Launch deadline moved up' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'approved');
  assert.equal(r.body.overBudgetReason, 'Launch deadline moved up');
  const p = (await spend(pid, mira.token)).body;
  assert.equal(p.spent, 111000);
  assert.equal(p.available, -11000);
  assert.equal(p.level, 'over');
});

await check('Accounts cannot file an expense that is over the budget directly; the finance head can, with a reason', async () => {
  const a = await charge(acc.token, { amount: 100, projectId: pid, department: 'Marketing' });
  assert.equal(a.status, 409);
  assert.equal(a.body.code, 'OVER_BUDGET');
  const noReason = await charge(fin.token, { amount: 100, projectId: pid, department: 'Marketing' });
  assert.equal(noReason.body.code, 'OVER_BUDGET_REASON');
  const ok = await charge(fin.token, { amount: 100, projectId: pid, department: 'Marketing', overBudgetReason: 'Domain renewal' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.overBudgetReason, 'Domain renewal');
});

await check('a rejected over-budget expense can be rejected by Accounts (nothing is blocked from being turned down)', async () => {
  const r = await charge(mhead.token, { amount: 999, projectId: pid });
  assert.equal(r.status, 201);
  assert.equal((await verify(r.body._id, acc.token, { status: 'rejected' })).status, 200);
});

await check('a larger budget approved by Finance brings the project back within it, and re-arms the warning', async () => {
  const before = (await notes(mira.id, 'project_budget_alert')).length;
  assert.equal((await api('PUT', `/projects/${pid}/cost`, mira.token, { budget: 200000, reason: 'Scope grew' })).status, 200);
  assert.equal((await spend(pid, mira.token)).body.limit, 100000, 'until Finance approves, the old limit stands');
  assert.equal((await api('POST', `/projects/${pid}/cost/decision`, fin.token, { decision: 'approve' })).status, 200);
  const s = (await spend(pid, mira.token)).body;
  assert.equal(s.limit, 200000);
  assert.equal(s.level, 'ok');
  assert.equal((await Project.findById(pid)).costAlertLevel, 'ok');
  assert.equal((await notes(mira.id, 'project_budget_alert')).length, before, 'coming back down is silent');
  // spending up to 80% of the new limit warns again
  assert.equal((await charge(acc.token, { amount: 50000, projectId: pid, department: 'Marketing' })).status, 201); // 1,61,100 of 2,00,000
  assert.equal((await notes(mira.id, 'project_budget_alert')).length, before + 1);
});

// ── changing and removing expenses ──────────────────────────────────────────
const second = await mkProject('Brand refresh', { limit: 50000 });

await check('moving an expense to another project moves the spending with it', async () => {
  const e = await charge(acc.token, { amount: 4000, projectId: pid, department: 'Marketing' });
  const before = (await spend(pid, mira.token)).body.spent;
  const moved = await api('PUT', `/admin-expenses/${e.body._id}`, acc.token, { projectId: second });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.projectName, 'Brand refresh');
  assert.equal((await spend(pid, mira.token)).body.spent, before - 4000);
  assert.equal((await spend(second, mira.token)).body.spent, 4000);
});

await check('taking an expense off its project', async () => {
  const e = await AdminExpense.findOne({ projectId: second });
  const r = await api('PUT', `/admin-expenses/${e._id}`, acc.token, { projectId: null });
  assert.equal(r.status, 200);
  assert.equal(r.body.projectId, null);
  assert.equal(r.body.projectName, '');
  assert.equal((await spend(second, mira.token)).body.spent, 0);
});

await check('raising an approved expense\'s amount past the limit needs the finance head', async () => {
  const e = await charge(acc.token, { amount: 40000, projectId: second, department: 'Marketing' }); // 40,000 of 50,000
  const up = await api('PUT', `/admin-expenses/${e.body._id}`, acc.token, { amount: 60000 });
  assert.equal(up.status, 409);
  assert.equal(up.body.code, 'OVER_BUDGET');
  assert.equal((await AdminExpense.findById(e.body._id)).amount, 40000, 'unchanged');
  const ok = await api('PUT', `/admin-expenses/${e.body._id}`, fin.token, { amount: 60000, overBudgetReason: 'Quote went up' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

await check('editing an expense\'s title does not re-check the budget', async () => {
  const e = await AdminExpense.findOne({ projectId: second, amount: 60000 });
  const r = await api('PUT', `/admin-expenses/${e._id}`, acc.token, { title: 'Renamed' });
  assert.equal(r.status, 200);
});

await check('deleting an expense gives the budget back', async () => {
  const e = await AdminExpense.findOne({ projectId: second, amount: 60000 });
  assert.equal((await api('DELETE', `/admin-expenses/${e._id}`, acc.token)).status, 200);
  assert.equal((await spend(second, mira.token)).body.spent, 0);
});

await check('a department head can move only their own pending expense, and not onto a project they are not on', async () => {
  const e = await charge(mhead.token, { amount: 500, projectId: pid });
  assert.equal(e.status, 201);
  const out = await api('PUT', `/admin-expenses/${e.body._id}`, mhead.token, { projectId: second });
  assert.equal(out.status, 200, 'the owning head is on both projects it owns');
  const sales = await api('PUT', `/admin-expenses/${e.body._id}`, outsider.token, { projectId: pid });
  assert.ok([400, 403].includes(sales.status), String(sales.status));
});

await check('the finance head cannot be charged through a project that was deleted: the expense keeps its name and can still be decided', async () => {
  const doomed = await mkProject('Doomed project', { limit: 30000 });
  const e = await charge(mhead.token, { amount: 1000, projectId: doomed });
  await Project.deleteOne({ _id: doomed });
  const r = await verify(e.body._id, acc.token, { status: 'approved' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.projectName, 'Doomed project');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
