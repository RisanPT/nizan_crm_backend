import mongoose from 'mongoose';
import FoodAllowance from '../models/FoodAllowance.js';
import { MEALS } from '../utils/mealAllocation.js';
import { validateRule } from '../utils/foodAllowance.js';

// The food allowance per head, one rule per meal (and date range). Anyone signed in may READ
// them (an artist sees the allowance while adding a meal); only Accounts / admin change them.

const WRITE_ROLES = new Set(['accounts', 'finance_head', 'admin']);
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const fail = (res, err) => res.status(err.status ?? 500).json({ message: err.message });
const present = (r) => ({
  _id: String(r._id),
  meal: r.meal,
  amountPerHead: r.amountPerHead,
  effectiveFrom: r.effectiveFrom || '',
  effectiveTo: r.effectiveTo || '',
  active: r.active !== false,
  note: r.note || '',
  updatedAt: r.updatedAt,
});

const mayWrite = (req) => {
  if (!WRITE_ROLES.has(req.user?.role)) throw bad('Only Accounts or an admin can change the food allowance.', 403);
};

/// Meals in the order of the day, then the latest rule first.
const ordered = (rules) =>
  [...rules].sort((a, b) => MEALS.indexOf(a.meal) - MEALS.indexOf(b.meal) || String(b.effectiveFrom || '').localeCompare(String(a.effectiveFrom || '')));

// @route GET /api/food-allowances
export const listAllowances = async (req, res) => {
  try {
    const rules = await FoodAllowance.find({}).lean();
    res.json(ordered(rules).map(present));
  } catch (err) {
    fail(res, err);
  }
};

// @route POST /api/food-allowances
export const createAllowance = async (req, res) => {
  try {
    mayWrite(req);
    const existing = await FoodAllowance.find({}).lean();
    const checked = validateRule(req.body ?? {}, existing);
    if (checked.error) throw bad(checked.error, checked.conflict ? 409 : 400);
    const rule = await FoodAllowance.create({ ...checked.clean, createdBy: req.user._id, updatedBy: req.user._id });
    res.status(201).json(present(rule));
  } catch (err) {
    fail(res, err);
  }
};

// @route PUT /api/food-allowances/:id
export const updateAllowance = async (req, res) => {
  try {
    mayWrite(req);
    if (!mongoose.isValidObjectId(req.params.id)) throw bad('That allowance is not valid');
    const rule = await FoodAllowance.findById(req.params.id);
    if (!rule) throw bad('Allowance not found', 404);
    const existing = await FoodAllowance.find({ _id: { $ne: rule._id } }).lean();
    // what is not sent stays as it was
    const merged = {
      meal: req.body?.meal ?? rule.meal,
      amountPerHead: req.body?.amountPerHead ?? rule.amountPerHead,
      effectiveFrom: req.body?.effectiveFrom ?? rule.effectiveFrom,
      effectiveTo: req.body?.effectiveTo ?? rule.effectiveTo,
      active: req.body?.active ?? rule.active,
      note: req.body?.note ?? rule.note,
    };
    const checked = validateRule(merged, existing);
    if (checked.error) throw bad(checked.error, checked.conflict ? 409 : 400);
    Object.assign(rule, checked.clean, { updatedBy: req.user._id });
    await rule.save();
    res.json(present(rule));
  } catch (err) {
    fail(res, err);
  }
};

// @route DELETE /api/food-allowances/:id
export const deleteAllowance = async (req, res) => {
  try {
    mayWrite(req);
    if (!mongoose.isValidObjectId(req.params.id)) throw bad('That allowance is not valid');
    const rule = await FoodAllowance.findByIdAndDelete(req.params.id);
    if (!rule) throw bad('Allowance not found', 404);
    res.json({ message: 'Allowance deleted', _id: String(rule._id) });
  } catch (err) {
    fail(res, err);
  }
};
