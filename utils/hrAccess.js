// Server-side gates for HR / payroll data. They mirror the permission keys the
// Flutter app already uses to show these screens (app_router.dart), so nobody
// who can open a screen today loses access — but a login that can't see the
// screen (e.g. an ESS 'employee' account) can no longer call the API directly.
//
// Mount `attachRolePermissions` before these so req.user.permissions is set.

import { isLeadership } from './leadership.js';

const roleOf = (user) => String(user?.role || '').trim().toLowerCase();
const permsOf = (user) => (Array.isArray(user?.permissions) ? user.permissions.map(String) : []);

/// True when the user holds `key` itself or its parent module
/// ('staff' grants 'staff.salaries').
export const hasPerm = (user, key) => {
  const perms = permsOf(user);
  if (perms.includes(key)) return true;
  const dot = key.indexOf('.');
  return dot > 0 && perms.includes(key.slice(0, dot));
};

/// True when the user holds the module or ANY of its sub-keys.
export const hasModule = (user, module) =>
  permsOf(user).some((p) => p === module || p.startsWith(`${module}.`));

export const isFullAccess = (user) => ['admin', 'manager'].includes(roleOf(user));

const FINANCE_ROLES = ['accounts', 'finance_head'];

/// Salary slips / payroll runs: HR salaries screen (staff.salaries) or the
/// Accounts salary + attendance-payroll screens (payables.*).
// The CEO and the Executive Director never see pay (totals reach them through the dashboards): whatever permissions their role
// holds, `staff.evaluation` for instance, which opens the 'staff' module by prefix, these stay false for them.
export const canManagePayroll = (user) =>
  !isLeadership(user) &&
  (isFullAccess(user) ||
    FINANCE_ROLES.includes(roleOf(user)) ||
    hasPerm(user, 'staff.salaries') ||
    hasPerm(user, 'payables.admin_salaries') ||
    hasPerm(user, 'payables.operations_salaries'));

/// HRA records (Accounts → HRA).
export const canManageHra = (user) =>
  !isLeadership(user) &&
  (isFullAccess(user) ||
    FINANCE_ROLES.includes(roleOf(user)) ||
    hasPerm(user, 'payables.hra') ||
    hasPerm(user, 'staff.salaries'));

/// HR staff records and HR modules (who may manage employees).
export const canManageStaff = (user) =>
  isFullAccess(user) || user?.isDepartmentHead === true || hasModule(user, 'staff');

/// May see salary / bank / ID fields on employee records.
export const canSeeEmployeePay = (user) => !isLeadership(user) && (canManageStaff(user) || canManagePayroll(user) || canManageHra(user));

/// Attendance (Timebox) views.
export const canSeeAttendance = (user) => canManageStaff(user) || canManagePayroll(user);

/// Express middleware factory: 403 unless `check(req.user)` passes.
export const requireAccess = (check, message = 'You are not allowed to do this') => (req, res, next) => {
  if (check(req.user)) return next();
  return res.status(403).json({ message });
};

/// Employee fields only HR / payroll may read.
export const SENSITIVE_EMPLOYEE_FIELDS = [
  'baseSalary',
  'allowances',
  'deductions',
  'hra',
  'hraDay',
  'salaryType',
  'bankName',
  'accountNumber',
  'ifscCode',
  'upiId',
  'panNumber',
  'statutoryApplicability',
  'overtimeRate',
  'currentGrade',
  'emergencyContact',
  'dateOfBirth',
];

/// Company-wide pay visibility: HR (staff module), payroll, HRA, admin/manager.
/// Department heads are NOT here — they see pay only for their own team.
export const canSeeAllEmployeePay = (user) =>
  !isLeadership(user) && (isFullAccess(user) || hasModule(user, 'staff') || canManagePayroll(user) || canManageHra(user));

/// Strips pay / bank / personal fields from an employee (doc or plain object)
/// unless the viewer may see them. A user always sees their own record; a
/// department head sees their own department's (pass `scope` from
/// getHrScope(req, ['staff'])).
export const redactEmployee = (emp, viewer, scope = null) => {
  if (!emp) return emp;
  // The CEO / Executive Director are "HR-wide" for reading (by the 'staff.evaluation' prefix) but never for pay: only their own record.
  const leader = isLeadership(viewer);
  if (!leader && (canSeeAllEmployeePay(viewer) || scope?.wide)) return emp;
  const obj = typeof emp.toObject === 'function' ? emp.toObject() : { ...emp };
  const id = String(obj._id);
  const own = viewer?.employeeId && String(viewer.employeeId) === id;
  if (own) return obj;
  if (!leader && scope && !scope.none && scope.employeeIds?.includes(id)) return obj;
  for (const f of SENSITIVE_EMPLOYEE_FIELDS) delete obj[f];
  return obj;
};
