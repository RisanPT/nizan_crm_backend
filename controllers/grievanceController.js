import asyncHandler from 'express-async-handler';
import Grievance from '../models/Grievance.js';
import Employee from '../models/Employee.js';

const isFull = (user) => ['admin', 'manager'].includes(String(user?.role || '').toLowerCase());

// Full access sees confidential cases; others with the perm see non-confidential.
const canManage = (user) => {
  if (isFull(user)) return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('grievance') || perms.includes('staff');
};

const getMine = asyncHandler(async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) return res.json([]);
  const rows = await Grievance.find({ employeeId }).sort({ createdAt: -1 }).limit(100).lean();
  res.json(rows);
});

// @route GET /api/grievances  (HR queue)
const getAll = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  // Only full-access HR sees confidential cases.
  if (!isFull(req.user)) filter.confidential = { $ne: true };
  const rows = await Grievance.find(filter)
    .populate('employeeId', 'name department')
    .populate('assignedTo', 'name')
    .sort({ createdAt: -1 })
    .limit(300);
  res.json(rows);
});

// @route POST /api/grievances  (employee raises)
const raiseGrievance = asyncHandler(async (req, res) => {
  const employeeId = req.user.employeeId;
  if (!employeeId) { res.status(400); throw new Error('No employee record is linked to your account.'); }
  const subject = String(req.body.subject || '').trim();
  if (!subject) { res.status(400); throw new Error('Please add a subject'); }
  const employee = await Employee.findById(employeeId).select('name department');

  const row = await Grievance.create({
    employeeId,
    employeeName: employee?.name || '',
    department: employee?.department || '',
    category: req.body.category || 'other',
    subject,
    description: String(req.body.description || '').trim(),
    confidential: Boolean(req.body.confidential),
    status: 'open',
    createdBy: req.user?._id || null,
  });
  res.status(201).json(row);
});

// @route PUT /api/grievances/:id  (HR: status / assign / resolution)
const updateGrievance = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const row = await Grievance.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Grievance not found'); }
  if (row.confidential && !isFull(req.user)) { res.status(403); throw new Error('This case is confidential'); }

  const b = req.body;
  if (b.status !== undefined) {
    row.status = b.status;
    if (['resolved', 'closed'].includes(b.status)) row.resolvedOn = row.resolvedOn || new Date();
    else row.resolvedOn = null;
  }
  if (b.assignedTo !== undefined) row.assignedTo = b.assignedTo || null;
  if (b.resolutionNote !== undefined) row.resolutionNote = String(b.resolutionNote).trim();
  await row.save();
  await row.populate('employeeId', 'name department');
  await row.populate('assignedTo', 'name');
  res.json(row);
});

// @route POST /api/grievances/:id/withdraw  (own open only)
const withdrawGrievance = asyncHandler(async (req, res) => {
  const row = await Grievance.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Grievance not found'); }
  const owns = String(row.employeeId) === String(req.user.employeeId || '');
  if (!owns) { res.status(403); throw new Error('Not allowed'); }
  if (row.status !== 'open') { res.status(409); throw new Error('Only an open case can be withdrawn'); }
  await row.deleteOne();
  res.json({ message: 'Grievance withdrawn', id: req.params.id });
});

// @route DELETE /api/grievances/:id (admin/manager cleanup)
const deleteGrievance = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) { res.status(403); throw new Error('Not allowed'); }
  const row = await Grievance.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Grievance not found'); }
  await row.deleteOne();
  res.json({ message: 'Grievance deleted', id: req.params.id });
});

export { getMine, getAll, raiseGrievance, updateGrievance, withdrawGrievance, deleteGrievance };

