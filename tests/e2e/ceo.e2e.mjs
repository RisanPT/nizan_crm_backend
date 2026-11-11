// End-to-end check of the CEO login against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else and drops its database first):
//
//   mkdir -p /tmp/ceo-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/ceo-e2e --fork --logpath /tmp/ceo-e2e/log
//   node tests/e2e/ceo.e2e.mjs
//
// The CEO sees everything, changes nothing except the decisions it takes, never sees pay or bank details — and the home screen's
// inbox and watch list count what is really waiting.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/ceo_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Project = await imp('models/Project.js');
const Employee = await imp('models/Employee.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));

await ensureDefaultRoles();

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
for (const [path, file] of [
  ['/api/auth', 'routes/authRoutes.js'],
  ['/api/ceo', 'routes/ceoRoutes.js'],
  ['/api/projects', 'routes/projectRoutes.js'],
  ['/api/employees', 'routes/employeeRoutes.js'],
  ['/api/salaries', 'routes/salaryRoutes.js'],
  ['/api/reports', 'routes/reportRoutes.js'],
  ['/api/bookings', 'routes/bookingRoutes.js'],
  ['/api/notifications', 'routes/notificationRoutes.js'],
  ['/api/work-profit', 'routes/workProfitRoutes.js'],
  ['/api/dashboard', 'routes/dashboardRoutes.js'],
  ['/api/marketing', 'routes/marketingRoutes.js'],
  ['/api/hr-analytics', 'routes/hrAnalyticsRoutes.js'],
  ['/api/accounting', 'routes/accountingRoutes.js'],
  ['/api/admin-expenses', 'routes/adminExpenseRoutes.js'],
  ['/api/collections', 'routes/collectionRoutes.js'],
  ['/api/expenses', 'routes/expenseRoutes.js'],
]) app.use(path, await imp(file));
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

let n = 0;
const mk = async (key, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), email: user.email, role, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await mk('boss', 'admin');
const manager = await mk('mgr', 'manager');
const ceo = await mk('ceo', 'ceo');
const artist = await mk('artist', 'artist');

const daysAgo = (d) => new Date(Date.now() - d * 86_400_000);
const raw = (modelName, docs) => mongoose.model(modelName).collection.insertMany(docs.map((d) => ({ createdAt: daysAgo(0), updatedAt: new Date(), ...d })));

// ── the role ────────────────────────────────────────────────────────────────
await check('the CEO role is seeded: home /ceo, view-and-decide permissions, nothing that opens pay, bank or the backup', async () => {
  const role = await Role.findOne({ key: 'ceo' });
  assert.ok(role, 'seeded');
  assert.equal(role.homeRoute, '/ceo');
  for (const p of ['ceo', 'dashboard', 'planning.manage', 'payables.dashboard', 'company_finance.month_end', 'hr_analytics']) assert.ok(role.permissions.includes(p), p);
  for (const parent of ['staff', 'payables', 'company_finance', 'it', 'settings', 'finance', 'compensation']) assert.ok(!role.permissions.includes(parent), `must not carry the whole "${parent}" module`);
  for (const sub of ['staff.salaries', 'payables.admin_salaries', 'payables.operations_salaries', 'payables.hra', 'company_finance.bank_balance']) assert.ok(!role.permissions.includes(sub), sub);
});

await check('signing in as the CEO lands on /ceo with those permissions', async () => {
  const r = await api('POST', '/auth/login', null, { email: ceo.email, password: 'secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.homeRoute ?? r.body.user?.homeRoute, '/ceo');
  const perms = r.body.permissions ?? r.body.user?.permissions ?? [];
  assert.ok(perms.includes('ceo'));
});

await check('a manager cannot create the CEO account, and cannot make anyone CEO; an administrator can', async () => {
  const body = (email) => ({ name: 'New', email, password: 'secret123', role: 'ceo' });
  assert.equal((await api('POST', '/auth/users', manager.token, body('m@e2e.test'))).status, 403);
  assert.equal((await api('PUT', `/auth/users/${artist.id}`, manager.token, { role: 'ceo' })).status, 403);
  assert.equal((await api('PUT', `/auth/users/${ceo.id}`, manager.token, { active: false })).status, 403);
  assert.equal((await api('POST', '/auth/users', admin.token, body('a@e2e.test'))).status, 201);
  assert.equal((await User.findById(ceo.id)).active, true);
});

// ── view-only ───────────────────────────────────────────────────────────────
await check('the CEO cannot change anything: bookings, projects, targets, users, tasks (403 CEO_READ_ONLY)', async () => {
  for (const [m, p] of [
    ['POST', '/bookings'],
    ['PUT', '/bookings/507f1f77bcf86cd799439011'],
    ['DELETE', '/bookings/507f1f77bcf86cd799439011'],
    ['POST', '/projects'],
    ['DELETE', '/projects/507f1f77bcf86cd799439011'],
    ['POST', '/projects/507f1f77bcf86cd799439011/departments/IT/respond'],
    ['PUT', '/reports/targets'],
    ['PUT', '/auth/users/507f1f77bcf86cd799439011'],
  ]) {
    const r = await api(m, p, ceo.token, {});
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.equal(r.body.code, 'CEO_READ_ONLY', `${m} ${p}`);
  }
});

await check('pay and bank routes are closed to the CEO even to read', async () => {
  const r = await api('GET', '/salaries', ceo.token);
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'CEO_NO_ACCESS');
  assert.equal((await api('GET', '/salaries', admin.token)).status, 200); // an admin still can
});

await check('the people list reaches the CEO without pay and bank fields (and still reaches an admin with them)', async () => {
  await Employee.collection.insertOne({ name: 'Amna', email: 'amna@e2e.test', baseSalary: 45000, allowances: 3000, accountNumber: '9988', panNumber: 'ABCDE1234F', createdAt: new Date() });
  const forCeo = await api('GET', '/employees', ceo.token);
  assert.equal(forCeo.status, 200);
  const rows = Array.isArray(forCeo.body) ? forCeo.body : forCeo.body.items ?? forCeo.body.employees ?? [];
  const amna = rows.find((e) => e.name === 'Amna');
  assert.ok(amna, 'the person is listed');
  for (const f of ['baseSalary', 'allowances', 'accountNumber', 'panNumber']) assert.equal(f in amna, false, `${f} must be stripped`);
  const forAdmin = await api('GET', '/employees', admin.token);
  const adminRows = Array.isArray(forAdmin.body) ? forAdmin.body : forAdmin.body.items ?? forAdmin.body.employees ?? [];
  assert.equal(adminRows.find((e) => e.name === 'Amna')?.baseSalary, 45000);
});

// ── what the CEO can read ───────────────────────────────────────────────────
await check('the reports a CEO reads answer 200: month-end review, targets, work profit, marketing insights, HR snapshot, dashboards', async () => {
  const now = new Date();
  for (const p of [
    `/reports/month-end?month=${now.getMonth() + 1}&year=${now.getFullYear()}`,
    `/reports/targets?month=${now.getMonth() + 1}&year=${now.getFullYear()}`,
    '/work-profit',
    '/marketing/insights',
    '/hr-analytics/summary',
    '/dashboard/sales',
    '/dashboard/finance',
    '/accounting/dashboard-summary',
  ]) {
    const r = await api('GET', p, ceo.token);
    assert.equal(r.status, 200, `${p} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
});

await check('the screens that are the CEO\'s are not an anyone\'s: an artist gets 403 from the CEO endpoints', async () => {
  assert.equal((await api('GET', '/ceo/inbox', artist.token)).status, 403);
  assert.equal((await api('GET', '/ceo/signals', artist.token)).status, 403);
  assert.equal((await api('GET', '/ceo/inbox', null)).status, 401);
});

// ── the inbox counts what is really waiting ─────────────────────────────────
const managerId = new mongoose.Types.ObjectId();
const proposed = await Project.create({ name: 'Open a Bangalore studio', managerId, targetDepartment: 'Management', status: 'proposed', departments: [{ name: 'Management', role: 'owner', status: 'accepted' }] });
await Project.create({ name: 'Second proposal', managerId, targetDepartment: 'Management', status: 'proposed', departments: [{ name: 'Management', role: 'owner', status: 'accepted' }] });
await raw('CeoDecision', [{ month: 11, year: 2026, type: 'capex', title: 'Buy a second van', amount: 800000, status: 'pending' }, { month: 11, year: 2026, type: 'hiring', title: 'Hire a trainer', amount: 0, status: 'done' }]);
await raw('AdminExpense', [{ status: 'pending', amount: 500, createdAt: daysAgo(6) }, { status: 'pending', amount: 700, createdAt: daysAgo(2) }, { status: 'approved', amount: 999 }]);
await raw('Collection', [{ status: 'pending', amount: 2500, createdAt: daysAgo(1) }, { status: 'verified', amount: 100 }]);
await raw('ApprovalRequest', [{ status: 'pending', createdAt: daysAgo(9) }, { status: 'pending', createdAt: daysAgo(3) }, { status: 'approved' }]);
await raw('Lead', [{ status: 'Pending Lost Approval', createdAt: daysAgo(4) }, { status: 'New' }]);

await check('/ceo/inbox: the CEO\'s own decisions first, then what is stuck with the team — counts, ₹ and how long', async () => {
  const r = await api('GET', '/ceo/inbox', ceo.token);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const by = Object.fromEntries(r.body.items.map((i) => [i.key, i]));
  assert.equal(by.project_proposals.count, 2);
  assert.equal(by.ceo_decisions.count, 1); // the one marked done is not open
  assert.equal(by.ceo_decisions.amount, 800000);
  assert.equal(by.admin_expenses.count, 2); // the approved one is not waiting
  assert.equal(by.admin_expenses.amount, 1200);
  assert.equal(by.admin_expenses.oldestDays, 6);
  assert.equal(by.admin_expenses.withWhom, 'Accounts');
  assert.equal(by.collections.count, 1);
  assert.equal(by.hr_approvals.count, 2);
  assert.equal(by.hr_approvals.oldestDays, 9);
  assert.equal(by.lost_leads.count, 1);
  assert.equal(r.body.needsYou, 3);
  assert.equal(r.body.withTeam, 2 + 1 + 2 + 1);
  assert.equal(r.body.oldestTeamDays, 9);
  assert.deepEqual(r.body.items.slice(0, 2).map((i) => i.owner), ['you', 'you']);
  assert.equal(by.hr_approvals.route, null); // a screen the CEO cannot open is not linked
});

await check('an administrator and a manager can open it too', async () => {
  assert.equal((await api('GET', '/ceo/inbox', admin.token)).status, 200);
  assert.equal((await api('GET', '/ceo/inbox', manager.token)).status, 200);
});

// ── the watch list ──────────────────────────────────────────────────────────
await Project.collection.insertOne({ name: 'Late one', status: 'active', targetDepartment: 'IT', endDate: daysAgo(10), createdAt: new Date() });
await raw('OKR', [{ title: 'Grow', status: 'blocked' }, { title: 'Fine', status: 'in-progress' }]);
await raw('InventoryProduct', [{ name: 'Foundation', quantity: 1, lowStockThreshold: 2 }, { name: 'Brushes', quantity: 50, lowStockThreshold: 2 }]);
await raw('Booking', [{ status: 'Cancelled', bookingDate: new Date() }, { status: 'cancelled', bookingDate: new Date() }, { status: 'confirmed', bookingDate: new Date() }]);
await raw('Review', [[10, 3], [9, 5], [3, 8], [7, 40], [2, 45]].map(([nps, d], i) => ({ token: `tok-${i}`, nps, submittedAt: daysAgo(d) })));

await check('/ceo/signals: what is overdue, blocked, low, cancelled, and how clients feel', async () => {
  const r = await api('GET', '/ceo/signals', ceo.token);
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  const by = Object.fromEntries(r.body.map((s) => [s.key, s]));
  assert.equal(by.overdue_projects.value, 1);
  assert.equal(by.blocked_okrs.value, 1);
  assert.equal(by.low_stock.value, 1);
  assert.equal(by.cancellations.value, 2); // 'Cancelled' and 'cancelled' both count
  assert.equal(by.nps.value, 33); // 2 promoters − 1 detractor of 3
  assert.equal(by.nps.previous, -50); // 40–45 days ago: 7 (passive) and 2 (detractor) → (0 − 1) / 2
  assert.ok(['watch', 'alert', 'ok'].includes(by.nps.severity));
});

// ── deciding ────────────────────────────────────────────────────────────────
await check('the CEO sees every project as view-only, with the proposal waiting for a decision', async () => {
  const r = await api('GET', '/projects', ceo.token);
  assert.equal(r.status, 200);
  const items = Array.isArray(r.body) ? r.body : r.body.items ?? r.body.projects ?? [];
  const p = items.find((x) => String(x._id ?? x.id) === String(proposed._id));
  assert.ok(p, 'sees the proposal');
  assert.equal(p.access.canDecide, true);
  assert.equal(p.access.canManage, false);
  assert.equal(p.access.canCreateTasks, false);
  assert.equal(p.access.canEditAllTasks, false);
});

await check('the CEO approves a proposal (200) — and that is the one project write they have', async () => {
  const r = await api('POST', `/projects/${proposed._id}/approve`, ceo.token, { note: 'Go ahead' });
  assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.equal((await Project.findById(proposed._id)).status, 'planning');
  assert.equal((await api('GET', '/ceo/inbox', ceo.token)).body.items.find((i) => i.key === 'project_proposals').count, 1);
});

await check('the CEO rejects the other one', async () => {
  const other = await Project.findOne({ name: 'Second proposal' });
  const r = await api('POST', `/projects/${other._id}/reject`, ceo.token, { note: 'Not this year' });
  assert.equal(r.status, 200);
  assert.equal((await Project.findById(other._id)).status, 'cancelled');
});

await check('the CEO keeps the decisions log: add, mark done, delete', async () => {
  const made = await api('POST', '/reports/decisions', ceo.token, { title: 'Approve the Calicut lease', type: 'capex', amount: 1500000 });
  assert.equal(made.status, 201, JSON.stringify(made.body).slice(0, 160));
  const id = made.body._id;
  assert.equal((await api('PUT', `/reports/decisions/${id}`, ceo.token, { status: 'approved' })).status, 200);
  assert.equal((await api('DELETE', `/reports/decisions/${id}`, ceo.token)).status, 200);
});

await check('…but the approvals that belong to Accounts stay with Accounts: the CEO cannot verify an expense, a collection or an artist expense', async () => {
  const id = '507f1f77bcf86cd799439011';
  for (const p of [`/admin-expenses/${id}/verify`, `/collections/${id}/verify`, `/expenses/${id}/verify`]) {
    const r = await api('PUT', p, ceo.token, { status: 'approved' });
    assert.equal(r.status, 403, p);
    assert.equal(r.body.code, 'CEO_READ_ONLY', p);
  }
});

// ── notifications ───────────────────────────────────────────────────────────
await check('the CEO gets one daily digest; an admin does not', async () => {
  // re-seed something waiting (the inbox above was partly cleared by deciding)
  await raw('HiringPlan', [{ status: 'raised', createdAt: daysAgo(5) }]);
  const first = await api('GET', '/notifications', ceo.token);
  assert.equal(first.status, 200);
  const digests = (first.body.items ?? first.body.notifications ?? []).filter((x) => x.type === 'ceo_digest');
  assert.equal(digests.length, 1, JSON.stringify(first.body).slice(0, 300));
  assert.match(digests[0].body, /need your decision|waiting with the team/);
  assert.equal(digests[0].link, '/ceo');
  const again = await api('GET', '/notifications', ceo.token);
  assert.equal((again.body.items ?? again.body.notifications ?? []).filter((x) => x.type === 'ceo_digest').length, 1, 'not repeated');
  const adminSees = await api('GET', '/notifications', admin.token);
  assert.equal((adminSees.body.items ?? adminSees.body.notifications ?? []).filter((x) => x.type === 'ceo_digest').length, 0);
});

await check('the CEO can clear their own notifications', async () => {
  assert.equal((await api('PATCH', '/notifications/read-all', ceo.token)).status, 200);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log('FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
