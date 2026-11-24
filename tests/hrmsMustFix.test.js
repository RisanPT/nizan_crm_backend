// Pure unit tests (no database, no network): node --test tests/hrmsMustFix.test.js
// HRMS must-fix items done 2026-11-24:
//  M3 generic orientation plans / courses no longer re-created; plans can be
//     deleted; no silent DevOps syllabus; starter shifts only on a new install.
//  M5 Timebox sync: no writes in demo mode, matches by Timebox id first, only
//     HR's manual sync creates staff, deleted people are never re-imported.
//  M6 user text is escaped before it goes into a RegExp.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Employee from '../models/Employee.js';
import Department from '../models/Department.js';
import Course from '../models/Course.js';
import Shift from '../models/Shift.js';
import OrientationPlan from '../models/OrientationPlan.js';
import OrientationAssignment from '../models/OrientationAssignment.js';
import TimeboxIgnoredEmployee from '../models/TimeboxIgnoredEmployee.js';
import * as lms from '../controllers/lmsController.js';
import * as shifts from '../controllers/shiftController.js';
import { performTimeboxEmployeeSync } from '../controllers/timeboxController.js';
import { deleteEmployee } from '../controllers/employeeController.js';
import { escapeRegex } from '../utils/escapeRegex.js';

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
const ADMIN = { role: 'admin', permissions: [] };

// ── M3 ──────────────────────────────────────────────────────────────────────
test('M3 orientation plans list writes nothing', async (t) => {
  t.after(restore);
  let writes = 0;
  stub(OrientationPlan, 'updateOne', async () => { writes++; });
  stub(OrientationPlan, 'insertMany', async () => { writes++; });
  stub(OrientationPlan, 'create', async () => { writes++; });
  stub(OrientationPlan, 'find', () => q([{ roleTitle: 'Bridal Artist' }]));
  const { res } = await call(lms.getOrientationPlans, { user: ADMIN, query: {} });
  assert.deepEqual(res.body, [{ roleTitle: 'Bridal Artist' }]);
  assert.equal(writes, 0);
});

test('M3 courses list writes nothing, even when empty', async (t) => {
  t.after(restore);
  let writes = 0;
  stub(Course, 'updateOne', async () => { writes++; });
  stub(Course, 'insertMany', async () => { writes++; });
  stub(Course, 'estimatedDocumentCount', async () => 0);
  stub(Course, 'find', () => q([]));
  await call(lms.getCourses, { user: ADMIN, query: {} });
  assert.equal(writes, 0);
});

test('M3 orientation plans can be deleted by HR, not by others', async (t) => {
  t.after(restore);
  let deleted = 0;
  stub(OrientationPlan, 'findById', async () => ({ _id: 'p1', deleteOne: async () => { deleted++; } }));
  let r = await call(lms.deleteOrientationPlan, { user: { role: 'artist', permissions: ['dashboard'] }, params: { id: 'p1' } });
  assert.equal(r.res.statusCode, 403);
  r = await call(lms.deleteOrientationPlan, { user: ADMIN, params: { id: 'p1' } });
  assert.equal(r.error, null);
  assert.equal(deleted, 1);
  assert.match(readFileSync(new URL('../routes/lmsRoutes.js', import.meta.url), 'utf8'), /\.delete\(deleteOrientationPlan\)/);
});

test('M3 assigning with no matching plan is refused, not given a DevOps syllabus', async (t) => {
  t.after(restore);
  let created = 0;
  stub(Employee, 'findById', async () => ({ _id: 'e1', name: 'A', role: 'Receptionist', department: 'Front Office' }));
  stub(OrientationPlan, 'findById', async () => null);
  stub(OrientationPlan, 'findOne', async () => null);
  stub(OrientationAssignment, 'create', async () => { created++; });
  const { res, error } = await call(lms.assignOrientation, { user: ADMIN, body: { employeeId: 'e1' } });
  assert.equal(res.statusCode, 400);
  assert.match(error.message, /No orientation plan/);
  assert.equal(created, 0);
});

test('M3 starter shifts only on a brand-new install, not when ?active=true is empty', async (t) => {
  t.after(restore);
  let inserted = 0;
  stub(Shift, 'insertMany', async () => { inserted++; });
  stub(Shift, 'find', () => q([]));
  stub(Shift, 'estimatedDocumentCount', async () => 4);
  await call(shifts.getShifts, { user: ADMIN, query: { active: 'true' } });
  assert.equal(inserted, 0);
  restore();
  stub(Shift, 'insertMany', async () => { inserted++; });
  stub(Shift, 'find', () => q([]));
  stub(Shift, 'estimatedDocumentCount', async () => 0);
  await call(shifts.getShifts, { user: ADMIN, query: {} });
  assert.equal(inserted, 1);
});

