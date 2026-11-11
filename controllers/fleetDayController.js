import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import FuelExpense from '../models/FuelExpense.js';
import { loadDayWorks, getDayPlan, workLabel } from '../services/dayTrip.js';
import { allocateExpenses } from '../utils/expenseAllocation.js';
import { dayDistance, tripKm } from '../utils/dayDistance.js';
import { artistsOf } from '../utils/workArtists.js';
import { suggestCategory, seatsFit } from '../utils/vehicleCategories.js';
import { mileageUnit } from '../utils/fuelEfficiency.js';
import { headquarters } from '../utils/distance.js';
import { parseDayParam, todayIst, istStart, istEnd } from '../utils/istDate.js';

const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;

// Same identity rule as controllers/fleetController.js: the driver's Employee id.
const driverIdOf = (user) => (user.employeeId ? user.employeeId.toString() : user._id.toString());

/// Everything about one driver's day: the works, the planned route and km, how the
/// odometer compares, and the day's expenses put under the works.
const buildDaySheet = async ({ driverId, dayKey, force = false }) => {
  const works = await loadDayWorks(driverId, dayKey);
  const plan = await getDayPlan({ driverId, dayKey, works, force });
  const stopOf = new Map((plan.stops || []).map((s) => [String(s.bookingId), s]));

  // Expenses of this day: tied by day, plus older rows saved before days were stored.
  const expenses = await FuelExpense.find({
    driverId,
    $or: [
      { dayKey },
      { dayKey: { $in: ['', null] }, date: { $gte: istStart(dayKey), $lte: istEnd(dayKey) } },
    ],
  })
    .populate('vehicleId', 'name registrationNumber')
    .sort({ date: 1, createdAt: 1 })
    .lean();
  const counted = expenses.filter((e) => e.status !== 'rejected'); // a rejected bill isn't a cost

  const allocation = allocateExpenses({
    works: works.map((b) => ({ id: String(b._id) })),
    expenses: counted.map((e) => ({
      id: String(e._id), bookingId: e.bookingId, amount: e.totalAmount, category: e.category,
    })),
  });

  const linesOf = new Map();
  for (const l of allocation.lines) {
    if (!linesOf.has(l.expenseId)) linesOf.set(l.expenseId, []);
    linesOf.get(l.expenseId).push(l);
  }

  // ── works ──
  const workRows = works.map((b) => {
    const id = String(b._id);
    const stop = stopOf.get(id);
    const km = tripKm(b);
    // People going to the work besides the driver (for the vehicle-capacity check).
    const team = artistsOf(b).length;
    const vehicle = b.vehicleId?._id ? b.vehicleId : null;
    return {
      id,
      bookingNumber: b.bookingNumber ?? '',
      label: workLabel(b),
      customerName: b.customerName ?? '',
      service: b.service ?? '',
      eventSlot: b.eventSlot ?? '',
      serviceStart: b.serviceStart,
      serviceEnd: b.serviceEnd,
      tripStatus: b.tripStatus ?? 'unassigned',
      startKm: b.startKm ?? null,
      endKm: b.endKm ?? null,
      trackedKm: km,
      plannedKm: stop?.km ?? 0,
      located: stop?.located ?? false,
      approximate: stop?.approximate ?? false,
      vehicle: vehicle && {
        id: String(vehicle._id),
        name: vehicle.name ?? '',
        registrationNumber: vehicle.registrationNumber ?? '',
        category: vehicle.category ?? '',
        seats: vehicle.seats ?? 0,
      },
      team: {
        count: team,
        suggested: suggestCategory(team),
        // null = the vehicle's capacity isn't recorded, or no vehicle yet
        fits: vehicle ? seatsFit(vehicle.seats, team) : null,
      },
      costs: allocation.perWork[id] ?? { total: 0, direct: 0, shared: 0, byCategory: {} },
    };
  });

  // ── distance: planned vs the odometer (rules in utils/dayDistance.js) ──
  const legs = plan.legs || [];
  const plannedKm = plan.plannedKm || 0;
  const dist = dayDistance({ legs, plannedKm, planError: plan.planError, works });

  // Expected fuel for the day, when one vehicle did all of it and its rated mileage is known.
  const vehicles = [...new Map(workRows.filter((w) => w.vehicle).map((w) => [w.vehicle.id, w.vehicle])).values()];
  let fuelEstimate = null;
  if (vehicles.length === 1 && plannedKm > 0) {
    const v = works.find((b) => b.vehicleId?._id)?.vehicleId;
    if (v?.ratedMileage > 0) {
      fuelEstimate = {
        vehicleId: vehicles[0].id,
        unit: mileageUnit(v.fuelType),
        ratedMileage: v.ratedMileage,
        units: round1(plannedKm / v.ratedMileage),
        basis: 'rated',
      };
    }
  }

  // ── expenses ──
  const expenseRows = expenses.map((e) => {
    const id = String(e._id);
    const lines = linesOf.get(id) ?? [];
    const mode = e.status === 'rejected' ? 'rejected' : lines[0]?.mode ?? 'unallocated';
    return {
      id,
      category: e.category,
      amount: e.totalAmount,
      status: e.status,
      date: e.date,
      station: e.station ?? '',
      notes: e.notes ?? '',
      billImage: e.billImage ?? '',
      liters: e.liters ?? 0,
      odometerKm: e.odometerKm ?? 0,
      vehicleName: e.vehicleId?.registrationNumber || e.vehicleId?.name || '',
      bookingId: e.bookingId ? String(e.bookingId) : null,
      mode, // direct | shared | unallocated | rejected
      reason: lines[0]?.reason ?? '',
      allocations: lines.filter((l) => l.bookingId).map((l) => ({ bookingId: l.bookingId, amount: l.amount })),
    };
  });
  const byCategory = {};
  for (const e of counted) byCategory[e.category] = round2((byCategory[e.category] || 0) + e.totalAmount);

  let driver = null;
  const emp = await Employee.findById(driverId).select('name phone').lean();
  if (emp) driver = { id: String(emp._id), name: emp.name ?? '', phone: emp.phone ?? '' };

  return {
    dayKey,
    driver,
    hq: headquarters().label,
    works: workRows,
    plan: {
      rule: plan.rule,
      legs,
      plannedKm,
      plannedMin: plan.plannedMin || 0,
      approximate: !!plan.approximate,
      warnings: plan.warnings || [],
      planError: plan.planError || '',
      calculatedAt: plan.calculatedAt,
    },
    distance: {
      plannedKm,
      returnKm: dist.returnKm,
      plannedTrackedKm: dist.plannedTrackedKm,
      trackedKm: dist.trackedKm,
      // tracked − planned-tracked; only when every work is finished and every leg measured
      variance: dist.variance,
      estimatedDayKm: dist.estimatedDayKm,
      // ok | over | under | in_progress | no_route | no_works
      status: dist.status,
    },
    fuelEstimate,
    expenses: expenseRows,
    totals: {
      amount: round2(counted.reduce((s, e) => s + e.totalAmount, 0)),
      byCategory,
      shared: allocation.sharedTotal,
      unallocated: allocation.unallocated,
    },
  };
};

const dayFromQuery = (req, res) => {
  if (req.query.date === undefined || req.query.date === '') return todayIst();
  const day = parseDayParam(req.query.date);
  if (!day) res.status(400).json({ message: 'Give the date as YYYY-MM-DD.' });
  return day;
};

// @desc    The logged-in driver's own day: works, route, km, expenses under each work
// @route   GET /api/fleet/driver/day-sheet?date=
export const getDriverDaySheet = async (req, res) => {
  try {
    const dayKey = dayFromQuery(req, res);
    if (!dayKey) return;
    res.json(await buildDaySheet({ driverId: driverIdOf(req.user), dayKey }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    A driver's day, for the fleet manager (refresh=1 recalculates the route)
// @route   GET /api/fleet/manager/day-sheet?driverId=&date=&refresh=
export const getManagerDaySheet = async (req, res) => {
  try {
    const driverId = String(req.query.driverId ?? '').trim();
    if (!mongoose.Types.ObjectId.isValid(driverId)) {
      return res.status(400).json({ message: 'Choose a driver.' });
    }
    const dayKey = dayFromQuery(req, res);
    if (!dayKey) return;
    res.json(await buildDaySheet({ driverId, dayKey, force: req.query.refresh === '1' }));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
