// End-to-end check that the CEO and the Executive Director never see anybody's pay — against a THROWAWAY local MongoDB (needs a mongod
// on 127.0.0.1:27099; refuses to run against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/leadership-leaks.e2e.mjs
//
// The method: plant values that cannot occur by chance (a salary of 73719.37, a bank called ZZ-SENTINEL-BANK, an account number…)
// in every place pay is kept — the employee record, raise history, a paid payslip, the audit log, ledger vouchers, a settlement, a
// job offer — then GET every URL that could carry them as the CEO and as the Executive Director and fail if a SENTINEL turns up in
// any response body, whatever its status. The same URLs as an administrator DO contain them (the control: it proves the test could fail).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/leadership_leaks_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Notification = await imp('models/Notification.js');
const AuditLog = await imp('models/AuditLog.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
for (const [path, file] of [
  ['/api/auth', 'routes/authRoutes.js'],
  ['/api/roles', 'routes/roleRoutes.js'],
  ['/api/ceo', 'routes/ceoRoutes.js'],
  ['/api/employees', 'routes/employeeRoutes.js'],
  ['/api/salaries', 'routes/salaryRoutes.js'],
  ['/api/audit', 'routes/auditRoutes.js'],
  ['/api/accounting', 'routes/accountingRoutes.js'],
  ['/api/admin-expenses', 'routes/adminExpenseRoutes.js'],
  ['/api/offboarding', 'routes/offboardingRoutes.js'],
  ['/api/recruitment', 'routes/recruitmentRoutes.js'],
  ['/api/reports', 'routes/reportRoutes.js'],
  ['/api/dashboard', 'routes/dashboardRoutes.js'],
  ['/api/notifications', 'routes/notificationRoutes.js'],
  ['/api/hr-analytics', 'routes/hrAnalyticsRoutes.js'],
  ['/api/projects', 'routes/projectRoutes.js'],
  ['/api/monthly-objectives', 'routes/monthlyObjectiveRoutes.js'],
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
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
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

let n = 0;
const mk = async (key, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), email: user.email, role, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await mk('boss', 'admin');
const manager = await mk('mgr', 'manager');
const salesHead = await mk('saleshead', 'sales', { isDepartmentHead: true });
const accounts = await mk('acc', 'accounts');
const ceo = await mk('ceo', 'ceo');
const ed = await mk('ed', 'executive_director');
const LEADERS = [ceo, ed];

// ── the planted values ──────────────────────────────────────────────────────
const SENTINELS = ['73719.37', '73719', '48211.55', 'ZZ-SENTINEL-BANK', '99887766554433', 'ZZPANSENT9X', '7.7777'];
const raw = (modelName) => mongoose.model(modelName).collection;
const empId = new mongoose.Types.ObjectId();
await raw('Employee').insertOne({
  _id: empId, name: 'Zed Sentinel', email: 'zed@e2e.test', department: 'Sales', role: 'Sales Executive', status: 'active', category: 'administrative',
  baseSalary: 73719.37, allowances: 48211.55, deductions: 0, hra: 5000, bankName: 'ZZ-SENTINEL-BANK', accountNumber: '99887766554433', ifscCode: 'ZZBK0000001',
  panNumber: 'ZZPANSENT9X', overtimeRate: 7.7777, dateOfBirth: new Date('1990-01-01'), emergencyContact: 'Mum 9999', createdAt: new Date(),
});
await raw('SalaryIncrement').insertOne({ employeeId: empId, previousSalary: 73719.37, newSalary: 48211.55, reason: 'annual', effectiveDate: new Date(), createdAt: new Date() });
await raw('Salary').insertOne({
  employeeId: empId, employeeName: 'Zed Sentinel', month: 11, year: 2026, department: 'Sales', baseSalary: 73719.37, netAmount: 48211.55,
  status: 'paid', paymentDate: new Date(), createdAt: new Date(),
});
// a second person on payroll, in the same department, so no company or department TOTAL can equal one person's pay by accident
// (totals are what leaders are meant to see; a single-person payroll would make the total BE that person's salary)
await raw('Salary').insertOne({
  employeeId: new mongoose.Types.ObjectId(), employeeName: 'Other Staff', month: 11, year: 2026, department: 'Sales', baseSalary: 10000.1, netAmount: 10000.1,
  status: 'paid', paymentDate: new Date(), createdAt: new Date(),
});
await raw('AuditLog').insertOne({
  entity: 'Salary', entityId: empId, employeeId: empId, action: 'update', by: new mongoose.Types.ObjectId(), byName: 'HR',
  changes: [{ field: 'baseSalary', from: 73719.37, to: 48211.55 }], at: new Date(), note: '',
});
await raw('JournalEntry').insertMany([
  { voucherNo: 'JV-ZZ1', type: 'journal', date: new Date(), narration: 'Salary · Zed Sentinel', lines: [{ account: new mongoose.Types.ObjectId(), debit: 48211.55, credit: 0, narration: 'Salary · Zed Sentinel' }], createdAt: new Date() },
  { voucherNo: 'JV-ZZ2', type: 'journal', date: new Date(), narration: 'HRA · Zed Sentinel', lines: [{ account: new mongoose.Types.ObjectId(), debit: 5000, credit: 0, narration: 'HRA · Zed Sentinel' }], createdAt: new Date() },
]);
// something for the rest of the checks to find: a department with an expense, a project, a department for the monthly objectives
await raw('AdminExpense').insertOne({ title: 'ZZ Rent for Sales', department: 'Sales', category: 'other', amount: 9000, date: new Date(), status: 'approved', createdAt: new Date() });
await raw('Project').insertOne({
  name: 'ZZ Project', status: 'planning', targetDepartment: 'Management', departments: [{ name: 'Management', role: 'owner', status: 'accepted' }], members: [],
  editMode: 'open', createdAt: new Date(),
});
await raw('Department').insertOne({ key: 'it', name: 'IT', division: 'administrative', active: true, createdAt: new Date() });
await raw('Offboarding').insertOne({ employeeId: empId, reason: 'resignation', status: 'in_progress', settlementPaid: false, checklist: [], createdAt: new Date() });
await raw('Offer').insertOne({ candidateId: new mongoose.Types.ObjectId(), designation: 'Designer', salary: 73719.37, basicSalary: 48211.55, status: 'sent', createdAt: new Date() });

const empUrl = `/employees/${empId}`;
const URLS = [
  '/employees', empUrl, `${empUrl}/increments`, `${empUrl}/reporting`,
  '/audit', `/audit?employeeId=${empId}`, `/audit?entity=Salary`,
  '/salaries', `/salaries?month=11&year=2026`,
  '/admin-expenses', '/admin-expenses/stats',
  '/accounting/journal', '/accounting/ledger/123', '/accounting/dashboard-summary', '/accounting/profit-loss', '/accounting/trial-balance',
  '/offboarding', '/offboarding/123/settlement',
  '/recruitment/offers', '/recruitment/plans',
  '/reports/month-end?month=11&year=2026', '/dashboard/finance', '/hr-analytics/summary',
  '/ceo/inbox', '/ceo/signals', '/auth/users',
];
const hasSentinel = (text) => SENTINELS.find((s) => text.includes(s)) || (/(Salary|HRA)\s*[·\-–]\s*Zed/i.test(text) ? 'a "Salary · <name>" narration' : null);

// ── the role itself ─────────────────────────────────────────────────────────
await check('the Executive Director role is seeded like the CEO: home /ceo, the same view-and-decide keys, nothing that opens pay, bank or the backup', async () => {
  const c = await Role.findOne({ key: 'ceo' });
  const e = await Role.findOne({ key: 'executive_director' });
  assert.ok(e, 'seeded');
  assert.equal(e.label, 'Executive Director');
  assert.equal(e.homeRoute, '/ceo');
  assert.equal(e.isSystem, true);
  assert.deepEqual([...e.permissions].sort(), [...c.permissions].sort());
  for (const p of ['ceo', 'dashboard', 'planning.manage', 'payables.dashboard', 'company_finance.month_end', 'hr_analytics']) assert.ok(e.permissions.includes(p), p);
  for (const parent of ['staff', 'payables', 'company_finance', 'it', 'settings', 'compensation', 'recruitment', 'offboarding', 'hr_letters', 'hr_files']) assert.ok(!e.permissions.includes(parent), `must not carry the whole "${parent}" module`);
  for (const sub of ['staff.salaries', 'payables.admin_salaries', 'payables.operations_salaries', 'payables.hra']) assert.ok(!e.permissions.includes(sub), sub);
});

await check('signing in as the Executive Director lands on /ceo with those permissions', async () => {
  const r = await api('POST', '/auth/login', null, { email: ed.email, password: 'secret123' });
  assert.equal(r.status, 200);
  assert.equal(r.body.homeRoute ?? r.body.user?.homeRoute, '/ceo');
  assert.ok((r.body.permissions ?? r.body.user?.permissions ?? []).includes('ceo'));
});

await check('an admin editing a leadership role cannot tick the keys that open pay — the Roles screen drops them', async () => {
  const e = await Role.findOne({ key: 'executive_director' });
  const r = await api('PUT', `/roles/${e._id}`, admin.token, { permissions: [...e.permissions, 'staff', 'payables', 'it', 'settings', 'compensation', 'staff.salaries', 'payables.hra'] });
  assert.equal(r.status, 200);
  for (const banned of ['staff', 'payables', 'it', 'settings', 'compensation', 'staff.salaries', 'payables.hra']) assert.ok(!r.body.permissions.includes(banned), banned);
  assert.ok(r.body.permissions.includes('ceo'));
  assert.ok(r.body.permissions.includes('staff.evaluation'), 'what the role is meant to have stays');
  // …but another role keeps whatever it is given
  const fh = await Role.findOne({ key: 'finance_head' });
  const r2 = await api('PUT', `/roles/${fh._id}`, admin.token, { permissions: [...fh.permissions, 'staff', 'payables'] });
  assert.ok(r2.body.permissions.includes('staff') && r2.body.permissions.includes('payables'));
});

await check('…and if such a key ever got into the database, the next sign-in (ensureDefaultRoles) takes it off again', async () => {
  await Role.updateOne({ key: 'ceo' }, { $addToSet: { permissions: { $each: ['staff', 'payables.admin_salaries'] } } });
  assert.ok((await Role.findOne({ key: 'ceo' })).permissions.includes('staff'));
  await ensureDefaultRoles();
  const c = await Role.findOne({ key: 'ceo' });
  assert.ok(!c.permissions.includes('staff') && !c.permissions.includes('payables.admin_salaries'));
  assert.ok(c.permissions.includes('staff.evaluation'));
});

await check('a leader role that only had the parent keys (payables, company_finance) is given the safe sub-keys when they are taken away — never left with no Money screens', async () => {
  await Role.updateOne({ key: 'executive_director' }, { $set: { permissions: ['dashboard', 'ceo', 'payables', 'company_finance', 'staff'] } });
  await ensureDefaultRoles();
  const r = await Role.findOne({ key: 'executive_director' });
  for (const banned of ['payables', 'company_finance', 'staff']) assert.ok(!r.permissions.includes(banned), banned);
  for (const safe of ['payables.dashboard', 'company_finance.month_end', 'company_finance.dept_reviews', 'company_finance.pnl']) assert.ok(r.permissions.includes(safe), safe);
  const before = [...r.permissions].sort();
  await ensureDefaultRoles(); // running it again changes nothing
  assert.deepEqual([...(await Role.findOne({ key: 'executive_director' })).permissions].sort(), before);
});

// ── the leaks ───────────────────────────────────────────────────────────────
await check('CONTROL: an administrator reading the same URLs does get the planted values (so this test can fail)', async () => {
  const found = new Set();
  for (const url of URLS) {
    const r = await api('GET', url, admin.token);
    const hit = hasSentinel(r.text);
    if (hit) found.add(url);
  }
  for (const url of ['/employees', empUrl, `${empUrl}/increments`, '/audit', '/admin-expenses']) assert.ok(found.has(url), `${url} should carry pay for an administrator`);
});

for (const who of LEADERS) {
  await check(`${who.role}: no URL carries a planted pay value, whatever its status (${URLS.length} URLs)`, async () => {
    const leaks = [];
    for (const url of URLS) {
      const r = await api('GET', url, who.token);
      const hit = hasSentinel(r.text);
      if (hit) {
        const at = r.text.indexOf(hit);
        leaks.push(`${url} → ${hit} (status ${r.status}) …${r.text.slice(Math.max(0, at - 90), at + 40).replace(/\s+/g, ' ')}…`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  await check(`${who.role}: the routes that hold pay are refused outright (403 CEO_NO_ACCESS)`, async () => {
    for (const url of ['/salaries', '/audit', `/audit?employeeId=${empId}`, `${empUrl}/increments`, '/accounting/journal', '/accounting/ledger/123', '/offboarding/123/settlement', '/recruitment/offers']) {
      const r = await api('GET', url, who.token);
      assert.equal(r.status, 403, url);
      assert.equal(r.body.code, 'CEO_NO_ACCESS', url);
    }
  });

  await check(`${who.role}: the people list still works — names, departments — without a single sensitive field`, async () => {
    const r = await api('GET', '/employees', who.token);
    assert.equal(r.status, 200);
    const zed = (Array.isArray(r.body) ? r.body : r.body.employees ?? []).find((e) => e.name === 'Zed Sentinel');
    assert.ok(zed, 'the person is listed');
    assert.equal(zed.department, 'Sales');
    for (const f of ['baseSalary', 'allowances', 'deductions', 'hra', 'hraDay', 'salaryType', 'bankName', 'accountNumber', 'ifscCode', 'upiId', 'panNumber', 'statutoryApplicability', 'overtimeRate', 'currentGrade', 'emergencyContact', 'dateOfBirth']) {
      assert.equal(f in zed, false, `${f} reached ${who.role}`);
    }
    const one = await api('GET', empUrl, who.token);
    assert.equal(one.status, 200);
    assert.equal(one.body.baseSalary, undefined);
    assert.equal(one.body.bankName, undefined);
    assert.equal(one.body.name, 'Zed Sentinel');
  });

  await check(`${who.role}: the department-expense list has no payroll rows, though Accounts and admins see them`, async () => {
    const mine = await api('GET', '/admin-expenses', who.token);
    assert.equal(mine.status, 200);
    assert.ok(!/Salary - Zed/.test(mine.text), 'a payroll row reached the leader');
    const theirs = await api('GET', '/admin-expenses', accounts.token);
    assert.ok(/Salary - Zed/.test(theirs.text), 'Accounts should still see payroll rows (the control)');
  });

  await check(`${who.role}: what the role is FOR still works — the reports, the dashboards, the inbox, every project, every department's month (all 200)`, async () => {
    for (const url of ['/reports/month-end?month=11&year=2026', '/accounting/dashboard-summary', '/dashboard/finance', '/hr-analytics/summary', '/ceo/inbox', '/ceo/signals', '/projects', '/monthly-objectives', '/auth/users']) {
      const r = await api('GET', url, who.token);
      assert.equal(r.status, 200, `${url} → ${r.status} ${r.text.slice(0, 120)}`);
    }
  });

  await check(`${who.role}: reads every department's expenses (an approver for reading) — a head with no department sees none of them`, async () => {
    assert.ok(/ZZ Rent for Sales/.test((await api('GET', '/admin-expenses', who.token)).text));
    assert.ok(!/ZZ Rent for Sales/.test((await api('GET', '/admin-expenses', salesHead.token)).text), 'the control: a department head is not an approver');
  });

  await check(`${who.role}: sees every project and every department's month, and plans none of it (view-only)`, async () => {
    const list = await api('GET', '/projects', who.token);
    const mine = (Array.isArray(list.body) ? list.body : list.body.projects ?? []).find((p) => p.name === 'ZZ Project');
    assert.ok(mine, 'every project is listed');
    assert.equal(mine.access.canManage, false);
    assert.equal(mine.access.canCreateTasks, false);
    assert.equal(mine.access.canEditAllTasks, false);
    const month = await api('GET', '/monthly-objectives', who.token);
    assert.ok(month.body.departments.length >= 1);
    assert.ok(month.body.departments.every((d) => d.canManage === false), 'no department can be managed');
  });

  await check(`${who.role}: still view-only — a write is refused with CEO_READ_ONLY, a decision is not`, async () => {
    const w = await api('POST', '/employees', who.token, { name: 'X' });
    assert.equal(w.status, 403);
    assert.equal(w.body.code, 'CEO_READ_ONLY');
    assert.equal((await api('PUT', `/admin-expenses/${empId}/verify`, who.token, {})).body.code, 'CEO_READ_ONLY');
  });
}

// ── who can make a leadership account ───────────────────────────────────────
await check('a manager and a department head cannot create an admin, manager, CEO or Executive Director — an administrator can', async () => {
  const body = (email, role) => ({ name: 'New', email, password: 'secret123', role });
  let i = 0;
  for (const role of ['admin', 'manager', 'ceo', 'executive_director']) {
    for (const who of [manager, salesHead]) {
      i += 1;
      const r = await api('POST', '/auth/users', who.token, body(`x${i}@e2e.test`, role));
      assert.equal(r.status, 403, `${who.role} → ${role}`);
    }
  }
  assert.equal(await User.countDocuments({ email: /^x\d+@e2e\.test$/ }), 0, 'nothing was created');
  const made = await api('POST', '/auth/users', admin.token, body('ed2@e2e.test', 'executive_director'));
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.role, 'executive_director');
});

await check('a manager can still create ordinary accounts; and cannot give the Executive Director role by editing, nor touch the account', async () => {
  const ok = await api('POST', '/auth/users', manager.token, { name: 'Sam', email: 'sam@e2e.test', password: 'secret123', role: 'sales' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal((await api('PUT', `/auth/users/${ok.body.id}`, manager.token, { role: 'executive_director' })).status, 403);
  assert.equal((await api('PUT', `/auth/users/${ed.id}`, manager.token, { active: false })).status, 403);
  assert.equal((await api('DELETE', `/auth/users/${ed.id}`, manager.token)).status, 403);
  assert.equal((await User.findById(ed.id)).active, true);
});

await check('making, re-roling and removing a top-level login is written to the audit log (who, what, when)', async () => {
  const sam = await User.findOne({ email: 'sam@e2e.test' });
  assert.equal(await AuditLog.countDocuments({ entity: 'User', entityId: sam._id }), 0, 'an ordinary login is not logged');
  const target = await mk('temp', 'sales');
  assert.equal((await api('PUT', `/auth/users/${target.id}`, admin.token, { role: 'executive_director' })).status, 200);
  assert.equal((await api('PUT', `/auth/users/${target.id}`, admin.token, { active: false })).status, 200);
  assert.equal((await api('DELETE', `/auth/users/${target.id}`, admin.token)).status, 200);
  const rows = await AuditLog.find({ entity: 'User', entityId: target.id }).sort({ at: 1 }).lean();
  assert.deepEqual(rows.map((r) => r.action), ['login changed', 'login changed', 'login deleted']);
  const roleChange = rows[0].changes.find((c) => c.field === 'role');
  assert.deepEqual([roleChange.from, roleChange.to], ['sales', 'executive_director']);
  assert.equal(rows[1].changes.find((c) => c.field === 'active').to, false);
  assert.equal(rows[0].byName, 'boss');
  const created = await AuditLog.findOne({ entity: 'User', action: 'login created', note: /ed2@e2e\.test/ });
  assert.ok(created, 'the Executive Director account that was created is on record');
  const log = await api('GET', '/audit?entity=User', admin.token);
  assert.equal(log.status, 200);
  assert.ok(log.body.length >= 4);
});

// ── notifications: a second leader must not be missed ───────────────────────
const { sweepCeoDigest, sweepMonthEndSummary } = await import(new URL('controllers/notificationController.js', root));
const countOf = (u, type) => Notification.countDocuments({ recipient: u.id, type });

await check('the daily digest reaches each leader once — a leader added later the same day still gets theirs, and nobody gets two', async () => {
  const { loadCeoInbox } = await import(new URL('services/ceoInbox.js', root));
  await raw('Project').insertOne({ name: 'A proposal', status: 'proposed', targetDepartment: 'IT', createdAt: new Date() }); // something to say
  assert.ok((await loadCeoInbox()).needsYou > 0);
  await sweepCeoDigest({ force: true });
  assert.equal(await countOf(ceo, 'ceo_digest'), 1);
  assert.equal(await countOf(ed, 'ceo_digest'), 1, 'the Executive Director gets it too');
  assert.equal(await countOf(admin, 'ceo_digest'), 0, 'an admin never gets operational notifications');
  const late = await mk('late', 'executive_director'); // appears later the same day
  await sweepCeoDigest({ force: true });
  assert.equal(await countOf(late, 'ceo_digest'), 1, 'the late leader still gets today\'s');
  assert.equal(await countOf(ceo, 'ceo_digest'), 1, 'nobody gets two');
  assert.equal(await countOf(ed, 'ceo_digest'), 1, 'nobody gets two');
  await sweepCeoDigest({ force: true });
  assert.equal(await countOf(late, 'ceo_digest') + (await countOf(ceo, 'ceo_digest')) + (await countOf(ed, 'ceo_digest')), 3);
});

await check('the month-end summary reaches the admin and every leader once — and one added later still gets it', async () => {
  await sweepMonthEndSummary({ force: true });
  for (const u of [admin, ceo, ed]) assert.equal(await countOf(u, 'month_end_summary'), 1, u.role);
  const last = await mk('last', 'executive_director');
  await sweepMonthEndSummary({ force: true });
  assert.equal(await countOf(last, 'month_end_summary'), 1, 'the newcomer gets this month\'s');
  for (const u of [admin, ceo, ed]) assert.equal(await countOf(u, 'month_end_summary'), 1, `${u.role} is not sent it twice`);
  assert.equal(await countOf(salesHead, 'month_end_summary'), 0, 'nobody else gets it');
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log('FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
