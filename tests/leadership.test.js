// Pure unit tests: node --test tests/leadership.test.js
// Leadership = the CEO and the Executive Director: one list, no pay, and keys an admin cannot tick for them.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEADERSHIP_ROLES, isLeadership, isLeadershipRole, leadershipTitle, LEADERSHIP_BANNED_PERMISSIONS, clampPermissions,
} from '../utils/leadership.js';
import { LEADERSHIP_PERMISSIONS } from '../controllers/roleController.js';
import {
  canSeeAllEmployeePay, canSeeEmployeePay, canManagePayroll, canManageHra, canManageStaff, canSeeAttendance, redactEmployee, SENSITIVE_EMPLOYEE_FIELDS,
} from '../utils/hrAccess.js';
import { isFullGeoAccess } from '../utils/geoScope.js';
import { mapRoleToDepartmentAndCategory } from '../utils/syncUserEmployee.js';
import { seesAllProjects, accessSummary } from '../utils/projectAccess.js';
import { isApprover, APPROVER_ROLES } from '../utils/departmentScope.js';

const leader = (role = 'ceo') => ({ role, permissions: LEADERSHIP_PERMISSIONS });

test('who is leadership: the CEO and the Executive Director, however the role is written', () => {
  assert.deepEqual(LEADERSHIP_ROLES, ['ceo', 'executive_director']);
  for (const role of ['ceo', ' CEO ', 'executive_director', 'Executive_Director', ' executive_director ']) {
    assert.equal(isLeadershipRole(role), true, role);
    assert.equal(isLeadership({ role }), true, role);
  }
  for (const role of ['admin', 'manager', 'accounts', 'finance_head', 'ceo_assistant', 'executive', 'director', 'executive_coordinator', '', undefined, null]) {
    assert.equal(isLeadershipRole(role), false, String(role));
    assert.equal(isLeadership({ role }), false, String(role));
  }
  assert.equal(isLeadership(undefined), false);
  assert.equal(isLeadership(null), false);
});

test('how the role reads on screen', () => {
  assert.equal(leadershipTitle('ceo'), 'CEO');
  assert.equal(leadershipTitle('executive_director'), 'Executive Director');
  assert.equal(leadershipTitle(' Executive_Director '), 'Executive Director');
});

test('the banned keys: the parents that open pay, the backup and the system — and the pay sub-keys', () => {
  for (const k of ['staff', 'payables', 'company_finance', 'it', 'settings', 'compensation', 'recruitment', 'offboarding', 'hr_letters', 'hr_files', 'staff.salaries', 'payables.admin_salaries', 'payables.operations_salaries', 'payables.hra']) {
    assert.ok(LEADERSHIP_BANNED_PERMISSIONS.includes(k), k);
  }
});

test('clamp: a leadership role loses the banned keys, whatever an admin ticked; everything else stays', () => {
  const ticked = ['dashboard', 'ceo', 'staff', 'payables', 'payables.dashboard', 'it', 'settings', 'compensation', 'staff.evaluation', 'payables.hra', 'company_finance.month_end', 'company_finance'];
  for (const role of ['ceo', 'executive_director', ' CEO ']) {
    assert.deepEqual(clampPermissions(role, ticked), ['dashboard', 'ceo', 'payables.dashboard', 'staff.evaluation', 'company_finance.month_end'], role);
  }
});

test('clamp: any other role is returned untouched (a finance head keeps payables and company_finance)', () => {
  const ticked = ['staff', 'payables', 'it', 'company_finance', 'compensation'];
  for (const role of ['finance_head', 'admin', 'manager', 'accounts', 'custom_role', '']) assert.deepEqual(clampPermissions(role, ticked), ticked, role);
});

test('clamp: the real default permissions of the CEO / Executive Director are not touched (it would silently break the role)', () => {
  assert.deepEqual(clampPermissions('ceo', LEADERSHIP_PERMISSIONS), LEADERSHIP_PERMISSIONS);
  assert.deepEqual(clampPermissions('executive_director', LEADERSHIP_PERMISSIONS), LEADERSHIP_PERMISSIONS);
  for (const k of LEADERSHIP_PERMISSIONS) assert.ok(!LEADERSHIP_BANNED_PERMISSIONS.includes(k), `${k} is both granted and banned`);
});

test('the default leadership permissions are sub-keys only where a parent would open pay', () => {
  for (const parent of ['staff', 'payables', 'company_finance', 'it', 'settings', 'compensation']) {
    assert.ok(!LEADERSHIP_PERMISSIONS.includes(parent), parent);
  }
});

// ── pay: the 'staff.evaluation' prefix problem ───────────────────────────────

test('the CEO and the Executive Director are never pay viewers — although staff.evaluation opens the "staff" module by prefix', () => {
  for (const role of LEADERSHIP_ROLES) {
    const u = leader(role);
    assert.equal(canSeeAllEmployeePay(u), false, role);
    assert.equal(canSeeEmployeePay(u), false, role);
    assert.equal(canManagePayroll(u), false, role);
    assert.equal(canManageHra(u), false, role);
  }
});

test('…but they can still read the people and attendance views (that is not pay)', () => {
  for (const role of LEADERSHIP_ROLES) {
    assert.equal(canManageStaff(leader(role)), true, role);
    assert.equal(canSeeAttendance(leader(role)), true, role);
  }
});

test('even a leadership role that somehow carries a pay key is not a pay viewer', () => {
  for (const role of LEADERSHIP_ROLES) {
    const u = { role, permissions: ['staff', 'staff.salaries', 'payables.hra', 'payables.admin_salaries'] };
    assert.equal(canSeeAllEmployeePay(u), false);
    assert.equal(canManagePayroll(u), false);
    assert.equal(canManageHra(u), false);
  }
});

