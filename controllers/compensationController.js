import asyncHandler from 'express-async-handler';
import SalaryBand from '../models/SalaryBand.js';
import CompensationRevision from '../models/CompensationRevision.js';
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
  return perms.includes('compensation') || perms.includes('staff');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage compensation');
  }
};

// ── Salary bands ─────────────────────────────────────────────────────────────
const getBands = asyncHandler(async (_req, res) => {
  const bands = await SalaryBand.find({}).sort({ level: 1, name: 1 }).lean();
  res.json(bands);
});

const createBand = asyncHandler(async (req, res) => {
  guard(req, res);
  const name = String(req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please provide a band name'); }
  const band = await SalaryBand.create({
    name,
    level: Number(req.body.level) || 1,
    minSalary: Number(req.body.minSalary) || 0,
    maxSalary: Number(req.body.maxSalary) || 0,
    currency: String(req.body.currency || 'INR'),
    notes: String(req.body.notes || '').trim(),
    active: req.body.active !== false,
    createdBy: req.user?._id || null,
  });
  res.status(201).json(band);
});

const updateBand = asyncHandler(async (req, res) => {
  guard(req, res);
  const band = await SalaryBand.findById(req.params.id);
  if (!band) { res.status(404); throw new Error('Band not found'); }
  const b = req.body;
  if (b.name !== undefined && String(b.name).trim()) band.name = String(b.name).trim();
  if (b.level !== undefined) band.level = Number(b.level) || 1;
  if (b.minSalary !== undefined) band.minSalary = Number(b.minSalary) || 0;
  if (b.maxSalary !== undefined) band.maxSalary = Number(b.maxSalary) || 0;
  if (b.currency !== undefined) band.currency = String(b.currency);
  if (b.notes !== undefined) band.notes = String(b.notes).trim();
  if (b.active !== undefined) band.active = Boolean(b.active);
  await band.save();
  res.json(band);
});

const deleteBand = asyncHandler(async (req, res) => {
  guard(req, res);
  const band = await SalaryBand.findByIdAndDelete(req.params.id);
  if (!band) { res.status(404); throw new Error('Band not found'); }
  res.json({ message: 'Band removed', id: req.params.id });
});

// ── Revisions ────────────────────────────────────────────────────────────────
const getRevisions = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const filter = {};
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  const rows = await CompensationRevision.find(filter).populate(empPopulate).sort({ createdAt: -1 }).limit(300);
  res.json(rows);
});

// @route POST /api/compensation/revisions  — propose a revision (→ approval)
const proposeRevision = asyncHandler(async (req, res) => {
  guard(req, res);
  const employeeId = String(req.body.employeeId || '').trim();
  const proposedSalary = Number(req.body.proposedSalary) || 0;
  if (!employeeId) { res.status(400); throw new Error('An employee is required'); }
  if (proposedSalary <= 0) { res.status(400); throw new Error('Proposed salary must be greater than zero'); }

  const employee = await Employee.findById(employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const rev = await CompensationRevision.create({
    employeeId: employee._id,
    employeeName: employee.name,
    department: employee.department || '',
    currentSalary: employee.baseSalary || 0,
    proposedSalary,
    effectiveDate: req.body.effectiveDate ? new Date(req.body.effectiveDate) : null,
    reason: String(req.body.reason || '').trim(),
    status: 'pending',
    createdBy: req.user?._id || null,
  });

  // Compensation revisions escalate to a `manager` by default (not the subject's
  // own reporting manager, since the subject may be a manager themselves).
  const isHead = employee.reportingManagerId || employee.departmentId;
  const chain = isHead
    ? await buildEmployeeApprovalChain(employee)
    : [{ label: 'Manager', approverRole: 'manager' }];
  const approval = await createApproval({
    module: 'comp_revision',
    title: `Compensation — ${employee.name}`,
    summary: `₹${(employee.baseSalary || 0).toFixed(0)} → ₹${proposedSalary.toFixed(0)}`,
    requesterEmployeeId: employee._id,
    requesterUserId: req.user?._id || null,
    subjectEmployeeId: employee._id,
    refModel: 'CompensationRevision',
    refId: rev._id,
    amount: proposedSalary,
    chain,
    link: '/hr/approvals',
    createdBy: req.user?._id || null,
  });
  rev.approvalId = approval._id;
  await rev.save();

  const populated = await CompensationRevision.findById(rev._id).populate(empPopulate);
  res.status(201).json(populated);
});

const cancelRevision = asyncHandler(async (req, res) => {
  guard(req, res);
  const rev = await CompensationRevision.findById(req.params.id);
  if (!rev) { res.status(404); throw new Error('Revision not found'); }
  if (rev.status !== 'pending') { res.status(409); throw new Error('Only a pending revision can be cancelled'); }
  rev.status = 'cancelled';
  await rev.save();
  if (rev.approvalId) {
    await ApprovalRequest.updateOne({ _id: rev.approvalId, status: 'pending' }, { $set: { status: 'cancelled' } });
  }
  res.json({ message: 'Revision cancelled', id: req.params.id });
});

export {
  getBands,
  createBand,
  updateBand,
  deleteBand,
  getRevisions,
  proposeRevision,
  cancelRevision,
};
