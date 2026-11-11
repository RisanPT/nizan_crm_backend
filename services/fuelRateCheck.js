import FuelPrice from '../models/FuelPrice.js';
import { istDayKey } from '../utils/istDate.js';
import { UNITS, priceOn, priceTypeOf, rateCheck } from '../utils/fuelPrice.js';

/// The rate check of ONE fuel expense (a plain object, its vehicle populated with `fuelType`), given
/// every price row. Null for anything that is not a fuel fill-up on a vehicle with a priced fuel.
///   → { fuelType, unit, status, rate, price, expected, diff, diffPct, tolerancePct }
export const rateCheckOf = (expense, rows) => {
  if (!expense || (expense.category ?? 'fuel') !== 'fuel') return null;
  const fuelType = priceTypeOf(expense.vehicleId?.fuelType);
  if (!fuelType) return null;
  const day = expense.dayKey || istDayKey(expense.date);
  const price = priceOn(rows, fuelType, day)?.pricePerUnit ?? null;
  return { fuelType, unit: UNITS[fuelType], ...rateCheck({ quantity: expense.liters, amount: expense.totalAmount, price }) };
};

/// Puts `rateCheck` on each of [items] (plain objects, in place). Never throws — a failure here only
/// means no check is shown; the expenses themselves are unaffected.
export const attachRateChecks = async (items) => {
  try {
    if (!items.length) return items;
    const rows = await FuelPrice.find({}).lean();
    for (const item of items) item.rateCheck = rateCheckOf(item, rows);
  } catch (err) {
    console.error('fuel rate check failed:', err.message);
  }
  return items;
};
