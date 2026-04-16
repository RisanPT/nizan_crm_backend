import mongoose from 'mongoose';
import FuelExpense from '../models/FuelExpense.js';

const normalizeObjectId = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : null;
};

const expensePopulate = [
  { path: 'vehicleId', select: 'name registrationNumber type fuelType status' },
  { path: 'driverId', select: 'name phone artistRole status' },
];

export const getFuelExpenses = async (req, res) => {
  try {
    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems] = await Promise.all([
        FuelExpense.find({})
          .populate(expensePopulate)
          .sort({ date: -1, createdAt: -1 })
          .skip(skip)
          .limit(currentLimit),
        FuelExpense.countDocuments({}),
      ]);

      return res.json({
        items,
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
      });
    }

    const expenses = await FuelExpense.find({})
      .populate(expensePopulate)
      .sort({ date: -1, createdAt: -1 });
    res.json(expenses);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createFuelExpense = async (req, res) => {
  const {
    vehicleId,
    driverId,
    category,
    date,
    odometerKm,
    liters,
    totalAmount,
    paymentMode,
    station,
    notes,
  } = req.body;

  try {
    const expense = await FuelExpense.create({
      vehicleId: normalizeObjectId(vehicleId),
      driverId: normalizeObjectId(driverId),
      category: category ?? 'fuel',
      date: date ?? new Date(),
      odometerKm: Number(odometerKm) || 0,
      liters: Number(liters) || 0,
      totalAmount: Number(totalAmount) || 0,
      paymentMode: paymentMode ?? 'cash',
      station: station ?? '',
      notes: notes ?? '',
    });

    const populated = await FuelExpense.findById(expense._id).populate(expensePopulate);
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateFuelExpense = async (req, res) => {
  try {
    const expense = await FuelExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Fuel expense not found' });
    }

    const {
      vehicleId,
      driverId,
      category,
      date,
      odometerKm,
      liters,
      totalAmount,
      paymentMode,
      station,
      notes,
    } = req.body;

    expense.vehicleId =
      vehicleId != null ? normalizeObjectId(vehicleId) : expense.vehicleId;
    expense.driverId =
      driverId != null ? normalizeObjectId(driverId) : expense.driverId;
    expense.category = category ?? expense.category;
    expense.date = date != null ? new Date(date) : expense.date;
    expense.odometerKm =
      odometerKm != null ? Number(odometerKm) || 0 : expense.odometerKm;
    expense.liters = liters != null ? Number(liters) || 0 : expense.liters;
    expense.totalAmount =
      totalAmount != null ? Number(totalAmount) || 0 : expense.totalAmount;
    expense.paymentMode = paymentMode ?? expense.paymentMode;
    expense.station = station ?? expense.station;
    expense.notes = notes ?? expense.notes;

    await expense.save();

    const populated = await FuelExpense.findById(expense._id).populate(expensePopulate);
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteFuelExpense = async (req, res) => {
  try {
    const expense = await FuelExpense.findById(req.params.id);
    if (!expense) {
      return res.status(404).json({ message: 'Fuel expense not found' });
    }

    await expense.deleteOne();
    res.json({ message: 'Fuel expense removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
