import Booking from '../models/Booking.js';
import DayTrip from '../models/DayTrip.js';
import { headquarters } from '../utils/distance.js';
import { daySignature } from '../utils/dayTrip.js';
import { dayDistance, tripKm } from '../utils/dayDistance.js';
import { allocateExpenses } from '../utils/expenseAllocation.js';
import { artistsOf } from '../utils/workArtists.js';
import { istDayKey, istStart, istEnd } from '../utils/istDate.js';
import { DEAD_STATUSES, toPlanWork } from './dayTrip.js';

// What Accounts needs beside a driver's expense, per expense:
//
//   split    which work(s) the money belongs to, who the artist on each is, and how
//            much each carries. A "whole day" expense is shared EQUALLY across that
//            day's works (rule: utils/expenseAllocation.js).
//   kmCheck  was there a work that day, how far was the route supposed to be, and
//            what did the odometer say (rules: utils/dayDistance.js).
//
// Both are derived from the driver's CURRENT works for that day, so if a work is
// added, moved or cancelled they change with it. kmCheck reads the STORED route
// plan (models/DayTrip.js) and never calls the map services, so listing hundreds of
// expenses stays fast; a plan that is missing, or was made before a work changed,
// is reported as such instead of being shown with numbers that may be wrong.

const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : '');
const keyOf = (driverId, dayKey) => `${driverId}|${dayKey}`;

/**
 * Adds `split` and `kmCheck` to each expense (plain objects; driverId / bookingId may
 * be populated). Expenses with no driver (e.g. an outsourced-driver salary) get null
 * for both. Mutates and returns the same array.
 *
 * split:   { mode, counted, reason, total, works: [{ bookingId, bookingNumber, customerName,
 *            serviceStart, artists: [{ name, roleType }], place, mapUrl, amount }] }
 *   mode     direct | shared | unallocated
 *   counted  false for a rejected bill (shown, but not a cost)
 *
 * kmCheck: { dayKey, status, routeState, works, plannedKm, returnKm, plannedTrackedKm,
 *            trackedKm, variance, estimatedDayKm, work, workMissing }
 *   status      ok | over | under | in_progress | no_route | no_works
 *   routeState  ok | missing | stale
 *   work        { plannedKm, trackedKm, tripStatus } for the work the expense is tied to
 */
export const attachDayContext = async (expenses) => {
  const dayOf = (e) => e.dayKey || (e.date ? istDayKey(e.date) : '');
  const rows = expenses.filter((e) => idOf(e.driverId) && dayOf(e));
  for (const e of expenses) {
    e.kmCheck = null;
    e.split = null;
  }
  if (rows.length === 0) return expenses;

  const drivers = [...new Set(rows.map((e) => idOf(e.driverId)))];
  const days = [...new Set(rows.map(dayOf))].sort();

  const [plans, bookings] = await Promise.all([
    DayTrip.find({ driverId: { $in: drivers }, dayKey: { $in: days } }).lean(),
    Booking.find({
      driverId: { $in: drivers },
      serviceStart: { $gte: istStart(days[0]), $lte: istEnd(days[days.length - 1]) },
    })
      .select(
        'driverId serviceStart status mapUrl dateMaps address pincode travelDistanceKm tripStatus startKm endKm ' +
          'bookingNumber customerName assignedStaff bookingItems.assignedStaff',
      )
      .sort({ serviceStart: 1, _id: 1 })
      .lean(),
  ]);

  const planOf = new Map(plans.map((p) => [keyOf(idOf(p.driverId), p.dayKey), p]));
  const worksOf = new Map();
  for (const b of bookings) {
    if (DEAD_STATUSES.has(String(b.status ?? '').toLowerCase())) continue;
    const k = keyOf(idOf(b.driverId), istDayKey(b.serviceStart));
    if (!worksOf.has(k)) worksOf.set(k, []);
    worksOf.get(k).push(b);
  }

  const hq = headquarters();
  const cache = new Map(); // one computation per driver-day
  const dayResult = (driverId, dayKey) => {
    const k = keyOf(driverId, dayKey);
    if (cache.has(k)) return cache.get(k);
    const works = worksOf.get(k) ?? [];
    const plan = planOf.get(k);
    let routeState = 'ok';
    let dist;
    if (works.length === 0) {
      dist = dayDistance({ works });
    } else if (!plan) {
      routeState = 'missing';
      dist = dayDistance({ works });
    } else if (plan.signature !== daySignature({ works: works.map((w) => toPlanWork(w, dayKey)), hq })) {
      routeState = 'stale'; // a work on that day changed after the route was calculated
      dist = dayDistance({ works });
    } else {
      dist = dayDistance({ legs: plan.legs, plannedKm: plan.plannedKm, planError: plan.planError, works });
    }
    const out = { dayKey, routeState, works, plan, dist };
    cache.set(k, out);
    return out;
  };

  const workRow = (b, amount, dayKey) => ({
    bookingId: String(b._id),
    bookingNumber: b.bookingNumber ?? '',
    customerName: b.customerName ?? '',
    serviceStart: b.serviceStart,
    artists: artistsOf(b).map(({ name, roleType }) => ({ name, roleType })),
    // where the work was (that date's map for a multi-date booking, else the booking's)
    place: [b.address, b.pincode].map((x) => String(x ?? '').trim()).filter(Boolean).join(' · '),
    mapUrl: toPlanWork(b, dayKey).mapUrl,
    amount,
  });

  for (const e of rows) {
    const dayKey = dayOf(e);
    const { routeState, works, plan, dist } = dayResult(idOf(e.driverId), dayKey);
    const workId = idOf(e.bookingId);

    // ── which work(s), who the artist is, and the share ──
    const alloc = allocateExpenses({
      works: works.map((w) => ({ id: String(w._id) })),
      expenses: [{ id: String(e._id), bookingId: workId || null, amount: e.totalAmount, category: e.category }],
    });
    const line = alloc.lines[0];
    const byId = new Map(works.map((w) => [String(w._id), w]));
    e.split = {
      mode: line?.mode ?? 'unallocated',
      counted: e.status !== 'rejected',
      reason: line?.reason ?? '',
      total: Number(e.totalAmount) || 0,
      works: alloc.lines
        .filter((l) => l.bookingId && byId.has(l.bookingId))
        .map((l) => workRow(byId.get(l.bookingId), l.amount, dayKey)),
    };

    // ── the km check ──
    let work = null;
    let workMissing = false;
    if (workId) {
      const w = byId.get(workId);
      if (w) {
        const stop = routeState === 'ok' ? plan?.stops?.find((s) => idOf(s.bookingId) === workId) : null;
        work = { plannedKm: stop ? stop.km : null, trackedKm: tripKm(w), tripStatus: w.tripStatus ?? 'unassigned' };
      } else {
        workMissing = true; // the work it was for is no longer on this day
      }
    }
    e.kmCheck = {
      dayKey,
      status: dist.status,
      routeState,
      works: works.length,
      plannedKm: routeState === 'ok' ? dist.plannedKm : null,
      returnKm: routeState === 'ok' ? dist.returnKm : null,
      plannedTrackedKm: routeState === 'ok' ? dist.plannedTrackedKm : null,
      trackedKm: dist.trackedKm,
      variance: dist.variance,
      estimatedDayKm: dist.estimatedDayKm,
      work,
      workMissing,
    };
  }
  return expenses;
};
