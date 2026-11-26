// Pure unit tests (no database, no mail): node --test tests/hrmsQaFixes.test.js
// HRMS QA fixes 2026-11-25:
//  #1  Employee Logins invite: department heads only their own department; the
//      set-password link goes back to admin / HR only; a disabled login is never
//      re-activated; bulk invite skips exited employees.
//  #10 Engagement feed honours the audience; clearing an event date saves.
//  #11 Withdrawing a grievance keeps the record (status 'withdrawn').
// Mongoose statics (and the mail transporter, when configured) are stubbed so
// nothing touches MongoDB or sends mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import Role from '../models/Role.js';
import Announcement from '../models/Announcement.js';
import Grievance, { GRIEVANCE_STATUSES } from '../models/Grievance.js';
import { transporter } from '../utils/mailer.js';
import { provisionEmployeeLogin, bulkProvisionEmployees } from '../controllers/authController.js';
import { getAnnouncements, updateAnnouncement } from '../controllers/engagementController.js';
import { withdrawGrievance, updateGrievance } from '../controllers/grievanceController.js';

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
  let error = null;
  await handler(req, res, (e) => { error = e; });
  return { res, error };
};
const httpReq = (user, body = {}) => ({
  user, body, params: {}, query: {}, protocol: 'https', get: () => 'crm.example.test',
});

// Shared stubs for the invite flow. Department "Sales" (dA) holds e1; e2 is in
// another department.
const inviteStubs = ({ existingUser = null } = {}) => {
  const emps = {
    e1: { _id: 'e1', name: 'Own Staff', email: 'own@x.in', status: 'active', departmentId: 'dA', save: async () => {} },
    e2: { _id: 'e2', name: 'Other Staff', email: 'other@x.in', status: 'active', departmentId: 'dB', save: async () => {} },
  };
  stub(Employee, 'findById', (id) => q(emps[String(id)] || null));
  stub(Employee, 'findOne', () => q(null));
  stub(Employee, 'find', () => q([{ _id: 'e1' }]));
  stub(Department, 'find', () => q([]));
  stub(Department, 'findById', (id) => q(id === 'dA' ? { _id: 'dA', key: 'sales', name: 'Sales' } : null));
  stub(Department, 'findOne', () => q(null));
  stub(Role, 'findOne', (f) => q({ key: f?.key || 'employee' }));
  stub(Role, 'find', () => q([])); // ensureDefaultRoles reads the roles list (after the 2026-11 main merge)
  stub(Role, 'exists', async () => true);
  stub(Role, 'create', async () => ({}));
  stub(Role, 'updateOne', async () => ({}));
  stub(Role, 'updateMany', async () => ({}));
  stub(User, 'findOne', () => q(existingUser));
  stub(User.prototype, 'save', async function () { return this; });
  // Never send real mail from a test.
  if (transporter) stub(transporter, 'sendMail', async () => { throw new Error('mail stubbed in tests'); });
};
const loginUser = (o = {}) => {
  const u = { _id: 'u9', email: 'own@x.in', role: 'employee', active: true, employeeId: 'e1', name: 'Own Staff', saved: 0, ...o };
  u.save = async function () { this.saved += 1; return this; };
  return u;
};
const salesHead = { _id: 'h1', role: 'sales', isDepartmentHead: true, employeeId: 'eh', departmentId: 'dA', permissions: [] };
const hrUser = { _id: 'hr1', role: 'hr', permissions: [] };

test('#1 a department head cannot invite staff of another department', async (t) => {
  t.after(restore);
  inviteStubs();
  const { res } = await call(provisionEmployeeLogin, httpReq(salesHead, { employeeId: 'e2' }));
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /not in your department/);
});

test('#1 a department head inviting own staff never receives the set-password link', async (t) => {
  t.after(restore);
  const existing = loginUser();
  inviteStubs({ existingUser: existing });
  const { res } = await call(provisionEmployeeLogin, httpReq(salesHead, { employeeId: 'e1' }));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailSent, false);
  assert.equal(res.body.setupLink, null);
  assert.match(res.body.message, /Ask HR/);
});

