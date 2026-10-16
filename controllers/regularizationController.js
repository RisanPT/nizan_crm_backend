import asyncHandler from 'express-async-handler';
import AttendanceRegularization from '../models/AttendanceRegularization.js';
import Employee from '../models/Employee.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { buildEmployeeApprovalChain } from '../utils/approvalChain.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('staff') || perms.includes('leave') || perms.includes('regularization');
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
  const rows = await AttendanceRegularization.find(filter).populate(empPopulate).sort({ date: -1 }).limit(200);
  res.json(rows);
});

// @route POST /api/regularizations
const applyRegularization = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to file for others'); }
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }
  if (!req.body.date) { res.status(400); throw new Error('Pick the date to regularize'); }

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const date = new Date(req.body.date);
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
