import asyncHandler from 'express-async-handler';
import Timesheet from '../models/Timesheet.js';
import Employee from '../models/Employee.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import { createApproval } from '../services/approvals.js';
import { buildEmployeeApprovalChain } from '../utils/approvalChain.js';
import { scopeFilter, assertEmployeeInScope } from '../utils/hrDeptScope.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

// Management key for company-wide timesheet rights.
const TS_KEYS = ['timesheet'];

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
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

/// Hours must be 0–24 per entry and per day. Returns an error message or null.
export const hoursError = (entries) => {
  const perDay = new Map();
  for (const e of entries) {
    const h = Number(e.hours);
    if (!Number.isFinite(h) || h < 0 || h > 24) return 'Hours must be between 0 and 24 for each day.';
    const key = Number.isNaN(e.date.getTime()) ? '' : e.date.toISOString().slice(0, 10);
    perDay.set(key, (perDay.get(key) || 0) + h);
  }
  for (const total of perDay.values()) if (total > 24) return 'A day cannot have more than 24 hours.';
  return null;
};

// Statuses the owner may still edit: a draft, or a rejected sheet being fixed.
const EDITABLE = ['draft', 'rejected'];

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
  // Dept heads see only their own department's timesheets.
  Object.assign(filter, await scopeFilter(req, TS_KEYS));
  const rows = await Timesheet.find(filter).populate(empPopulate).sort({ periodStart: -1 }).limit(200);
  res.json(rows);
});

// @route POST /api/timesheets  — create or update the caller's draft for a period
const saveTimesheet = asyncHandler(async (req, res) => {
  let employeeId = req.user.employeeId;
  const onBehalf = req.body.employeeId && String(req.body.employeeId) !== String(employeeId || '');
  if (onBehalf) {
    if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed to file for others'); }
    await assertEmployeeInScope(req, res, req.body.employeeId, TS_KEYS);
    employeeId = req.body.employeeId;
  }
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }

  if (!req.body.periodStart) { res.status(400); throw new Error('A period is required'); }
  const employee = await Employee.findById(employeeId).select('name department');
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const periodStart = new Date(req.body.periodStart);
  const entries = cleanEntries(req.body.entries);

  if (Number.isNaN(periodStart.getTime())) { res.status(400); throw new Error('Invalid period'); }
  const hoursMsg = hoursError(entries);
  if (hoursMsg) { res.status(400); throw new Error(hoursMsg); }

  const samePeriod = await Timesheet.findOne({ employeeId, periodStart });
  let ts = samePeriod;
  if (req.body.id) {
    // Editing a known sheet: changing its week moves it (never a second copy).
    ts = await Timesheet.findById(req.body.id);
    if (!ts || String(ts.employeeId) !== String(employeeId)) { res.status(404); throw new Error('Timesheet not found'); }
    if (samePeriod && String(samePeriod._id) !== String(ts._id)) {
      res.status(409);
      throw new Error('There is already a timesheet for that week. Open that one instead.');
    }
    ts.periodStart = periodStart;
  }
  if (ts && !EDITABLE.includes(ts.status)) {
    res.status(409);
    throw new Error('This period is already submitted and can no longer be edited.');
  }
  if (ts && ts.status === 'rejected') {
    // Fixing a rejected sheet: back to draft, ready to submit again. The
    // rejection stays on the old approval request.
    ts.approvalId = null;
    ts.decidedBy = null;
    ts.decidedAt = null;
    ts.decisionNote = '';
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
  if (!owns) await assertEmployeeInScope(req, res, ts.employeeId, TS_KEYS);
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
  if (!owns) await assertEmployeeInScope(req, res, ts.employeeId, TS_KEYS);
  if (ts.status !== 'draft') { res.status(409); throw new Error('Only a draft can be deleted'); }
  await ts.deleteOne();
  res.json({ message: 'Timesheet removed', id: req.params.id });
});

export { getMyTimesheets, getTimesheets, saveTimesheet, submitTimesheet, deleteTimesheet };
