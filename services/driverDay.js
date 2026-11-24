import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Employee from '../models/Employee.js';
import { istEnd, istStart } from '../utils/istDate.js';
import { isBlocking } from '../utils/fleetAvailability.js';
import { assignmentProblems } from './fleetAvailability.js';
import { describe } from '../middleware/fleetAssignmentGuard.js';
import { driverDayChange, planDriverDay, withDriverEntry, workLabel } from '../utils/driverDay.js';

// ONE DRIVER PER ARTIST PER DAY — the database half. The rules are in utils/driverDay.js.
// Called from bookingController.createBooking / updateBooking, the only places a booking's
// driver is set (both the Manage Booking and the Fleet Assignments screens save through them).

const PICK =
  'bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd ' +
  'bookingItems.selectedDates bookingItems.startTime bookingItems.endTime bookingItems.assignedStaff ' +
  'pincode address assignedStaff driverId driverName vehicleId tripStatus artistTripOtp travelMode';

const id = (v) => (v == null || v === '' ? '' : String(v._id ?? v));
const oid = (v) => (v && mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(String(v)) : null);
const plain = (doc) => (doc && typeof doc.toObject === 'function' ? doc.toObject() : doc);

export const CONFIRM_HEADER = 'x-confirm-driver-day';
export const isConfirmed = (req) => String(req.get?.(CONFIRM_HEADER) ?? '') === '1';

/// Other bookings that share a lead artist and one of the days (the pure rules narrow them down).
const candidatesFor = async ({ booking, leadIds, days }) => {
  if (leadIds.length === 0 || days.length === 0) return [];
  const sorted = [...days].sort();
  const staff = leadIds.map((x) => oid(x)).filter(Boolean);
  const query = {
    $and: [
      { $or: [{ 'assignedStaff.employeeId': { $in: staff } }, { 'bookingItems.assignedStaff.employeeId': { $in: staff } }] },
      {
        $or: [
          { selectedDates: { $in: days } },
          { 'bookingItems.selectedDates': { $in: days } },
          { serviceStart: { $gte: istStart(sorted[0]), $lte: istEnd(sorted[sorted.length - 1]) } },
        ],
      },
    ],
  };
  if (booking._id && mongoose.isValidObjectId(booking._id)) query._id = { $ne: booking._id };
  return Booking.find(query).select(PICK).lean();
};

/// The work as the app shows it in the confirmation / result.
const brief = (b, day, extra = {}) => ({
  bookingId: id(b._id),
  bookingNumber: b.bookingNumber ?? '',
  customerName: b.customerName ?? '',
  serviceStart: b.serviceStart ?? null,
  day,
  label: workLabel(b),
  ...extra,
});

const driverNames = async (ids) => {
  const list = [...new Set(ids.filter(Boolean))];
  if (list.length === 0) return new Map();
  const rows = await Employee.find({ _id: { $in: list } }).select('name').lean();
  return new Map(rows.map((r) => [String(r._id), r.name ?? '']));
};

/**
 * Works out, BEFORE the edited booking is saved, which of the artist's other works that day follow.
 *
 * @param {object}  o
 * @param {object}  o.before     the booking as stored (null for a new booking)
 * @param {object}  o.after      the booking as it is about to be saved (a document or plain object)
 * @param {boolean} o.confirmed  the person agreed to move works that have another driver
 * @param {boolean} [o.skipOtherDrivers] a new booking: leave those works alone instead of asking
 * @returns {Promise<{ conflict: object|null, pending: object|null }>}
 *   conflict — answer 409 with it (nothing saved); pending — pass to applyDriverDay() after the save
 */
export const prepareDriverDay = async ({ before, after, confirmed, skipOtherDrivers = false }) => {
  const booking = plain(after);
  const change = driverDayChange({ before, after: booking });
  if (!change) return { conflict: null, pending: null };
  const first = planDriverDay({ booking, change, candidates: [] });
  const candidates = await candidatesFor({ booking, leadIds: first.leadIds, days: first.days });
  const plan = planDriverDay({ booking, change, candidates });
  if (plan.update.length === 0 && plan.skipped.length === 0) return { conflict: null, pending: null };

  const names = await driverNames([change.nextDriver, ...plan.update.map((u) => u.from.driverId)]);
  const nameOf = (x, fallback = '') => names.get(x) || fallback;
  const others = plan.update.filter((u) => u.otherDriver);

  if (others.length > 0 && skipOtherDrivers) {
    plan.update = plan.update.filter((u) => !u.otherDriver);
    plan.skipped.push(...others.map((u) => ({ booking: u.booking, day: u.day, reason: 'other_driver' })));
  } else if (others.length > 0 && !confirmed) {
    const driverName = nameOf(change.nextDriver, booking.driverName || 'this driver');
    const works = others.map((u) =>
      brief(u.booking, u.day, { currentDriverName: nameOf(u.from.driverId, u.booking.driverName || 'another driver') }),
    );
    return {
      pending: null,
      conflict: {
        code: 'DRIVER_DAY_CONFLICT',
        message:
          `One driver covers all of the artist's works in a day. ` +
          `${works.map((w) => `${w.label} has ${w.currentDriverName}`).join('; ')}. ` +
          `Confirm to move ${works.length === 1 ? 'it' : 'them'} to ${driverName} too.`,
        driverName,
        works,
      },
    };
  }
  return { conflict: null, pending: { change, plan, names } };
};

