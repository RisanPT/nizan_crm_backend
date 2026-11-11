import AdminExpense from '../models/AdminExpense.js';
import Salary from '../models/Salary.js';
import { notifyRoles, notify } from '../utils/notify.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { ADMIN_PAYMENT_METHODS, EXPENSE_HEADS } from '../models/AdminExpense.js';
import ChartOfAccount from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';

// Expense heads = active expense ledgers in the Chart of Accounts (plus the
// Sales Return contra head). The original seeded heads keep their flags.
const HEAD_FLAGS = new Map(EXPENSE_HEADS.map((h) => [h.code, h]));
const headQuery = () => ({
  status: { $ne: 'archived' },
  $or: [{ nature: 'expense' }, { code: 'SRT-01' }],
  // Non-cash ledgers (depreciation) are never paid out.
  group: { $not: /non-cash/i },
});

// The head as the app reads it. The flags are the account's own; an account that never had them set
// (the original seeded heads) keeps the ones built into EXPENSE_HEADS.
const headView = (a, used) => {
  const f = HEAD_FLAGS.get(a.code) || {};
  return {
    id: String(a._id),
    code: a.code,
    label: a.name,
    group: a.group || f.group || '',
    jobLinked: !!(a.jobLinked ?? f.jobLinked),
    recurring: !!(a.recurring ?? f.recurring),
    foreign: !!(a.foreign ?? f.foreign),
    status: a.status === 'archived' ? 'archived' : 'active',
    system: !!a.isSystem,
    used: used ?? 0,
  };
};

const HEAD_FIELDS = 'code name group status isSystem jobLinked recurring foreign';

