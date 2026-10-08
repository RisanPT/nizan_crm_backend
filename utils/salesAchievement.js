import Booking from '../models/Booking.js';
import { salesCountMatch } from './salesRules.js';

// How much each salesperson sold in a month — the "achieved" side of sales
// targets. One rule, used by every target screen:
//  • Month  = when the booking was MADE (createdAt), as an IST calendar month.
//  • Value  = totalPrice − discountAmount (net), like the Sales Dashboard.
//  • Credit = booking.salesPersonId, else the converted lead's assignedTo.
//  • Not counted: non-sale statuses (same list as the sales reports) and
//    bookings entered by users excluded from sales totals.

export const SALES_TARGET_ROLES = ['sales', 'sales_executive', 'sales_manager'];

const NOT_A_SALE = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const IST_OFFSET_MS = 330 * 60 * 1000;

/// UTC instants bounding an IST calendar month: [start, end).
export const istMonthRange = (month, year) => ({
  start: new Date(Date.UTC(year, month - 1, 1) - IST_OFFSET_MS),
  end: new Date(Date.UTC(year, month, 1) - IST_OFFSET_MS),
});

/// IST day of month (1–31) for an instant.
export const istDay = (date) => new Date(new Date(date).getTime() + IST_OFFSET_MS).getUTCDate();

const idOf = (v) => (v == null ? null : String(v._id ?? v));

/// Pure part (unit-testable): bookings → per-user totals and daily series.
/// Each booking needs status, totalPrice, discountAmount, createdAt,
/// salesPersonId and leadId (populated with assignedTo, or null).
export const tallyAchievement = (bookings, daysInMonth) => {
  const byUser = new Map();
  for (const b of bookings) {
    if (NOT_A_SALE.includes(String(b.status ?? '').toLowerCase())) continue;
    const userId = idOf(b.salesPersonId) ?? idOf(b.leadId?.assignedTo);
    if (!userId) continue; // unattributed sales count toward no one's target
    const value = Math.max(0, (Number(b.totalPrice) || 0) - (Number(b.discountAmount) || 0));
    let row = byUser.get(userId);
    if (!row) {
      row = { salesValue: 0, bookings: 0, daily: Array(daysInMonth).fill(0) };
      byUser.set(userId, row);
    }
    row.salesValue += value;
    row.bookings += 1;
    const day = istDay(b.createdAt);
    if (day >= 1 && day <= daysInMonth) row.daily[day - 1] += value;
  }
  return byUser;
};

// ── Sales manager = sum of the team ──────────────────────────────────────────
// A sales manager (role like 'sales_manager') has no target of their own: it
// is the total of every salesperson's target for the month, and their
// achievement is the team's sales plus anything credited to them directly.

/// Individual salespeople whose targets roll up to the sales manager.
export const SALESPERSON_ROLES = ['sales', 'sales_executive'];

export const isSalesManagerRole = (role) => /^sales.*manager$/i.test(String(role ?? '').trim());

/// Pure: the team rollup for a month.
/// `members` = [{ id, role }] of everyone in view (salespeople, managers, and
/// anyone holding a target); `targets` = Map(id → { salesTarget,
/// bookingsTarget }); `achievement` = Map from tallyAchievement.
/// Returns { target, achieved, teamIds } — achieved excludes managers' own.
export const teamRollup = (members, targets, achievement, daysInMonth) => {
  const teamIds = members
    .filter((m) => !isSalesManagerRole(m.role))
    .filter((m) => SALESPERSON_ROLES.includes(String(m.role ?? '').toLowerCase()) || targets.has(m.id))
    .map((m) => m.id);
  const target = { salesTarget: 0, bookingsTarget: 0 };
  const achieved = { salesValue: 0, bookings: 0, daily: Array(daysInMonth).fill(0) };
  for (const id of teamIds) {
    const t = targets.get(id);
    target.salesTarget += t?.salesTarget || 0;
    target.bookingsTarget += t?.bookingsTarget || 0;
    const a = achievement.get(id);
    if (!a) continue;
    achieved.salesValue += a.salesValue;
    achieved.bookings += a.bookings;
    a.daily?.forEach((v, i) => {
      if (i < daysInMonth) achieved.daily[i] += v;
    });
  }
  return { target, achieved, teamIds };
};

/// Pure: a manager's figures = team rollup + their own credited sales.
export const managerFigures = (rollup, own, daysInMonth) => ({
  target: rollup.target,
  achieved: {
    salesValue: rollup.achieved.salesValue + (own?.salesValue ?? 0),
    bookings: rollup.achieved.bookings + (own?.bookings ?? 0),
    daily: Array.from({ length: daysInMonth }, (_, i) => rollup.achieved.daily[i] + (own?.daily?.[i] ?? 0)),
  },
});

/// Per-user sales value and booking count for bookings MADE in [start, end)
/// — the "achieved" side of combined (pool) targets. Same sale rules as the
/// monthly targets; `service` limits it to one package family.
export const rangeAchievement = async (start, end, { service = '', serviceTypeOf = null } = {}) => {
  const bookings = await Booking.find({
    $and: [{ createdAt: { $gte: start, $lt: end } }, await salesCountMatch()],
  })
    .select('status totalPrice discountAmount createdAt salesPersonId leadId service bookingItems.service')
    .populate('leadId', 'assignedTo')
    .lean();
  const byUser = new Map();
  for (const b of bookings) {
    if (NOT_A_SALE.includes(String(b.status ?? '').toLowerCase())) continue;
    if (service && serviceTypeOf && serviceTypeOf(b.bookingItems?.[0]?.service || b.service) !== service) continue;
    const userId = idOf(b.salesPersonId) ?? idOf(b.leadId?.assignedTo);
    if (!userId) continue;
    const row = byUser.get(userId) ?? { salesValue: 0, bookings: 0 };
    row.salesValue += Math.max(0, (Number(b.totalPrice) || 0) - (Number(b.discountAmount) || 0));
    row.bookings += 1;
    byUser.set(userId, row);
  }
  return byUser;
};

/// Achievement for every credited user in the IST month.
export const monthAchievement = async (month, year) => {
  const { start, end } = istMonthRange(month, year);
  const bookings = await Booking.find({
    $and: [{ createdAt: { $gte: start, $lt: end } }, await salesCountMatch()],
  })
    .select('status totalPrice discountAmount createdAt salesPersonId leadId')
    .populate('leadId', 'assignedTo')
    .lean();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return tallyAchievement(bookings, daysInMonth);
};
