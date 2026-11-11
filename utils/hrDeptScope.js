// Department-head scoping for HR modules (owner decision 2026-11-06):
// a department head manages HR only for THEIR OWN department's staff.
//
// Company-wide HR rights ("HR-wide") stay with:
//   • admin / manager roles
//   • any role granted the 'staff' module (e.g. CRM, Artist Head) — unchanged
//   • any role granted the module's own permission key (e.g. 'leave', 'lms')
//   • the head of the HR department (Department.key === 'hr')
//
// Everyone else who is a department head is scoped to the employees of the
// department(s) they head. Plain employees have no HR scope at all (each
// controller keeps its own "own record" rules for them).

import Department from '../models/Department.js';
import Employee from '../models/Employee.js';
import { resolveUserDeptName } from './departmentScope.js';

const roleOf = (u) => String(u?.role || '').trim().toLowerCase();
const permsOf = (u) => (Array.isArray(u?.permissions) ? u.permissions.map(String) : []);
const hasModule = (u, m) => permsOf(u).some((p) => p === m || p.startsWith(`${m}.`));
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/// Departments this user heads: Department.head === their employee record,
/// plus (when flagged isDepartmentHead) the department on their own profile.
async function headedDepartments(user) {
  const out = new Map(); // id -> { id, key, name }
  if (user?.employeeId) {
    const rows = await Department.find({ head: user.employeeId }).select('key name').lean();
    for (const d of rows) out.set(String(d._id), { id: String(d._id), key: d.key, name: d.name });
  }
  if (user?.isDepartmentHead) {
    if (user.departmentId) {
      const d = await Department.findById(user.departmentId).select('key name').lean();
      if (d) out.set(String(d._id), { id: String(d._id), key: d.key, name: d.name });
    }
    if (out.size === 0) {
      const name = await resolveUserDeptName(user);
      if (name) {
        const d = await Department.findOne({ name: new RegExp(`^${esc(name)}$`, 'i') }).select('key name').lean();
        out.set(d ? String(d._id) : `name:${name}`, { id: d ? String(d._id) : null, key: d?.key || '', name });
      }
    }
  }
  return [...out.values()];
}

/**
 * Resolves (and caches on req) the caller's HR scope for a module.
 *   { wide: true }                         → every employee
 *   { wide: false, employeeIds, deptNames } → only these employees
 *   { wide: false, none: true }            → no HR scope (not a manager)
 *
 * @param {import('express').Request} req
 * @param {string[]} moduleKeys permission keys that grant company-wide rights for this module
 */
export async function getHrScope(req, moduleKeys = []) {
  const user = req.user;
  const cacheKey = `_hrScope:${moduleKeys.join(',')}`;
  if (req[cacheKey]) return req[cacheKey];

  let scope;
  if (['admin', 'manager'].includes(roleOf(user)) || hasModule(user, 'staff') ||
      moduleKeys.some((k) => hasModule(user, k))) {
    scope = { wide: true };
  } else {
    const depts = await headedDepartments(user);
    if (depts.some((d) => d.key === 'hr')) {
      scope = { wide: true };
    } else if (depts.length === 0) {
      scope = { wide: false, none: true, employeeIds: [], deptNames: [] };
    } else {
      const ids = depts.map((d) => d.id).filter(Boolean);
      const names = depts.map((d) => d.name).filter(Boolean);
      const or = [];
      if (ids.length) or.push({ departmentId: { $in: ids } });
      for (const n of names) or.push({ department: new RegExp(`^${esc(n)}$`, 'i') });
      const emps = or.length ? await Employee.find({ $or: or }).select('_id').lean() : [];
      scope = {
        wide: false,
        none: false,
        employeeIds: emps.map((e) => String(e._id)),
        deptNames: names,
      };
    }
  }
  req[cacheKey] = scope;
  return scope;
}

/// True when the caller may manage records of `employeeId` in this module.
export async function canManageEmployee(req, employeeId, moduleKeys = []) {
  const s = await getHrScope(req, moduleKeys);
  if (s.wide) return true;
  if (s.none || !employeeId) return false;
  return s.employeeIds.includes(String(employeeId?._id ?? employeeId));
}

/// Mongo filter limiting a list to the caller's scope ({} when HR-wide).
/// `field` is the employee reference on the collection (default employeeId).
export async function scopeFilter(req, moduleKeys = [], field = 'employeeId') {
  const s = await getHrScope(req, moduleKeys);
  if (s.wide) return {};
  return { [field]: { $in: s.employeeIds } };
}

/// Mongo filter on a free-text department field (recruitment items).
export async function deptNameFilter(req, moduleKeys = [], field = 'department') {
  const s = await getHrScope(req, moduleKeys);
  if (s.wide) return {};
  if (!s.deptNames.length) return { [field]: { $in: [] } };
  return { $or: s.deptNames.map((n) => ({ [field]: new RegExp(`^${esc(n)}$`, 'i') })) };
}

/// True for HR-wide callers only (company master data: designations, leave
/// types, holidays, templates, plans, shift definitions…).
export async function isHrWide(req, moduleKeys = []) {
  return (await getHrScope(req, moduleKeys)).wide === true;
}

/// Throws a 403 (for asyncHandler controllers) unless in scope.
export async function assertEmployeeInScope(req, res, employeeId, moduleKeys = []) {
  if (!(await canManageEmployee(req, employeeId, moduleKeys))) {
    res.status(403);
    throw new Error('This employee is not in your department');
  }
}
