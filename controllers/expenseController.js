import mongoose from 'mongoose';
import Expense from '../models/Expense.js';

const expensePopulate = [
  { path: 'bookingId', select: 'bookingNumber customerName service' },
  { path: 'employeeId', select: 'name phone artistRole status' },
  { path: 'verifiedBy', select: 'name role' },
];

export const getExpenses = async (req, res) => {
  try {
    const { status, employeeId, bookingId } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (employeeId) filter.employeeId = employeeId;
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
  const { employeeId, bookingId, category, amount, date, notes, receiptImage } = req.body;

  try {
    const expense = await Expense.create({
      employeeId,
      bookingId: bookingId || null,
      category: category ?? 'other',
      amount: Number(amount) || 0,
      date: date ?? new Date(),
      notes: notes ?? '',
      receiptImage: receiptImage ?? '',
    });

    const populated = await Expense.findById(expense._id).populate(expensePopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const verifyExpense = async (req, res) => {
  try {
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

    if (expense.status === 'verified') {
      return res.status(400).json({ message: 'Cannot delete a verified expense' });
    }

    await expense.deleteOne();
    res.json({ message: 'Expense removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
