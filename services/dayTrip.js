import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import DayTrip from '../models/DayTrip.js';
import { planDay, daySignature } from '../utils/dayTrip.js';
import { headquarters, resolveWorkPlace, routeLeg, distanceConfigured } from '../utils/distance.js';
import { istStart, istEnd } from '../utils/istDate.js';

// A work that has fallen through doesn't need a vehicle. Booking.status is a free
// string with mixed casing in old data, so compare it lower-cased.
export const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'lost']);

// A plan that couldn't measure a leg is retried, but not on every single read.
const RETRY_AFTER_MS = 10 * 60 * 1000;

const WORK_FIELDS =
  'bookingNumber customerName service eventSlot status address pincode mapUrl dateMaps ' +
  'travelDistanceKm serviceStart serviceEnd driverId vehicleId tripStatus startKm endKm ' +
  'tripStartedAt tripCompletedAt assignedStaff bookingItems.assignedStaff';

const mapValue = (m, key) => (!m ? '' : typeof m.get === 'function' ? m.get(key) || '' : m[key] || '');

/// The driver's works for one IST calendar day, earliest first, without cancelled ones.
export const loadDayWorks = async (driverId, dayKey) => {
  const rows = await Booking.find({
    driverId,
    serviceStart: { $gte: istStart(dayKey), $lte: istEnd(dayKey) },
  })
    .select(WORK_FIELDS)
    .populate('vehicleId', 'name registrationNumber type category seats currentKm ratedMileage fuelType')
    .sort({ serviceStart: 1, _id: 1 })
    .lean();
  return rows.filter((b) => !DEAD_STATUSES.has(String(b.status ?? '').toLowerCase()));
};

/// How a work is shown in a route: "2610 1234 · Anjali".
export const workLabel = (b) => [b.bookingNumber, b.customerName].filter(Boolean).join(' · ') || 'Work';

export const toPlanWork = (b, dayKey) => ({
  id: String(b._id),
  label: workLabel(b),
  serviceStart: b.serviceStart,
  travelDistanceKm: b.travelDistanceKm || 0,
  // What the location depends on — feeds the signature, so changing the venue recalculates.
  mapUrl: String(mapValue(b.dateMaps, dayKey) || b.mapUrl || '').trim(),
  address: b.address || '',
  pincode: b.pincode || '',
});

const isIncomplete = (t) => !!t.planError || (t.legs || []).some((l) => l.km === null);

/**
 * The day's route plan for one driver. Reuses the stored plan while nothing it
 * depends on has changed; otherwise measures it with the map services and stores
 * the result. Never throws for map problems — those become `planError` /
 * `warnings` on the returned plan.
 *
 * @param {object}  o
 * @param {*}       o.driverId
 * @param {string}  o.dayKey  'YYYY-MM-DD' (IST)
 * @param {Array}   o.works   from loadDayWorks (so callers load them once)
 * @param {boolean} [o.force] recalculate even if nothing changed
 */
export const getDayPlan = async ({ driverId, dayKey, works, force = false }) => {
  const hq = headquarters();
  const planWorks = works.map((b) => toPlanWork(b, dayKey));
  const signature = daySignature({ works: planWorks, hq });

  const stored = await DayTrip.findOne({ driverId, dayKey }).lean();

  // No works that day: nothing to plan or store. If every work was removed since
  // the last calculation, the old plan is stale — drop it.
  if (works.length === 0) {
    if (stored) await DayTrip.deleteOne({ _id: stored._id });
    return {
      driverId, dayKey, signature, rule: 'none', stops: [], legs: [], plannedKm: 0, plannedMin: 0,
      approximate: false, warnings: [], planError: '', calculatedAt: new Date(),
    };
  }

  if (stored && !force && stored.signature === signature) {
    const fresh = Date.now() - new Date(stored.calculatedAt).getTime() < RETRY_AFTER_MS;
    if (!isIncomplete(stored) || fresh) return stored;
  }

  // Works to plan but no map service configured: say so (nothing was calculated,
  // so nothing is stored).
  if (!distanceConfigured()) {
    return {
      driverId, dayKey, signature, rule: 'none', stops: [], legs: [], plannedKm: 0, plannedMin: 0,
      approximate: true, warnings: [],
      planError: 'Distance is not set up on the server (ORS_API_KEY is missing), so the route could not be calculated.',
      calculatedAt: new Date(),
    };
  }

  const byId = new Map(works.map((b) => [String(b._id), b]));
  const plan = await planDay({
    works: planWorks,
    hq,
    placeOf: (w) => resolveWorkPlace(byId.get(w.id), dayKey),
    legOf: routeLeg,
  });

  const doc = {
    signature,
    rule: plan.rule,
    stops: plan.stops.map((s) => ({
      bookingId: new mongoose.Types.ObjectId(s.bookingId),
      label: s.label,
      located: s.located,
      approximate: s.approximate,
      km: plan.perWorkKm[s.bookingId] ?? 0,
    })),
    legs: plan.legs,
    plannedKm: plan.plannedKm,
    plannedMin: plan.plannedMin,
    approximate: plan.approximate,
    warnings: plan.warnings,
    planError: '',
    calculatedAt: new Date(),
  };

  const save = () =>
    DayTrip.findOneAndUpdate({ driverId, dayKey }, { $set: doc }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  try {
    return await save();
  } catch (err) {
    if (err?.code !== 11000) throw err; // two requests raced to create the same day: the second just updates
    return save();
  }
};

// ── warming ──────────────────────────────────────────────────────────────────
// Accounts reviews a driver's expense without opening the day sheet, and its km
// check reads the STORED plan (the list never calls the map services). So when a
// driver's expense is saved, the day's route is calculated in the background.
// Failures are swallowed: the day sheet recalculates on demand anyway.

const pendingWarms = new Set();

export const warmDayPlan = (driverId, dayKey) => {
  if (!driverId || !dayKey) return Promise.resolve();
  const job = (async () => {
    try {
      const works = await loadDayWorks(driverId, dayKey);
      if (works.length > 0) await getDayPlan({ driverId, dayKey, works });
    } catch (err) {
      console.error('day plan warm-up failed:', err.message);
    }
  })();
  pendingWarms.add(job);
  job.finally(() => pendingWarms.delete(job));
  return job;
};

/// Resolves once every background warm-up has finished (for tests).
export const settleWarms = () => Promise.allSettled([...pendingWarms]);
