// Pure unit tests (no database): node --test tests/jobRoles.test.js
// HRMS job roles are HR-owned (2026-11-24): admin + hr only, real departments,
// an optional linked CRM login role, and a hire carries the job role onto the
// employee. Mongoose statics are stubbed so nothing touches MongoDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import JobRole from '../models/JobRole.js';
import Department from '../models/Department.js';
import Role from '../models/Role.js';
import Employee from '../models/Employee.js';
import Offer from '../models/Offer.js';
import JobPost from '../models/JobPost.js';
import Onboarding from '../models/Onboarding.js';
import * as ctrl from '../controllers/recruitmentController.js';
const { linkHiredCandidateToOnboarding } = ctrl;

// A chainable, awaitable stand-in for a mongoose Query.
const q = (v) => {
  const o = { select: () => o, lean: () => o, sort: () => o, populate: () => o, then: (r, j) => Promise.resolve(v).then(r, j) };
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

// asyncHandler passes thrown errors to next(err); capture them.
const call = async (handler, req) => {
  const res = mockRes();
  let error = null;
  await handler(req, res, (e) => { error = e; });
  return { res, error };
};

const DEPT = { _id: 'dep1', name: 'Artist', active: true };

const baseStubs = ({ existing = false } = {}) => {
  stub(Department, 'findById', (id) => q(id === 'dep1' ? DEPT : null));
  stub(Department, 'findOne', () => q(DEPT));
  stub(Role, 'findOne', ({ key }) => q(['artist', 'driver', 'sales', 'manager', 'ceo', 'admin'].includes(key) ? { key, active: true } : null));
  stub(JobRole, 'exists', async () => existing);
};

test('only admin and hr logins may create a job role', async (t) => {
  t.after(restore);
  baseStubs();
  let created = null;
  stub(JobRole, 'create', async (doc) => { created = doc; return { _id: 'jr1', ...doc }; });
  for (const role of ['manager', 'crm', 'artist_head', 'employee', '']) {
    const { res, error } = await call(ctrl.createJobRole, { user: { role, permissions: ['staff', 'recruitment'] }, body: { designation: 'Bridal Artist', departmentId: 'dep1' } });
    assert.equal(res.statusCode, 403, role);
    assert.match(error.message, /Only HR or an administrator/);
  }
  assert.equal(created, null);
  for (const role of ['hr', 'admin', ' HR ']) {
    const { res, error } = await call(ctrl.createJobRole, { user: { role }, body: { designation: 'Bridal Artist', departmentId: 'dep1', crmRoleKey: 'Artist' } });
    assert.equal(error, null, role);
    assert.equal(res.statusCode, 201);
  }
  assert.equal(created.dept, 'Artist'); // name comes from the Departments master
  assert.equal(created.departmentId, 'dep1');
  assert.equal(created.crmRoleKey, 'artist');
});

test('department must come from the Departments master', async (t) => {
  t.after(restore);
  baseStubs();
  stub(Department, 'findOne', () => q(null));
  stub(JobRole, 'create', async (d) => d);
  const { res, error } = await call(ctrl.createJobRole, { user: { role: 'hr' }, body: { designation: 'X', dept: 'Executive / Governance' } });
  assert.equal(res.statusCode, 400);
  assert.match(error.message, /Departments list/);
});

test('CRM role link: unknown refused, admin-only roles need an admin, blank allowed', async (t) => {
  t.after(restore);
  baseStubs();
  stub(JobRole, 'create', async (d) => d);
  let r = await call(ctrl.createJobRole, { user: { role: 'hr' }, body: { designation: 'A', departmentId: 'dep1', crmRoleKey: 'nope' } });
  assert.equal(r.res.statusCode, 400);
  for (const key of ['manager', 'ceo', 'admin']) {
    r = await call(ctrl.createJobRole, { user: { role: 'hr' }, body: { designation: 'A', departmentId: 'dep1', crmRoleKey: key } });
    assert.equal(r.res.statusCode, 403, key);
    r = await call(ctrl.createJobRole, { user: { role: 'admin' }, body: { designation: 'A', departmentId: 'dep1', crmRoleKey: key } });
    assert.equal(r.error, null, key);
  }
  r = await call(ctrl.createJobRole, { user: { role: 'hr' }, body: { designation: 'A', departmentId: 'dep1', crmRoleKey: '' } });
  assert.equal(r.error, null);
  assert.equal(r.res.body.crmRoleKey, '');
});

test('duplicate active title is refused', async (t) => {
  t.after(restore);
  baseStubs({ existing: true });
  stub(JobRole, 'create', async (d) => d);
  const { res } = await call(ctrl.createJobRole, { user: { role: 'hr' }, body: { designation: 'Bridal Artist', departmentId: 'dep1' } });
  assert.equal(res.statusCode, 409);
});

test('edit and delete are admin + hr only; delete archives', async (t) => {
  t.after(restore);
  baseStubs();
  const doc = { _id: 'jr1', active: true, designation: 'Old', saved: 0, save: async function () { this.saved++; } };
  stub(JobRole, 'findById', async () => doc);
  let r = await call(ctrl.updateJobRole, { user: { role: 'manager' }, params: { id: 'jr1' }, body: { designation: 'New' } });
  assert.equal(r.res.statusCode, 403);
  r = await call(ctrl.deleteJobRole, { user: { role: 'crm' }, params: { id: 'jr1' } });
  assert.equal(r.res.statusCode, 403);
  r = await call(ctrl.updateJobRole, { user: { role: 'hr' }, params: { id: 'jr1' }, body: { designation: 'New', departmentId: 'dep1', crmRoleKey: 'driver' } });
  assert.equal(r.error, null);
  assert.equal(doc.designation, 'New');
  assert.equal(doc.dept, 'Artist');
  assert.equal(doc.crmRoleKey, 'driver');
  r = await call(ctrl.deleteJobRole, { user: { role: 'admin' }, params: { id: 'jr1' } });
  assert.equal(r.error, null);
  assert.equal(doc.active, false);
});

test('list has no seeding: an empty collection stays empty', async (t) => {
  t.after(restore);
  let inserted = false;
  stub(JobRole, 'find', () => q([]));
  stub(JobRole, 'insertMany', async () => { inserted = true; });
  const { res } = await call(ctrl.getJobRoles, { user: { role: 'hr' } });
  assert.deepEqual(res.body, []);
  assert.equal(inserted, false);
});

test('a hire carries the job role, its department and artist/driver role onto the new employee', async (t) => {
  t.after(restore);
  const jr = { _id: 'jr9', designation: 'Bridal Artist', dept: 'Artist', departmentId: 'dep1', crmRoleKey: 'artist', active: true };
  let lookedUp = null;
  stub(JobRole, 'findOne', (f) => { lookedUp = f; return q(jr); });
  stub(Onboarding, 'findOne', () => q(null));
  stub(Offer, 'findOne', () => q(null));
  stub(JobPost, 'findById', () => q(null));
  stub(Employee, 'findOne', () => q(null));
  let emp = null;
  stub(Employee, 'create', async (d) => { emp = { _id: 'e1', ...d }; return emp; });
  stub(Onboarding, 'create', async (d) => d);
  await linkHiredCandidateToOnboarding({ _id: 'c1', name: 'Asha', email: 'a@x.in', jobTitle: 'bridal artist' });
  assert.equal(lookedUp.active, true);
  assert.equal(emp.jobRoleId, 'jr9');
  assert.equal(emp.department, 'Artist');
  assert.equal(emp.departmentId, 'dep1');
  assert.equal(emp.artistRole, 'artist');
  assert.equal(emp.category, 'operations');
  assert.equal(emp.role, 'bridal artist');
});

test('a hire with no matching job role stays a plain staff record', async (t) => {
  t.after(restore);
  stub(JobRole, 'findOne', () => q(null));
  stub(Onboarding, 'findOne', () => q(null));
  stub(Offer, 'findOne', () => q(null));
  stub(Employee, 'findOne', () => q(null));
  let emp = null;
  stub(Employee, 'create', async (d) => { emp = { _id: 'e2', ...d }; return emp; });
  stub(Onboarding, 'create', async (d) => d);
  await linkHiredCandidateToOnboarding({ _id: 'c2', name: 'B', email: '', jobTitle: 'Receptionist (Front desk)' });
  assert.equal(emp.jobRoleId, null);
  assert.equal(emp.artistRole, 'staff');
  assert.equal(emp.department, 'General');
});

test('an existing employee only gains the job-role link', async (t) => {
  t.after(restore);
  const jr = { _id: 'jr9', dept: 'Artist', departmentId: 'dep1', crmRoleKey: 'artist' };
  stub(JobRole, 'findOne', () => q(jr));
  stub(Onboarding, 'findOne', () => q(null));
  stub(Offer, 'findOne', () => q(null));
  const existing = { _id: 'e3', name: 'C', department: 'Sales', role: 'Exec', artistRole: 'staff', jobRoleId: null };
  stub(Employee, 'findOne', () => q(existing));
  let update = null;
  stub(Employee, 'updateOne', async (f, u) => { update = u; });
  stub(Employee, 'create', async () => { throw new Error('should not create'); });
  stub(Onboarding, 'create', async (d) => d);
  await linkHiredCandidateToOnboarding({ _id: 'c3', name: 'C', email: 'c@x.in', jobTitle: 'Bridal Artist' });
  assert.deepEqual(update, { $set: { jobRoleId: 'jr9' } });
  assert.equal(existing.department, 'Sales');
  assert.equal(existing.artistRole, 'staff');
});
