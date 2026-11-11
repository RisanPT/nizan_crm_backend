import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { istDayKey } from '../utils/istDate.js';
import { positionsInDay } from '../utils/artistDay.js';
import { DEAD_STATUSES } from '../services/dayTrip.js';
import { loadArtistDayWorks, getArtistDayLegs, isArtistOn, ARTIST_WORK_FIELDS } from '../services/artistDay.js';

const MAX_IDS = 60;
const MAX_DAYS = 31;

// Roles that may look at ANOTHER artist's day (?employeeId=); an artist only ever sees their own.
const MAY_VIEW_OTHERS = new Set(['admin', 'manager', 'artist_head']);

const mapValue = (m, key) => (!m ? '' : typeof m.get === 'function' ? m.get(key) || '' : m[key] || '');

/// Where the work is, in a few words for the strip on the card.
const placeText = (b) => {
  const address = String(b.address || '').replace(/\s+/g, ' ').trim();
  if (address) return address.length > 80 ? `${address.slice(0, 77)}…` : address;
  return b.pincode ? `Pincode ${b.pincode}` : '';
};

/**
 * @desc   For each of the artist's works asked about (?ids=a,b,c): where it falls in
 *         their day ("work 2 of 3") and, when there is a later work the same day,
 *         which one it is and how far it is from this one.
 * @route  GET /api/bookings/next-work?ids=…[&employeeId=…]
 * @access Private — an artist gets their own; admin / manager / artist_head may pass ?employeeId=
 * @returns { distanceReady, hints: { [bookingId]: { dayKey, position, total, next: {...} | null } } }
 */
export const getNextWorkHints = async (req, res) => {
  try {
    const role = req.user?.role;
    let employeeId = req.user?.employeeId ? String(req.user.employeeId) : '';
    if (MAY_VIEW_OTHERS.has(role) && req.query.employeeId && mongoose.isValidObjectId(req.query.employeeId)) {
      employeeId = String(req.query.employeeId);
    }

    const ids = [...new Set(String(req.query.ids ?? '').split(',').map((s) => s.trim()).filter((s) => mongoose.isValidObjectId(s)))].slice(0, MAX_IDS);
    if (!employeeId || ids.length === 0) return res.json({ distanceReady: true, hints: {} });

    // The works asked about — only the ones this artist is really on.
    const asked = (await Booking.find({ _id: { $in: ids } }).select(ARTIST_WORK_FIELDS).lean()).filter(
      (b) => !DEAD_STATUSES.has(String(b.status ?? '').toLowerCase()) && isArtistOn(b, employeeId),
    );
    const askedByDay = new Map();
    for (const b of asked) {
      const day = istDayKey(b.serviceStart);
      if (!askedByDay.has(day)) askedByDay.set(day, []);
      askedByDay.get(day).push(String(b._id));
    }

    const hints = {};
    let distanceReady = true;
    for (const [dayKey, askedIds] of [...askedByDay.entries()].slice(0, MAX_DAYS)) {
      const works = await loadArtistDayWorks(employeeId, dayKey);
      const { order, legs, distanceReady: ready } = await getArtistDayLegs({ employeeId, dayKey, works });
      if (!ready) distanceReady = false;
      const positions = positionsInDay(order, legs);
      const byId = new Map(works.map((b) => [String(b._id), b]));

      for (const id of askedIds) {
        const p = positions.get(id);
        if (!p) continue;
        const nextBooking = p.nextId ? byId.get(p.nextId) : null;
        hints[id] = {
          dayKey,
          position: p.position,
          total: p.total,
          next: nextBooking
            ? {
                bookingId: String(nextBooking._id),
                bookingNumber: nextBooking.bookingNumber || '',
                customerName: nextBooking.customerName || '',
                service: nextBooking.service || '',
                serviceStart: nextBooking.serviceStart,
                serviceEnd: nextBooking.serviceEnd,
                place: placeText(nextBooking),
                mapUrl: String(mapValue(nextBooking.dateMaps, dayKey) || nextBooking.mapUrl || '').trim(),
                km: p.leg?.km ?? null,
                durationMin: p.leg?.durationMin ?? 0,
                approximate: !!p.leg?.approximate,
              }
            : null,
        };
      }
    }

    res.json({ distanceReady, hints });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