test('#1 HR gets the link back when mail is not configured', async (t) => {
  t.after(restore);
  const existing = loginUser();
  inviteStubs({ existingUser: existing });
  const { res } = await call(provisionEmployeeLogin, httpReq(hrUser, { employeeId: 'e1' }));
  assert.equal(res.statusCode, 200);
  assert.match(String(res.body.setupLink), /\/api\/auth\/set-password\//);
});

test('#1 an invite never re-activates a login HR switched off', async (t) => {
  t.after(restore);
  const existing = loginUser({ active: false });
  inviteStubs({ existingUser: existing });
  const { res } = await call(provisionEmployeeLogin, httpReq(hrUser, { employeeId: 'e1' }));
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /disabled/);
  assert.equal(existing.active, false);
  assert.equal(existing.saved, 0);
  assert.equal(existing.passwordSetupToken, undefined);
});

test('#1 bulk invite is refused for a department head and skips exited staff', async (t) => {
  t.after(restore);
  inviteStubs();
  const refused = await call(bulkProvisionEmployees, httpReq(salesHead));
  assert.equal(refused.res.statusCode, 403);

  let seen = null;
  stub(Employee, 'find', (f) => { seen = f; return q([]); });
  const { res } = await call(bulkProvisionEmployees, httpReq(hrUser));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.employmentStatus, { $ne: 'exited' });
  assert.equal(seen.status, 'active');
});

test('#10 an ordinary employee sees posts for all, their department and their own', async (t) => {
  t.after(restore);
  stub(Department, 'find', () => q([]));
  stub(Department, 'findById', () => q({ _id: 'dA', key: 'sales', name: 'Sales' }));
  let seen = null;
  stub(Announcement, 'find', (f) => { seen = f; return q([]); });
  const user = { _id: 'u1', role: 'employee', departmentId: 'dA', employeeId: 'e1', permissions: [] };
  const { res, error } = await call(getAnnouncements, { user, query: {} });
  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(seen.$or));
  const deptRule = seen.$or.find((r) => r.audience instanceof RegExp && r.audience.test('Sales'));
  assert.ok(deptRule, 'own department rule present');
  assert.equal(deptRule.audience.test('Marketing'), false);
  assert.ok(seen.$or.some((r) => r.audience instanceof RegExp && r.audience.test('all')));
  assert.ok(seen.$or.some((r) => r.postedBy === 'u1'));
});

test('#10 HR sees every audience', async (t) => {
  t.after(restore);
  let seen = null;
  stub(Announcement, 'find', (f) => { seen = f; return q([]); });
  await call(getAnnouncements, { user: { _id: 'a1', role: 'admin', permissions: [] }, query: {} });
  assert.equal(seen.$or, undefined);
  await call(getAnnouncements, { user: hrUser, query: {} });
  assert.equal(seen.$or, undefined);
});

test('#10 editing a post with eventDate null clears the date', async (t) => {
  t.after(restore);
  const row = { _id: 'p1', title: 'Town hall', eventDate: new Date('2025-01-01'), postedBy: 'a1', save: async () => {} };
  stub(Announcement, 'findById', async () => row);
  const req = { user: { _id: 'a1', role: 'admin', permissions: [] }, params: { id: 'p1' }, body: { title: 'Town hall', eventDate: null } };
  const { res, error } = await call(updateAnnouncement, req);
  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.equal(row.eventDate, null);
});

test('#11 withdrawing keeps the grievance, marked withdrawn', async (t) => {
  t.after(restore);
  assert.ok(GRIEVANCE_STATUSES.includes('withdrawn'));
  let deleted = false;
  let saved = 0;
  const row = { _id: 'g1', employeeId: 'e1', status: 'open', save: async () => { saved += 1; }, deleteOne: async () => { deleted = true; } };
  stub(Grievance, 'findById', async () => row);
  const { res, error } = await call(withdrawGrievance, { user: { _id: 'u1', employeeId: 'e1' }, params: { id: 'g1' } });
  assert.equal(error, null);
  assert.equal(res.statusCode, 200);
  assert.equal(deleted, false);
  assert.equal(saved, 1);
  assert.equal(row.status, 'withdrawn');
});

test('#11 HR cannot set or change a withdrawn status', async (t) => {
  t.after(restore);
  const row = { _id: 'g1', employeeId: 'e1', status: 'withdrawn', save: async () => {} };
  stub(Grievance, 'findById', async () => row);
  const { error } = await call(updateGrievance, { user: { _id: 'a1', role: 'admin', permissions: [] }, params: { id: 'g1' }, body: { status: 'open' } });
  assert.ok(error);
  assert.equal(row.status, 'withdrawn');
});
