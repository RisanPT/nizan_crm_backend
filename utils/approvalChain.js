import User from '../models/User.js';

/**
 * Single-level approval chain for an employee's self-service request:
 * reporting manager → department head → any `manager` role. Shared by every HR
 * module that routes through the approval engine (leave, regularization,
 * timesheet, reimbursement, travel…).
 */
export async function buildEmployeeApprovalChain(employee) {
  let approverUserId = null;
  if (employee?.reportingManagerId) {
    const mgr = await User.findOne({
      employeeId: employee.reportingManagerId,
      active: { $ne: false },
    }).select('_id');
    if (mgr) approverUserId = mgr._id;
  }
  if (!approverUserId && employee?.departmentId) {
    const head = await User.findOne({
      departmentId: employee.departmentId,
      isDepartmentHead: true,
      active: { $ne: false },
    }).select('_id');
    if (head) approverUserId = head._id;
  }
  if (approverUserId) return [{ label: 'Reporting manager', approverUserId }];
  return [{ label: 'Manager', approverRole: 'manager' }];
}
