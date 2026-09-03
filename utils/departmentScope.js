import Department from '../models/Department.js';
import Employee from '../models/Employee.js';

// Accounts + Admin are the approvers: they see every department and manage all
// of them. Everyone else acts within their OWN department only.
export const APPROVER_ROLES = ['admin', 'accounts'];
export const isApprover = (user) => APPROVER_ROLES.includes(user?.role);

// The department NAME a user is scoped to. Resolved in priority order so a
// department head is recognised however their record is set up:
//   1. User.departmentId → Department.name
//   2. their linked Employee's departmentId → Department.name
//   3. their linked Employee's free-text `department`
// Returns '' only when none of those are set.
export const resolveUserDeptName = async (user) => {
  if (user?.departmentId) {
    const dept = await Department.findById(user.departmentId).select('name').lean();
    if (dept?.name?.trim()) return dept.name.trim();
  }
  if (user?.employeeId) {
    const emp = await Employee.findById(user.employeeId)
      .select('department departmentId')
      .lean();
    if (emp?.departmentId) {
      const d = await Department.findById(emp.departmentId).select('name').lean();
      if (d?.name?.trim()) return d.name.trim();
    }
    if (emp?.department?.trim()) return emp.department.trim();
  }
  return '';
};
