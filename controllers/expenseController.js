import mongoose from 'mongoose';
import Expense from '../models/Expense.js';
import { notifyRoles } from '../utils/notify.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { applyMoneyAccount } from '../utils/moneyAccount.js';
import { runFinanceList } from '../services/financeList.js';
import { isNewStyleQuery, QueryError } from '../utils/financeListQuery.js';
import { cleanMeals, canonicalMeals, mealsOf, mealsText, singleMeal } from '../utils/mealAllocation.js';
import { attachMealAllocation, computeAllocations } from '../services/mealAllocation.js';
import { teamMealStates, teamMealKey } from '../services/teamMealLimit.js';
import { teamMealCheck } from '../utils/foodAllowance.js';

const expensePopulate = [
  // travelDistanceKm: the work's distance, shown to Accounts beside the food bill
  { path: 'bookingId', select: 'bookingNumber customerName service travelDistanceKm bookingItems.travelDistanceKm' },
  { path: 'employeeId', select: 'name phone artistRole status' },
  { path: 'verifiedBy', select: 'name role' },
];

// @desc    Artist expenses, newest first. With ?page / ?summary / ?export / ?from / ?search /
//          ?sort … (the Accounts screens) it is filtered, sorted and paged on the server —
//          see services/financeList.js. Without them, the plain list older callers expect.
// With ?withWorks=1 (the Accounts screens) each FOOD expense also carries `allocation`: the
// work it was eaten for (by the meal's time) and why — services/mealAllocation.js. A failure
// there never fails the list; the expenses are then returned without it.
const withAllocation = async (out, req) => {
  if (req.query.withWorks !== '1' || req.user?.role === 'driver') return out;
  try {
    if (Array.isArray(out)) return await attachMealAllocation(out.map((d) => d.toJSON()));
    const items = await attachMealAllocation(out.items.map((d) => d.toJSON()));
    return { ...out, items };
  } catch (err) {
    console.error('meal allocation failed:', err.message);
    return out;
  }
};

/// Is the team over its limit for the meal(s) on the work this food expense counts under?
///   → { workId, meal, meals, heads, allowancePerHead, limit, alreadySpent, thisAmount, total, over, status } | null
/// (null for anything that is not a meal under a client work). `meals` is the pool the limit is for —
/// the entry's own meals, plus any other the team tied to them on that work — and `meal` its key
/// ('lunch', or 'breakfast+lunch+dinner'); allowancePerHead is the sum over the pool. Never throws:
/// a failure just means no check is reported.
const limitCheckFor = async (expense) => {
  try {
    const meals = mealsOf(expense);
    if (expense.category !== 'food' || expense.workType === 'model_shoot' || meals.length === 0) return null;
    const { byExpense } = await computeAllocations([expense.toObject()]);
    const workId = byExpense.get(String(expense._id))?.shares?.[0]?.bookingId;
    if (!workId) return null;
    const state = (await teamMealStates([{ workId, meals }], { excludeExpenseId: expense._id })).get(teamMealKey(workId, meals));
    if (!state) return null;
    return { workId, meal: state.meals.join('+'), meals: state.meals, ...teamMealCheck({ heads: state.heads, allowancePerHead: state.allowancePerHead, alreadySpent: state.alreadySpent, amount: expense.amount }) };
  } catch (err) {
    console.error('team limit check failed:', err.message);
    return null;
  }
};

/// What the client sent for the meals of a food entry: `meals` (a list — one bill may cover several
/// meals), else the older single `meal`. → { meals: [...cleaned], meal: the single one or '' }
const mealFields = (meals, meal, category) => {
  const list = cleanMeals(canonicalMeals(meals).length > 0 ? meals : meal, category);
  return { meals: list, meal: singleMeal(list) };
};

export const getExpenses = async (req, res) => {
  try {
    if (isNewStyleQuery(req.query)) {
      const out = await runFinanceList({ kind: 'expense', query: req.query, user: req.user, populate: expensePopulate });
      return res.json(await withAllocation(out, req));
    }
    const { status, employeeId, bookingId, workType } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (workType && workType !== 'All') filter.workType = workType;
    
    // Role-based scoping
    if (req.user && (req.user.role === 'artist' || req.user.role === 'driver')) {
      filter.employeeId = req.user.employeeId;
    } else if (employeeId) {
      filter.employeeId = employeeId;
    }

    if (bookingId) filter.bookingId = bookingId;

    const expenses = await Expense.find(filter)
      .populate(expensePopulate)
      .sort({ date: -1, createdAt: -1 });
    res.json(expenses);
  } catch (error) {
    res.status(error instanceof QueryError ? error.status : 500).json({ message: error.message });
  }
};

