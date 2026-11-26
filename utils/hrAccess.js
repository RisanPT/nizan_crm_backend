// Server-side gates for HR / payroll data. They mirror the permission keys the
// Flutter app already uses to show these screens (app_router.dart), so nobody
// who can open a screen today loses access — but a login that can't see the
// screen (e.g. an ESS 'employee' account) can no longer call the API directly.
//
// Mount `attachRolePermissions` before these so req.user.permissions is set.

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
export const canManagePayroll = (user) =>
  isFullAccess(user) ||
  isHrRoleUser(user) ||
  FINANCE_ROLES.includes(roleOf(user)) ||
  hasPerm(user, 'staff.salaries') ||
  hasPerm(user, 'payables.admin_salaries') ||
  hasPerm(user, 'payables.operations_salaries');

/// HRA records (Accounts → HRA).
export const canManageHra = (user) =>
  isFullAccess(user) ||
  FINANCE_ROLES.includes(roleOf(user)) ||
  hasPerm(user, 'payables.hra') ||
  hasPerm(user, 'staff.salaries');

/// The `hr` login role: all of HRMS (owner 2026-11-26).
export const isHrRoleUser = (user) => roleOf(user) === 'hr';

/// HR staff records and HR modules (who may manage employees). A department
/// head passes here but every write is further limited to their own team by
/// getHrScope. A lone unrelated `staff.*` sub-key (e.g. staff.slots) no longer
/// counts — only the whole `staff` module or `staff.employees` (2026-11-26).
export const canManageStaff = (user) =>
  isFullAccess(user) || isHrRoleUser(user) || user?.isDepartmentHead === true || hasPerm(user, 'staff.employees');

/// May see salary / bank / ID fields on employee records.
export const canSeeEmployeePay = (user) => canManageStaff(user) || canManagePayroll(user) || canManageHra(user);

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

/// Company-wide pay visibility: HR (whole staff module / staff.salaries / hr
/// role), payroll, HRA, admin/manager. Department heads are NOT here and, since
/// 2026-11-26 (owner: "team view, no pay"), don't see their team's pay either.
export const canSeeAllEmployeePay = (user) =>
  isFullAccess(user) || isHrRoleUser(user) || hasPerm(user, 'staff.salaries') ||
  canManagePayroll(user) || canManageHra(user);

/// Plain staff logins (self-service only): they see colleagues as a bare list
/// (name, designation, department) — enough for the app's pickers — and only
/// their OWN record in full (owner 2026-11-26: "staff see only themselves").
export const SELF_SERVICE_ROLES = ['employee', 'artist', 'driver'];
export const isSelfServiceOnly = (user) => SELF_SERVICE_ROLES.includes(roleOf(user));
const MINIMAL_EMPLOYEE_FIELDS = [
  '_id', 'name', 'employeeCode', 'designation', 'designationId', 'department', 'departmentId',
  'artistRole', 'status', 'profileImage', 'photoUrl',
];

/// Strips pay / bank / personal fields from an employee (doc or plain object)
/// unless the viewer may see them. A user always sees their own record.
/// Self-service logins see only the minimal fields of anyone else.
export const redactEmployee = (emp, viewer, scope = null) => {
  if (!emp) return emp;
  if (canSeeAllEmployeePay(viewer) || (scope?.wide && !isSelfServiceOnly(viewer))) return emp;
  const obj = typeof emp.toObject === 'function' ? emp.toObject() : { ...emp };
  const id = String(obj._id);
  const own = viewer?.employeeId && String(viewer.employeeId) === id;
  if (own) return obj;
  if (isSelfServiceOnly(viewer)) {
    const out = {};
    for (const f of MINIMAL_EMPLOYEE_FIELDS) if (obj[f] !== undefined) out[f] = obj[f];
    return out;
  }
  for (const f of SENSITIVE_EMPLOYEE_FIELDS) delete obj[f];
  return obj;
};
