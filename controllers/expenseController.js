import mongoose from 'mongoose';
import Expense from '../models/Expense.js';

const expensePopulate = [
  { path: 'bookingId', select: 'bookingNumber customerName service' },
  { path: 'employeeId', select: 'name phone artistRole status' },
  { path: 'verifiedBy', select: 'name role' },
];

export const getExpenses = async (req, res) => {
  try {
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
    res.status(500).json({ message: error.message });
  }
};

export const createExpense = async (req, res) => {
  const { employeeId, bookingId, category, amount, date, notes, receiptImage, workType } = req.body;

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
      workType: workType === 'model_shoot' ? 'model_shoot' : 'bridal',
      amount: amountNum,
      date: date ?? new Date(),
      notes: notes ?? '',
      receiptImage: receiptImage ?? '',
    });

    await expense.save();

    const populated = await Expense.findById(expense._id).populate(expensePopulate);
    res.status(201).json(populated);
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

    const { bookingId, category, amount, date, notes, receiptImage, workType } =
      req.body;
    if (workType !== undefined) {
      expense.workType = workType === 'model_shoot' ? 'model_shoot' : 'bridal';
    }
    if (bookingId !== undefined) expense.bookingId = bookingId || null;
    if (category !== undefined) expense.category = category;
    if (amount !== undefined) expense.amount = Number(amount) || 0;
    if (date !== undefined) expense.date = date;
    if (notes !== undefined) expense.notes = notes ?? '';
    if (receiptImage !== undefined) expense.receiptImage = receiptImage ?? '';

    await expense.save();

    const populated = await Expense.findById(expense._id).populate(
      expensePopulate
    );
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyExpense = async (req, res) => {
  try {
    if (req.user && req.user.role !== 'admin' && req.user.role !== 'accounts') {
      return res.status(403).json({ message: 'Not authorized to verify expenses' });
    }

    const expense = await Expense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Expense not found' });
    }

    const { status, verifiedBy } = req.body;
    if (!['verified', 'rejected'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    expense.status = status;
    expense.verifiedBy = verifiedBy;
    expense.verifiedAt = new Date();

    await expense.save();

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
    res.json({ message: 'Expense removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
