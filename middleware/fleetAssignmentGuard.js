import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { isBlocking, istTime, workWindows } from '../utils/fleetAvailability.js';
import { assignmentProblems } from '../services/fleetAvailability.js';

// FLEET GUARD — in front of booking create / update. When a request ASSIGNS a different driver or
// vehicle to a booking, and that driver / vehicle is already on another work at the same time (or
// is unavailable: vehicle under service, driver on approved leave), the request is answered 409
// FLEET_CONFLICT instead of being saved — unless the caller confirms with the header
//   X-Confirm-Fleet-Conflict: 1
// (the app asks "assign anyway?" and repeats the request with it). It never stops anything else:
//   • a request that doesn't change the driver or vehicle passes untouched, however the booking's
//     other fields change;
//   • a "tight" gap or an overdue paper is advice, not a block;
//   • any failure in the guard itself lets the request through — it must never be why a booking
//     can't be saved;
//   • FLEET_AVAILABILITY_GUARD=off in the server's .env switches it off.

const toId = (v) => {
  const s = String(v ?? '').trim();
  return mongoose.Types.ObjectId.isValid(s) ? s : '';
};
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

const PICK =
  'bookingNumber customerName status selectedDates bookingDate serviceStart serviceEnd ' +
  'bookingItems.selectedDates bookingItems.startTime bookingItems.endTime pincode address driverId vehicleId';

/// The schedule a request carries, laid over the stored booking (only what the guard needs).
const scheduleOf = (body) => {
  const out = {};
  if (Array.isArray(body.selectedDates)) out.selectedDates = body.selectedDates.map(String);
  for (const key of ['serviceStart', 'serviceEnd', 'bookingDate']) {
    if (body[key] != null && !Number.isNaN(new Date(body[key]).getTime())) out[key] = new Date(body[key]);
  }
  if (Array.isArray(body.bookingItems)) {
    out.bookingItems = body.bookingItems.map((i) => ({ selectedDates: i?.selectedDates ?? [], startTime: i?.startTime ?? '', endTime: i?.endTime ?? '' }));
  }
  for (const key of ['pincode', 'address']) if (typeof body[key] === 'string') out[key] = body[key];
  return out;
};

const signature = (windows) => windows.map((w) => `${w.day}|${w.start.toISOString()}|${w.end.toISOString()}`).join(',');

const confirmed = (req) => String(req.get('x-confirm-fleet-conflict') ?? '') === '1';

/// "Innova is already on BK-12 (9:00–13:00) on 2026-10-30" — what a person reads in the dialog / error.
export const describe = (p) => {
  if (p.kind === 'overlap') return `${p.name} is already on ${p.with?.bookingNumber || 'another work'} (${istTime(p.start)}–${istTime(p.end)}) on ${p.day}`;
  return p.reason || `${p.name} is not available`;
};

export const fleetAssignmentGuard = async (req, res, next) => {
  try {
    if (process.env.FLEET_AVAILABILITY_GUARD === 'off') return next();
    const body = req.body ?? {};
    if (!('driverId' in body) && !('vehicleId' in body)) return next();
    if (confirmed(req)) return next();

    const stored = req.params?.id ? await Booking.findById(req.params.id).select(PICK).lean() : null;
    if (req.params?.id && !stored) return next(); // the controller answers 404

    // exactly what the controllers do: a sent value replaces the stored one, a missing / null one keeps it
    const effective = (key) => (body[key] != null ? toId(body[key]) : idOf(stored?.[key]));
    const driverId = effective('driverId');
    const vehicleId = effective('vehicleId');
    const driverChanged = Boolean(driverId) && driverId !== idOf(stored?.driverId);
    const vehicleChanged = Boolean(vehicleId) && vehicleId !== idOf(stored?.vehicleId);
    if (!driverChanged && !vehicleChanged) return next();

    const booking = { ...(stored ?? {}), ...scheduleOf(body), _id: stored?._id };
    // A resource that is NOT being changed is still checked when this same request moves the works's
    // times — that is a clash the request itself brings in. (A reschedule on its own is never blocked.)
    const scheduleChanged = Boolean(stored) && signature(workWindows(stored)) !== signature(workWindows(booking));
    const problems = await assignmentProblems({
      booking,
      driverId: driverChanged || scheduleChanged ? driverId : '',
      vehicleId: vehicleChanged || scheduleChanged ? vehicleId : '',
    });
    const blocking = problems.filter(isBlocking);
    if (blocking.length === 0) return next();

    return res.status(409).json({
      code: 'FLEET_CONFLICT',
      message: `${blocking.map(describe).join('. ')}. Confirm to assign anyway.`,
      problems: blocking,
      warnings: problems.filter((p) => !isBlocking(p)),
    });
  } catch (err) {
    console.error('fleet assignment guard failed (request let through):', err.message);
    return next();
  }
};
