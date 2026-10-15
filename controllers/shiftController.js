import asyncHandler from 'express-async-handler';
import Shift from '../models/Shift.js';
import ShiftAssignment from '../models/ShiftAssignment.js';
import Employee from '../models/Employee.js';

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('staff') || perms.includes('shift');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage shifts');
  }
};

// ── Shifts ─────────────────────────────────────────────────────────────────
const getShifts = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.active === 'true') filter.active = true;
  const shifts = await Shift.find(filter).sort({ name: 1 }).lean();
  res.json(shifts);
});

const createShift = asyncHandler(async (req, res) => {
  guard(req, res);
  const name = String(req.body.name || '').trim();
  if (!name) { res.status(400); throw new Error('Please provide a shift name'); }
  const shift = await Shift.create({
    name,
    code: String(req.body.code || '').trim(),
    startTime: String(req.body.startTime || '09:00'),
    endTime: String(req.body.endTime || '18:00'),
    graceInMin: Number(req.body.graceInMin) || 0,
    graceOutMin: Number(req.body.graceOutMin) || 0,
    workingDays: Array.isArray(req.body.workingDays) ? req.body.workingDays.map(Number) : undefined,
    color: String(req.body.color || '#601A29'),
    active: req.body.active !== false,
    createdBy: req.user?._id || null,
  });
  res.status(201).json(shift);
});

const updateShift = asyncHandler(async (req, res) => {
  guard(req, res);
  const shift = await Shift.findById(req.params.id);
  if (!shift) { res.status(404); throw new Error('Shift not found'); }
  const b = req.body;
  if (b.name !== undefined && String(b.name).trim()) shift.name = String(b.name).trim();
  if (b.code !== undefined) shift.code = String(b.code).trim();
  if (b.startTime !== undefined) shift.startTime = String(b.startTime);
  if (b.endTime !== undefined) shift.endTime = String(b.endTime);
  if (b.graceInMin !== undefined) shift.graceInMin = Number(b.graceInMin) || 0;
  if (b.graceOutMin !== undefined) shift.graceOutMin = Number(b.graceOutMin) || 0;
  if (Array.isArray(b.workingDays)) shift.workingDays = b.workingDays.map(Number);
  if (b.color !== undefined) shift.color = String(b.color);
  if (b.active !== undefined) shift.active = Boolean(b.active);
  await shift.save();
  res.json(shift);
});

const deleteShift = asyncHandler(async (req, res) => {
  guard(req, res);
  const inUse = await ShiftAssignment.countDocuments({ shiftId: req.params.id });
  if (inUse > 0) {
    res.status(409);
    throw new Error(`Cannot delete: ${inUse} assignment(s) use this shift`);
  }
  const shift = await Shift.findByIdAndDelete(req.params.id);
  if (!shift) { res.status(404); throw new Error('Shift not found'); }
  res.json({ message: 'Shift removed', id: req.params.id });
});

// ── Assignments (roster) ─────────────────────────────────────────────────────
const getAssignments = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.employeeId) filter.employeeId = req.query.employeeId;
  if (req.query.shiftId) filter.shiftId = req.query.shiftId;
  const rows = await ShiftAssignment.find(filter)
    .populate('employeeId', 'name department')
    .populate('shiftId', 'name startTime endTime color')
    .sort({ fromDate: -1 })
    .lean();
  res.json(rows);
});

const createAssignment = asyncHandler(async (req, res) => {
  guard(req, res);
  const employeeId = String(req.body.employeeId || '').trim();
  const shiftId = String(req.body.shiftId || '').trim();
  if (!employeeId || !shiftId) { res.status(400); throw new Error('Employee and shift are required'); }
  if (!req.body.fromDate) { res.status(400); throw new Error('A start date is required'); }

  const [employee, shift] = await Promise.all([
    Employee.findById(employeeId).select('name department'),
    Shift.findById(shiftId).select('name'),
  ]);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }
  if (!shift) { res.status(404); throw new Error('Shift not found'); }

  const row = await ShiftAssignment.create({
    employeeId,
    employeeName: employee.name,
    department: employee.department || '',
    shiftId,
    shiftName: shift.name,
    fromDate: new Date(req.body.fromDate),
    toDate: req.body.toDate ? new Date(req.body.toDate) : null,
    note: String(req.body.note || '').trim(),
    createdBy: req.user?._id || null,
  });
  await row.populate('shiftId', 'name startTime endTime color');
  res.status(201).json(row);
});

const deleteAssignment = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await ShiftAssignment.findByIdAndDelete(req.params.id);
  if (!row) { res.status(404); throw new Error('Assignment not found'); }
  res.json({ message: 'Assignment removed', id: req.params.id });
});

export {
  getShifts,
  createShift,
  updateShift,
  deleteShift,
  getAssignments,
  createAssignment,
  deleteAssignment,
};
