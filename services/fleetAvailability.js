import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Employee from '../models/Employee.js';
import LeaveRequest from '../models/LeaveRequest.js';
import ServiceReminder from '../models/ServiceReminder.js';
import Vehicle from '../models/Vehicle.js';
import { cachedCoordsForPincodes, pincodeOf } from '../utils/geocode.js';
import { istDayKey, istEnd, istStart } from '../utils/istDate.js';
import {
  EXCLUDED_STATUSES, briefOf, clashesWith, driverProblems, paperWarnings, runsOn, statusOf, travelBetween, vehicleProblem, workWindows,
} from '../utils/fleetAvailability.js';

// FLEET AVAILABILITY — the database half. The rules are in utils/fleetAvailability.js.

const PICK =
  'bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd ' +
  'bookingItems.selectedDates bookingItems.startTime bookingItems.endTime pincode address driverId vehicleId assignedStaff';

const id = (v) => (v == null ? '' : String(v._id ?? v));
const alive = (b) => !EXCLUDED_STATUSES.has(String(b.status ?? '').toLowerCase());

/// Every booking that runs on one of [days] with its windows, except [excludeId] and the ones that are
/// not happening. Narrowed to those using one of [driverIds] / [vehicleIds] when given; with neither
/// given, every booking that has a driver or a vehicle.
const commitmentsOn = async ({ days, driverIds, vehicleIds, excludeId }) => {
  if (days.length === 0) return [];
  const sorted = [...days].sort();
  const use = [];
  if (driverIds === undefined && vehicleIds === undefined) {
    use.push({ driverId: { $ne: null } }, { vehicleId: { $ne: null } });
  } else {
    if (driverIds?.length) use.push({ driverId: { $in: driverIds } });
    if (vehicleIds?.length) use.push({ vehicleId: { $in: vehicleIds } });
  }
  if (use.length === 0) return [];
  const query = {
    $and: [
      { $or: use },
      {
        $or: [
          { selectedDates: { $in: days } },
          { 'bookingItems.selectedDates': { $in: days } },
          { serviceStart: { $gte: istStart(sorted[0]), $lte: istEnd(sorted[sorted.length - 1]) } },
        ],
      },
    ],
  };
  if (excludeId && mongoose.isValidObjectId(excludeId)) query._id = { $ne: excludeId };
  const rows = await Booking.find(query).select(PICK).lean();
  return rows
    .filter(alive)
    .map((booking) => ({ booking, windows: workWindows(booking) }))
    .filter(({ windows }) => days.some((d) => runsOn(windows, d)));
};

/// A drive-time function between the candidate work and another, from the pincode coordinates already
/// in the cache (a flat default where either is unknown).
const travelFor = async (candidate, others) => {
  const pins = [candidate, ...others].map(pincodeOf);
  const coords = await cachedCoordsForPincodes(pins);
  const mine = coords.get(pincodeOf(candidate)) ?? null;
  return (other) => travelBetween(mine, coords.get(pincodeOf(other)) ?? null);
};

const leavesOf = async (employeeIds, days) => {
  const out = new Map();
  if (employeeIds.length === 0 || days.length === 0) return out;
  const sorted = [...days].sort();
  const rows = await LeaveRequest.find({
    employeeId: { $in: employeeIds },
    status: 'approved',
    fromDate: { $lte: istEnd(sorted[sorted.length - 1]) },
    toDate: { $gte: istStart(sorted[0]) },
  })
    .select('employeeId fromDate toDate halfDay')
    .lean();
  for (const r of rows) {
    const key = id(r.employeeId);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({ fromDay: istDayKey(r.fromDate), toDay: istDayKey(r.toDate), halfDay: r.halfDay || 'none' });
  }
  return out;
};

const remindersOf = async (vehicleIds, firstDay) => {
  const out = new Map();
  if (vehicleIds.length === 0) return out;
  const rows = await ServiceReminder.find({
    vehicle: { $in: vehicleIds },
    status: 'pending',
    serviceType: { $in: ['Insurance', 'Pollution', 'Tax'] },
    dueDate: { $lt: istEnd(firstDay) },
  })
    .select('vehicle serviceType dueDate status')
    .lean();
  for (const r of rows) {
    const key = id(r.vehicle);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(r);
  }
  return out;
};

