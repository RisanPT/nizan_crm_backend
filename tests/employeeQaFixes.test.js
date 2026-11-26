// Pure unit tests (no database, no network): node --test tests/employeeQaFixes.test.js
// HRMS QA fixes 2026-11-25 in employeeController:
//  - delete refuses (409) when the person has a login, direct reports or heads a department
//  - reporting-loop guard shared by updateEmployee and setReportingDetails
//  - updateEmployee follows a department-name change to its departmentId
//  - duplicate Timebox ids are refused (409) on update
import test from 'node:test';
import assert from 'node:assert/strict';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import AuditLog from '../models/AuditLog.js';
import {
  deleteEmployee,
  updateEmployee,
  reportingLoopError,
  deleteBlockedMessage,
} from '../controllers/employeeController.js';

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

test('reportingLoopError: self, loop and clean chains', async () => {
  const chain = { b: 'c', c: 'a', d: null };
  const find = async (id) => chain[id] ?? null;
  assert.equal(await reportingLoopError('a', null, find), null);
  assert.match(await reportingLoopError('a', 'a', find), /themselves/);
  assert.match(await reportingLoopError('a', 'b', find), /loop/);
  assert.equal(await reportingLoopError('a', 'd', find), null);
});

test('deleteBlockedMessage lists every reason, null when safe', () => {
  assert.equal(deleteBlockedMessage({ name: 'X', hasLogin: false, reportCount: 0, headOf: [] }), null);
  const msg = deleteBlockedMessage({ name: 'Asha', hasLogin: true, reportCount: 2, headOf: ['HR'] });
  assert.match(msg, /CRM login/);
  assert.match(msg, /2 staff/);
  assert.match(msg, /head of HR/);
  assert.match(msg, /Inactive or use Offboarding/);
});

test('deleteEmployee refuses with 409 when a login is linked, deletes nothing', async (t) => {
  t.after(restore);
  let removed = 0;
  stub(Employee, 'findById', async () => ({ _id: 'e1', name: 'Asha', deleteOne: async () => { removed++; } }));
  stub(User, 'exists', async () => ({ _id: 'u1' }));
  stub(Employee, 'countDocuments', async () => 0);
  stub(Department, 'find', () => q([]));
  const res = mockRes();
  await deleteEmployee({ params: { id: 'e1' }, user: { _id: 'u9' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(removed, 0);
});

const fakeEmployee = (over = {}) => ({
  _id: 'e1', name: 'Asha', email: '', department: 'Operations', departmentId: 'dOps',
  reportingManagerId: 'm1', timeboxEmployeeId: 5, works: [], specialization: 'Artist',
  save: async function () { this.saved = true; },
  ...over,
});

test('updateEmployee follows a department name change to its id, clears manager + timebox', async (t) => {
  t.after(restore);
  const emp = fakeEmployee();
  stub(Employee, 'findById', (id) => (id === 'e1' && !emp.saved ? Promise.resolve(emp) : q(emp)));
  stub(Department, 'findOne', () => q({ _id: 'dHr' }));
  stub(AuditLog, 'create', async () => null);
  stub(Employee, 'findOne', () => q(null));
  const res = mockRes();
  await updateEmployee({
    params: { id: 'e1' }, user: { _id: 'u9', role: 'admin' },
    body: { department: 'HR', reportingManagerId: '', timeboxEmployeeId: null, timeboxName: '' },
  }, res);
  assert.equal(emp.department, 'HR');
  assert.equal(emp.departmentId, 'dHr');
  assert.equal(emp.reportingManagerId, null);
  assert.equal(emp.timeboxEmployeeId, null);
});

test('updateEmployee refuses a Timebox id linked to someone else (409)', async (t) => {
  t.after(restore);
  const emp = fakeEmployee({ timeboxEmployeeId: null });
  stub(Employee, 'findById', async () => emp);
  stub(Employee, 'findOne', () => q({ _id: 'e2', name: 'Other', employeeCode: 'TN002' }));
  const res = mockRes();
  await updateEmployee({ params: { id: 'e1' }, user: { _id: 'u9' }, body: { timeboxEmployeeId: 7 } }, res);
  assert.equal(res.statusCode, 409);
  assert.match(res.body.message, /already linked to Other/);
  assert.equal(emp.saved, undefined);
});
