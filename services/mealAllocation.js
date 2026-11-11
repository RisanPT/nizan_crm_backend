import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import { allocateArtistDay, mealDayKey, mealsOf, workPeriod } from '../utils/mealAllocation.js';
import { artistsOf } from '../utils/workArtists.js';
import { teamMealCheck } from '../utils/foodAllowance.js';
import { teamMealStates, teamMealKey } from './teamMealLimit.js';
import { istDayKey, istStart, istEnd } from '../utils/istDate.js';
import { DEAD_STATUSES } from './dayTrip.js';
import { ARTIST_WORK_FIELDS } from './artistDay.js';

// Puts artists' expenses "under the works" they belong to — food by the time of the
// meal (rules: utils/mealAllocation.js). Everything here is derived from the artist's
// CURRENT works for that day, so a work that is added, moved or cancelled moves the
// food with it; nothing is stored.

const idOf = (v) => (v && typeof v === 'object' && v._id ? String(v._id) : v ? String(v) : '');
const keyOf = (employeeId, dayKey) => `${employeeId}|${dayKey}`;

const placeOf = (b) =>
  [b.address, b.pincode].map((x) => String(x ?? '').trim()).filter(Boolean).join(' · ');

/// How far the work is: the travel distance (km) taken on the booking — the booking's own, else the
/// longest of its items'. 0 = not recorded. Accounts reads it beside the food bill to judge the amount.
export const workDistanceKm = (b) => {
  const own = Number(b?.travelDistanceKm) || 0;
  if (own > 0) return own;
  return Math.max(0, ...(b?.bookingItems ?? []).map((i) => Number(i?.travelDistanceKm) || 0));
};

/// The works of several artists over a span of days, bucketed per artist-day:
/// Map('employeeId|YYYY-MM-DD' → [{ id, serviceStart, serviceEnd, booking }]) in time order.
/// Cancelled works are left out; a driver listed on a booking is not an artist.
export const loadWorksForArtists = async (employeeIds, dayKeys) => {
  const buckets = new Map();
  if (employeeIds.length === 0 || dayKeys.length === 0) return buckets;
  const wanted = new Set(employeeIds.map(String));
  const days = [...dayKeys].sort();
  const eids = employeeIds.map((id) => new mongoose.Types.ObjectId(String(id)));
  const rows = await Booking.find({
    serviceStart: { $gte: istStart(days[0]), $lte: istEnd(days[days.length - 1]) },
    $or: [{ 'assignedStaff.employeeId': { $in: eids } }, { 'bookingItems.assignedStaff.employeeId': { $in: eids } }],
  })
    .select(ARTIST_WORK_FIELDS)
    .sort({ serviceStart: 1, _id: 1 })
    .lean();
  for (const b of rows) {
    if (DEAD_STATUSES.has(String(b.status ?? '').toLowerCase())) continue;
    const day = istDayKey(b.serviceStart);
    for (const a of artistsOf(b)) {
      if (!wanted.has(a.employeeId)) continue;
      const k = keyOf(a.employeeId, day);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push({ id: String(b._id), serviceStart: b.serviceStart, serviceEnd: b.serviceEnd, booking: b });
    }
  }
  return buckets;
};

/**
 * Where each expense belongs.
 * @param {Array} expenses  plain objects: _id, employeeId, bookingId, category, meal, amount, date, workType, status
 *                          (employeeId / bookingId may be populated)
 * @returns {{ byExpense: Map<string, Allocation>, bookings: Map<string, BookingInfo> }}
 *   Allocation: { mode, counted, reason, flag, relation, minutes, meal, meals, mealAt, total,
 *                 shares: [{ bookingId, amount }] }   — `counted` is false for a rejected bill
 *   BookingInfo: { bookingId, bookingNumber, customerName, service, serviceStart, serviceEnd, period, place,
 *                  travelDistanceKm (0 = not recorded), artists: [name], people }
 */