const split = (problems) => ({
  conflicts: problems.filter((p) => p.kind !== 'warning'),
  warnings: problems.filter((p) => p.kind === 'warning'),
});

/**
 * How each active driver and each vehicle stands for one booking's days.
 * @returns {{ bookingId, days, drivers: Array<{ id, name, status, conflicts, warnings }>, vehicles: Array<{ id, name, registrationNumber, status, conflicts, warnings }> }}
 */
export const availabilityForBooking = async (bookingId) => {
  if (!mongoose.isValidObjectId(bookingId)) throw Object.assign(new Error('That booking is not valid'), { status: 400 });
  const booking = await Booking.findById(bookingId).select(PICK).lean();
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  const mine = workWindows(booking);
  const days = mine.map((w) => w.day);
  const [drivers, vehicles, commitments] = await Promise.all([
    Employee.find({ artistRole: 'driver', status: { $ne: 'inactive' } }).select('name status').lean(),
    Vehicle.find({}).select('name registrationNumber status category seats ownershipType').lean(),
    commitmentsOn({ days, excludeId: bookingId }),
  ]);
  const travel = await travelFor(booking, commitments.map((c) => c.booking));
  const leaves = await leavesOf(drivers.map((d) => id(d)), days);
  const papers = await remindersOf(vehicles.map((v) => id(v)), days[0] ?? istDayKey(new Date()));

  const clashesFor = (field, resourceId) =>
    commitments.filter((c) => id(c.booking[field]) === resourceId).flatMap((c) => clashesWith(mine, c, travel));

  return {
    bookingId: String(booking._id),
    days,
    drivers: drivers.map((d) => {
      const problems = [...driverProblems({ employee: d, leaves: leaves.get(id(d)) ?? [], days }), ...clashesFor('driverId', id(d))];
      return { id: id(d), name: d.name, status: statusOf(problems), ...split(problems) };
    }),
    vehicles: vehicles.map((v) => {
      const own = vehicleProblem(v);
      const problems = [...(own ? [own] : []), ...clashesFor('vehicleId', id(v)), ...paperWarnings(papers.get(id(v)), days[0] ?? '')];
      return { id: id(v), name: v.name, registrationNumber: v.registrationNumber || '', status: statusOf(problems), ...split(problems) };
    }),
  };
};

/**
 * The blocking and non-blocking problems of putting [driverId] / [vehicleId] on [booking] (a plain
 * booking, possibly with the edited schedule laid over it). Used by the check endpoint and the guard.
 * @returns {Array<{ resource: 'driver'|'vehicle', id, name, kind, reason?, ... }>}
 */
export const assignmentProblems = async ({ booking, driverId, vehicleId }) => {
  const mine = workWindows(booking);
  const days = mine.map((w) => w.day);
  if (days.length === 0) return [];
  const driverIds = driverId ? [String(driverId)] : [];
  const vehicleIds = vehicleId ? [String(vehicleId)] : [];
  const [driver, vehicle, commitments] = await Promise.all([
    driverIds.length ? Employee.findById(driverIds[0]).select('name status').lean() : null,
    vehicleIds.length ? Vehicle.findById(vehicleIds[0]).select('name registrationNumber status').lean() : null,
    commitmentsOn({ days, driverIds, vehicleIds, excludeId: booking._id }),
  ]);
  const travel = await travelFor(booking, commitments.map((c) => c.booking));
  const out = [];

  if (driver) {
    const leaves = (await leavesOf([id(driver)], days)).get(id(driver)) ?? [];
    const problems = [
      ...driverProblems({ employee: driver, leaves, days }),
      ...commitments.filter((c) => id(c.booking.driverId) === id(driver)).flatMap((c) => clashesWith(mine, c, travel)),
    ];
    out.push(...problems.map((p) => ({ resource: 'driver', id: id(driver), name: driver.name, ...p })));
  }
  if (vehicle) {
    const own = vehicleProblem(vehicle);
    const papers = (await remindersOf([id(vehicle)], days[0])).get(id(vehicle));
    const problems = [
      ...(own ? [own] : []),
      ...commitments.filter((c) => id(c.booking.vehicleId) === id(vehicle)).flatMap((c) => clashesWith(mine, c, travel)),
      ...paperWarnings(papers, days[0]),
    ];
    out.push(...problems.map((p) => ({ resource: 'vehicle', id: id(vehicle), name: vehicle.name, ...p })));
  }
  return out;
};

