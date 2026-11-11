import asyncHandler from 'express-async-handler';
import Offboarding, { DEFAULT_CLEARANCE_ITEMS } from '../models/Offboarding.js';
import Employee from '../models/Employee.js';
import User from '../models/User.js';
import EmployeeAsset from '../models/EmployeeAsset.js';
import Salary from '../models/Salary.js';
import { isPayrollLocked } from '../models/PayrollLock.js';
import { scopeFilter, assertEmployeeInScope, isHrWide } from '../utils/hrDeptScope.js';
import { prorateFinalSettlement } from '../utils/settlementMath.js';
import { istDayKey } from '../utils/istDate.js';

// Dept heads only manage exits for their own department's staff.
const KEYS = ['offboarding'];

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
  guard(req, res);
  let filter = {};
  if (req.query.status && req.query.status !== 'all') filter.status = req.query.status;
  filter = { ...filter, ...(await scopeFilter(req, KEYS)) };
  const rows = await Offboarding.find(filter).populate(empPopulate).sort({ createdAt: -1 }).limit(300);
  res.json(rows);
});

const createOffboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  const employeeId = String(req.body.employeeId || '').trim();
  if (!employeeId) { res.status(400); throw new Error('An employee is required'); }
  const employee = await Employee.findById(employeeId).select('name department');
  if (!employee) { res.status(404); throw new Error('Employee not found'); }
  await assertEmployeeInScope(req, res, employee._id, KEYS);

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
  await assertEmployeeInScope(req, res, row.employeeId, KEYS);
  const b = req.body;

  // An exit can't be completed while company property is still with the
  // employee. HR-wide users may override with forceComplete + a reason.
  const completing = b.status === 'completed' && row.status !== 'completed';
  let forcedNote = '';
  if (completing) {
    const outstanding = await EmployeeAsset.find({ employeeId: row.employeeId, status: 'issued' })
      .select('item serialNo category').lean();
    if (outstanding.length) {
      const list = outstanding.map((a) => (a.serialNo ? `${a.item} (${a.serialNo})` : a.item)).join(', ');
      const reason = String(b.notes || '').trim();
      if (b.forceComplete === true) {
        if (!(await isHrWide(req, KEYS))) {
          res.status(403);
          throw new Error('Only HR can complete an exit while assets are still issued');
        }
        if (!reason) {
          res.status(400);
          throw new Error('A reason (notes) is required to complete an exit with assets still issued');
        }
        forcedNote = `Completed with ${outstanding.length} asset(s) not returned: ${list}. Reason: ${reason}`;
      } else {
        res.status(400);
        throw new Error(`Cannot complete exit: ${outstanding.length} asset(s) still issued — ${list}. Mark them returned or lost first.`);
      }
    }
  }

  if (Array.isArray(b.clearanceItems)) row.clearanceItems = cleanItems(b.clearanceItems);
  if (b.reason !== undefined) row.reason = b.reason;
  if (b.lastWorkingDay !== undefined) row.lastWorkingDay = b.lastWorkingDay ? new Date(b.lastWorkingDay) : null;
  if (b.finalSettlementAmount !== undefined) row.finalSettlementAmount = Number(b.finalSettlementAmount) || 0;
  if (b.settlementPaid !== undefined) row.settlementPaid = Boolean(b.settlementPaid);
  if (b.experienceLetterIssued !== undefined) row.experienceLetterIssued = Boolean(b.experienceLetterIssued);
  if (forcedNote) {
    // The forced reason is appended to (never replaces) the existing notes.
    row.notes = [String(row.notes || '').trim(), forcedNote].filter(Boolean).join('\n');
  } else if (b.notes !== undefined) {
    row.notes = String(b.notes).trim();
  }
  if (b.status !== undefined) row.status = b.status;
  await row.save();

  // Completing an exit retires the employee AND closes their login, so a
  // leaver can't keep using the CRM. The owner (admin) account is never
  // switched off from here, to avoid locking the business out.
  if (row.status === 'completed') {
    await Employee.updateOne(
      { _id: row.employeeId },
      { $set: { status: 'inactive', employmentStatus: 'exited', exitDate: row.lastWorkingDay || new Date() } },
    );
    await User.updateMany(
      { employeeId: row.employeeId, role: { $ne: 'admin' } },
      { $set: { active: false } },
    );
  }
  await row.populate(empPopulate);
  res.json(row);
});

const deleteOffboarding = asyncHandler(async (req, res) => {
  guard(req, res);
  // Load first so the scope check runs before anything is deleted.
  const row = await Offboarding.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Offboarding not found'); }
  await assertEmployeeInScope(req, res, row.employeeId, KEYS);
  await row.deleteOne();
  res.json({ message: 'Offboarding removed', id: req.params.id });
});