export const createExpense = async (req, res) => {
  const { employeeId, bookingId, category, amount, date, notes, receiptImage, workType, meal, meals } = req.body;

  try {
    let finalEmployeeId = employeeId;
    if (req.user && (req.user.role === 'artist' || req.user.role === 'driver')) {
      finalEmployeeId = req.user.employeeId;
    }

    const amountNum = Number(amount) || 0;
    
    // Create the expense
    const expense = new Expense({
      employeeId: finalEmployeeId,
      bookingId: bookingId || null,
      category: category ?? 'other',
      // for food: one or more of breakfast | lunch | snacks | dinner (the time is `date`); anything else is dropped
      ...mealFields(meals, meal, category ?? 'other'),
      workType: workType === 'model_shoot' ? 'model_shoot' : 'bridal',
      amount: amountNum,
      date: date ?? new Date(),
      notes: notes ?? '',
      receiptImage: receiptImage ?? '',
    });

    await expense.save();

    // Is the team over its limit for this meal? (heads × the allowance per head, counting what the
    // team has already logged.) Reported back to the artist and to Accounts.
    const limitCheck = await limitCheckFor(expense);
    const overBy = limitCheck?.status === 'over' ? ` Team limit for ${mealsText(limitCheck.meals) || 'the meal'} exceeded by ₹${limitCheck.over.toLocaleString('en-IN')} (${limitCheck.heads} × ₹${limitCheck.allowancePerHead}).` : '';

    // Notify Accounts + Admins that a new expense/payable was submitted.
    await notifyRoles({
      roles: ['accounts', 'finance_head', 'admin'],
      type: 'expense_recorded',
      title: limitCheck?.status === 'over' ? 'Expense over the food limit' : 'New expense recorded',
      body: `A ${expense.category} expense of ₹${amountNum.toLocaleString('en-IN')} was submitted.${overBy}`,
      link: '/accounts/bills',
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    const populated = await Expense.findById(expense._id).populate(expensePopulate);
    res.status(201).json({ ...populated.toJSON(), limitCheck });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/// Edits an expense. An artist/driver may only change their OWN entry, and
/// only while it is still `pending` — once Accounts has verified or rejected
/// it the record is locked so the audited figure cannot move underneath them.
export const updateExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    const role = req.user?.role;
    const isOwnerRole = role === 'artist' || role === 'driver';

    if (isOwnerRole) {
      if (String(expense.employeeId) !== String(req.user.employeeId)) {
        return res
          .status(403)
          .json({ message: 'Not authorized to edit this expense' });
      }
      if (expense.status !== 'pending') {
        return res.status(400).json({
          message:
            `This expense has already been ${expense.status} by Accounts and can no longer be edited.`,
        });
      }
    }

    const { bookingId, category, amount, date, notes, receiptImage, workType, meal, meals } =
      req.body;
    if (workType !== undefined) {
      expense.workType = workType === 'model_shoot' ? 'model_shoot' : 'bridal';
    }
    if (bookingId !== undefined) expense.bookingId = bookingId || null;
    if (category !== undefined) expense.category = category;
    // A meal only means something on a food expense: keep it in step with the category.
    if (meal !== undefined || meals !== undefined || category !== undefined) {
      const sent = meals !== undefined || meal !== undefined;
      Object.assign(expense, mealFields(sent ? meals : mealsOf(expense), sent ? meal : '', expense.category));
    }
    if (amount !== undefined) expense.amount = Number(amount) || 0;
    if (date !== undefined) expense.date = date;
    if (notes !== undefined) expense.notes = notes ?? '';
    if (receiptImage !== undefined) expense.receiptImage = receiptImage ?? '';

    await expense.save();
    // Keep a posted (popup-verified) expense's voucher in step with edits.
    await safePost(() => postDoc('Expense', expense.toObject(), req.user?._id || null));

    const populated = await Expense.findById(expense._id).populate(
      expensePopulate
    );
    // After an edit, is the team (still) over its limit for this meal?
    res.json({ ...populated.toJSON(), limitCheck: await limitCheckFor(expense) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyExpense = async (req, res) => {
  try {
    if (req.user && req.user.role !== 'admin' && req.user.role !== 'accounts' && req.user.role !== 'finance_head') {
      return res.status(403).json({ message: 'Not authorized to verify expenses' });
    }

    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    const { status, verifiedBy, verifiedAt } = req.body;
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    expense.status = status;
    expense.verifiedBy = verifiedBy;
    expense.verifiedAt = verifiedAt ? new Date(verifiedAt) : new Date();

    // How it was paid back (approval popup). Only expenses verified with an
    // account post to the ledger.
    if (status === 'verified') {
      const err = await applyMoneyAccount(expense, req.body, {
        modeField: 'paymentMode',
        modes: ['cash', 'upi', 'bank_transfer', 'other'],
      });
      if (err) return res.status(400).json({ message: err });
    }

    await expense.save();
    await safePost(() => postDoc('Expense', expense.toObject(), req.user?._id || null));

    const populated = await Expense.findById(expense._id).populate(expensePopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteExpense = async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    if (req.user && (req.user.role === 'artist' || req.user.role === 'driver') && String(expense.employeeId) !== String(req.user.employeeId)) {
      return res.status(403).json({ message: 'Not authorized to delete this expense' });
    }

    // Restriction removed as per user request: Admin/Accounts need to be able to delete entries.
    /*
    if (expense.status === 'verified') {
      return res.status(400).json({ message: 'Cannot delete a verified expense' });
    }
    */

    await expense.deleteOne();
    await safePost(() => unpostDoc('Expense', expense._id));
    res.json({ message: 'Expense removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
