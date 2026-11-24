// ONE DRIVER PER ARTIST PER DAY
//
// "If we assign a driver for work 1 on day x of artist n, then the driver is responsible for
// all of that artist's works on day x." Owner's decisions (2026-11-16):
//   • the artist = the booking's LEAD artist(s). A booking with nobody marked lead but exactly one
//     artist counts that artist as its lead. Assistants' separate works are not pulled in.
//   • a day = an IST calendar day the work runs on (utils/fleetAvailability.js workWindows).
//   • the vehicle follows the driver.
//   • changing or removing the driver later applies to the whole day too.
//   • another of her works that day with a DIFFERENT driver is moved only after the person confirms.
//   • cancelled / postponed / rejected / lost works are left alone.
//   • a work that runs over several days is not touched (its one driver covers its other days too)
//     — it is reported so someone assigns it by hand. So is a work whose trip has already started.
//   • no backfill: only applies when a driver / vehicle is assigned from now on.
//
// Pure — tests/driverDay.test.js. The database half is services/driverDay.js.

import { EXCLUDED_STATUSES, workWindows } from './fleetAvailability.js';
import { artistsOf } from './workArtists.js';

const id = (v) => (v == null || v === '' ? '' : String(v._id ?? v));

/// Trip states after which a work's driver / vehicle must not be changed behind the driver's back.
export const TRIP_STARTED = new Set(['inspection_pending', 'in_progress', 'completed', 'accident']);

export const isLive = (b) => !EXCLUDED_STATUSES.has(String(b?.status ?? '').toLowerCase());

/// The lead artist ids of a booking (see the rule above for a booking with no lead marked).
export const leadIdsOf = (booking) => {
  const artists = artistsOf(booking);
  const leads = artists.filter((a) => a.roleType === 'lead');
  if (leads.length > 0) return leads.map((a) => a.employeeId);
  return artists.length === 1 ? [artists[0].employeeId] : [];
};

/// The IST days ('YYYY-MM-DD') a booking runs on.
export const daysOf = (booking) => [...new Set(workWindows(booking).map((w) => w.day))];

/**
 * What changed in the driver / vehicle of one booking — null when nothing that the rule cares about.
 * A vehicle change only counts while the booking has a driver (the vehicle follows the driver).
 */
export const driverDayChange = ({ before, after }) => {
  const prevDriver = id(before?.driverId);
  const nextDriver = id(after?.driverId);
  const prevVehicle = id(before?.vehicleId);
  const nextVehicle = id(after?.vehicleId);
  const driverChanged = prevDriver !== nextDriver;
  const vehicleChanged = Boolean(nextDriver) && prevVehicle !== nextVehicle;
  if (!driverChanged && !vehicleChanged) return null;
  return { prevDriver, nextDriver, prevVehicle, nextVehicle, driverChanged };
};

/**
 * Which of the artist's other works that day get the same driver / vehicle.
 *
 * @param {object} o
 * @param {object} o.booking     the edited booking as it will be saved (driverId, vehicleId, staff, dates, status)
 * @param {object} o.change      from driverDayChange()
 * @param {Array}  o.candidates  other bookings that may share a lead artist and a day (any extra is ignored)
 * @returns {{ leadIds, days, update: Array, skipped: Array }}
 *   update[]:  { booking, day, from: { driverId, vehicleId }, to: { driverId, vehicleId }, otherDriver }
 *              otherDriver = it has a different driver now (needs the person's confirmation)
 *   skipped[]: { booking, day, reason: 'multi_day' | 'trip_started' }
 */
export const planDriverDay = ({ booking, change, candidates }) => {
  const out = { leadIds: [], days: [], update: [], skipped: [] };
  if (!change || !booking || !isLive(booking)) return out;
  const leadIds = leadIdsOf(booking);
  const days = daysOf(booking);
  out.leadIds = leadIds;
  out.days = days;
  if (leadIds.length === 0 || days.length === 0) return out;

  const { prevDriver, nextDriver, prevVehicle, nextVehicle, driverChanged } = change;
  const self = id(booking._id);
  const seen = new Set();

  for (const c of candidates || []) {
    const cid = id(c?._id);
    if (!cid || cid === self || seen.has(cid)) continue;
    seen.add(cid);
    if (!isLive(c)) continue;
    const cDays = daysOf(c);
    const day = cDays.find((d) => days.includes(d));
    if (!day) continue;
    if (!leadIdsOf(c).some((l) => leadIds.includes(l))) continue;

    const cDriver = id(c.driverId);
    const cVehicle = id(c.vehicleId);
    let to;
    let otherDriver = false;

    if (nextDriver) {
      // A vehicle-only change moves the vehicle on the works this driver already has, nothing else.
      if (!driverChanged && cDriver !== nextDriver) continue;
      otherDriver = Boolean(cDriver) && cDriver !== nextDriver && cDriver !== prevDriver;
      // The vehicle: the booking's own; with none chosen, the work keeps its vehicle unless it was
      // the one just taken off.
      const vehicle = nextVehicle || (cVehicle === prevVehicle ? '' : cVehicle);
      to = { driverId: nextDriver, vehicleId: vehicle };
    } else {
      // Driver removed: the works that had the same driver lose it too.
      if (!prevDriver || cDriver !== prevDriver) continue;
      to = { driverId: '', vehicleId: cVehicle === prevVehicle ? nextVehicle : cVehicle };
    }
    if (to.driverId === cDriver && to.vehicleId === cVehicle) continue;

    if (TRIP_STARTED.has(String(c.tripStatus ?? ''))) {
      out.skipped.push({ booking: c, day, reason: 'trip_started' });
    } else if (cDays.length > 1) {
      out.skipped.push({ booking: c, day, reason: 'multi_day' });
    } else {
      out.update.push({ booking: c, day, from: { driverId: cDriver, vehicleId: cVehicle }, to, otherDriver });
    }
  }
  return out;
};

/**
 * A booking's staff lists with the driver entry put right: every roleType 'driver' entry is replaced
 * by [driverEntry] (or dropped when [driverEntry] is null). If there was none anywhere and there is a
 * driver, it is added to the booking-level list — the Manage Booking screen reads the driver from
 * these lists and would otherwise put the old one back on the next save.
 * @returns {{ assignedStaff: Array, items: Array<Array|null> }}  items[i] null = unchanged
 */
export const withDriverEntry = (booking, driverEntry) => {
  let found = false;
  const fix = (list) => {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.some((s) => s?.roleType === 'driver')) return null;
    found = true;
    const kept = arr.filter((s) => s?.roleType !== 'driver');
    return driverEntry ? [...kept, { ...driverEntry }] : kept;
  };
  const top = fix(booking?.assignedStaff);
  const items = (booking?.bookingItems || []).map((it) => fix(it?.assignedStaff));
  let assignedStaff = top ?? [...(booking?.assignedStaff || [])];
  if (!found && driverEntry) assignedStaff = [...assignedStaff, { ...driverEntry }];
  return { assignedStaff, items };
};

/// "BK-12 · Anu" — how a work is named in messages and the app.
export const workLabel = (b) =>
  [b?.bookingNumber ? `#${b.bookingNumber}` : '', String(b?.customerName ?? '').trim()].filter(Boolean).join(' · ') || 'a work';
