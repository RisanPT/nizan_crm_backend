import Salary from '../models/Salary.js';
import Employee from '../models/Employee.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { applyMoneyAccount } from '../utils/moneyAccount.js';
import { SALARY_PAYMENT_METHODS } from '../models/Salary.js';
import PayrollLock, { isPayrollLocked } from '../models/PayrollLock.js';
import { logChange, snapshot, maskTail } from '../utils/audit.js';

// Slip fields tracked in the HR change log.
const SALARY_AUDIT_FIELDS = [
  'baseSalary', 'incentives', 'roomRent', 'allowances', 'bonus', 'deductions',
  'attendanceDeduction', 'netAmount', 'salaryType', 'status', 'notes', 'department', 'role',
  'paymentDate', 'paymentMethod', 'transactionRef',
];

const lockedMsg = (m, y) => `Payroll for ${m}/${y} is locked. Ask an admin to unlock it first.`;

// Treat user search text literally — an unescaped "(" or "*" would otherwise
// throw "Invalid regular expression" and fail the whole request with a 500.
const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// @desc    Get salaries with optional filters (month, year, category, status, department)
// @route   GET /api/salaries
// @access  Private
export const getSalaries = async (req, res) => {
  try {
    const { month, year, category, department, status, search } = req.query;

    const query = {};

    if (month) query.month = Number(month);
    if (year) query.year = Number(year);
    if (status && status !== 'all') query.status = status;
    if (department && department !== 'All' && department !== 'all') query.department = department;

    if (category && category !== 'all') {
      if (category === 'administrative' || category === 'admin') {
        query.employeeCategory = 'administrative';
      } else if (category === 'operations' || category === 'creative') {
        query.employeeCategory = 'operations';
      }
    }

    if (search) {
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      query.$or = [
        { employeeName: searchRegex },
        { department: searchRegex },
        { role: searchRegex },
        { notes: searchRegex },
      ];
    }

    const salaries = await Salary.find(query)
      .populate({
        path: 'employeeId',
        select: 'name email phone profileImage artistRole type category department employeeCode designationId',
        populate: { path: 'designationId', select: 'name' },
      })
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email')
      .sort({ createdAt: -1 });

    // Compute summary stats for the current filter scope (month/year)
    const statsQuery = {};
    if (month) statsQuery.month = Number(month);
    if (year) statsQuery.year = Number(year);

    const allForPeriod = await Salary.find(statsQuery).lean();

    let totalAdministrative = 0;
    let totalOperations = 0;
    let totalPaid = 0;
    let totalPending = 0;
    let totalNet = 0;
    let draftCount = 0;
    let draftAmount = 0;
    let approvedCount = 0;
    let approvedAmount = 0;

    for (const s of allForPeriod) {
      const net = s.netAmount || 0;
      totalNet += net;

      if (s.employeeCategory === 'administrative') {
        totalAdministrative += net;
      } else {
        totalOperations += net;
      }

      if (s.status === 'paid') {
        totalPaid += net;
      } else if (s.status !== 'cancelled') {
        totalPending += net;
        if (s.status === 'draft') {
          draftCount++;
          draftAmount += net;
        } else if (s.status === 'approved_by_hr') {
          approvedCount++;
          approvedAmount += net;
        }
      }
    }

    res.json({
      salaries,
      stats: {
        totalAdministrative,
        totalOperations,
        totalPaid,
        totalPending,
        totalNet,
        draftCount,
        draftAmount,
        approvedCount,
        approvedAmount,
        count: allForPeriod.length,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    The logged-in employee's own payslips (ESS)
// @route   GET /api/salaries/mine
// @access  Any logged-in user linked to an employee (own slips only)
export const getMySalaries = async (req, res) => {
  try {
    const employeeId = req.user?.employeeId;
    if (!employeeId) return res.json([]);
    const salaries = await Salary.find({
      employeeId,
      status: { $in: ['approved_by_hr', 'paid'] },
    })
      .select('-approvedBy -paidBy -moneyAccount')
      .populate({
        path: 'employeeId',
        select: 'name employeeCode department role designationId',
        populate: { path: 'designationId', select: 'name' },
      })
      .sort({ year: -1, month: -1 })
      .lean();
    // Own slips only — the account number is still shown masked.
    for (const s of salaries) {
      if (s.bankDetails?.accountNumber) s.bankDetails.accountNumber = maskTail(s.bankDetails.accountNumber);
      // Staff see only the system attendance line — never HR's internal notes.
      s.notes = String(s.notes || '').split(/\r?\n/).filter((l) => l.startsWith('Attendance ')).join('\n');
    }
    res.json(salaries);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Auto-generate monthly salary slips for all active employees
// @route   POST /api/salaries/generate
// @access  Private
export const generateMonthlySalaries = async (req, res) => {
  try {
    const { month, year } = req.body;
    const targetMonth = Number(month) || new Date().getMonth() + 1;
    const targetYear = Number(year) || new Date().getFullYear();
    if (await isPayrollLocked(targetMonth, targetYear)) {
      return res.status(409).json({ message: lockedMsg(targetMonth, targetYear) });
    }

    // Outsource (freelance) artists are paid per booking via the Artist Payout
    // module — NEVER on monthly payroll — so exclude them from generation.
    // (Filter by `type` only: all operations staff, incl. in-house artists,
    // default to salaryType 'per_booking', so salaryType is not a safe filter.)
    const activeEmployees = await Employee.find({
      status: 'active',
      type: { $ne: 'outsource' },
    });
    let createdCount = 0;
    let skippedCount = 0;

    for (const emp of activeEmployees) {
      const isOps =
        emp.artistRole === 'driver' ||
        emp.artistRole === 'artist' ||
        emp.artistRole === 'assistant' ||
        emp.category === 'operations' ||
        emp.category === 'creative';

      const employeeCategory = isOps ? 'operations' : 'administrative';
      const department = isOps ? 'Operations' : (emp.department || 'General');

      const existing = await Salary.findOne({
        employeeId: emp._id,
        month: targetMonth,
        year: targetYear,
      });

      if (!existing) {
        const baseSalary = Number(emp.baseSalary) || 0;
        const allowances = Number(emp.allowances) || 0;
        const deductions = Number(emp.deductions) || 0;
        const bonus = 0;
        const netAmount = Math.max(0, baseSalary + allowances + bonus - deductions);

        await Salary.create({
          employeeId: emp._id,
          employeeName: emp.name,
          employeeCategory,
          department,
          role: emp.role || (isOps ? emp.specialization || 'Operations Staff' : 'Staff'),
          month: targetMonth,
          year: targetYear,
          salaryType: emp.salaryType || (isOps ? 'per_booking' : 'fixed_monthly'),
          baseSalary,
          allowances,
          bonus,
          deductions,
          netAmount,
          status: 'draft',
          bankDetails: {
            bankName: emp.bankName || '',
            accountNumber: emp.accountNumber || '',
            ifscCode: emp.ifscCode || '',
            upiId: emp.upiId || '',
          },
          approvedBy: null,
          approvedAt: null,
        });
        createdCount++;
      } else {
        skippedCount++;
      }
    }

    res.status(200).json({
      message: `Generated ${createdCount} salary slips for ${targetMonth}/${targetYear}. ${skippedCount} already existed.`,
      createdCount,
      skippedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Create a single custom salary slip
// @route   POST /api/salaries
// @access  Private
export const createSalary = async (req, res) => {
  try {
    const {
      employeeId,
      month,
      year,
      salaryType,
      baseSalary,
      incentives,
      roomRent,
      allowances,
      bonus,
      deductions,
      status,
      notes,
    } = req.body;

    if (!employeeId) {
      return res.status(400).json({ message: 'Select an employee.' });
    }
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    if (await isPayrollLocked(month, year)) {
      return res.status(409).json({ message: lockedMsg(month, year) });
    }
    const employee = await Employee.findById(employeeId);
    if (!employee) {
      return res.status(404).json({ message: 'Employee not found' });
    }

    const isOps =
      employee.artistRole === 'driver' ||
      employee.artistRole === 'artist' ||
      employee.artistRole === 'assistant' ||
      employee.category === 'operations' ||
      employee.category === 'creative';

    const base = Number(baseSalary) || 0;
    const inc = Number(incentives) || 0;
    const rr = Number(roomRent) || 0;
    const allow = Number(allowances) || 0;
    const bon = Number(bonus) || 0;
    const ded = Number(deductions) || 0;
    // HRA is deliberately excluded from the salary net — it is paid separately
    // via the HRA screen (Accounts). See Employee.hra / HraRecord.
    const netAmount = Math.max(0, base + inc + rr + allow + bon - ded);

    const salary = await Salary.create({
      employeeId: employee._id,
      employeeName: employee.name,
      employeeCategory: isOps ? 'operations' : 'administrative',
      department: isOps ? 'Operations' : (employee.department || 'General'),
      role: employee.role || 'Staff',
      month: Number(month),
      year: Number(year),
      salaryType: salaryType || employee.salaryType || 'fixed_monthly',
      baseSalary: base,
      incentives: inc,
      roomRent: rr,
      hra: 0,
      allowances: allow,
      bonus: bon,
      deductions: ded,
      netAmount,
      status: status || 'draft',
      notes: notes || '',
      bankDetails: {
        bankName: employee.bankName || '',
        accountNumber: employee.accountNumber || '',
        ifscCode: employee.ifscCode || '',
        upiId: employee.upiId || '',
      },
      approvedBy: status === 'approved_by_hr' ? (req.user?._id || null) : null,
      approvedAt: status === 'approved_by_hr' ? new Date() : null,
    });

    const populated = await Salary.findById(salary._id)
      .populate('employeeId')
      .populate('approvedBy', 'name email');

    res.status(201).json(populated);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Salary slip already exists for this employee in the selected month/year.' });
    }
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update a salary slip (amounts, bonus, deductions, notes)
// @route   PUT /api/salaries/:id
// @access  Private
export const updateSalary = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id);
    if (!salary) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }
    if (await isPayrollLocked(salary.month, salary.year)) {
      return res.status(409).json({ message: lockedMsg(salary.month, salary.year) });
    }
    // A paid slip is final; only the owner (admin) may correct it.
    if (salary.status === 'paid' && String(req.user?.role || '') !== 'admin') {
      return res.status(409).json({ message: 'This salary is already paid and can no longer be edited.' });
    }
    // 'paid' is set only by the Pay action, which records how it was paid.
    if (req.body.status === 'paid' && salary.status !== 'paid') {
      return res.status(400).json({ message: 'Use "Mark as paid" to record a payment.' });
    }

    const {
      baseSalary,
      incentives,
      roomRent,
      allowances,
      bonus,
      deductions,
      salaryType,
      status,
      notes,
      department,
      role,
    } = req.body;

    const before = snapshot(salary, SALARY_AUDIT_FIELDS);
    if (baseSalary !== undefined) salary.baseSalary = Number(baseSalary) || 0;
    if (incentives !== undefined) salary.incentives = Number(incentives) || 0;
    if (roomRent !== undefined) salary.roomRent = Number(roomRent) || 0;
    if (allowances !== undefined) salary.allowances = Number(allowances) || 0;
    if (bonus !== undefined) salary.bonus = Number(bonus) || 0;
    if (deductions !== undefined) salary.deductions = Number(deductions) || 0;
    if (salaryType !== undefined) salary.salaryType = salaryType;
    if (status !== undefined) salary.status = status;
    if (notes !== undefined) salary.notes = notes;
    if (department !== undefined) salary.department = department;
    if (role !== undefined) salary.role = role;

    // HRA excluded from salary net (paid separately via the HRA screen).
    salary.netAmount = Math.max(
      0,
      salary.baseSalary + salary.incentives + salary.roomRent +
          salary.allowances + salary.bonus - salary.deductions,
    );

    await salary.save();
    await logChange({
      req, entity: 'Salary', entityId: salary._id, employeeId: salary.employeeId,
      action: 'update', before, after: salary, fields: SALARY_AUDIT_FIELDS,
      note: `Slip ${salary.month}/${salary.year}`,
    });

    // Post paid salaries to the ledger (best-effort).
    await safePost(() => postDoc('Salary', salary.toObject(), req.user?._id || null));

    const populated = await Salary.findById(salary._id)
      .populate('employeeId')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email');

    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    HR Approve salary slip
// @route   PUT /api/salaries/:id/approve
// @access  Private
export const approveSalary = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id);
    if (!salary) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    if (await isPayrollLocked(salary.month, salary.year)) {
      return res.status(409).json({ message: lockedMsg(salary.month, salary.year) });
    }
    // Only a draft (or cancelled) slip can be approved — never pull a paid
    // slip back to "approved".
    if (salary.status === 'paid') {
      return res.status(409).json({ message: 'This salary is already paid.' });
    }

    const beforeStatus = snapshot(salary, ['status']);
    salary.status = 'approved_by_hr';
    salary.approvedBy = req.user?._id || null;
    salary.approvedAt = new Date();

    await salary.save();
    await logChange({
      req, entity: 'Salary', entityId: salary._id, employeeId: salary.employeeId,
      action: 'approve', before: beforeStatus, after: salary, fields: ['status'], always: true,
      note: `Slip ${salary.month}/${salary.year}`,
    });

    const populated = await Salary.findById(salary._id)
      .populate('employeeId')
      .populate('approvedBy', 'name email');

    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Accounts mark salary as paid
// @route   PUT /api/salaries/:id/pay
// @access  Private
export const paySalary = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id);
    if (!salary) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    const { paymentDate, paymentMethod, transactionRef, notes } = req.body;

    const before = snapshot(salary, SALARY_AUDIT_FIELDS);
    salary.status = 'paid';
    salary.paymentDate = paymentDate ? new Date(paymentDate) : new Date();
    salary.paymentMethod = paymentMethod || 'bank_transfer';
    salary.transactionRef = transactionRef || '';
    if (notes) salary.notes = notes;
    salary.paidBy = req.user?._id || null;
    salary.paidAt = new Date();
    // Which bank / cash account paid it (pay popup).
    const moneyErr = await applyMoneyAccount(salary, { ...req.body, paymentMode: paymentMethod }, {
      modeField: 'paymentMethod',
      modes: SALARY_PAYMENT_METHODS,
    });
    if (moneyErr) return res.status(400).json({ message: moneyErr });

    await salary.save();
    await logChange({
      req, entity: 'Salary', entityId: salary._id, employeeId: salary.employeeId,
      action: 'pay', before, after: salary, fields: SALARY_AUDIT_FIELDS, always: true,
      note: `Slip ${salary.month}/${salary.year}`,
    });

    // Post paid salaries to the ledger (best-effort).
    await safePost(() => postDoc('Salary', salary.toObject(), req.user?._id || null));

    const populated = await Salary.findById(salary._id)
      .populate('employeeId')
      .populate('approvedBy', 'name email')
      .populate('paidBy', 'name email');

    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete salary slip
// @route   DELETE /api/salaries/:id
// @access  Private
export const deleteSalary = async (req, res) => {
  try {
    const salary = await Salary.findById(req.params.id);
    if (!salary) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    if (salary.status === 'paid') {
      return res.status(400).json({ message: 'Cannot delete a paid salary slip.' });
    }
    if (await isPayrollLocked(salary.month, salary.year)) {
      return res.status(409).json({ message: lockedMsg(salary.month, salary.year) });
    }

    await salary.deleteOne();
    await logChange({
      req, entity: 'Salary', entityId: salary._id, employeeId: salary.employeeId,
      action: 'delete', before: salary, after: {}, fields: ['status', 'netAmount'], always: true,
      note: `Slip ${salary.month}/${salary.year} deleted`,
    });
    await safePost(() => unpostDoc('Salary', salary._id));
    res.json({ message: 'Salary slip removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Submit all draft salaries for a specific month/year to Accounts
// @route   POST /api/salaries/submit
// @access  Private
export const submitPayrollToAccounts = async (req, res) => {
  try {
    const { month, year } = req.body;
    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }
    if (await isPayrollLocked(month, year)) {
      return res.status(409).json({ message: lockedMsg(month, year) });
    }

    const result = await Salary.updateMany(
      { month: Number(month), year: Number(year), status: 'draft' },
      { 
        $set: { 
          status: 'approved_by_hr', 
          approvedBy: req.user?._id || null, 
          approvedAt: new Date() 
        } 
      }
    );

    res.json({
      message: `Submitted ${result.modifiedCount} payroll records to Accounts.`,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Payroll month lock ───────────────────────────────────────────────────────
// @route GET /api/salaries/locks?year=  — locked months (for the screens)
export const getPayrollLocks = async (req, res) => {
  try {
    const filter = { locked: true };
    if (req.query.year) filter.year = Number(req.query.year);
    const locks = await PayrollLock.find(filter).populate('lockedBy', 'name').sort({ year: -1, month: -1 }).lean();
    res.json(locks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/salaries/lock { month, year, note? }
// Finalises a month: no more generating / editing / approving / deleting.
export const lockPayrollMonth = async (req, res) => {
  try {
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    if (!(month >= 1 && month <= 12) || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }
    const drafts = await Salary.countDocuments({ month, year, status: 'draft' });
    if (drafts > 0) {
      return res.status(400).json({
        message: `${drafts} slip(s) for ${month}/${year} are still drafts. Approve or remove them before locking.`,
      });
    }
    const lock = await PayrollLock.findOneAndUpdate(
      { month, year },
      {
        $set: {
          locked: true,
          lockedBy: req.user?._id || null,
          lockedAt: new Date(),
          unlockedBy: null,
          unlockedAt: null,
          note: String(req.body.note || '').trim(),
        },
      },
      { upsert: true, new: true }
    );
    await logChange({
      req, entity: 'PayrollLock', entityId: lock?._id, action: 'lock', always: true,
      note: `Payroll ${month}/${year} locked${lock?.note ? ` — ${lock.note}` : ''}`,
    });
    res.json({ message: `Payroll for ${month}/${year} locked.`, lock });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/salaries/unlock { month, year }  — admin only
export const unlockPayrollMonth = async (req, res) => {
  try {
    if (String(req.user?.role || '') !== 'admin') {
      return res.status(403).json({ message: 'Only an admin can unlock a payroll month.' });
    }
    const month = Number(req.body.month);
    const year = Number(req.body.year);
    const lock = await PayrollLock.findOneAndUpdate(
      { month, year, locked: true },
      { $set: { locked: false, unlockedBy: req.user._id, unlockedAt: new Date() } },
      { new: true }
    );
    if (!lock) return res.status(404).json({ message: 'That month is not locked.' });
    await logChange({
      req, entity: 'PayrollLock', entityId: lock._id, action: 'unlock', always: true,
      note: `Payroll ${month}/${year} unlocked`,
    });
    res.json({ message: `Payroll for ${month}/${year} unlocked.`, lock });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