/// The staff entry for the driver on the other works: copied from the edited booking, else built.
const driverEntryFor = async (booking, driverId) => {
  if (!driverId) return null;
  const lists = [booking.assignedStaff, ...(booking.bookingItems || []).map((i) => i?.assignedStaff)];
  for (const list of lists) {
    const hit = (list || []).find((s) => s?.roleType === 'driver' && id(s.employeeId) === driverId);
    if (hit) return { ...plain(hit), employeeId: oid(driverId) };
  }
  const emp = await Employee.findById(driverId).select('name phone type specialization').lean();
  return {
    employeeId: oid(driverId),
    artistName: emp?.name || booking.driverName || 'Driver',
    role: 'Driver',
    specialization: emp?.specialization ?? '',
    works: ['Driver'],
    phone: emp?.phone ?? '',
    type: emp?.type ?? '',
    roleType: 'driver',
  };
};

const generateOtp = () => String(Math.floor(1000 + Math.random() * 9000));

/**
 * After the edited booking is saved: gives the other works their driver / vehicle and returns what
 * the app shows — { driverName, removed, assigned: [...], skipped: [...], warnings: [...] }.
 * Never throws: a failure here must not turn a saved booking into an error.
 */
export const applyDriverDay = async ({ saved, pending }) => {
  if (!pending) return null;
  const { change, plan, names } = pending;
  const booking = plain(saved);
  const result = {
    driverName: names.get(change.nextDriver) || booking.driverName || '',
    removed: !change.nextDriver,
    assigned: [],
    skipped: plan.skipped.map((s) => brief(s.booking, s.day, { reason: s.reason })),
    warnings: [],
  };
  try {
    const entry = await driverEntryFor(booking, change.nextDriver);
    for (const u of plan.update) {
      const c = u.booking;
      const set = {
        driverId: oid(u.to.driverId),
        driverName: u.to.driverId ? result.driverName || entry?.artistName || '' : '',
        vehicleId: oid(u.to.vehicleId),
        tripStatus: u.to.driverId ? 'assigned' : 'unassigned',
      };
      if (u.to.vehicleId && u.to.vehicleId === id(booking.vehicleId) && booking.travelMode) set.travelMode = booking.travelMode;
      if (u.to.driverId !== u.from.driverId) {
        const staff = withDriverEntry(c, u.to.driverId ? entry : null);
        set.assignedStaff = staff.assignedStaff;
        staff.items.forEach((list, i) => {
          if (list) set[`bookingItems.${i}.assignedStaff`] = list;
        });
        if (u.to.driverId && !c.artistTripOtp && (staff.assignedStaff.some((s) => s.roleType !== 'driver'))) {
          set.artistTripOtp = generateOtp();
        }
      }
      // Only while the trip has not started (re-checked here, in case it started meanwhile).
      const r = await Booking.updateOne(
        { _id: c._id, tripStatus: { $nin: ['inspection_pending', 'in_progress', 'completed', 'accident'] } },
        { $set: set },
      );
      if (r.matchedCount === 0) {
        result.skipped.push(brief(c, u.day, { reason: 'trip_started' }));
        continue;
      }
      result.assigned.push(
        brief(c, u.day, { previousDriverName: names.get(u.from.driverId) || (u.from.driverId ? c.driverName || '' : '') }),
      );
      if (u.to.driverId) {
        try {
          const problems = await assignmentProblems({
            booking: { ...c, ...set, _id: c._id },
            driverId: u.to.driverId,
            vehicleId: u.to.vehicleId,
          });
          for (const p of problems.filter(isBlocking)) {
            result.warnings.push(`${workLabel(c)}: ${describe(p)}`);
          }
        } catch (e) {
          console.error('driver-day availability check failed:', e.message);
        }
      }
    }
  } catch (err) {
    console.error('driver-day apply failed:', err);
    result.warnings.push(`Could not update every work of the day (${err.message}). Please check them.`);
  }
  return result;
};