export const computeAllocations = async (expenses) => {
  const rows = expenses.filter((e) => idOf(e.employeeId) && e.date);
  const employees = [...new Set(rows.map((e) => idOf(e.employeeId)))];
  const days = [...new Set(rows.map((e) => mealDayKey(e.date)))];
  const buckets = await loadWorksForArtists(employees, days);

  // group per artist-day, then allocate each group
  const groups = new Map();
  for (const e of rows) {
    const k = keyOf(idOf(e.employeeId), mealDayKey(e.date));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  const byExpense = new Map();
  const bookings = new Map();
  const remember = (b) => {
    if (!b || bookings.has(String(b._id))) return;
    bookings.set(String(b._id), {
      bookingId: String(b._id),
      bookingNumber: b.bookingNumber ?? '',
      customerName: b.customerName ?? '',
      service: b.service ?? '',
      serviceStart: b.serviceStart ?? null,
      serviceEnd: b.serviceEnd ?? null,
      // morning / afternoon / evening — when in the day the work is
      period: b.serviceStart ? workPeriod(b) : '',
      place: placeOf(b),
      // how far the venue is (km, 0 = not recorded) — so Accounts can judge the food bill against the trip
      travelDistanceKm: workDistanceKm(b),
      artists: artistsOf(b).map((a) => a.name).filter(Boolean),
      // everyone assigned to the work — the heads for the per-head cost (the driver is not an artist)
      people: artistsOf(b),
    });
  };

  for (const [k, list] of groups) {
    const works = buckets.get(k) ?? [];
    for (const w of works) remember(w.booking);
    const { lines } = allocateArtistDay({
      works,
      expenses: list.map((e) => ({
        id: String(e._id),
        amount: e.amount,
        category: e.category,
        meal: e.meal || '',
        meals: mealsOf(e),
        at: e.date,
        bookingId: idOf(e.bookingId) || null,
        workType: e.workType,
      })),
    });
    for (const e of list) {
      const line = lines.get(String(e._id));
      if (!line) continue;
      byExpense.set(String(e._id), {
        mode: line.mode,
        counted: e.status !== 'rejected',
        reason: line.reason,
        flag: line.flag,
        relation: line.relation ?? '',
        basis: line.basis ?? '',
        minutes: line.minutes ?? null,
        meal: e.meal || '',
        meals: mealsOf(e),
        mealAt: e.date,
        total: e.amount,
        shares: line.shares,
      });
    }
  }

  // Works named by a pin (the artist tied the food to one) that aren't on the day's list.
  const missing = new Set();
  for (const a of byExpense.values()) for (const s of a.shares) if (!bookings.has(s.bookingId)) missing.add(s.bookingId);
  for (const e of expenses) {
    const b = e.bookingId && typeof e.bookingId === 'object' && e.bookingId._id ? e.bookingId : null;
    if (b && missing.has(String(b._id))) {
      remember(b);
      missing.delete(String(b._id));
    }
  }
  if (missing.size > 0) {
    const rest = await Booking.find({ _id: { $in: [...missing].filter((id) => mongoose.isValidObjectId(id)) } })
      .select('bookingNumber customerName service serviceStart serviceEnd address pincode travelDistanceKm bookingItems.travelDistanceKm assignedStaff bookingItems.assignedStaff')
      .lean();
    for (const b of rest) remember(b);
  }
  return { byExpense, bookings };
};

/// The shape Accounts reads on an expense: the allocation with each share's work spelled out.
export const presentAllocation = (allocation, bookings) =>
  allocation && {
    ...allocation,
    shares: allocation.shares.map((s) => ({ ...(bookings.get(s.bookingId) ?? { bookingId: s.bookingId }), amount: s.amount })),
  };

/**
 * Adds `allocation` to each FOOD expense (plain objects). Other expenses get null.
 * Mutates and returns the same array.
 */
export const attachMealAllocation = async (expenses) => {
  const { byExpense, bookings } = await computeAllocations(expenses.filter((e) => e.category === 'food'));

  // The TEAM's limit for the meal on the work each food expense counts under (heads × the allowance
  // per head, against everything the team logged for that meal there): so Accounts sees, on the
  // expense itself, that the limit was exceeded. One lookup for the whole page.
  const pairs = [];
  for (const e of expenses) {
    const a = e.category === 'food' ? byExpense.get(String(e._id)) : null;
    if (a?.shares?.length && a.counted && a.meals.length > 0) pairs.push({ workId: a.shares[0].bookingId, meals: a.meals });
  }
  let states = new Map();
  try {
    states = await teamMealStates(pairs);
  } catch (err) {
    console.error('team limit lookup failed:', err.message); // the list still loads, without the limit
  }

  for (const e of expenses) {
    const a = e.category === 'food' ? presentAllocation(byExpense.get(String(e._id)) ?? null, bookings) : null;
    if (a) {
      const raw = byExpense.get(String(e._id));
      const state = raw?.shares?.length && raw.counted && raw.meals.length > 0 ? states.get(teamMealKey(raw.shares[0].bookingId, raw.meals)) : null;
      let limit = null;
      if (state) {
        const c = teamMealCheck({ heads: state.heads, allowancePerHead: state.allowancePerHead, alreadySpent: state.alreadySpent, amount: 0 });
        if (c.status === 'over' || c.status === 'within') {
          // `meal` is the pool's key ('lunch', or 'breakfast+lunch+dinner' when meals were paid together)
          limit = { meal: state.meals.join('+'), meals: state.meals, heads: c.heads, allowancePerHead: c.allowancePerHead, limit: c.limit, teamTotal: c.total, over: c.over, status: c.status };
        }
      }
      a.limit = limit;
    }
    e.allocation = a;
  }
  return expenses;
};
