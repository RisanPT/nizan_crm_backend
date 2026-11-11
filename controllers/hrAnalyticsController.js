import asyncHandler from 'express-async-handler';
import Employee from '../models/Employee.js';
import Onboarding from '../models/Onboarding.js';
import Offboarding from '../models/Offboarding.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import Grievance from '../models/Grievance.js';
import LeaveRequest from '../models/LeaveRequest.js';
import { getHrScope } from '../utils/hrDeptScope.js';
import mongoose from 'mongoose';

const canView = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('hr_analytics') || perms.includes('staff');
};

// @route GET /api/hr-analytics/summary
// HR-wide users see the whole company; a department head sees their own
// department's numbers only (and never confidential grievances).
const getSummary = asyncHandler(async (req, res) => {
  if (!canView(req.user)) { res.status(403); throw new Error('Not allowed'); }

  const scope = await getHrScope(req, ['hr_analytics']);
  const ids = scope.wide ? null : (scope.employeeIds || []);
  const objIds = ids ? ids.filter((i) => mongoose.isValidObjectId(i)).map((i) => new mongoose.Types.ObjectId(i)) : null;
  const byEmp = (field = 'employeeId') => (ids ? { [field]: { $in: ids } } : {});
  const empSelf = ids ? { _id: { $in: objIds } } : {};

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    active,
    inactive,
    byDepartmentRaw,
    newHires,
    onboardingInProgress,
    exitsInProgress,
    pendingApprovals,
    openGrievances,
    pendingLeave,
  ] = await Promise.all([
    Employee.countDocuments({ ...empSelf, status: 'active' }),
    Employee.countDocuments({ ...empSelf, status: 'inactive' }),
    Employee.aggregate([
      { $match: { ...empSelf, status: 'active' } },
      { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Employee.countDocuments({ ...empSelf, createdAt: { $gte: monthStart } }),
    Onboarding.countDocuments({ ...byEmp(), status: 'in_progress' }),
    Offboarding.countDocuments({ ...byEmp(), status: 'in_progress' }),
    ApprovalRequest.countDocuments({ ...byEmp('subjectEmployeeId'), status: 'pending' }),
    Grievance.countDocuments({
      ...byEmp(),
      ...(ids ? { confidential: { $ne: true } } : {}),
      status: { $in: ['open', 'in_review'] },
    }),
    LeaveRequest.countDocuments({ ...byEmp(), status: 'pending' }),
  ]);

  const byDepartment = byDepartmentRaw.map((d) => ({ department: d._id || 'Unassigned', count: d.count }));

  res.json({
    headcount: { active, inactive, total: active + inactive },
    byDepartment,
    newHiresThisMonth: newHires,
    onboardingInProgress,
    exitsInProgress,
    pendingApprovals,
    pendingLeave,
    openGrievances,
  });
});

export { getSummary };
