// HRMS workflow rules (2026-11-26). Stubbed models, no database.
//   node --test tests/hrmsWorkflow.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Offboarding from '../models/Offboarding.js';
import EmployeeAsset from '../models/EmployeeAsset.js';
import Candidate from '../models/Candidate.js';
import Offer from '../models/Offer.js';
import JobPost from '../models/JobPost.js';
import User from '../models/User.js';
import Notification from '../models/Notification.js';
import * as offboarding from '../controllers/offboardingController.js';
import * as recruitment from '../controllers/recruitmentController.js';

const q = (v) => {
  const o = { select: () => o, lean: () => o, sort: () => o, populate: () => o, limit: () => o, then: (r, j) => Promise.resolve(v).then(r, j) };
  return o;
};
User.find = () => q([]);
Notification.insertMany = async () => [];
EmployeeAsset.find = () => q([]);
JobPost.findById = () => q(null);

const HR = { _id: 'u1', role: 'hr', permissions: [] };
const HEAD = { _id: 'u2', role: 'sales_manager', isDepartmentHead: true, permissions: [] };

// Run an asyncHandler-wrapped controller; resolve with { status, error }.
const run = (handler, req) =>
  new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    handler(req, res, (err) => resolve({ status: res.statusCode, error: err?.message || '' }));
  });

const exitRow = (over = {}) => {
  const r = {
    _id: 'x1', employeeId: 'e1', status: 'in_progress', lastWorkingDay: null, settlementPaid: false,
    clearanceItems: [{ label: 'Return assets', cleared: true }, { label: 'Revoke access', cleared: false }],
    ...over,
  };
  r.save = async () => r;
  r.populate = async () => r;
  return r;
};

const pick = (name) => offboarding[name] ?? recruitment[name];
const updateOffboarding = pick('updateOffboarding');

test('department heads can no longer run exits (HR job)', async () => {
  Offboarding.findById = async () => exitRow();
  const r = await run(updateOffboarding, { user: HEAD, params: { id: 'x1' }, body: { notes: 'x' } });
  assert.equal(r.status, 403);
});

test('an exit cannot be completed without a last working day', async () => {
  Offboarding.findById = async () => exitRow();
  const r = await run(updateOffboarding, { user: HR, params: { id: 'x1' }, body: { status: 'completed' } });
  assert.equal(r.status, 400);
  assert.match(r.error, /last working day/i);
});

test('an exit cannot be completed with clearance items open', async () => {
  Offboarding.findById = async () => exitRow({ lastWorkingDay: new Date('2026-11-30') });
  const r = await run(updateOffboarding, { user: HR, params: { id: 'x1' }, body: { status: 'completed' } });
  assert.equal(r.status, 400);
  assert.match(r.error, /Revoke access/);
});

test('an exit cannot be completed before the settlement is paid', async () => {
  Offboarding.findById = async () => exitRow({
    lastWorkingDay: new Date('2026-11-30'),
    clearanceItems: [{ label: 'Return assets', cleared: true }],
  });
  const r = await run(updateOffboarding, { user: HR, params: { id: 'x1' }, body: { status: 'completed' } });
  assert.equal(r.status, 400);
  assert.match(r.error, /settlement/i);
});

const updateCandidate = pick('updateCandidate');
const cand = (over = {}) => {
  const c = { _id: 'c1', name: 'Asha', stage: 'interview', jobPostId: null, ...over };
  c.save = async () => c;
  return c;
};

test('a candidate cannot jump to Hired without an accepted offer', async () => {
  const c = cand();
  Candidate.findById = async () => c;
  Offer.findOne = () => q(null);
  const r = await run(updateCandidate, { user: HR, params: { id: 'c1' }, body: { stage: 'hired' } });
  assert.equal(r.status, 400);
  assert.match(r.error, /offer/i);
  assert.equal(c.stage, 'interview');
});

test('a hired candidate cannot be moved back out of Hired', async () => {
  const c = cand({ stage: 'hired' });
  Candidate.findById = async () => c;
  const r = await run(updateCandidate, { user: HR, params: { id: 'c1' }, body: { stage: 'rejected' } });
  assert.equal(r.status, 409);
  assert.equal(c.stage, 'hired');
});

test('other stage moves still work', async () => {
  const c = cand({ stage: 'screening' });
  Candidate.findById = async () => c;
  const r = await run(updateCandidate, { user: HR, params: { id: 'c1' }, body: { stage: 'interview' } });
  assert.equal(r.status, 200);
  assert.equal(c.stage, 'interview');
});

// ── Attendance corrections (regularization) ─────────────────────────────────
import AttendanceRegularization from '../models/AttendanceRegularization.js';
import Employee from '../models/Employee.js';
import PayrollLock from '../models/PayrollLock.js';
import * as regularization from '../controllers/regularizationController.js';

const applyReg = regularization.applyRegularization;
const ME = { _id: 'u5', role: 'employee', employeeId: 'e5', permissions: [] };
Employee.findById = async () => ({ _id: 'e5', name: 'Asha', department: 'Sales' });

test('a second correction for the same day is refused', async () => {
  AttendanceRegularization.find = () => q([{ date: new Date('2026-11-10T06:00:00Z'), status: 'pending' }]);
  PayrollLock.exists = async () => null;
  const r = await run(applyReg, { user: ME, body: { date: '2026-11-10T06:00:00Z', type: 'missing_punch' } });
  assert.equal(r.status, 409);
  assert.match(r.error, /already a pending request/);
});

test('a correction for a locked payroll month is refused', async () => {
  AttendanceRegularization.find = () => q([]);
  PayrollLock.exists = async () => ({ _id: 'lock' });
  const r = await run(applyReg, { user: ME, body: { date: '2026-10-10T06:00:00Z', type: 'missing_punch' } });
  assert.equal(r.status, 409);
  assert.match(r.error, /locked/);
});