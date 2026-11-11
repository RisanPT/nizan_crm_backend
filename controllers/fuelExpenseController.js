import mongoose from 'mongoose';
import FuelExpense from '../models/FuelExpense.js';
import Booking from '../models/Booking.js';
import { istDayKey } from '../utils/istDate.js';
import { attachDayContext } from '../services/expenseDayContext.js';
import { buildExpenseFilter, summarizeExpenses } from '../services/fuelExpenseQuery.js';
import { parseExpenseQuery, QueryError, SORTS } from '../utils/fuelExpenseQuery.js';
import { warmDayPlan } from '../services/dayTrip.js';
import { postDoc, unpostDoc, safePost } from '../services/posting.js';
import { applyMoneyAccount } from '../utils/moneyAccount.js';
import FuelPrice from '../models/FuelPrice.js';
import { attachRateChecks, rateCheckOf } from '../services/fuelRateCheck.js';

const normalizeObjectId = (value) => {
  const normalized = String(value ?? '').trim();
  if (!normalized) return null;
  return mongoose.Types.ObjectId.isValid(normalized) ? normalized : null;
};

const expensePopulate = [
  { path: 'vehicleId', select: 'name registrationNumber type fuelType status' },
  { path: 'driverId', select: 'name phone artistRole status' },
  // mapUrl / address / pincode: where the work was, shown to Accounts for the location check.
  { path: 'bookingId', select: 'bookingNumber customerName service serviceStart mapUrl address pincode' },
];

// The expense list, as plain objects. Only when asked (?withWorks=1 — the Accounts
// screen) each expense also carries its `split` (the day's works with client and
// artist, and how much each carries) and `kmCheck` (planned vs odometer for that
// driver's day) — see services/expenseDayContext.js. Fleet screens don't ask, so
// artist details never reach them. A failure there never fails the request; the
// expenses are then returned without them.
const present = async (docs, req) => {
  const plain = docs.map((d) => d.toJSON());
  // Each fill-up's rate against the fuel price of its day. Not for a driver's own list: they get the
  // check when they save, and the review is Accounts' / the fleet manager's.
  if (req.user.role !== 'driver') await attachRateChecks(plain);
  if (req.query.withWorks !== '1') return plain;
  try {
    await attachDayContext(plain);
  } catch (err) {
    console.error('expense day context failed:', err.message);
  }
  return plain;
};

// A saved expense, as the API returns it, with the rate check of that fill-up (null for anything that
// is not fuel). Never fails the save.
const withRateCheck = async (populated) => {
  const json = populated.toJSON();
  try {
    json.rateCheck = rateCheckOf(json, await FuelPrice.find({}).lean());
  } catch (err) {
    console.error('fuel rate check failed:', err.message);
    json.rateCheck = null;
  }
  return json;
};

// Ties an expense to one of the day's works. Returns { error } (a status + message
// to send), or { booking } — null when the expense isn't tied to a work.
// A driver can only tie an expense to a work assigned to them.
const resolveWork = async (req, rawBookingId) => {
  const id = normalizeObjectId(rawBookingId);
  if (!id) {
    return String(rawBookingId ?? '').trim() ? { error: { status: 400, message: 'That work is not valid' } } : { booking: null };
  }
  const booking = await Booking.findById(id).select('driverId vehicleId serviceStart').lean();
  if (!booking) return { error: { status: 404, message: 'Work not found' } };
  if (req.user.role === 'driver' && String(booking.driverId ?? '') !== String(req.user.employeeId ?? '')) {
    return { error: { status: 403, message: 'That work is not assigned to you' } };
  }
  return { booking };
};

// The IST day an expense belongs under: its work's day, else the day it was paid.
const dayKeyFor = (booking, date) => istDayKey(booking ? booking.serviceStart : date);

// @desc    The fleet expenses, newest first. Filters: see utils/fuelExpenseQuery.js.
//          ?page= / ?limit=   a page: { items, page, limit, totalItems, totalPages }
//          ?summary=1         (with a page) adds totals for the WHOLE filtered set
//          ?export=1          every match (capped), as { items, totalItems, truncated }
//          ?withWorks=1       Accounts only: each expense also carries `split` + `kmCheck`
//          none of these      a plain array (older callers)
// @route   GET /api/fuel-expenses
const EXPORT_CAP = 5000;
const NO_ONE = '000000000000000000000000';

