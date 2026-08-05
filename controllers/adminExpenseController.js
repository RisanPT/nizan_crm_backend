import AdminExpense from '../models/AdminExpense.js';
import Salary from '../models/Salary.js';
import { notifyRoles } from '../utils/notify.js';

const expensePopulate = [
  { path: 'paidBy', select: 'name phone department artistRole status' },
  { path: 'approvedBy', select: 'name role' },
  { path: 'createdBy', select: 'name role' },
];

export const getAdminExpenses = async (req, res) => {
  try {
    const { department, category, status, startDate, endDate, search } = req.query;
    const filter = {};

    if (department && department !== 'All') {
      filter.department = department;
    }

    if (category && category !== 'All') {
      filter.category = category;
    }

    if (status && status !== 'All' && status !== 'all') {
      filter.status = status;
    }

    if (startDate || endDate) {
      filter.date = {};
      if (startDate) {
        filter.date.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.date.$lte = end;
      }
    }

    if (search) {
      const searchRegex = new RegExp(search, 'i');
      filter.$or = [
        { title: searchRegex },
        { paidByName: searchRegex },
        { invoiceNumber: searchRegex },
        { notes: searchRegex },
      ];
    }

    const expenses = await AdminExpense.find(filter)
      .populate(expensePopulate)
      .lean();

    let salaries = [];
    if (!category || category === 'All' || category === 'other') {
      const salaryFilter = { status: 'paid' };
      
      if (department && department !== 'All') {
        salaryFilter.department = department;
      }

      if (startDate || endDate) {
        salaryFilter.paymentDate = {};
        if (startDate) {
          salaryFilter.paymentDate.$gte = new Date(startDate);
        }
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          salaryFilter.paymentDate.$lte = end;
        }
      }

      if (search) {
        const searchRegex = new RegExp(search, 'i');
        salaryFilter.$or = [
          { employeeName: searchRegex },
          { notes: searchRegex }
        ];
      }

      salaries = await Salary.find(salaryFilter)
        .populate('employeeId', 'name phone department artistRole status')
        .populate('approvedBy', 'name role')
        .populate('paidBy', 'name role')
        .lean();
    }

    const formattedSalaries = salaries.map(s => ({
      _id: s._id,
      title: `Salary - ${s.employeeName} (${s.month}/${s.year})`,
      department: s.department || 'General',
      category: 'other',
      amount: s.netAmount || 0,
      date: s.paymentDate || s.createdAt,
      paymentMethod: s.paymentMethod || 'bank_transfer',
      paidBy: s.paidBy,
      paidByName: s.employeeName,
      receiptImage: '',
      invoiceNumber: '',
      notes: s.notes || 'Auto-integrated from Payroll',
      status: 'approved',
      createdBy: s.paidBy,
      approvedBy: s.approvedBy,
      approvedAt: s.approvedAt,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      isSalary: true,
    }));

    const combined = [...expenses, ...formattedSalaries].sort((a, b) => {
      const dateA = new Date(a.date).getTime();
      const dateB = new Date(b.date).getTime();
      if (dateB !== dateA) return dateB - dateA;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    res.json(combined);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAdminExpenseStats = async (req, res) => {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

    const allExpenses = await AdminExpense.find({});

    let totalAmount = 0;
    let thisMonthAmount = 0;
    let pendingCount = 0;
    let pendingAmount = 0;
    let approvedAmount = 0;
    const departmentBreakdown = {};

    for (const exp of allExpenses) {
      const amt = Number(exp.amount) || 0;
      totalAmount += amt;

      if (exp.status === 'approved') {
        approvedAmount += amt;
      } else if (exp.status === 'pending') {
        pendingCount += 1;
        pendingAmount += amt;
      }

      const expDate = new Date(exp.date);
      if (expDate >= startOfMonth && expDate <= endOfMonth) {
        thisMonthAmount += amt;
      }

      const dept = exp.department || 'General';
      departmentBreakdown[dept] = (departmentBreakdown[dept] || 0) + amt;
    }

    const allSalaries = await Salary.find({ status: 'paid' });
    for (const salary of allSalaries) {
      const amt = Number(salary.netAmount) || 0;
      totalAmount += amt;
      approvedAmount += amt;

      const salaryDate = salary.paymentDate ? new Date(salary.paymentDate) : new Date(salary.year, salary.month - 1, 15);
      if (salaryDate >= startOfMonth && salaryDate <= endOfMonth) {
        thisMonthAmount += amt;
      }

      const dept = salary.department || 'General';
      departmentBreakdown[dept] = (departmentBreakdown[dept] || 0) + amt;
    }

    res.json({
      totalCount: allExpenses.length,
      totalAmount,
      thisMonthAmount,
      pendingCount,
      pendingAmount,
      approvedAmount,
      departmentBreakdown,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getAdminExpenseById = async (req, res) => {
  try {
    const expense = await AdminExpense.findById(req.params.id).populate(expensePopulate);
    if (!expense) {
      return res.status(404).json({ message: 'Administrative expense not found' });
    }
    res.json(expense);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createAdminExpense = async (req, res) => {
  try {
    const {
      title,
      department,
      category,
      amount,
      date,
      paymentMethod,
      paidBy,
      paidByName,
      receiptImage,
      invoiceNumber,
      notes,
    } = req.body;

    const amountNum = Number(amount) || 0;

    const expense = new AdminExpense({
      title,
      department: department || 'General',
      category: category || 'other',
      amount: amountNum,
      date: date ? new Date(date) : new Date(),
      paymentMethod: paymentMethod || 'bank_transfer',
      paidBy: paidBy || null,
      paidByName: paidByName || '',
      receiptImage: receiptImage || '',
      invoiceNumber: invoiceNumber || '',
      notes: notes || '',
      createdBy: req.user?._id || null,
      status: 'pending',
    });

    await expense.save();

    await notifyRoles({
      roles: ['accounts', 'admin'],
      type: 'expense_recorded',
      title: 'New Administrative Expense',
      body: `₹${amountNum.toLocaleString('en-IN')} for "${title}" (${expense.department}) submitted.`,
      link: '/accounts/administrative/expenses',
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    const populated = await AdminExpense.findById(expense._id).populate(expensePopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateAdminExpense = async (req, res) => {
  try {
    const expense = await AdminExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Administrative expense not found' });
    }

    const {
      title,
      department,
      category,
      amount,
      date,
      paymentMethod,
      paidBy,
      paidByName,
      receiptImage,
      invoiceNumber,
      notes,
      status,
    } = req.body;

    if (title !== undefined) expense.title = title;
    if (department !== undefined) expense.department = department;
    if (category !== undefined) expense.category = category;
    if (amount !== undefined) expense.amount = Number(amount) || 0;
    if (date !== undefined) expense.date = new Date(date);
    if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod;
    if (paidBy !== undefined) expense.paidBy = paidBy || null;
    if (paidByName !== undefined) expense.paidByName = paidByName;
    if (receiptImage !== undefined) expense.receiptImage = receiptImage;
    if (invoiceNumber !== undefined) expense.invoiceNumber = invoiceNumber;
    if (notes !== undefined) expense.notes = notes;
    if (status !== undefined) expense.status = status;

    await expense.save();

    const populated = await AdminExpense.findById(expense._id).populate(expensePopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyAdminExpense = async (req, res) => {
  try {
    const expense = await AdminExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Administrative expense not found' });
    }

    const { status } = req.body;
    if (!['approved', 'rejected', 'pending'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    expense.status = status;
    expense.approvedBy = req.user?._id || null;
    expense.approvedAt = status !== 'pending' ? new Date() : null;

    await expense.save();

    const populated = await AdminExpense.findById(expense._id).populate(expensePopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteAdminExpense = async (req, res) => {
  try {
    const expense = await AdminExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Administrative expense not found' });
    }

    await expense.deleteOne();
    res.json({ message: 'Expense deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
