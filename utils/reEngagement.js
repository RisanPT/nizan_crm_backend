// Past clients due for a RE-TOUCH: their last event was before [cutoff] and they have not booked since. Shared by the Marketing
// re-engagement worklist (GET /api/marketing/re-engagement) and the CRM's (GET /api/crm/re-engagement), where a client can be turned
// into a call case. Pure — tests/reEngagement.test.js.

import { normalizePhone } from './phone.js';

// Booking.status is free text in mixed casing (and old imports carry spaces): these never count as a live booking.
export const NON_REVENUE = ['cancelled', 'canceled', 'rejected', 'lost', 'draft'];
export const NON_REVENUE_FILTER = {
  $not: { $regex: `^\\s*(${NON_REVENUE.join('|')})\\s*$`, $options: 'i' },
};

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * One row per client (a client = a phone's last 10 digits, so "+91 98950 00001" and "9895000001" are the same person), from their
 * live [bookings] ({ _id, customerName, phone, service, serviceStart, bookingDate }). Only clients whose most recent event is before
 * [cutoff]; the longest-waiting first.
 * → [{ customerName, phone, phoneKey, service, lastEventDate, lastBookingId, bookings, monthsSince }]
 */
export const reEngagementList = (bookings, { cutoff, now = new Date() }) => {
  const byPhone = new Map();
  for (const b of bookings) {
    const key = normalizePhone(b.phone);
    if (!key) continue;
    const when = new Date(b.serviceStart || b.bookingDate);
    if (Number.isNaN(when.getTime())) continue;
    const cur = byPhone.get(key);
    if (!cur || when > cur.lastEventDate) {
      byPhone.set(key, {
        customerName: b.customerName || '',
        phone: String(b.phone).trim(),
        phoneKey: key,
        service: b.service || '',
        lastEventDate: when,
        lastBookingId: b._id,
        bookings: (cur?.bookings || 0) + 1,
      });
    } else {
      cur.bookings += 1;
    }
  }
  const at = new Date(now).getTime();
  return [...byPhone.values()]
    .filter((c) => c.lastEventDate < cutoff)
    .map((c) => ({ ...c, monthsSince: Math.floor((at - c.lastEventDate.getTime()) / MONTH_MS) }))
    .sort((a, b) => a.lastEventDate - b.lastEventDate);
};

/// The cutoff [months] before [now] (at least 1 month, at most 60).
export const reEngagementCutoff = (months, now = new Date()) => {
  const m = Math.max(1, Math.min(60, Number(months) || 6));
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - m);
  return { months: m, cutoff };
};
