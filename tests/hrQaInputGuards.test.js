// Pure unit tests (no database, no network): node --test tests/hrQaInputGuards.test.js
// HRMS QA fixes 2026-11-25: bad input is a 400 (not a 500), and nothing is
// written before validation passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import Employee from '../models/Employee.js';
import ExpenseClaim from '../models/ExpenseClaim.js';
import TravelRequest from '../models/TravelRequest.js';
import SalaryBand from '../models/SalaryBand.js';
import CompensationRevision from '../models/CompensationRevision.js';
import * as reimb from '../controllers/reimbursementController.js';
import * as travel from '../controllers/travelController.js';
import * as comp from '../controllers/compensationController.js';

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
const EMP = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const HR = { _id: 'u1', role: 'hr', employeeId: EMP, permissions: [] };

test('reimbursement: unknown category / bad date → 400, nothing created', async (t) => {
  t.after(restore);
  let created = 0;
  stub(Employee, 'findById', async () => ({ _id: EMP, name: 'A' }));
  stub(ExpenseClaim, 'create', async () => { created++; });
  let r = await call(reimb.submitClaim, { user: HR, body: { title: 'Taxi', amount: 100, category: 'bogus' } });
  assert.equal(r.res.statusCode, 400);
  assert.ok(r.error);
  r = await call(reimb.submitClaim, { user: HR, body: { title: 'Taxi', amount: 100, date: 'not-a-date' } });
  assert.equal(r.res.statusCode, 400);
  assert.equal(created, 0);
});

test('travel: return before start → 400; advance off → amount 0', async (t) => {
  t.after(restore);
  const rows = [];
  stub(Employee, 'findById', async () => ({ _id: EMP, name: 'A' }));
  stub(TravelRequest, 'create', async (d) => { rows.push(d); throw new Error('stop here'); });
  let r = await call(travel.applyTravel, { user: HR, body: { destination: 'Kochi', fromDate: '2026-12-10', toDate: '2026-12-05' } });
  assert.equal(r.res.statusCode, 400);
  assert.equal(rows.length, 0);
  r = await call(travel.applyTravel, { user: HR, body: { destination: 'Kochi', advanceRequested: false, advanceAmount: 5000 } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].advanceAmount, 0);
});

test('compensation: hr role may manage; band min > max → 400', async (t) => {
  t.after(restore);
  let created = 0;
  stub(SalaryBand, 'create', async () => { created++; });
  const r = await call(comp.createBand, { user: HR, body: { name: 'L1', minSalary: 50000, maxSalary: 20000 } });
  assert.equal(r.res.statusCode, 400);
  assert.match(String(r.error?.message), /Minimum salary/);
  assert.equal(created, 0);
});

test('compensation: a second pending revision for the same employee → 409', async (t) => {
  t.after(restore);
  let created = 0;
  stub(Employee, 'findById', async () => ({ _id: OTHER, name: 'B', baseSalary: 20000 }));
  stub(CompensationRevision, 'exists', async () => ({ _id: 'r1' }));
  stub(CompensationRevision, 'create', async () => { created++; });
  const r = await call(comp.proposeRevision, { user: HR, body: { employeeId: OTHER, proposedSalary: 25000 } });
  assert.equal(r.res.statusCode, 409);
  assert.equal(created, 0);
});
