// HRMS login-based access (2026-11-26): who counts as HR, who sees pay, what a
// plain staff login sees of colleagues. Stubbed models, no database.
//   node --test tests/hrmsAccess.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import { getHrScope } from '../utils/hrDeptScope.js';
import {
  canManageStaff,
  canSeeAllEmployeePay,
  canManagePayroll,
  redactEmployee,
  isSelfServiceOnly,
} from '../utils/hrAccess.js';

const q = (data) => {
  const c = { select: () => c, lean: async () => data, then: (a, b) => Promise.resolve(data).then(a, b) };
  return c;
};
// No department headed by anyone unless a test says so.
let headed = [];
Department.find = () => q(headed);
Department.findById = () => q(null);
Department.findOne = () => q(null);
Employee.find = () => q([{ _id: 'e1' }, { _id: 'e2' }]);

const scope = (user, keys = []) => getHrScope({ user }, keys);

test('a lone staff.* sub-key is NOT company-wide HR any more', async () => {
  assert.equal((await scope({ role: 'x', permissions: ['staff.slots'] }, ['staff.employees'])).wide, false);
  assert.equal((await scope({ role: 'x', permissions: ['staff.evaluation'] }, ['hr_files'])).wide, false);
});

test('the sub-key still opens its own module', async () => {
  assert.equal((await scope({ role: 'x', permissions: ['staff.attendance'] }, ['staff.attendance'])).wide, true);
  assert.equal((await scope({ role: 'x', permissions: ['staff.employees'] }, ['staff.employees'])).wide, true);
});

test('the whole staff module (CRM / Artist Head, kept by the owner) is still HR-wide', async () => {
  assert.equal((await scope({ role: 'crm', permissions: ['staff'] }, ['hr_files'])).wide, true);
});

test('the hr login role is HR-wide everywhere', async () => {
  assert.equal((await scope({ role: 'hr', permissions: [] }, ['staff.employees'])).wide, true);
  assert.equal((await scope({ role: 'hr', permissions: [] }, ['recruitment'])).wide, true);
});

test('a department head is limited to their own department', async () => {
  headed = [{ _id: 'd1', key: 'sales', name: 'Sales' }];
  const s = await scope({ role: 'sales_manager', permissions: [], employeeId: 'emp9' }, ['staff.employees']);
  headed = [];
  assert.equal(s.wide, false);
  assert.deepEqual(s.employeeIds, ['e1', 'e2']);
});

test('a plain login has no HR scope', async () => {
  assert.equal((await scope({ role: 'employee', permissions: ['leave'] }, ['staff.employees'])).none, true);
});

test('managing staff: sub-key holders out, hr role and staff.employees in', () => {
  assert.equal(canManageStaff({ role: 'x', permissions: ['staff.slots'] }), false);
  assert.equal(canManageStaff({ role: 'x', permissions: ['staff.employees'] }), true);
  assert.equal(canManageStaff({ role: 'hr', permissions: [] }), true);
  assert.equal(canManageStaff({ role: 'x', permissions: [], isDepartmentHead: true }), true); // scoped to own team elsewhere
});

test('company-wide pay: HR, payroll and finance — not department heads, not sub-keys', () => {
  assert.equal(canSeeAllEmployeePay({ role: 'hr' }), true);
  assert.equal(canSeeAllEmployeePay({ role: 'accounts' }), true);
  assert.equal(canSeeAllEmployeePay({ role: 'x', permissions: ['staff'] }), true);
  assert.equal(canSeeAllEmployeePay({ role: 'x', permissions: ['staff.slots'] }), false);
  assert.equal(canSeeAllEmployeePay({ role: 'sales_manager', isDepartmentHead: true, permissions: [] }), false);
  assert.equal(canManagePayroll({ role: 'hr' }), true);
});

const emp = { _id: 'e1', name: 'Asha', designation: 'Artist', phone: '999', email: 'a@x', baseSalary: 20000, accountNumber: '1' };

test('a department head sees their team WITHOUT pay', () => {
  const head = { role: 'sales_manager', isDepartmentHead: true, permissions: [] };
  const out = redactEmployee(emp, head, { wide: false, none: false, employeeIds: ['e1'] });
  assert.equal(out.baseSalary, undefined);
  assert.equal(out.accountNumber, undefined);
  assert.equal(out.phone, '999'); // team contact details stay
});

test('a plain staff login sees only name and position of a colleague', () => {
  const artist = { role: 'artist', employeeId: 'e2' };
  assert.equal(isSelfServiceOnly(artist), true);
  const out = redactEmployee(emp, artist, { wide: false, none: true, employeeIds: [] });
  assert.deepEqual(Object.keys(out).sort(), ['_id', 'designation', 'name']);
});

test('everyone still sees their own record in full', () => {
  const me = { role: 'artist', employeeId: 'e1' };
  const out = redactEmployee(emp, me, { wide: false, none: true, employeeIds: [] });
  assert.equal(out.baseSalary, 20000);
  assert.equal(out.phone, '999');
});
