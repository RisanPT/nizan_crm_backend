import asyncHandler from 'express-async-handler';
import Timesheet from '../models/Timesheet.js';
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
  return perms.includes('staff') || perms.includes('timesheet');
};

const sumHours = (entries) =>
  (Array.isArray(entries) ? entries : []).reduce((t, e) => t + (Number(e.hours) || 0), 0);

const cleanEntries = (entries) =>
  (Array.isArray(entries) ? entries : [])
    .filter((e) => e && e.date)
    .map((e) => ({
      date: new Date(e.date),
      project: String(e.project || '').trim(),
      hours: Number(e.hours) || 0,
      note: String(e.note || '').trim(),
    }));

// @route GET /api/timesheets/mine
const getMyTimesheets = asyncHandler(async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.json([]);
  const rows = await Timesheet.find({ employeeId }).sort({ periodStart: -1 }).limit(60).lean();
  res.json(rows);
});

// @route GET /api/timesheets/requests  (HR / manager)
const getTimesheets = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  else filter.status = { $ne: 'draft' }; // managers see submitted work, not drafts
  const rows = await Timesheet.find(filter).populate(empPopulate).sort({ periodStart: -1 }).limit(200);
  res.json(rows);
});

// @route POST /api/timesheets  — create or update the caller's draft for a period
const saveTimesheet = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to file for others'); }
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }

  if (!req.body.periodStart) { res.status(400); throw new Error('A period is required'); }
  const employee = await Employee.findById(employeeId).select('name department');
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const periodStart = new Date(req.body.periodStart);
  const entries = cleanEntries(req.body.entries);

  let ts = await Timesheet.findOne({ employeeId, periodStart });
  if (ts && ts.status !== 'draft') {
    res.status(409);
    throw new Error('This period is already submitted and can no longer be edited.');
  }
  if (!ts) {
    ts = new Timesheet({ employeeId, employeeName: employee.name, department: employee.department || '', periodStart });
  }
  ts.periodType = req.body.periodType === 'monthly' ? 'monthly' : 'weekly';
  ts.periodLabel = String(req.body.periodLabel || '').trim();
  ts.entries = entries;
  ts.totalHours = sumHours(entries);
  ts.status = 'draft';
  ts.createdBy = req.user?._id || null;
  await ts.save();
  res.status(201).json(ts);
});

// @route POST /api/timesheets/:id/submit
const submitTimesheet = asyncHandler(async (req, res) => {
  const ts = await Timesheet.findById(req.params.id);
  if (!ts) { res.status(404); throw new Error('Timesheet not found'); }
  const owns = String(ts.employeeId) === String(req.user.employeeId || '');
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  if (ts.status !== 'draft') { res.status(409); throw new Error('Only a draft can be submitted'); }
  if (!ts.entries.length) { res.status(400); throw new Error('Add at least one entry before submitting'); }

  ts.status = 'pending';
  await ts.save();

  const employee = await Employee.findById(ts.employeeId);
  const chain = employee ? await buildEmployeeApprovalChain(employee) : [{ label: 'Manager', approverRole: 'manager' }];
  const approval = await createApproval({
    module: 'timesheet',
    title: `Timesheet — ${ts.employeeName}`,
    summary: `${ts.periodLabel || 'Period'} · ${ts.totalHours}h`,
    requesterEmployeeId: ts.employeeId,
    requesterUserId: req.user?._id || null,
    subjectEmployeeId: ts.employeeId,
    refModel: 'Timesheet',
    refId: ts._id,
    chain,
    link: '/hr/approvals',
    createdBy: req.user?._id || null,
  });
  ts.approvalId = approval._id;
  await ts.save();
  res.json(ts);
});

// @route DELETE /api/timesheets/:id  — draft only
const deleteTimesheet = asyncHandler(async (req, res) => {
  const ts = await Timesheet.findById(req.params.id);
  if (!ts) { res.status(404); throw new Error('Timesheet not found'); }
  const owns = String(ts.employeeId) === String(req.user.employeeId || '');
  if (!owns && !canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  if (ts.status !== 'draft') { res.status(409); throw new Error('Only a draft can be deleted'); }
  await ts.deleteOne();
  res.json({ message: 'Timesheet removed', id: req.params.id });
});

export { getMyTimesheets, getTimesheets, saveTimesheet, submitTimesheet, deleteTimesheet };