// ── Final settlement ─────────────────────────────────────────────────────────
// Owner rule: the final settlement is ONLY the unpaid salary for the exit
// month up to the last working day (calendar days, 1st → LWD inclusive). No
// leave encashment, no gratuity, no recoveries. HRA is paid separately (HRA
// screen) and is not part of it.

const settlementFor = async (req, res) => {
  const row = await Offboarding.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Offboarding not found'); }
  await assertEmployeeInScope(req, res, row.employeeId, KEYS);
  if (!row.lastWorkingDay) { res.status(400); throw new Error('Set the last working day first'); }
  const employee = await Employee.findById(row.employeeId);
  if (!employee) { res.status(404); throw new Error('Employee not found'); }

  const lwd = istDayKey(row.lastWorkingDay);
  const calc = prorateFinalSettlement({
    baseSalary: employee.baseSalary,
    allowances: employee.allowances,
    lastWorkingDay: lwd,
  });
  const existing = await Salary.findOne({ employeeId: employee._id, month: calc.month, year: calc.year })
    .select('status netAmount baseSalary allowances notes').lean();
  const locked = await isPayrollLocked(calc.month, calc.year);
  const warnings = [];
  if (employee.salaryType && employee.salaryType !== 'fixed_monthly') {
    warnings.push(`Salary type is "${employee.salaryType}" — prorating uses the monthly base salary only.`);
  }
  if (!(Number(employee.baseSalary) > 0)) warnings.push('No base salary is set on the employee record.');
  return { row, employee, calc, existing, locked, warnings };
};

const slipSummary = (s) => (s ? { id: s._id, status: s.status, netAmount: s.netAmount } : null);

// @route GET /api/offboarding/:id/settlement
const getSettlement = asyncHandler(async (req, res) => {
  guard(req, res);
  const { row, calc, existing, locked, warnings } = await settlementFor(req, res);
  res.json({
    offboardingId: row._id,
    employeeId: row.employeeId,
    employeeName: row.employeeName,
    ...calc,
    payrollLocked: locked,
    existingSlip: slipSummary(existing),
    canCreateSlip: !locked && (!existing || ['draft', 'cancelled'].includes(existing.status)),
    warnings,
  });
});

// @route POST /api/offboarding/:id/settlement/slip
// Creates (or refreshes a draft) salary slip for the exit month with the
// prorated amounts and stores the amount on the offboarding.
const createSettlementSlip = asyncHandler(async (req, res) => {
  guard(req, res);
  const { row, employee, calc, existing, locked } = await settlementFor(req, res);
  if (locked) {
    res.status(400);
    throw new Error(`Payroll for ${calc.month}/${calc.year} is locked — unlock the month first`);
  }
  if (existing && existing.status === 'paid') {
    res.status(409);
    throw new Error(`A paid salary slip already exists for ${calc.month}/${calc.year}`);
  }
  if (existing && existing.status === 'approved_by_hr') {
    res.status(409);
    throw new Error(`An approved salary slip already exists for ${calc.month}/${calc.year} — move it back to draft first`);
  }

  const isOps =
    employee.artistRole === 'driver' ||
    employee.artistRole === 'artist' ||
    employee.artistRole === 'assistant' ||
    employee.category === 'operations' ||
    employee.category === 'creative';

  const fields = {
    employeeName: employee.name,
    employeeCategory: isOps ? 'operations' : 'administrative',
    department: isOps ? 'Operations' : (employee.department || 'General'),
    role: employee.role || 'Staff',
    salaryType: employee.salaryType || 'fixed_monthly',
    baseSalary: calc.proratedBase,
    incentives: 0,
    roomRent: 0,
    hra: 0,
    allowances: calc.proratedAllowances,
    bonus: 0,
    deductions: 0,
    attendanceDeduction: null,
    netAmount: calc.amount,
    status: 'draft',
    notes: `Final settlement — last working day ${calc.lastWorkingDay} (${calc.daysWorked}/${calc.daysInMonth} days)`,
    bankDetails: {
      bankName: employee.bankName || '',
      accountNumber: employee.accountNumber || '',
      ifscCode: employee.ifscCode || '',
      upiId: employee.upiId || '',
    },
    approvedBy: null,
    approvedAt: null,
  };

  let slip;
  if (existing) {
    slip = await Salary.findByIdAndUpdate(existing._id, { $set: fields }, { new: true, runValidators: true });
  } else {
    slip = await Salary.create({ employeeId: employee._id, month: calc.month, year: calc.year, ...fields });
  }

  row.finalSettlementAmount = calc.amount;
  await row.save();
  await row.populate(empPopulate);
  res.status(existing ? 200 : 201).json({ offboarding: row, slip, settlement: calc, updated: Boolean(existing) });
});

export {
  getOffboardings,
  createOffboarding,
  updateOffboarding,
  deleteOffboarding,
  getSettlement,
  createSettlementSlip,
};