// @desc    The expense heads. The form's dropdown gets the active ones; ?all=1 (approvers, for managing
//          them) also gets the archived ones and how many expenses use each.
// @route   GET /api/admin-expenses/heads
export const getExpenseHeads = async (req, res) => {
  try {
    const all = req.query.all === '1' && isApprover(req.user);
    const query = all ? { ...headQuery(), status: { $in: ['active', 'archived'] } } : headQuery();
    const accounts = await ChartOfAccount.find(query).select(HEAD_FIELDS).sort({ code: 1 }).lean();
    let counts = new Map();
    if (all) {
      const rows = await AdminExpense.aggregate([{ $match: { expenseHead: { $ne: '' } } }, { $group: { _id: '$expenseHead', n: { $sum: 1 } } }]);
      counts = new Map(rows.map((r) => [r._id, r.n]));
    }
    res.json(accounts.map((a) => headView(a, counts.get(a.code))));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Managing the heads (Accounts / Admin) ───────────────────────────────────────────────────────
// A head is an expense ledger in the Chart of Accounts, so adding one here adds the ledger and a new
// head is ready to post to straight away. Renaming and re-grouping are always safe (everything refers to
// the CODE); the code can only change while nothing uses it. A head that has been used is archived
// (hidden from the form, old expenses keep it), never deleted — and the seeded ones are never deleted.

const HEAD_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const DEFAULT_GROUP = 'Operating Expense';
const JOB_GROUP = 'Direct / Job Expense';

const cleanHeadText = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const flag = (v) => v === true || v === 'true';

const needApprover = (req, res) => {
  if (isApprover(req.user)) return true;
  res.status(403).json({ message: 'Only Accounts or an admin can manage expense heads.' });
  return false;
};

/// A free code for a new head from its name, in the style of the seeded ones: "Courier Charges" → COU-01.
const nextHeadCode = async (name) => {
  const prefix = (String(name).match(/[A-Za-z]/g) || []).join('').slice(0, 3).toUpperCase().padEnd(3, 'X');
  const taken = await ChartOfAccount.find({ code: new RegExp(`^${prefix}-\\d+$`) }).select('code').lean();
  const max = taken.reduce((m, a) => Math.max(m, Number(a.code.split('-')[1]) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(2, '0')}`;
};

/// Another head (active or archived) with this name?
const nameTaken = async (name, exceptId = null) =>
  ChartOfAccount.findOne({
    ...(exceptId ? { _id: { $ne: exceptId } } : {}),
    name: new RegExp(`^${escapeRegex(name)}$`, 'i'),
    $or: [{ nature: 'expense' }, { code: 'SRT-01' }],
  })
    .select('code status')
    .lean();

const nameClash = (hit) =>
  `There is already ${hit.status === 'archived' ? 'an archived head' : 'a head'} with that name (${hit.code}).${hit.status === 'archived' ? ' Restore it instead.' : ''}`;

/// How many expenses use a head's code, and how many ledger postings its account has.
const headUsage = async (account) => ({
  expenses: await AdminExpense.countDocuments({ expenseHead: account.code }),
  postings: await JournalEntry.countDocuments({ 'lines.account': account._id, status: { $ne: 'void' } }),
});

// @route POST /api/admin-expenses/heads   { name, group?, code?, jobLinked?, recurring?, foreign? }
export const createExpenseHead = async (req, res) => {
  if (!needApprover(req, res)) return;
  try {
    const name = cleanHeadText(req.body.name, 80);
    if (!name) return res.status(400).json({ message: 'Give the head a name.' });
    const hit = await nameTaken(name);
    if (hit) return res.status(400).json({ message: nameClash(hit) });

    const jobLinked = flag(req.body.jobLinked);
    let code = cleanHeadText(req.body.code, 20).toUpperCase();
    if (code) {
      if (!HEAD_CODE_RE.test(code)) return res.status(400).json({ message: 'The code can use letters, numbers and "-" (2–20 characters), e.g. COU-01.' });
      if (await ChartOfAccount.exists({ code })) return res.status(400).json({ message: `The code ${code} is already used by another account.` });
    } else {
      code = await nextHeadCode(name);
    }
    const account = await ChartOfAccount.create({
      code,
      name,
      nature: 'expense',
      accountType: jobLinked ? 'direct_expense' : 'indirect_expense',
      group: cleanHeadText(req.body.group, 60) || (jobLinked ? JOB_GROUP : DEFAULT_GROUP),
      jobLinked,
      recurring: flag(req.body.recurring),
      foreign: flag(req.body.foreign),
      createdBy: req.user?._id ?? null,
    });
    res.status(201).json(headView(account, 0));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/admin-expenses/heads/:id   { name?, group?, code?, jobLinked?, recurring?, foreign?, status? ('active'|'archived') }
export const updateExpenseHead = async (req, res) => {
  if (!needApprover(req, res)) return;
  try {
    const account = await ChartOfAccount.findOne({ _id: req.params.id, ...headQuery(), status: { $in: ['active', 'archived'] } });
    if (!account) return res.status(404).json({ message: 'Expense head not found.' });
    const b = req.body;

    if (b.name !== undefined) {
      const name = cleanHeadText(b.name, 80);
      if (!name) return res.status(400).json({ message: 'Give the head a name.' });
      if (name.toLowerCase() !== account.name.toLowerCase()) {
        const hit = await nameTaken(name, account._id);
        if (hit) return res.status(400).json({ message: nameClash(hit) });
      }
      account.name = name;
    }
    if (b.group !== undefined) account.group = cleanHeadText(b.group, 60) || account.group || DEFAULT_GROUP;
    // The seeded heads' own flags are on first edit copied onto the account, so a flag set here sticks
    // and the others keep what they were.
    const seed = HEAD_FLAGS.get(account.code) || {};
    for (const k of ['jobLinked', 'recurring', 'foreign']) {
      if (b[k] !== undefined) account[k] = flag(b[k]);
      else if (account[k] == null && seed[k]) account[k] = true;
    }
    if (b.jobLinked !== undefined && !account.isSystem) account.accountType = account.jobLinked ? 'direct_expense' : 'indirect_expense';
    if (b.status !== undefined) account.status = b.status === 'archived' ? 'archived' : 'active';

    if (b.code !== undefined) {
      const code = cleanHeadText(b.code, 20).toUpperCase();
      if (code && code !== account.code) {
        if (account.isSystem) return res.status(400).json({ message: 'The code of a built-in head cannot be changed.' });
        if (!HEAD_CODE_RE.test(code)) return res.status(400).json({ message: 'The code can use letters, numbers and "-" (2–20 characters), e.g. COU-01.' });
        const usage = await headUsage(account);
        if (usage.expenses > 0 || usage.postings > 0) return res.status(400).json({ message: 'This head is already used, so its code cannot change. Rename it instead.' });
        if (await ChartOfAccount.exists({ code, _id: { $ne: account._id } })) return res.status(400).json({ message: `The code ${code} is already used by another account.` });
        account.code = code;
      }
    }
    await account.save();
    res.json(headView(account, await AdminExpense.countDocuments({ expenseHead: account.code })));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/admin-expenses/heads/:id
export const deleteExpenseHead = async (req, res) => {
  if (!needApprover(req, res)) return;
  try {
    const account = await ChartOfAccount.findOne({ _id: req.params.id, ...headQuery(), status: { $in: ['active', 'archived'] } });
    if (!account) return res.status(404).json({ message: 'Expense head not found.' });
    if (account.isSystem) return res.status(400).json({ message: 'A built-in head cannot be deleted — archive it to hide it from the form.' });
    const { expenses, postings } = await headUsage(account);
    if (expenses > 0) return res.status(400).json({ message: `${expenses} expense${expenses === 1 ? ' uses' : 's use'} this head — archive it instead of deleting.` });
    if (postings > 0) return res.status(400).json({ message: `This head has ${postings} posting${postings === 1 ? '' : 's'} in the books — archive it instead of deleting.` });
    await account.deleteOne();
    res.json({ message: 'Expense head removed', id: String(account._id) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// '' is allowed (legacy rows); anything else must be an expense head.
const checkHead = async (code) => {
  if (!code) return null;
  const ok = await ChartOfAccount.exists({ ...headQuery(), code });
  return ok ? null : `Unknown expense head "${code}"`;
};
import { applyMoneyAccount } from '../utils/moneyAccount.js';
import { isApprover, resolveUserDeptName } from '../utils/departmentScope.js';
import { prepareCharge, overBudgetGate, afterSpendChange } from '../services/projectSpend.js';

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
      projectId,
      overBudgetReason,
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

    const headErr = await checkHead(expenseHead);
    if (headErr) return res.status(400).json({ message: headErr });

    const status = approver ? 'approved' : 'pending';

    // Charged to a project: it must be one that can take expenses (its cost approved). One that takes it past the approved
    // budget still goes in — pending, and flagged — but cannot be approved on the spot except by the finance head.
    let charge = null;
    let reasonForOver = '';
    if (projectId) {
      charge = await prepareCharge({ projectId, user: req.user, amount: amountNum });
      if (charge.error) return res.status(charge.error.status).json({ message: charge.error.message, code: charge.error.code });
      if (approver) {
        const gate = overBudgetGate({ check: charge.check, user: req.user, reason: overBudgetReason });
        if (gate) return res.status(gate.status).json(gate);
        if (charge.check.over) reasonForOver = String(overBudgetReason).trim().slice(0, 300);
      }
    }

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
      projectId: charge ? charge.project._id : null,
      projectName: charge ? charge.project.name : '',
      overBudgetReason: reasonForOver,
    });

    await expense.save();

    await notifyRoles({
      roles: ['accounts', 'finance_head', 'admin'],
      type: 'expense_recorded',
      title: approver
        ? 'New Administrative Expense'
        : charge?.check.over
          ? 'Department expense over a project\'s budget'
          : 'Department expense awaiting approval',
      body: approver
        ? `₹${amountNum.toLocaleString('en-IN')} for "${title}" (${deptForExpense}) recorded.`
        : `${deptForExpense}: ₹${amountNum.toLocaleString('en-IN')} for "${title}" submitted for approval${charge?.check.over ? `. It takes ${charge.project.name} over its approved budget — only the finance head can approve it.` : '.'}`,
      link: '/accounts/admin-expenses',
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    // Only APPROVED expenses hit the books. A pending departmental submission
    // is NOT posted until Accounts approves it.
    if (status === 'approved') {
      await safePost(() => postDoc('AdminExpense', expense.toObject(), req.user?._id || null));
    }

    if (charge) await afterSpendChange(charge.project);

    const populated = await AdminExpense.findById(expense._id).populate(expensePopulate);
    // a pending expense that takes the project over its budget is filed, with the warning beside it
    res.status(201).json(charge?.check.over && !approver ? { ...populated.toObject(), warning: { code: 'OVER_BUDGET', ...charge.check } } : populated);
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
      projectId,
      overBudgetReason,
    } = req.body;

    // Charged to another project (or to none), or a different amount: check it again against the project it will sit on.
    const oldProject = expense.projectId;
    const nextAmount = amount !== undefined ? Number(amount) || 0 : expense.amount;
    const nextProject = projectId !== undefined ? projectId || null : expense.projectId;
    const nextStatus = approver && status !== undefined ? status : expense.status;
    let charge = null;
    if (nextProject && nextStatus !== 'rejected') {
      const changed = projectId !== undefined || amount !== undefined || nextStatus !== expense.status;
      if (changed) {
        charge = await prepareCharge({ projectId: nextProject, user: req.user, amount: nextAmount, exceptId: expense._id });
        if (charge.error) return res.status(charge.error.status).json({ message: charge.error.message, code: charge.error.code });
        if (nextStatus === 'approved') {
          const gate = overBudgetGate({ check: charge.check, user: req.user, reason: overBudgetReason });
          if (gate) return res.status(gate.status).json(gate);
          expense.overBudgetReason = charge.check.over ? String(overBudgetReason).trim().slice(0, 300) : '';
        }
        expense.projectId = charge.project._id;
        expense.projectName = charge.project.name;
      }
    } else if (projectId !== undefined && !projectId) {
      expense.projectId = null;
      expense.projectName = '';
      expense.overBudgetReason = '';
    }

    if (title !== undefined) expense.title = title;
    // Only approvers may re-assign the department or move the approval status.
    if (approver && department !== undefined) expense.department = department;
    if (category !== undefined) expense.category = category;
    // (an unchanged head is not re-checked: a head archived since the expense was filed must not lock its edits)
    if (expenseHead !== undefined && expenseHead !== expense.expenseHead) {
      const headErr = await checkHead(expenseHead);
      if (headErr) return res.status(400).json({ message: headErr });
      expense.expenseHead = expenseHead;
    }
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

    // what the project(s) have spent has changed
    if (oldProject) await afterSpendChange(oldProject);
    if (expense.projectId && String(expense.projectId) !== String(oldProject ?? '')) await afterSpendChange(expense.projectId);

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

    // Approving an expense charged to a project: it must still be able to take it, and one that takes the project past its
    // approved budget is the finance head's to approve, with a reason.
    if (status === 'approved' && expense.projectId) {
      const charge = await prepareCharge({ projectId: expense.projectId, user: req.user, amount: expense.amount, exceptId: expense._id });
      if (charge.error && charge.error.status !== 404) return res.status(charge.error.status).json({ message: charge.error.message, code: charge.error.code });
      if (!charge.error) {
        const gate = overBudgetGate({ check: charge.check, user: req.user, reason: req.body.overBudgetReason });
        if (gate) return res.status(gate.status).json(gate);
        expense.overBudgetReason = charge.check.over ? String(req.body.overBudgetReason).trim().slice(0, 300) : '';
      }
    }

    expense.status = status;
    expense.approvedBy = req.user?._id || null;
    expense.approvedAt = status !== 'pending' ? new Date() : null;

    // Which bank / cash account paid it (approval popup).
    if (status === 'approved') {
      const err = await applyMoneyAccount(expense, req.body, {
        modeField: 'paymentMethod',
        modes: ADMIN_PAYMENT_METHODS,
      });
      if (err) return res.status(400).json({ message: err });
    }

    await expense.save();
    if (expense.projectId) await afterSpendChange(expense.projectId);

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
    if (expense.projectId) await afterSpendChange(expense.projectId);
    await safePost(() => unpostDoc('AdminExpense', expense._id));
    res.json({ message: 'Expense deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
