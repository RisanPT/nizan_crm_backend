import asyncHandler from 'express-async-handler';
import AttendanceRegularization from '../models/AttendanceRegularization.js';
import Employee from '../models/Employee.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { buildEmployeeApprovalChain } from '../utils/approvalChain.js';
import { scopeFilter, assertEmployeeInScope } from '../utils/hrDeptScope.js';
import { toDayKey } from '../utils/leaveMath.js';
import { isPayrollLocked } from '../models/PayrollLock.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

// Management key for company-wide regularization rights.
const REG_KEYS = ['regularization'];

// Not the plain `leave` key: every employee/artist has it for self-service,
// so it must not unlock everyone's regularizations.
const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('staff') || perms.includes('regularization');
};

// @route GET /api/regularizations/mine
const getMine = asyncHandler(async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.json([]);
  const rows = await AttendanceRegularization.find({ employeeId })
    .sort({ date: -1 })
    .limit(100)
    .lean();
  res.json(rows);
});

// @route GET /api/regularizations/requests  (HR / manager)
const getRequests = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  if (req.query.month) filter.month = Number(req.query.month);
  if (req.query.year) filter.year = Number(req.query.year);
  // Dept heads see only their own department's requests.
  Object.assign(filter, await scopeFilter(req, REG_KEYS));
  const rows = await AttendanceRegularization.find(filter).populate(empPopulate).sort({ date: -1 }).limit(200);
  res.json(rows);
});

// @route POST /api/regularizations
const applyRegularization = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to file for others'); }
    await assertEmployeeInScope(req, res, req.body.employeeId, REG_KEYS);
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }
  if (!req.body.date) { res.status(400); throw new Error('Pick the date to regularize'); }

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const date = new Date(req.body.date);
  if (Number.isNaN(date.getTime())) { res.status(400); throw new Error('Invalid date'); }
  // Only a day that has already started can be regularized (India calendar).
  if (toDayKey(date) > toDayKey(new Date())) {
    res.status(400);
    throw new Error('You cannot regularize a future date');
  }
  // One request per day: a second one for a day that already has a pending or
  // approved request would be counted twice (2026-11-26).
  const dayKey = toDayKey(date);
  const near = await AttendanceRegularization.find({
    employeeId: employee._id,
    status: { $in: ['pending', 'approved'] },
    date: { $gte: new Date(date.getTime() - 36 * 3600000), $lte: new Date(date.getTime() + 36 * 3600000) },
  }).select('date status').lean();
  const same = near.find((r) => toDayKey(r.date) === dayKey);
  if (same) {
    res.status(409);
    throw new Error(`There is already a ${same.status} request for ${dayKey}`);
  }
  // A month whose payroll is locked can't change any more, so a request for it
  // would silently do nothing — say so instead.
  if (await isPayrollLocked(date.getMonth() + 1, date.getFullYear())) {
    res.status(409);
    throw new Error('Payroll for that month is already locked. Ask HR to correct it directly.');
  }
  const reg = await AttendanceRegularization.create({
    employeeId: employee._id,
    employeeName: employee.name,
    department: employee.department || '',
    date,
    type: String(req.body.type || 'missing_punch'),
    requestedInTime: String(req.body.requestedInTime || ''),
    requestedOutTime: String(req.body.requestedOutTime || ''),
    reason: String(req.body.reason || '').trim(),
    status: 'pending',
    month: date.getMonth() + 1,
    year: date.getFullYear(),
    createdBy: req.user?._id || null,
  });

  const chain = await buildEmployeeApprovalChain(employee);
  const approval = await createApproval({
    module: 'regularization',
    title: `Regularization — ${employee.name}`,
    summary: `${reg.type.replace('_', ' ')} · ${date.toDateString()}`,
    requesterEmployeeId: employee._id,
    requesterUserId: req.user?._id || null,
    subjectEmployeeId: employee._id,
    refModel: 'AttendanceRegularization',
    refId: reg._id,
    chain,
    link: '/hr/approvals',
    createdBy: req.user?._id || null,
  });
  reg.approvalId = approval._id;
  await reg.save();

  const populated = await AttendanceRegularization.findById(reg._id).populate(empPopulate);
  res.status(201).json(populated);
});

// @route POST /api/regularizations/:id/cancel  — own pending only
const cancelRegularization = asyncHandler(async (req, res) => {
  const reg = await AttendanceRegularization.findById(req.params.id);
  if (!reg) { res.status(404); throw new Error('Request not found'); }
  const owns = String(reg.employeeId) === String(req.user.employeeId || '');
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  if (!owns) await assertEmployeeInScope(req, res, reg.employeeId, REG_KEYS);
  if (reg.status !== 'pending') { res.status(409); throw new Error('Only a pending request can be cancelled'); }
  reg.status = 'cancelled';
  await reg.save();
  if (reg.approvalId) {
    await ApprovalRequest.updateOne(
      { _id: reg.approvalId, status: 'pending' },
      { $set: { status: 'cancelled' } }
    );
  }
  res.json({ message: 'Request cancelled', id: req.params.id });
});

export { getMine, getRequests, applyRegularization, cancelRegularization };
