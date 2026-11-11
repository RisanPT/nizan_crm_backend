import mongoose from 'mongoose';
import FuelPrice from '../models/FuelPrice.js';
import { todayIst } from '../utils/istDate.js';
import { FUEL_TYPES, TOLERANCE_PCT, UNITS, currentPrices, validatePrice } from '../utils/fuelPrice.js';

// The fuel prices. Anyone signed in may READ them (a driver sees today's rate while adding a fill-up);
// only Accounts, the fleet manager or an admin change them.

const WRITE_ROLES = new Set(['accounts', 'finance_head', 'fleet_manager', 'admin']);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const fail = (res, err) => res.status(err.status ?? 500).json({ message: err.message });

const present = (r) => ({
  _id: String(r._id),
  fuelType: r.fuelType,
  unit: UNITS[r.fuelType],
  pricePerUnit: r.pricePerUnit,
  effectiveFrom: r.effectiveFrom,
  note: r.note || '',
  updatedAt: r.updatedAt,
});

const mayWrite = (req) => {
  if (!WRITE_ROLES.has(req.user?.role)) throw bad('Only Accounts, the fleet manager or an admin can change the fuel prices.', 403);
};

/// Fuels in a fixed order, the latest price first within each.
const ordered = (rows) =>
  [...rows].sort((a, b) => FUEL_TYPES.indexOf(a.fuelType) - FUEL_TYPES.indexOf(b.fuelType) || b.effectiveFrom.localeCompare(a.effectiveFrom));

// @route GET /api/fuel-prices
// → { items, current: { petrol: {…}|null, … }, today, tolerancePct }
export const listFuelPrices = async (req, res) => {
  try {
    const rows = await FuelPrice.find({}).lean();
    const today = todayIst();
    const current = Object.fromEntries(Object.entries(currentPrices(rows, today)).map(([t, r]) => [t, r ? present(r) : null]));
    res.json({ items: ordered(rows).map(present), current, today, tolerancePct: TOLERANCE_PCT });
  } catch (err) {
    fail(res, err);
  }
};

// @route POST /api/fuel-prices
export const createFuelPrice = async (req, res) => {
  try {
    mayWrite(req);
    const existing = await FuelPrice.find({}).lean();
    // no "from" date sent → the price starts today
    const checked = validatePrice({ ...(req.body ?? {}), effectiveFrom: req.body?.effectiveFrom || todayIst() }, existing);
    if (checked.error) throw bad(checked.error, checked.conflict ? 409 : 400);
    const row = await FuelPrice.create({ ...checked.clean, createdBy: req.user._id, updatedBy: req.user._id });
    res.status(201).json(present(row));
  } catch (err) {
    fail(res, err);
  }
};

// @route PUT /api/fuel-prices/:id
export const updateFuelPrice = async (req, res) => {
  try {
    mayWrite(req);
    if (!mongoose.isValidObjectId(req.params.id)) throw bad('That price is not valid');
    const row = await FuelPrice.findById(req.params.id);
    if (!row) throw bad('Price not found', 404);
    const existing = await FuelPrice.find({ _id: { $ne: row._id } }).lean();
    // what is not sent stays as it was
    const merged = {
      fuelType: req.body?.fuelType ?? row.fuelType,
      pricePerUnit: req.body?.pricePerUnit ?? row.pricePerUnit,
      effectiveFrom: req.body?.effectiveFrom ?? row.effectiveFrom,
      note: req.body?.note ?? row.note,
    };
    const checked = validatePrice(merged, existing);
    if (checked.error) throw bad(checked.error, checked.conflict ? 409 : 400);
    Object.assign(row, checked.clean, { updatedBy: req.user._id });
    await row.save();
    res.json(present(row));
  } catch (err) {
    fail(res, err);
  }
};

// @route DELETE /api/fuel-prices/:id
export const deleteFuelPrice = async (req, res) => {
  try {
    mayWrite(req);
    if (!mongoose.isValidObjectId(req.params.id)) throw bad('That price is not valid');
    const row = await FuelPrice.findById(req.params.id);
    if (!row) throw bad('Price not found', 404);
    await row.deleteOne();
    res.json({ message: 'Price removed' });
  } catch (err) {
    fail(res, err);
  }
};
