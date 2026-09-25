import AdminExpense from '../models/AdminExpense.js';
import Salary from '../models/Salary.js';
import { notifyRoles, notify } from '../utils/notify.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { isApprover, resolveUserDeptName } from '../utils/departmentScope.js';

// Treat user search text literally — an unescaped "(" or "*" would otherwise
// throw "Invalid regular expression" and fail the whole request with a 500.
const escapeRegex = (s) => String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Accounts + Admin are the approvers: they see every department's expenses,
// approve/reject them, and anything they add directly is auto-approved (posts
// to the books immediately). Everyone else is a department head who may only
// SUBMIT expenses for their OWN department — those stay pending (and out of the
// ledger) until an approver approves them. Mirrors the artist-expense flow.
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
      const searchRegex = new RegExp(escapeRegex(search), 'i');
      filter.$or = [
        { title: searchRegex },
        { paidByName: searchRegex },
        { invoiceNumber: searchRegex },
        { notes: searchRegex },
      ];
    }

    // Department heads (non-approvers) only ever see their OWN department's
    // expenses — the query's `department` param can't widen that.
    const approver = isApprover(req.user);
    if (!approver) {
      const deptName = await resolveUserDeptName(req.user);
      if (deptName) {
        filter.department = deptName;
      } else {
        // No department on record → restrict to only what they submitted.
        filter.createdBy = req.user?._id ?? null;
      }
    }

    const expenses = await AdminExpense.find(filter)
      .populate(expensePopulate)
      .lean();

    // Payroll rows are sensitive — only approvers get the auto-integrated
    // salary lines merged in.
    let salaries = [];
    if (approver && (!category || category === 'All' || category === 'other')) {
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
        const searchRegex = new RegExp(escapeRegex(search), 'i');
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

    // Scope stats to the department head's own department; approvers see all.
    const approver = isApprover(req.user);
    const statsFilter = {};
    if (!approver) {
      const deptName = await resolveUserDeptName(req.user);
      if (deptName) {
        statsFilter.department = deptName;
      } else {
        statsFilter.createdBy = req.user?._id ?? null;
      }
    }

    const allExpenses = await AdminExpense.find(statsFilter);

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

    const allSalaries = approver ? await Salary.find({ status: 'paid' }) : [];
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
      expenseHead,
      vendor,
      costTag,
      isRecurring,
      gstType,
      gstAmount,
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

    // Approvers (Accounts/Admin) may file for any department and it is approved
    // on the spot (and posted). A department head may only file for their OWN
    // department, and it stays pending — out of the books — until Accounts
    // approves it. Mirrors the artist-expense submit → verify flow.
    const approver = isApprover(req.user);
    let deptForExpense = department || 'General';
    if (!approver) {
      const deptName = await resolveUserDeptName(req.user);
      if (!deptName) {
        return res.status(400).json({
          message:
            'Your account is not linked to a department, so you cannot submit a departmental expense. Ask an admin to set your department.',
        });
      }
      deptForExpense = deptName;
    }

    const status = approver ? 'approved' : 'pending';

    const expense = new AdminExpense({
      title,
      department: deptForExpense,
      category: category || 'other',
      expenseHead: expenseHead || '',
      vendor: vendor || '',
      costTag: costTag || '',
      isRecurring: isRecurring === true || isRecurring === 'true',
      gstType: gstType || 'none',
      gstAmount: Number(gstAmount) || 0,
      amount: amountNum,
      date: date ? new Date(date) : new Date(),
      paymentMethod: paymentMethod || 'bank_transfer',
      paidBy: paidBy || null,
      paidByName: paidByName || '',
      receiptImage: receiptImage || '',
      invoiceNumber: invoiceNumber || '',
      notes: notes || '',
      createdBy: req.user?._id || null,
      status,
      approvedBy: approver ? req.user?._id || null : null,
      approvedAt: approver ? new Date() : null,
    });

    await expense.save();

    await notifyRoles({
      roles: ['accounts', 'admin'],
      type: 'expense_recorded',
      title: approver
        ? 'New Administrative Expense'
        : 'Department expense awaiting approval',
      body: approver
        ? `₹${amountNum.toLocaleString('en-IN')} for "${title}" (${deptForExpense}) recorded.`
        : `${deptForExpense}: ₹${amountNum.toLocaleString('en-IN')} for "${title}" submitted for approval.`,
      link: '/accounts/admin-expenses',
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    // Only APPROVED expenses hit the books. A pending departmental submission
    // is NOT posted until Accounts approves it.
    if (status === 'approved') {
      await safePost(() => postDoc('AdminExpense', expense.toObject(), req.user?._id || null));
    }

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

    // A department head may only edit their OWN department's expense while it is
    // still pending — once Accounts has approved/rejected it, it is locked and
    // they cannot move the audited figure. They also cannot re-file it under
    // another department or change its approval status.
    const approver = isApprover(req.user);
    if (!approver) {
      const deptName = await resolveUserDeptName(req.user);
      if (deptName && expense.department !== deptName) {
        return res
          .status(403)
          .json({ message: 'Not authorized to edit this expense' });
      }
      if (expense.status !== 'pending') {
        return res.status(400).json({
          message: `This expense has already been ${expense.status} by Accounts and can no longer be edited.`,
        });
      }
    }

    const {
      title,
      department,
      category,
      expenseHead,
      vendor,
      costTag,
      isRecurring,
      gstType,
      gstAmount,
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
    // Only approvers may re-assign the department or move the approval status.
    if (approver && department !== undefined) expense.department = department;
    if (category !== undefined) expense.category = category;
    if (expenseHead !== undefined) expense.expenseHead = expenseHead;
    if (vendor !== undefined) expense.vendor = vendor;
    if (costTag !== undefined) expense.costTag = costTag;
    if (isRecurring !== undefined) expense.isRecurring = isRecurring === true || isRecurring === 'true';
    if (gstType !== undefined) expense.gstType = gstType;
    if (gstAmount !== undefined) expense.gstAmount = Number(gstAmount) || 0;
    if (amount !== undefined) expense.amount = Number(amount) || 0;
    if (date !== undefined) expense.date = new Date(date);
    if (paymentMethod !== undefined) expense.paymentMethod = paymentMethod;
    if (paidBy !== undefined) expense.paidBy = paidBy || null;
    if (paidByName !== undefined) expense.paidByName = paidByName;
    if (receiptImage !== undefined) expense.receiptImage = receiptImage;
    if (invoiceNumber !== undefined) expense.invoiceNumber = invoiceNumber;
    if (notes !== undefined) expense.notes = notes;
    if (approver && status !== undefined) expense.status = status;

    await expense.save();

    // Keep the ledger in step with the approval status: an approved expense is
    // (re)posted; a pending/rejected one is kept out of the books.
    if (expense.status === 'approved') {
      await safePost(() => postDoc('AdminExpense', expense.toObject(), req.user?._id || null));
    } else {
      await safePost(() => unpostDoc('AdminExpense', expense._id));
    }

    const populated = await AdminExpense.findById(expense._id).populate(expensePopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyAdminExpense = async (req, res) => {
  try {
    // Approving/rejecting a payment is an Accounts/Admin action only.
    if (!isApprover(req.user)) {
      return res
        .status(403)
        .json({ message: 'Only Accounts can approve or reject expenses' });
    }

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

    // Post to the books on approval; pull it back out on reject / send-back.
    if (status === 'approved') {
      await safePost(() => postDoc('AdminExpense', expense.toObject(), req.user?._id || null));
    } else {
      await safePost(() => unpostDoc('AdminExpense', expense._id));
    }

    // Let the department head who submitted it know the outcome.
    if (expense.createdBy && status !== 'pending') {
      await notify({
        recipients: [expense.createdBy],
        type: 'expense_recorded',
        title: status === 'approved' ? 'Expense approved' : 'Expense rejected',
        body: `Your ${expense.department} expense "${expense.title}" (₹${(Number(expense.amount) || 0).toLocaleString('en-IN')}) was ${status} by Accounts.`,
        link: '/accounts/admin-expenses',
        createdBy: req.user?._id ?? null,
        excludeUserId: req.user?._id ?? null,
      });
    }

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
    await safePost(() => unpostDoc('AdminExpense', expense._id));
    res.json({ message: 'Expense deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
