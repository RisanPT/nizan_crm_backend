// Pure unit tests (no database, no network): node --test tests/salaryGuards.test.js
// HRMS QA fixes 2026-11-25:
//  #3 nobody approves their own salary slip (admin excepted); bulk submit
//     skips the caller's own draft and reports it.
//  #4 a slip can be paid only once, and only after HR approval.
import test from 'node:test';
import assert from 'node:assert/strict';
import Salary from '../models/Salary.js';
import PayrollLock from '../models/PayrollLock.js';
import AuditLog from '../models/AuditLog.js';
import * as salaries from '../controllers/salaryController.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';

// Approving / submitting now sends "payslip ready" notifications (2026-11-26):
// no logins in these tests, so nothing is sent and nothing touches a database.
User.find = () => ({ select: async () => [] });
Notification.insertMany = async () => [];

const q = (v) => {
  const o = { select: () => o, lean: () => o, sort: () => o, populate: () => o, limit: () => o, then: (r, j) => Promise.resolve(v).then(r, j) };
  return o;
};
const stubs = [];
const stub = (obj, name, fn) => { stubs.push([obj, name, obj[name]]); obj[name] = fn; };
const restore = () => { while (stubs.length) { const [o, n, f] = stubs.pop(); o[n] = f; } };
const mockRes = () => {
  const r = { statusCode: 200, body: undefined };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
};
const call = async (handler, req) => {
  const res = mockRes();
  await handler(req, res);
  return res;
};

const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const HR = { _id: 'u1', role: 'hr', employeeId: ME, permissions: [] };
const ADMIN = { _id: 'u0', role: 'admin', employeeId: ME, permissions: [] };

const slip = (over = {}) => {
  const s = { _id: 's1', employeeId: OTHER, month: 11, year: 2026, status: 'draft', saved: 0, ...over };
  s.save = async () => { s.saved++; return s; };
  s.toObject = () => ({ ...s });
  return s;
};
const common = (s) => {
  stub(PayrollLock, 'exists', async () => null);
  stub(AuditLog, 'create', async () => ({}));
  stub(Salary, 'findById', () => q(s));
};

test('#3 approving your own slip is refused', async (t) => {
  t.after(restore);
  const s = slip({ employeeId: ME });
  common(s);
  const res = await call(salaries.approveSalary, { user: HR, params: { id: 's1' } });
  assert.equal(res.statusCode, 403);
  assert.equal(s.status, 'draft');
  assert.equal(s.saved, 0);
});

test('#3 admin may approve their own slip; HR may approve someone else', async (t) => {
  t.after(restore);
  const own = slip({ employeeId: ME });
  common(own);
  let res = await call(salaries.approveSalary, { user: ADMIN, params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(own.status, 'approved_by_hr');
  restore();
  const other = slip();
  common(other);
  res = await call(salaries.approveSalary, { user: HR, params: { id: 's1' } });
  assert.equal(res.statusCode, 200);
  assert.equal(other.status, 'approved_by_hr');
});

test('#3 a custom slip cannot be created already approved for yourself, nor as paid', async (t) => {
  t.after(restore);
  stub(PayrollLock, 'exists', async () => null);
  let res = await call(salaries.createSalary, { user: HR, body: { employeeId: ME, month: 11, year: 2026, status: 'approved_by_hr' } });
  assert.equal(res.statusCode, 403);
  res = await call(salaries.createSalary, { user: HR, body: { employeeId: OTHER, month: 11, year: 2026, status: 'paid' } });
  assert.equal(res.statusCode, 400);
});

test('#3 bulk submit skips the caller\'s own draft and reports it', async (t) => {
  t.after(restore);
  stub(PayrollLock, 'exists', async () => null);
  let updateFilter = null;
  stub(Salary, 'countDocuments', async () => 1);
  // The drafts about to be approved (read first, for "payslip ready" notices).
  stub(Salary, 'find', () => q([{ employeeId: OTHER }]));
  stub(Salary, 'updateMany', async (f) => { updateFilter = f; return { modifiedCount: 4 }; });
  const res = await call(salaries.submitPayrollToAccounts, { user: HR, body: { month: 11, year: 2026 } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(updateFilter.employeeId, { $ne: ME });
  assert.equal(res.body.skippedOwn, 1);
  assert.match(res.body.message, /own slip was skipped/);
});

test('#4 a draft slip cannot be paid', async (t) => {
  t.after(restore);
  const s = slip({ status: 'draft' });
  common(s);
  const res = await call(salaries.paySalary, { user: HR, params: { id: 's1' }, body: { paymentMethod: 'cash' } });
  assert.equal(res.statusCode, 409);
  assert.equal(s.status, 'draft');
  assert.equal(s.saved, 0);
});

test('#4 a paid slip cannot be paid again', async (t) => {
  t.after(restore);
  const paidOn = new Date('2026-11-01');
  const s = slip({ status: 'paid', paymentDate: paidOn, paymentMethod: 'bank_transfer' });
  common(s);
  const res = await call(salaries.paySalary, { user: HR, params: { id: 's1' }, body: { paymentMethod: 'cash' } });
  assert.equal(res.statusCode, 409);
  assert.equal(s.paymentDate, paidOn);
  assert.equal(s.paymentMethod, 'bank_transfer');
  assert.equal(s.saved, 0);
});

// ── HRMS workflow 2026-11-26 ────────────────────────────────────────────────
const money = (over = {}) => slip({
  baseSalary: 20000, incentives: 0, roomRent: 0, allowances: 0, bonus: 0, deductions: 0, netAmount: 20000, ...over,
});

test('editing the amount of an approved slip sends it back to draft', async (t) => {
  t.after(restore);
  const s = money({ status: 'approved_by_hr', approvedBy: 'u9' });
  common(s);
  const res = await call(salaries.updateSalary, { user: HR, params: { id: 's1' }, body: { bonus: 1500 } });
  assert.equal(res.statusCode, 200);
  assert.equal(s.status, 'draft');
  assert.equal(s.approvedBy, null);
  assert.equal(s.netAmount, 21500);
});

test('editing only the notes of an approved slip keeps it approved', async (t) => {
  t.after(restore);
  const s = money({ status: 'approved_by_hr' });
  common(s);
  await call(salaries.updateSalary, { user: HR, params: { id: 's1' }, body: { notes: 'Bank details checked' } });
  assert.equal(s.status, 'approved_by_hr');
});

test('"Back to draft": an approved slip goes back; a paid one cannot', async (t) => {
  t.after(restore);
  const s = money({ status: 'approved_by_hr', approvedBy: 'u9' });
  common(s);
  const ok = await call(salaries.moveSalaryToDraft, { user: HR, params: { id: 's1' } });
  assert.equal(ok.statusCode, 200);
  assert.equal(s.status, 'draft');
  restore();
  const p = money({ status: 'paid' });
  common(p);
  const no = await call(salaries.moveSalaryToDraft, { user: HR, params: { id: 's1' } });
  assert.equal(no.statusCode, 409);
  assert.equal(p.status, 'paid');
});

test('"Back to draft" is refused while the month is locked', async (t) => {
  t.after(restore);
  const s = money({ status: 'approved_by_hr' });
  stub(PayrollLock, 'exists', async () => ({ _id: 'lock' }));
  stub(Salary, 'findById', () => q(s));
  const res = await call(salaries.moveSalaryToDraft, { user: HR, params: { id: 's1' } });
  assert.equal(res.statusCode, 409);
  assert.equal(s.status, 'approved_by_hr');
});