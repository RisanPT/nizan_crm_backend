// Pure unit tests (no database): node --test tests/hrmsBlockers.test.js
// HRMS pre-deploy blockers fixed 2026-11-24:
//  B1 the startup user→employee sync no longer overwrites HR's employee edits;
//  B2 opening the Onboarding list has no side effects and new onboardings start
//     with nothing ticked / received;
//  B3 attendance, the PHP HR bridge and salary bands are no longer open to every login.
// Mongoose statics are stubbed so nothing touches MongoDB.
import test from 'node:test';
import assert from 'node:assert/strict';
import User from '../models/User.js';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import Candidate from '../models/Candidate.js';
import Onboarding from '../models/Onboarding.js';
import Offer from '../models/Offer.js';
import JobRole from '../models/JobRole.js';
import SalaryBand from '../models/SalaryBand.js';
import { syncUserToEmployee, migrateAndSyncAll } from '../utils/syncUserEmployee.js';
import { getOnboardings } from '../controllers/onboardingController.js';
import { linkHiredCandidateToOnboarding } from '../controllers/recruitmentController.js';
import { getBands } from '../controllers/compensationController.js';
import { hrWideOnly } from '../middleware/hrWideOnly.js';

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
const emp = (o) => ({ saved: 0, save: async function () { this.saved++; }, ...o });

// ── B1 ──────────────────────────────────────────────────────────────────────
test('B1 restart sync keeps HR department, category, name and status', async (t) => {
  t.after(restore);
  const e = emp({ _id: 'e1', name: 'Asha K (HR)', department: 'Artist', departmentId: 'd9', category: 'administrative', artistRole: 'staff', role: 'Front Desk', specialization: 'Desk', status: 'active' });
  stub(Employee, 'findById', async () => e);
  const user = { email: 'a@x.in', role: 'sales', name: 'Asha', active: false, employeeId: 'e1', save: async () => {} };
  await syncUserToEmployee(user, { boot: true });
  assert.equal(e.department, 'Artist');
  assert.equal(e.category, 'administrative');
  assert.equal(e.name, 'Asha K (HR)');
  assert.equal(e.status, 'active'); // a disabled login does not flip HR status on restart
  assert.equal(e.role, 'Front Desk');
});

test('B1 explicit login edit copies name/active but never department, and never re-activates an exited employee', async (t) => {
  t.after(restore);
  const e = emp({ _id: 'e2', name: 'Old', department: 'Accounts', category: 'administrative', artistRole: 'staff', role: 'X', specialization: 'Y', status: 'inactive', employmentStatus: 'exited' });
  stub(Employee, 'findById', async () => e);
  await syncUserToEmployee({ email: 'b@x.in', role: 'crm', name: 'New Name', active: true, employeeId: 'e2', save: async () => {} });
  assert.equal(e.name, 'New Name');
  assert.equal(e.department, 'Accounts');
  assert.equal(e.status, 'inactive');
  e.employmentStatus = 'confirmed';
  await syncUserToEmployee({ email: 'b@x.in', role: 'crm', name: 'New Name', active: true, employeeId: 'e2', save: async () => {} });
  assert.equal(e.status, 'active');
});

test('B1 a driver login keeps driver features but HR department stays', async (t) => {
  t.after(restore);
  const e = emp({ _id: 'e3', name: 'D', department: 'Fleet', category: 'administrative', artistRole: 'staff', role: 'Chauffeur', specialization: 'Driving', status: 'active' });
  stub(Employee, 'findById', async () => e);
  await syncUserToEmployee({ email: 'd@x.in', role: 'driver', name: 'D', active: true, employeeId: 'e3', save: async () => {} }, { boot: true });
  assert.equal(e.artistRole, 'driver');
  assert.equal(e.category, 'operations');
  assert.equal(e.department, 'Fleet');
  assert.equal(e.role, 'Chauffeur');
});

test('B1 blanks are still filled', async (t) => {
  t.after(restore);
  const e = emp({ _id: 'e4', name: 'S', department: '', category: '', artistRole: 'staff', role: '', specialization: '', status: 'active' });
  stub(Employee, 'findById', async () => e);
  await syncUserToEmployee({ email: 's@x.in', role: 'sales', name: 'S', active: true, employeeId: 'e4', save: async () => {} }, { boot: true });
  assert.equal(e.department, 'Sales');
  assert.equal(e.category, 'administrative');
  assert.equal(e.role, 'Sales Executive');
});

test('B1 startup normalise pass no longer moves drivers/artists to Operations', async (t) => {
  t.after(restore);
  const driver = emp({ _id: 'e5', artistRole: 'driver', category: 'operations', department: 'Fleet', role: 'Senior Driver', specialization: 'Driving' });
  const artist = emp({ _id: 'e6', artistRole: 'artist', category: 'operations', department: 'Artist', role: 'MUA' });
  const blank = emp({ _id: 'e7', artistRole: 'artist', category: 'creative', department: '', role: 'MUA' });
  stub(User, 'find', async () => []);
  stub(Employee, 'find', async () => [driver, artist, blank]);
  await migrateAndSyncAll();
  assert.equal(driver.department, 'Fleet');
  assert.equal(driver.role, 'Senior Driver');
  assert.equal(driver.saved, 0);
  assert.equal(artist.department, 'Artist');
  assert.equal(artist.saved, 0);
  assert.equal(blank.department, 'Operations');
  assert.equal(blank.category, 'operations');
});