test('the control group is unchanged: HR, payroll, Accounts and admins still see pay', () => {
  assert.equal(canSeeAllEmployeePay({ role: 'admin', permissions: [] }), true);
  assert.equal(canSeeAllEmployeePay({ role: 'manager', permissions: [] }), true);
  assert.equal(canSeeAllEmployeePay({ role: 'crm', permissions: ['staff'] }), true);
  assert.equal(canSeeAllEmployeePay({ role: 'accounts', permissions: [] }), true);
  assert.equal(canManagePayroll({ role: 'finance_head', permissions: [] }), true);
  assert.equal(canManageHra({ role: 'crm', permissions: ['staff.salaries'] }), true);
  assert.equal(canSeeEmployeePay({ role: 'crm', permissions: ['staff.evaluation'] }), true, 'any other role with a staff sub-key behaves as before');
});

const emp = (extra = {}) => ({
  _id: 'e1', name: 'Amna', department: 'Sales',
  baseSalary: 73719.37, allowances: 1, deductions: 2, hra: 3, hraDay: 1, salaryType: 'monthly', bankName: 'ZZ-SENTINEL-BANK',
  accountNumber: '1234567890', ifscCode: 'X', upiId: 'a@b', panNumber: 'PAN', statutoryApplicability: {}, overtimeRate: 9,
  currentGrade: 'G3', emergencyContact: 'Mum', dateOfBirth: '1990-01-01', ...extra,
});

test('redactEmployee: for the CEO / Executive Director every sensitive field goes — even with a wide HR scope', () => {
  for (const role of LEADERSHIP_ROLES) {
    const u = { ...leader(role), employeeId: 'someone-else' };
    for (const scope of [null, { wide: true }, { wide: false, none: false, employeeIds: ['e1'] }]) {
      const out = redactEmployee(emp(), u, scope);
      for (const f of SENSITIVE_EMPLOYEE_FIELDS) assert.equal(out[f], undefined, `${role} ${f} ${JSON.stringify(scope)}`);
      assert.equal(out.name, 'Amna');
      assert.equal(out.department, 'Sales');
    }
  }
});

test('redactEmployee: a leader still sees their own record', () => {
  const u = { ...leader('executive_director'), employeeId: 'e1' };
  assert.equal(redactEmployee(emp(), u, { wide: true }).baseSalary, 73719.37);
});

test('redactEmployee: HR (wide scope) and a department head (own team) are unchanged', () => {
  assert.equal(redactEmployee(emp(), { role: 'crm', permissions: ['staff'] }, { wide: true }).baseSalary, 73719.37);
  assert.equal(redactEmployee(emp(), { role: 'sales', isDepartmentHead: true, permissions: [] }, { wide: false, employeeIds: ['e1'] }).baseSalary, 73719.37);
  assert.equal(redactEmployee(emp(), { role: 'sales', permissions: [] }, { wide: false, none: true, employeeIds: [] }).baseSalary, undefined);
});

// ── the rest of the company's rules that name the leaders ────────────────────

test('territory: a leader sees the whole company even if a district was pinned on the login', () => {
  for (const role of LEADERSHIP_ROLES) {
    assert.equal(isFullGeoAccess({ role, districtId: 'd1', regionId: 'r1' }), true, role);
  }
  // the control: an ordinary role with a district pinned is limited to it
  assert.equal(isFullGeoAccess({ role: 'sales', districtId: 'd1' }), false);
  assert.equal(isFullGeoAccess({ role: 'admin', districtId: 'd1' }), true);
});

test('the staff list: a leader appears under Management with their own title, not as a generic "Manager"', () => {
  const ceo = mapRoleToDepartmentAndCategory('ceo');
  assert.deepEqual([ceo.department, ceo.role, ceo.category, ceo.specialization], ['Management', 'CEO', 'administrative', 'Leadership']);
  const ed = mapRoleToDepartmentAndCategory('executive_director');
  assert.deepEqual([ed.department, ed.role, ed.category, ed.specialization], ['Management', 'Executive Director', 'administrative', 'Leadership']);
  assert.equal(mapRoleToDepartmentAndCategory('executive_director', 'Executive Director, Creative').role, 'Executive Director, Creative', 'a title typed in wins');
  // others are as before
  assert.equal(mapRoleToDepartmentAndCategory('admin').department, 'General');
  assert.equal(mapRoleToDepartmentAndCategory('sales_manager').department, 'Sales');
});

test('projects: both leaders see every project; neither can run one — only decide on a proposal', async () => {
  for (const role of LEADERSHIP_ROLES) assert.equal(await seesAllProjects({ role, permissions: [] }), true, role);
  assert.equal(await seesAllProjects({ role: 'sales', permissions: [] }), false);
  // view-only: the project list says so to the app
  const project = { status: 'planning', targetDepartment: 'Management', departments: [], members: [], editMode: 'open' };
  const ctx = { full: true, viewOnly: true, empId: '', isHead: false, deptName: '' };
  const a = accessSummary(project, ctx);
  assert.deepEqual([a.canManage, a.canCreateTasks, a.canEditAllTasks, a.role], [false, false, false, 'viewer']);
  assert.equal(accessSummary({ ...project, status: 'proposed' }, ctx).canDecide, true);
});

test('expenses: both leaders are approvers for READING every department (their writes are refused by the guard)', () => {
  for (const role of LEADERSHIP_ROLES) {
    assert.ok(APPROVER_ROLES.includes(role), role);
    assert.equal(isApprover({ role }), true, role);
  }
  assert.equal(isApprover({ role: 'sales' }), false);
});
