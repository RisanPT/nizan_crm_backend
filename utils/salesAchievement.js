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