// ── B2 ──────────────────────────────────────────────────────────────────────
test('B2 opening the Onboarding list creates nothing', async (t) => {
  t.after(restore);
  let candidateLookups = 0;
  let created = 0;
  stub(Candidate, 'find', () => { candidateLookups++; return q([{ _id: 'c1', stage: 'hired', name: 'X' }]); });
  stub(Employee, 'create', async () => { created++; });
  stub(Onboarding, 'create', async () => { created++; });
  stub(Onboarding, 'find', () => q([{ _id: 'o1' }]));
  const { res, error } = await call(getOnboardings, { user: { role: 'admin' }, query: {} });
  assert.equal(error, null);
  assert.deepEqual(res.body, [{ _id: 'o1' }]);
  assert.equal(candidateLookups, 0);
  assert.equal(created, 0);
});

test('B2 a hire starts onboarding with nothing ticked and no document marked received', async (t) => {
  t.after(restore);
  stub(JobRole, 'findOne', () => q(null));
  stub(Onboarding, 'findOne', () => q(null));
  stub(Offer, 'findOne', () => q(null));
  stub(Employee, 'findOne', () => q(null));
  stub(Employee, 'create', async (d) => ({ _id: 'e9', ...d }));
  let ob = null;
  stub(Onboarding, 'create', async (d) => { ob = d; return d; });
  await linkHiredCandidateToOnboarding({ _id: 'c9', name: 'N', email: '', jobTitle: 'Helper' });
  assert.ok(ob.tasks.length > 0);
  assert.ok(ob.tasks.every((x) => x.done === false));
  assert.ok(ob.documents.every((d) => d.status === 'Pending'), JSON.stringify(ob.documents));
});

test('B2 the Onboarding model default documents start as Pending', () => {
  const doc = new Onboarding({ employeeName: 'Z' });
  assert.ok(doc.documents.every((d) => d.status === 'Pending'));
});

// ── B3 ──────────────────────────────────────────────────────────────────────
const gate = async (user) => {
  let passed = false;
  const res = mockRes();
  let err = null;
  await hrWideOnly(['staff.attendance'])({ user }, res, (e) => { if (e) err = e; else passed = true; });
  if (err) throw err;
  return passed ? 'ok' : res.statusCode;
};

test('B3 attendance / HR bridge gate: HR-wide in, everyone else out', async (t) => {
  t.after(restore);
  stub(Department, 'find', () => q([]));
  stub(Department, 'findById', () => q(null));
  stub(Department, 'findOne', () => q(null));
  stub(Employee, 'findById', () => q(null));
  for (const user of [
    { role: 'admin' }, { role: 'manager' }, { role: 'hr' }, { role: ' HR ' },
    { role: 'crm', permissions: ['staff'] }, { role: 'x', permissions: ['staff.attendance'] },
  ]) assert.equal(await gate(user), 'ok', JSON.stringify(user));
  for (const user of [
    { role: 'artist', permissions: ['dashboard', 'calendar'] }, { role: 'driver', permissions: [] },
    { role: 'sales', permissions: ['sales'] }, { role: 'employee', permissions: ['leave'] }, {},
  ]) assert.equal(await gate(user), 403, JSON.stringify(user));
});

test('B3 the HR department head is HR-wide; another department head is not', async (t) => {
  t.after(restore);
  stub(Department, 'find', () => q([{ _id: 'dh', key: 'hr', name: 'HR' }]));
  assert.equal(await gate({ role: 'x', employeeId: 'emp1', permissions: [] }), 'ok');
  restore();
  stub(Department, 'find', () => q([{ _id: 'ds', key: 'sales', name: 'Sales' }]));
  stub(Employee, 'find', () => q([]));
  assert.equal(await gate({ role: 'x', employeeId: 'emp2', permissions: [] }), 403);
});

test('B3 salary bands need compensation rights', async (t) => {
  t.after(restore);
  stub(SalaryBand, 'find', () => q([{ name: 'L1' }]));
  let r = await call(getBands, { user: { role: 'artist', permissions: ['dashboard'] } });
  assert.equal(r.res.statusCode, 403);
  r = await call(getBands, { user: { role: 'sales', permissions: ['sales'] } });
  assert.equal(r.res.statusCode, 403);
  for (const user of [{ role: 'admin' }, { role: 'x', permissions: ['compensation'] }, { role: 'x', isDepartmentHead: true }]) {
    r = await call(getBands, { user });
    assert.equal(r.error, null, JSON.stringify(user));
    assert.deepEqual(r.res.body, [{ name: 'L1' }]);
  }
});
