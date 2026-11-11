import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import ArtistDayRoute from '../models/ArtistDayRoute.js';
import { planArtistLegs, artistDaySignature, inTimeOrder } from '../utils/artistDay.js';
import { artistsOf } from '../utils/workArtists.js';
import { resolveWorkPlace, routeLeg, distanceConfigured } from '../utils/distance.js';
import { istStart, istEnd } from '../utils/istDate.js';
import { DEAD_STATUSES } from './dayTrip.js';

// A plan that couldn't measure a leg is retried, but not on every single read.
const RETRY_AFTER_MS = 10 * 60 * 1000;

export const ARTIST_WORK_FIELDS =
  'bookingNumber customerName service eventSlot status address pincode mapUrl dateMaps ' +
  'serviceStart serviceEnd travelDistanceKm bookingItems.travelDistanceKm assignedStaff bookingItems.assignedStaff';

const mapValue = (m, key) => (!m ? '' : typeof m.get === 'function' ? m.get(key) || '' : m[key] || '');

/// True when the artist (lead or assistant — never the driver) is on the booking,
/// at the booking level or on any of its per-package items.
export const isArtistOn = (booking, employeeId) =>
  artistsOf(booking).some((a) => a.employeeId === String(employeeId));

/// The artist's works for one IST calendar day, earliest first, without cancelled ones.
/// A work counts on the day it STARTS (a multi-date booking appears on its first day —
/// the same rule the driver's day uses).
export const loadArtistDayWorks = async (employeeId, dayKey) => {
  const eid = new mongoose.Types.ObjectId(String(employeeId));
  const rows = await Booking.find({
    serviceStart: { $gte: istStart(dayKey), $lte: istEnd(dayKey) },
    $or: [{ 'assignedStaff.employeeId': eid }, { 'bookingItems.assignedStaff.employeeId': eid }],
  })
    .select(ARTIST_WORK_FIELDS)
    .sort({ serviceStart: 1, _id: 1 })
    .lean();
  return rows.filter((b) => !DEAD_STATUSES.has(String(b.status ?? '').toLowerCase()) && isArtistOn(b, employeeId));
};

/// How a work is named in a route: "2610 1234 · Anjali".
export const artistWorkLabel = (b) => [b.bookingNumber, b.customerName].filter(Boolean).join(' · ') || 'Work';

export const toArtistPlanWork = (b, dayKey) => ({
  id: String(b._id),
  label: artistWorkLabel(b),
  serviceStart: b.serviceStart,
  // What the location depends on — feeds the signature, so changing the venue recalculates.
  mapUrl: String(mapValue(b.dateMaps, dayKey) || b.mapUrl || '').trim(),
  address: b.address || '',
  pincode: b.pincode || '',
});

const isIncomplete = (r) => (r.legs || []).some((l) => l.km === null);

/**
 * The legs between one artist's consecutive works on one day. Reuses the stored legs
 * while nothing they depend on has changed; otherwise measures them with the map
 * services and stores the result. Never throws for map problems — a leg that could
 * not be measured has `km: null`.
 *
 * @param {object} o
 * @param {*}      o.employeeId
 * @param {string} o.dayKey  'YYYY-MM-DD' (IST)
 * @param {Array}  o.works   from loadArtistDayWorks (so callers load them once)
 * @returns {{ order: string[], legs: Array, distanceReady: boolean }}
 *          legs: [{ fromId, toId, km, durationMin, approximate, note }]
 */
export const getArtistDayLegs = async ({ employeeId, dayKey, works }) => {
  const ordered = inTimeOrder(works.map((b) => toArtistPlanWork(b, dayKey)));
  const order = ordered.map((w) => w.id);

  // One work (or none) in the day: nothing to travel between. Drop a stale plan.
  if (works.length < 2) {
    await ArtistDayRoute.deleteOne({ employeeId, dayKey });
    return { order, legs: [], distanceReady: true };
  }

  const signature = artistDaySignature({ works: ordered });
  const asLegs = (stored) =>
    (stored.legs || []).map((l) => ({
      fromId: String(l.fromBookingId),
      toId: String(l.toBookingId),
      km: l.km,
      durationMin: l.durationMin || 0,
      approximate: !!l.approximate,
      note: l.note || '',
    }));

  const stored = await ArtistDayRoute.findOne({ employeeId, dayKey }).lean();
  if (stored && stored.signature === signature) {
    const fresh = Date.now() - new Date(stored.calculatedAt).getTime() < RETRY_AFTER_MS;
    if (!isIncomplete(stored) || fresh) return { order, legs: asLegs(stored), distanceReady: true };
  }

  // Several works but no map service configured: say so (nothing was calculated,
  // so nothing is stored). The legs are listed without distances.
  if (!distanceConfigured()) {
    const legs = order.slice(0, -1).map((id, i) => ({
      fromId: id, toId: order[i + 1], km: null, durationMin: 0, approximate: true, note: 'not_configured',
    }));
    return { order, legs, distanceReady: false };
  }

  const byId = new Map(works.map((b) => [String(b._id), b]));
  const plan = await planArtistLegs({
    works: ordered,
    placeOf: (w) => resolveWorkPlace(byId.get(w.id), dayKey),
    legOf: routeLeg,
  });

  const doc = {
    signature,
    legs: plan.legs.map((l) => ({
      fromBookingId: new mongoose.Types.ObjectId(l.fromId),
      toBookingId: new mongoose.Types.ObjectId(l.toId),
      km: l.km,
      durationMin: l.durationMin,
      approximate: l.approximate,
      note: l.note,
    })),
    warnings: plan.warnings,
    calculatedAt: new Date(),
  };
  const save = () =>
    ArtistDayRoute.findOneAndUpdate({ employeeId, dayKey }, { $set: doc }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  let saved;
  try {
    saved = await save();
  } catch (err) {
    if (err?.code !== 11000) throw err; // two requests raced to create the same day: the second just updates
    saved = await save();
  }
  return { order, legs: asLegs(saved), distanceReady: true };
};