/**
 * One day on the fleet board: every vehicle and driver with the works they have that day, anything that
 * is already double-booked, and the works that still need a driver or a vehicle.
 */
export const availabilityForDay = async (day) => {
  const [drivers, vehicles, commitments, needing] = await Promise.all([
    Employee.find({ artistRole: 'driver', status: { $ne: 'inactive' } }).select('name status').lean(),
    Vehicle.find({}).select('name registrationNumber status category seats ownershipType').lean(),
    commitmentsOn({ days: [day] }),
    Booking.find({
      $and: [
        { $or: [{ driverId: null }, { vehicleId: null }, { driverId: { $exists: false } }, { vehicleId: { $exists: false } }] },
        { 'assignedStaff.0': { $exists: true } },
        { $or: [{ selectedDates: day }, { 'bookingItems.selectedDates': day }, { serviceStart: { $gte: istStart(day), $lte: istEnd(day) } }] },
      ],
    })
      .select(PICK)
      .lean(),
  ]);
  const leaves = await leavesOf(drivers.map((d) => id(d)), [day]);
  const papers = await remindersOf(vehicles.map((v) => id(v)), day);
  const travel = await travelFor({}, []);

  const worksOf = (field, resourceId) =>
    commitments
      .filter((c) => id(c.booking[field]) === resourceId)
      .map((c) => {
        const w = c.windows.find((x) => x.day === day);
        return { ...briefOf(c.booking), start: w.start.toISOString(), end: w.end.toISOString(), _c: c };
      })
      .sort((a, b) => a.start.localeCompare(b.start));

  // among one resource's own works: any that clash with each other (already double-booked)
  const selfClashes = (works) => {
    const out = [];
    for (let i = 0; i < works.length; i++) {
      for (let j = i + 1; j < works.length; j++) {
        const [c] = clashesWith(works[i]._c.windows, works[j]._c, travel).filter((x) => x.day === day);
        if (c) out.push({ kind: c.kind, between: [works[i].bookingNumber, works[j].bookingNumber] });
      }
    }
    return out;
  };

  const strip = (works) => works.map(({ _c, ...rest }) => rest);
  const shape = (works, problems) => ({ works: strip(works), clashes: selfClashes(works), ...split(problems) });

  return {
    day,
    vehicles: vehicles.map((v) => {
      const own = vehicleProblem(v);
      const works = worksOf('vehicleId', id(v));
      const problems = [...(own ? [own] : []), ...paperWarnings(papers.get(id(v)), day)];
      const state = shape(works, problems);
      return {
        id: id(v), name: v.name, registrationNumber: v.registrationNumber || '', category: v.category || '', seats: v.seats || 0,
        status: statusOf([...problems, ...state.clashes.map((c) => ({ kind: c.kind }))]), ...state,
      };
    }),
    drivers: drivers.map((d) => {
      const works = worksOf('driverId', id(d));
      const problems = driverProblems({ employee: d, leaves: leaves.get(id(d)) ?? [], days: [day] });
      const state = shape(works, problems);
      return { id: id(d), name: d.name, status: statusOf([...problems, ...state.clashes.map((c) => ({ kind: c.kind }))]), ...state };
    }),
    needing: needing
      .filter(alive)
      .map((b) => {
        const w = workWindows(b).find((x) => x.day === day);
        return { ...briefOf(b), needsDriver: !b.driverId, needsVehicle: !b.vehicleId, start: w?.start.toISOString() ?? null, end: w?.end.toISOString() ?? null };
      })
      .sort((a, b) => String(a.start).localeCompare(String(b.start))),
  };
};
