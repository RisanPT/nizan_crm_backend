import Salary from '../models/Salary.js';
import Employee from '../models/Employee.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';

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
      const searchRegex = new RegExp(search, 'i');
      query.$or = [
        { employeeName: searchRegex },
        { department: searchRegex },
        { role: searchRegex },
        { notes: searchRegex },
      ];
    }

    const salaries = await Salary.find(query)
      .populate('employeeId', 'name email phone profileImage artistRole type category department')
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

// @desc    Auto-generate monthly salary slips for all active employees
// @route   POST /api/salaries/generate
// @access  Private
export const generateMonthlySalaries = async (req, res) => {
  try {
    const { month, year } = req.body;
    const targetMonth = Number(month) || new Date().getMonth() + 1;
    const targetYear = Number(year) || new Date().getFullYear();

    const activeEmployees = await Employee.find({ status: 'active' });
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

    salary.status = 'approved_by_hr';
    salary.approvedBy = req.user?._id || null;
    salary.approvedAt = new Date();

    await salary.save();

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

    salary.status = 'paid';
    salary.paymentDate = paymentDate ? new Date(paymentDate) : new Date();
    salary.paymentMethod = paymentMethod || 'bank_transfer';
    salary.transactionRef = transactionRef || '';
    if (notes) salary.notes = notes;
    salary.paidBy = req.user?._id || null;
    salary.paidAt = new Date();

    await salary.save();

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

    await salary.deleteOne();
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
