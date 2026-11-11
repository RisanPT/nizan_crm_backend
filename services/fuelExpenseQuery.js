import mongoose from 'mongoose';
import FuelExpense from '../models/FuelExpense.js';
import Employee from '../models/Employee.js';
import Vehicle from '../models/Vehicle.js';
import Booking from '../models/Booking.js';
import { istStart, istEnd } from '../utils/istDate.js';
import { escapeRegex } from '../utils/fuelExpenseQuery.js';

// The database half of the fleet-expense list filters (parsing/validation is in
// utils/fuelExpenseQuery.js). Used by the list, its summary and the export, so the
// three always agree on what "the filtered expenses" are.

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param {object} p  from parseExpenseQuery
 * @param {object} [o]
 * @param {boolean} [o.excludeStatus]  ignore the status filter (for the status chips' counts)
 * @param {*} [o.driverEmployeeId]    a driver signed in sees only their own — overrides driverId
 * @returns a Mongo filter. Ids are real ObjectIds because aggregate() does not cast.
 */
export const buildExpenseFilter = async (p, { excludeStatus = false, driverEmployeeId = null } = {}) => {
  const f = {};
  const and = [];

  if (p.from || p.to) {
    f.date = {};
    if (p.from) f.date.$gte = istStart(p.from);
    if (p.to) f.date.$lte = istEnd(p.to);
  }
  if (!excludeStatus && p.statuses.length) f.status = { $in: p.statuses };
  if (p.categories.length) f.category = { $in: p.categories };
  if (p.paymentModes.length) f.paymentMode = { $in: p.paymentModes };
  if (p.driverId) f.driverId = oid(p.driverId);
  if (p.vehicleId) f.vehicleId = oid(p.vehicleId);
  if (p.work === 'linked') f.bookingId = { $ne: null };
  if (p.work === 'whole_day') f.bookingId = null; // matches "no work" and "field missing"
  if (p.bill === 'with') f.billImage = { $nin: ['', null] };
  if (p.bill === 'without') and.push({ $or: [{ billImage: '' }, { billImage: null }] });
  if (p.minAmount !== null || p.maxAmount !== null) {
    f.totalAmount = {};
    if (p.minAmount !== null) f.totalAmount.$gte = p.minAmount;
    if (p.maxAmount !== null) f.totalAmount.$lte = p.maxAmount;
  }

  if (p.search) {
    const rx = new RegExp(escapeRegex(p.search), 'i');
    const [drivers, vehicles, bookings] = await Promise.all([
      Employee.find({ name: rx }).select('_id').limit(200).lean(),
      Vehicle.find({ $or: [{ name: rx }, { registrationNumber: rx }] }).select('_id').limit(200).lean(),
      // client name / booking number → the expenses tied to those works
      Booking.find({ $or: [{ customerName: rx }, { bookingNumber: rx }] }).select('_id').limit(500).lean(),
    ]);
    const ors = [{ station: rx }, { notes: rx }, { category: rx }];
    if (drivers.length) ors.push({ driverId: { $in: drivers.map((d) => d._id) } });
    if (vehicles.length) ors.push({ vehicleId: { $in: vehicles.map((v) => v._id) } });
    if (bookings.length) ors.push({ bookingId: { $in: bookings.map((b) => b._id) } });
    if (/^\d+(\.\d+)?$/.test(p.search)) ors.push({ totalAmount: Number(p.search) });
    and.push({ $or: ors });
  }

  if (driverEmployeeId) f.driverId = oid(driverEmployeeId); // wins over any driverId filter
  if (and.length) f.$and = and;
  return f;
};

const sums = [{ $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }];

/**
 * Totals for the whole filtered set (every page):
 *   byStatus    per-status count + amount, IGNORING the status filter (the chips / KPI cards)
 *   shown       count + amount of exactly what the list shows
 *   byCategory  per category, biggest first
 *   byDriver    top 8 drivers by amount, with names
 */
export const summarizeExpenses = async (p, opts = {}) => {
  const full = await buildExpenseFilter(p, opts);
  const noStatus = await buildExpenseFilter(p, { ...opts, excludeStatus: true });

  const [statusRows, categoryRows, driverRows, shownRows] = await Promise.all([
    FuelExpense.aggregate([{ $match: noStatus }, { $group: { _id: '$status', count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } }]),
    FuelExpense.aggregate([
      { $match: full },
      { $group: { _id: '$category', count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } },
      { $sort: { amount: -1 } },
    ]),
    FuelExpense.aggregate([
      { $match: { ...full, driverId: full.driverId ?? { $ne: null } } },
      { $group: { _id: '$driverId', count: { $sum: 1 }, amount: { $sum: '$totalAmount' } } },
      { $sort: { amount: -1 } },
      { $limit: 8 },
    ]),
    FuelExpense.aggregate([{ $match: full }, ...sums]),
  ]);

  const names = new Map(
    (await Employee.find({ _id: { $in: driverRows.map((r) => r._id) } }).select('name').lean()).map((e) => [String(e._id), e.name]),
  );
  const status = Object.fromEntries(['pending', 'approved', 'rejected'].map((s) => [s, { count: 0, amount: 0 }]));
  for (const r of statusRows) if (r._id in status) status[r._id] = { count: r.count, amount: round2(r.amount) };

  return {
    byStatus: status,
    shown: { count: shownRows[0]?.count ?? 0, amount: round2(shownRows[0]?.amount) },
    byCategory: categoryRows.map((r) => ({ category: r._id, count: r.count, amount: round2(r.amount) })),
    byDriver: driverRows.map((r) => ({ driverId: String(r._id), name: names.get(String(r._id)) ?? 'Driver', count: r.count, amount: round2(r.amount) })),
  };
};