export const getFuelExpenses = async (req, res) => {
  try {
    const parsed = parseExpenseQuery(req.query);
    // A driver signed in only ever sees their own expenses, whatever they ask for.
    // (a driver with no linked employee matches nothing rather than everything)
    const scope = { driverEmployeeId: req.user.role === 'driver' ? req.user.employeeId || NO_ONE : null };
    const filter = await buildExpenseFilter(parsed, scope);
    const sort = SORTS[parsed.sort];

    if (req.query.export === '1') {
      const [docs, totalItems] = await Promise.all([
        FuelExpense.find(filter).populate(expensePopulate).sort(sort).limit(EXPORT_CAP),
        FuelExpense.countDocuments(filter),
      ]);
      return res.json({ items: await present(docs, req), totalItems, truncated: totalItems > EXPORT_CAP });
    }

    const page = Number.parseInt(req.query.page, 10);
    const limit = Number.parseInt(req.query.limit, 10);

    if (Number.isFinite(page) || Number.isFinite(limit)) {
      const currentPage = Math.max(1, page || 1);
      const currentLimit = Math.min(100, Math.max(1, limit || 20));
      const skip = (currentPage - 1) * currentLimit;

      const [items, totalItems, summary] = await Promise.all([
        FuelExpense.find(filter).populate(expensePopulate).sort(sort).skip(skip).limit(currentLimit),
        FuelExpense.countDocuments(filter),
        req.query.summary === '1' ? summarizeExpenses(parsed, scope) : null,
      ]);

      return res.json({
        items: await present(items, req),
        page: currentPage,
        limit: currentLimit,
        totalItems,
        totalPages: Math.max(1, Math.ceil(totalItems / currentLimit)),
        ...(summary ? { summary } : {}),
      });
    }

    const expenses = await FuelExpense.find(filter).populate(expensePopulate).sort(sort);
    res.json(await present(expenses, req));
  } catch (error) {
    res.status(error instanceof QueryError ? error.status : 500).json({ message: error.message });
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
    billImage,
    bookingId,
  } = req.body;

  try {
    const work = await resolveWork(req, bookingId);
    if (work.error) return res.status(work.error.status).json({ message: work.error.message });

    const finalCategory = category ?? 'fuel';
    // Tied to a work → that work's vehicle is the default.
    const normalizedVehicleId = normalizeObjectId(vehicleId) ?? work.booking?.vehicleId ?? null;

    // Outsourced-driver salary is a manager-only expense and carries no vehicle.
    if (finalCategory === 'outsource_salary') {
      if (req.user.role === 'driver') {
        return res
          .status(403)
          .json({ message: 'Drivers cannot record salary expenses' });
      }
    } else if (!normalizedVehicleId) {
      // Every other category is vehicle-related.
      return res.status(400).json({ message: 'Please select a vehicle' });
    }

    let finalDriverId = normalizeObjectId(driverId);
    if (req.user.role === 'driver') {
      finalDriverId = req.user.employeeId;
    } else if (work.booking) {
      // A manager entering it for a work: it's that work's driver's expense.
      if (finalDriverId && work.booking.driverId && String(work.booking.driverId) !== String(finalDriverId)) {
        return res.status(400).json({ message: 'That work belongs to another driver' });
      }
      finalDriverId = finalDriverId ?? work.booking.driverId ?? null;
    }

    const expenseDate = date ?? new Date();
    const expense = await FuelExpense.create({
      vehicleId: normalizedVehicleId,
      driverId: finalDriverId,
      bookingId: work.booking?._id ?? null,
      dayKey: dayKeyFor(work.booking, expenseDate),
      category: finalCategory,
      date: expenseDate,
      odometerKm: Number(odometerKm) || 0,
      liters: Number(liters) || 0,
      totalAmount: Number(totalAmount) || 0,
      paymentMode: paymentMode ?? 'cash',
      station: station ?? '',
      notes: notes ?? '',
      billImage: String(billImage ?? '').trim(),
      status: 'pending',
    });

    await safePost(() => postDoc('FuelExpense', expense.toObject(), req.user?._id || null));
    const populated = await FuelExpense.findById(expense._id).populate(expensePopulate);
    res.status(201).json(await withRateCheck(populated));
    // Background: have the day's route ready for Accounts' km check.
    warmDayPlan(expense.driverId, expense.dayKey);
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

    if (req.user.role === 'driver' && String(expense.driverId) !== String(req.user.employeeId)) {
      return res.status(403).json({ message: 'Not authorized to update this expense' });
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
      billImage,
      status,
      bookingId,
    } = req.body;

    // Re-tie to another work (or null / '' to make it a whole-day expense).
    let linkedWork;
    if (bookingId !== undefined) {
      const work = await resolveWork(req, bookingId);
      if (work.error) return res.status(work.error.status).json({ message: work.error.message });
      linkedWork = work.booking;
      expense.bookingId = linkedWork?._id ?? null;
    } else if (expense.bookingId && date != null) {
      linkedWork = await Booking.findById(expense.bookingId).select('serviceStart').lean();
    }

    if (billImage !== undefined) expense.billImage = String(billImage).trim();
    // Only a manager/fleet manager (not the driver) may change review status.
    if (status !== undefined && req.user.role !== 'driver' &&
        ['pending', 'approved', 'rejected'].includes(status)) {
      expense.status = status;
    }
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
    // Keep the day it groups under in step with its work / date.
    if (bookingId !== undefined || date != null) {
      expense.dayKey = dayKeyFor(linkedWork, expense.date);
    }

    // Accounts approving with the popup: which bank / cash account paid it.
    if (expense.status === 'approved' && req.user.role !== 'driver') {
      const err = await applyMoneyAccount(expense, req.body, {
        modeField: 'paymentMode',
        modes: ['cash', 'upi', 'card', 'other'],
      });
      if (err) return res.status(400).json({ message: err });
    }

    await expense.save();

    await safePost(() => postDoc('FuelExpense', expense.toObject(), req.user?._id || null));
    const populated = await FuelExpense.findById(expense._id).populate(expensePopulate);
    res.json(await withRateCheck(populated));
    warmDayPlan(expense.driverId, expense.dayKey);
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

    if (req.user.role === 'driver' && String(expense.driverId) !== String(req.user.employeeId)) {
      return res.status(403).json({ message: 'Not authorized to delete this expense' });
    }

    await expense.deleteOne();
    await safePost(() => unpostDoc('FuelExpense', expense._id));
    res.json({ message: 'Fuel expense removed' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
