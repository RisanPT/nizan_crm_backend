import asyncHandler from 'express-async-handler';
import Offboarding, { DEFAULT_CLEARANCE_ITEMS } from '../models/Offboarding.js';
import Employee from '../models/Employee.js';

const empPopulate = { path: 'employeeId', select: 'name department profileImage' };

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('offboarding') || perms.includes('staff');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage offboarding');
  }
};

const cleanItems = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((i) => i && String(i.label || '').trim())
    .map((i) => ({ label: String(i.label).trim(), cleared: Boolean(i.cleared), owner: String(i.owner || '').trim() }));

const getOffboardings = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  const rows = await Offboarding.find(filter).populate(empPopulate).sort({ createdAt: -1 }).limit(300);
  res.json(rows);
});

const createOffboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const employeeId = String(req.body.employeeId || '').trim();
  if (!employeeId) { res.status(400); throw new Error('An employee is required'); }
  const employee = await Employee.findById(employeeId).select('name department');
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const items = Array.isArray(req.body.clearanceItems) && req.body.clearanceItems.length
    ? cleanItems(req.body.clearanceItems)
    : DEFAULT_CLEARANCE_ITEMS.map((l) => ({ label: l, cleared: false }));

  const row = await Offboarding.create({
    employeeId,
    employeeName: employee.name,
    department: employee.department || '',
    reason: req.body.reason || 'resignation',
    lastWorkingDay: req.body.lastWorkingDay ? new Date(req.body.lastWorkingDay) : null,
    clearanceItems: items,
    finalSettlementAmount: Number(req.body.finalSettlementAmount) || 0,
    notes: String(req.body.notes || '').trim(),
    createdBy: req.user?._id || null,
  });
  await row.populate(empPopulate);
  res.status(201).json(row);
});

const updateOffboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await Offboarding.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Offboarding not found'); }
  const b = req.body;
  if (Array.isArray(b.clearanceItems)) row.clearanceItems = cleanItems(b.clearanceItems);
  if (b.reason !== undefined) row.reason = b.reason;
  if (b.lastWorkingDay !== undefined) row.lastWorkingDay = b.lastWorkingDay ? new Date(b.lastWorkingDay) : null;
  if (b.finalSettlementAmount !== undefined) row.finalSettlementAmount = Number(b.finalSettlementAmount) || 0;
  if (b.settlementPaid !== undefined) row.settlementPaid = Boolean(b.settlementPaid);
  if (b.experienceLetterIssued !== undefined) row.experienceLetterIssued = Boolean(b.experienceLetterIssued);
  if (b.notes !== undefined) row.notes = String(b.notes).trim();
  if (b.status !== undefined) row.status = b.status;
  await row.save();

  // Completing an exit retires the employee.
  if (row.status === 'completed') {
    await Employee.updateOne({ _id: row.employeeId }, { $set: { status: 'inactive' } });
  }
  await row.populate(empPopulate);
  res.json(row);
});

const deleteOffboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await Offboarding.findByIdAndDelete(req.params.id);
  if (!row) { res.status(404); throw new Error('Offboarding not found'); }
  res.json({ message: 'Offboarding removed', id: req.params.id });
});

export { getOffboardings, createOffboarding, updateOffboarding, deleteOffboarding };