// ── M5 ──────────────────────────────────────────────────────────────────────
const tbSetup = ({ crm = [], tb = [], ignored = [] } = {}) => {
  const created = [];
  const updates = [];
  stub(Employee, 'find', () => q(crm));
  stub(Department, 'find', () => q([]));
  stub(TimeboxIgnoredEmployee, 'find', () => q(ignored.map((id) => ({ timeboxEmployeeId: id }))));
  stub(Employee, 'create', async (d) => { created.push(d); return { _id: 'new' + created.length, ...d }; });
  stub(Employee, 'findByIdAndUpdate', async (id, patch) => { updates.push({ id, patch }); });
  return { created, updates, fetch: async () => ({ data: tb }), live: () => 'live' };
};

test('M5 demo mode writes nothing', async (t) => {
  t.after(restore);
  const s = tbSetup({ tb: [{ id: 1, full_name: 'Demo Person' }] });
  let fetched = 0;
  const r = await performTimeboxEmployeeSync({ createMissing: true, _mode: () => 'demo', _fetch: async () => { fetched++; return { data: [] }; } });
  assert.equal(r.ok, false);
  assert.equal(r.mode, 'demo');
  assert.equal(fetched, 0);
  assert.equal(s.created.length, 0);
});

test('M5 automatic sync links but never creates', async (t) => {
  t.after(restore);
  const s = tbSetup({ crm: [{ _id: 'c1', name: 'Asha', email: 'a@x.in' }], tb: [{ id: 7, full_name: 'Asha', email: 'a@x.in' }, { id: 8, full_name: 'New Person' }] });
  const r = await performTimeboxEmployeeSync({ _fetch: s.fetch, _mode: s.live });
  assert.equal(s.created.length, 0);
  assert.equal(r.unmatched, 1);
  assert.equal(r.synced, 1);
  assert.deepEqual(s.updates[0].patch.timeboxEmployeeId, 7);
});

test('M5 HR sync creates new staff but never someone HR deleted', async (t) => {
  t.after(restore);
  const s = tbSetup({ tb: [{ id: 8, full_name: 'New Person' }, { id: 9, full_name: 'Deleted Person' }], ignored: [9] });
  const r = await performTimeboxEmployeeSync({ createMissing: true, _fetch: s.fetch, _mode: s.live });
  assert.equal(s.created.length, 1);
  assert.equal(s.created[0].timeboxEmployeeId, 8);
  assert.equal(r.skippedDeleted, 1);
});

test('M5 a renamed, re-emailed person is matched by Timebox id, not duplicated', async (t) => {
  t.after(restore);
  const s = tbSetup({ crm: [{ _id: 'c5', name: 'Old Name', email: 'old@x.in', timeboxEmployeeId: 5 }], tb: [{ id: 5, full_name: 'New Name', email: 'new@x.in' }] });
  const r = await performTimeboxEmployeeSync({ createMissing: true, _fetch: s.fetch, _mode: s.live });
  assert.equal(s.created.length, 0);
  assert.equal(r.alreadySynced, 1);
});

test('M5 deleting a Timebox-linked employee records them so the sync skips them', async (t) => {
  t.after(restore);
  let recorded = null;
  let removed = 0;
  stub(Employee, 'findById', async () => ({ _id: 'e9', name: 'Gone', email: 'g@x.in', timeboxEmployeeId: 9, deleteOne: async () => { removed++; } }));
  stub(TimeboxIgnoredEmployee, 'updateOne', async (f, u, o) => { recorded = { f, u, o }; });
  const res = mockRes();
  await deleteEmployee({ params: { id: 'e9' }, user: { _id: 'u1' } }, res);
  assert.equal(removed, 1);
  assert.deepEqual(recorded.f, { timeboxEmployeeId: 9 });
  assert.equal(recorded.o.upsert, true);
});

// ── M6 ──────────────────────────────────────────────────────────────────────
test('M6 escapeRegex makes user text literal', () => {
  for (const raw of ['(', '[abc', 'a+b', 'C++ dev', '.*', 'x|y', '\\', '(a+)+$']) {
    const rx = new RegExp(`^${escapeRegex(raw)}$`, 'i');
    assert.equal(rx.test(raw), true, raw);
  }
  assert.equal(new RegExp(escapeRegex('a.c')).test('abc'), false);
});

test('M6 the four unsafe spots now escape their input', () => {
  const src = (f) => readFileSync(new URL(`../controllers/${f}`, import.meta.url), 'utf8');
  const emp = src('employeeController.js');
  assert.match(emp, /new RegExp\(`\^\$\{escapeRegex\(deptTerm\)\}\$`, 'i'\)/);
  assert.match(emp, /new RegExp\(escapeRegex\(String\(req\.query\.search\)\.trim\(\)\), 'i'\)/);
  assert.match(src('leaveController.js'), /escapeRegex\(empName\)/);
  assert.match(src('recruitmentController.js'), /escRx\(jobTitle\.trim\(\)\)/);
});
