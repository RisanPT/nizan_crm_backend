import Booking from '../models/Booking.js';
import Expense from '../models/Expense.js';
import FuelExpense from '../models/FuelExpense.js';
import ArtistPayout from '../models/ArtistPayout.js';
import { computeAllocations } from './mealAllocation.js';
import { ensureGstConfig } from './posting.js';
import { DEAD_STATUSES } from './dayTrip.js';
import { isSale } from '../controllers/dashboardController.js';
import { makeCountsTowardSales } from '../utils/salesRules.js';
import { allocateExpenses, toPaise, toRupees } from '../utils/expenseAllocation.js';
import { addDays, istDayKey, istEnd, istStart } from '../utils/istDate.js';
import { artistsOf } from '../utils/workArtists.js';
import { addCost, newCosts, profitRow } from '../utils/workProfit.js';

// WORK PROFIT — the database half; the rules are in utils/workProfit.js.
//
// The works are the bookings whose first day falls in the period (a multi-day booking counts once, on
// its first day — like the fleet and the dashboards). Each work gets:
//   • its revenue (the dashboards' "net value", GST backed out),
//   • the artists' expenses placed on it (services/mealAllocation.js — the same placement Accounts sees),
//   • the drivers' expenses (tied to it, or shared equally over that driver's works that day — the same
//     split as the Fleet Expenses screen),
//   • what freelancers are paid for it.
// Costs that belong to no work — or to a work this report doesn't count — are returned separately as
// `unallocated`, so every rupee spent in the period is either on a work or there. Nothing is stored:
// it is all worked out on read.

const PICK =
  'bookingNumber customerName service status serviceStart serviceEnd totalPrice discountAmount advanceAmount collectedAmount ' +
  'createdBy driverId district region assignedStaff bookingItems.assignedStaff';

const id = (v) => (v == null ? '' : String(v._id ?? v));

/**
 * @param {{ from: string, to: string }} range  IST days, inclusive
 * @returns {{ works: Array<{ booking, row }>, unallocated: { artist, fleet }, gst: object }}
 *   row = utils/workProfit.js profitRow result
 */
export const workProfitFor = async ({ from, to }) => {
  const gst = await ensureGstConfig();
  const counts = await makeCountsTowardSales();

  const bookings = await Booking.find({ serviceStart: { $gte: istStart(from), $lte: istEnd(to) } })
    .select(PICK)
    .lean();
  const works = bookings.filter((b) => isSale(b) && counts(b));
  const empty = { works: [], unallocated: { artist: 0, fleet: 0 }, gst };
  if (works.length === 0) return empty;

  const ids = works.map((b) => id(b));
  const inScope = new Set(ids);
  const costs = new Map(ids.map((i) => [i, newCosts()]));
  const unallocated = { artist: 0, fleet: 0 }; // paise
  const lo = istStart(addDays(from, -1));
  const hi = istEnd(addDays(to, 1));
  const inRange = (day) => day >= from && day <= to;

  // ── the artists' expenses, placed on works the way Accounts sees them ──
  const artistExpenses = await Expense.find({
    status: { $in: ['pending', 'verified'] },
    $or: [{ date: { $gte: lo, $lte: hi } }, { bookingId: { $in: ids } }],
  })
    .select('employeeId bookingId category meal meals amount date workType status')
    .lean();
  const { byExpense } = await computeAllocations(artistExpenses);
  for (const e of artistExpenses) {
    const shares = byExpense.get(id(e))?.shares ?? [];
    if (shares.length === 0) {
      if (inRange(istDayKey(e.date))) unallocated.artist += toPaise(e.amount);
      continue;
    }
    for (const s of shares) {
      if (inScope.has(s.bookingId)) {
        addCost(costs.get(s.bookingId), 'artist', e.category, toPaise(s.amount), { pending: e.status === 'pending' });
      } else if (inRange(istDayKey(e.date))) {
        unallocated.artist += toPaise(s.amount); // on a work this report doesn't count
      }
    }
  }

  // ── the drivers' expenses, tied to a work or shared over that driver's works that day ──
  const fleetExpenses = (
    await FuelExpense.find({
      status: { $ne: 'rejected' },
      category: { $ne: 'outsource_salary' }, // a salary is not a cost of one work
      $or: [{ date: { $gte: lo, $lte: hi } }, { bookingId: { $in: ids } }],
    })
      .select('driverId bookingId category totalAmount date dayKey status')
      .lean()
  )
    .map((e) => ({ ...e, day: e.dayKey || istDayKey(e.date) }))
    .filter((e) => inRange(e.day));

  const drivers = [...new Set(fleetExpenses.map((e) => id(e.driverId)).filter(Boolean))];
  const dayWorks = new Map(); // driver|day → that driver's real works, in order (cancelled ones out)
  if (drivers.length) {
    const theirs = await Booking.find({ driverId: { $in: drivers }, serviceStart: { $gte: istStart(from), $lte: istEnd(to) } })
      .select('driverId serviceStart status')
      .sort({ serviceStart: 1, _id: 1 })
      .lean();
    for (const b of theirs) {
      if (DEAD_STATUSES.has(String(b.status ?? '').toLowerCase())) continue;
      const k = `${id(b.driverId)}|${istDayKey(b.serviceStart)}`;
      if (!dayWorks.has(k)) dayWorks.set(k, []);
      dayWorks.get(k).push({ id: id(b) });
    }
  }

  const groups = new Map(); // driver|day → expenses
  for (const e of fleetExpenses) {
    if (!id(e.driverId)) {
      unallocated.fleet += toPaise(e.totalAmount); // no driver, no day to share it over
      continue;
    }
    const k = `${id(e.driverId)}|${e.day}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const [k, list] of groups) {
    const byId = new Map(list.map((e) => [id(e), e]));
    const { lines } = allocateExpenses({
      works: dayWorks.get(k) ?? [],
      expenses: list.map((e) => ({ id: id(e), bookingId: id(e.bookingId) || null, amount: e.totalAmount, category: e.category })),
    });
    for (const line of lines) {
      const e = byId.get(line.expenseId);
      if (line.mode !== 'unallocated' && line.bookingId && inScope.has(line.bookingId)) {
        addCost(costs.get(line.bookingId), 'fleet', e.category, toPaise(line.amount), { pending: e.status === 'pending', shared: line.mode === 'shared' });
      } else {
        // tied to no work, or to a work this report doesn't count (a pending booking, say)
        unallocated.fleet += toPaise(line.amount);
      }
    }
  }

  // ── what freelancers are paid for the job ──
  const payouts = await ArtistPayout.find({ bookingId: { $in: ids }, status: { $in: ['pending', 'approved', 'paid'] } })
    .select('bookingId amount status')
    .lean();
  for (const p of payouts) addCost(costs.get(id(p.bookingId)), 'freelance', 'payout', toPaise(p.amount), { pending: p.status === 'pending' });

  return {
    works: works.map((booking) => ({ booking, row: profitRow({ booking, gst, costs: costs.get(id(booking)) }) })),
    unallocated: { artist: toRupees(unallocated.artist), fleet: toRupees(unallocated.fleet) },
    gst,
  };
};

/// What the card shows to identify a work.
export const identityOf = (b) => ({
  bookingId: id(b),
  bookingNumber: b.bookingNumber ?? '',
  customerName: b.customerName ?? '',
  service: b.service ?? '',
  status: b.status ?? '',
  serviceStart: b.serviceStart,
  place: [b.district, b.region].map((x) => String(x ?? '').trim()).filter(Boolean)[0] ?? '',
  artists: artistsOf(b).map((a) => a.name).filter(Boolean),
});
