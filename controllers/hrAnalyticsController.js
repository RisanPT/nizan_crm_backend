import asyncHandler from 'express-async-handler';
import Employee from '../models/Employee.js';
import Onboarding from '../models/Onboarding.js';
import Offboarding from '../models/Offboarding.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import Grievance from '../models/Grievance.js';
import LeaveRequest from '../models/LeaveRequest.js';

const canView = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('hr_analytics') || perms.includes('staff');
};

// @route GET /api/hr-analytics/summary
const getSummary = asyncHandler(async (req, res) => {
  if (!canView(req.user)) { res.status(403); throw new Error('Not allowed'); }

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
    Employee.countDocuments({ status: 'active' }),
    Employee.countDocuments({ status: 'inactive' }),
    Employee.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: { $ifNull: ['$department', 'Unassigned'] }, count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    Employee.countDocuments({ createdAt: { $gte: monthStart } }),
    Onboarding.countDocuments({ status: 'in_progress' }),
    Offboarding.countDocuments({ status: 'in_progress' }),
    ApprovalRequest.countDocuments({ status: 'pending' }),
    Grievance.countDocuments({ status: { $in: ['open', 'in_review'] } }),
    LeaveRequest.countDocuments({ status: 'pending' }),
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
