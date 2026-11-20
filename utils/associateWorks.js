// THE ASSOCIATE WORKS REPORT — which works each associate artist did, and what they were paid for them.
//
// An associate is an outside artist (Employee.isAssociate: outsource, no login, no payroll) that Operations puts on a work while assigning
// its team. Nothing is typed twice: the WORKS come from the bookings' own team assignments, the MONEY from the Artist Payouts Accounts
// already records. This file only joins them. Pure — no database (tests/associateWorks.test.js).
//
//  • A WORK is a booking the associate is assigned to — on the booking itself, or on any of its package items. A booking counts ONCE in a
//    period, on its first day (`serviceStart`), exactly like the dashboards, Work Profit and the fleet. Cancelled / rejected / lost
//    bookings are not works. A multi-day booking is one work with `days` = how many of its days the associate is on.
//  • DAYS: on a booking-level assignment the associate is on every day of the booking; on an item-level one, only that item's dates (an item
//    with no dates inherits the booking's).
//  • FEE: what Accounts recorded as an Artist Payout for that associate on that booking, cancelled ones left out. PAID = payouts marked
//    paid; OWED = approved or pending ones (money promised, not yet paid). payout = 'paid' (fee, nothing owed), 'owed' (something unpaid),
//    'none' (no fee recorded yet — the report says so; it never guesses a fee).
//  • Money is added in paise so the parts always add back to the whole. Someone who may not see money gets works only (fee/paid/owed null).

import { toPaise, toRupees } from './expenseAllocation.js';
import { istDayKey } from './istDate.js';

export const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'rejected', 'lost']);
export const PAYOUT_FILTERS = ['paid', 'owed', 'none'];

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const dayOf = (d) => {
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? istDayKey(new Date(t)) : '';
};
const uniq = (list) => [...new Set(list.filter(Boolean))];

/** The days of a booking: its dates when it has them, else its first day. */
const bookingDays = (b) => {
  const dates = (b.selectedDates ?? []).map((d) => String(d).slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  return dates.length ? uniq(dates).sort() : uniq([dayOf(b.serviceStart)]);
};

/**
 * How one person is on one booking, or null when they are not (a driver does not count).
 * @returns {{ roleType: 'lead'|'assistant', role: string, services: string[], days: string[] } | null}
 */
export const assignmentOf = (booking, employeeId) => {
  const want = idOf(employeeId);
  const fromAll = bookingDays(booking);
  const itemServices = (booking.bookingItems ?? []).map((i) => i.service).filter(Boolean);
  const hits = [];
  for (const s of booking.assignedStaff ?? []) {
    if (idOf(s.employeeId) === want && s.roleType !== 'driver') hits.push({ s, services: itemServices.length ? itemServices : [booking.service], days: fromAll });
  }
  for (const item of booking.bookingItems ?? []) {
    for (const s of item.assignedStaff ?? []) {
      if (idOf(s.employeeId) !== want || s.roleType === 'driver') continue;
      const own = (item.selectedDates ?? []).map((d) => String(d).slice(0, 10)).filter(Boolean);
      hits.push({ s, services: [item.service], days: own.length ? own : fromAll });
    }
  }
  if (!hits.length) return null;
  const role = hits.map((h) => String(h.s.role ?? '').trim()).find(Boolean) ?? '';
  return {
    roleType: hits.some((h) => h.s.roleType === 'lead') ? 'lead' : 'assistant',
    role,
    services: uniq(hits.flatMap((h) => h.services).map((x) => String(x ?? '').trim())),
    days: uniq(hits.flatMap((h) => h.days)).sort(),
  };
};

/** A payout's money by (associate, booking): { fee, paid, owed } in paise. */
const payoutIndex = (payouts) => {
  const by = new Map();
  for (const p of payouts) {
    if (p.status === 'cancelled' || !p.bookingId) continue;
    const key = `${idOf(p.employeeId)}|${idOf(p.bookingId)}`;
    const e = by.get(key) ?? { fee: 0, paid: 0, owed: 0 };
    const amount = toPaise(p.amount);
    e.fee += amount;
    if (p.status === 'paid') e.paid += amount;
    else e.owed += amount; // approved or pending
    by.set(key, e);
  }
  return by;
};

/**
 * One row per (associate, booking) — see the rules above.
 * @param {{ bookings: object[], associates: Array<{ id, name, phone? }>, payouts?: object[], canSeeFees?: boolean }} input
 *   `bookings` are the ones whose first day is in the period (the caller's query); dead ones are left out here.
 */
export const workRows = ({ bookings, associates, payouts = [], canSeeFees = true }) => {
  const money = payoutIndex(payouts);
  const rows = [];
  for (const b of bookings) {
    if (DEAD_STATUSES.has(String(b.status ?? '').trim().toLowerCase())) continue;
    for (const a of associates) {
      const asg = assignmentOf(b, a.id);
      if (!asg) continue;
      const m = money.get(`${idOf(a.id)}|${idOf(b)}`) ?? { fee: 0, paid: 0, owed: 0 };
      rows.push({
        associateId: idOf(a.id),
        associateName: a.name ?? '',
        phone: a.phone ?? '',
        bookingId: idOf(b),
        bookingNumber: b.bookingNumber ?? '',
        customerName: b.customerName ?? '',
        services: asg.services.length ? asg.services : [String(b.service ?? '')].filter(Boolean),
        role: asg.role,
        roleType: asg.roleType,
        firstDay: dayOf(b.serviceStart),
        days: asg.days.length,
        place: [b.district, b.region].map((x) => String(x ?? '').trim()).filter(Boolean).join(', '),
        status: String(b.status ?? ''),
        fee: canSeeFees ? toRupees(m.fee) : null,
        paid: canSeeFees ? toRupees(m.paid) : null,
        owed: canSeeFees ? toRupees(m.owed) : null,
        payout: canSeeFees ? (m.fee === 0 ? 'none' : m.owed === 0 ? 'paid' : 'owed') : null,
      });
    }
  }
  return rows;
};

/** The rows the search words match (client, booking number, associate, service). */
export const searchRows = (rows, q) => {
  const words = String(q ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return rows;
  return rows.filter((r) => {
    const hay = `${r.customerName} ${r.bookingNumber} ${r.associateName} ${r.services.join(' ')} ${r.place}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
};

/** The table's own cuts: one associate, and one payout state (ignored when the viewer may not see money). */
export const filterRows = (rows, { associateId = '', payout = '' } = {}) =>
  rows.filter((r) => (!associateId || r.associateId === associateId) && (!payout || r.payout === null || r.payout === payout));

/** Latest work first, then the associate's name. */
export const sortRows = (rows) =>
  [...rows].sort((a, b) => (a.firstDay < b.firstDay ? 1 : a.firstDay > b.firstDay ? -1 : a.associateName.localeCompare(b.associateName) || a.bookingNumber.localeCompare(b.bookingNumber)));

const sum = (rows, key) => toRupees(rows.reduce((s, r) => s + toPaise(r[key] ?? 0), 0));

/** The headline numbers of a set of rows. Money is null when the viewer may not see it. */
export const summarize = (rows) => {
  const money = rows.length === 0 || rows[0].fee !== null;
  return {
    associates: new Set(rows.map((r) => r.associateId)).size,
    works: rows.length,
    days: rows.reduce((s, r) => s + r.days, 0),
    fee: money ? sum(rows, 'fee') : null,
    paid: money ? sum(rows, 'paid') : null,
    owed: money ? sum(rows, 'owed') : null,
    noFee: money ? rows.filter((r) => r.payout === 'none').length : null,
  };
};

/** One line per associate: works, days, money and the last work day. Most works first, then by name. */
export const byAssociate = (rows) => {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.associateId)) by.set(r.associateId, []);
    by.get(r.associateId).push(r);
  }
  return [...by.values()]
    .map((list) => ({
      id: list[0].associateId,
      name: list[0].associateName,
      phone: list[0].phone,
      ...summarize(list),
      lastDay: list.reduce((m, r) => (r.firstDay > m ? r.firstDay : m), ''),
    }))
    .sort((a, b) => b.works - a.works || a.name.localeCompare(b.name));
};

/**
 * Money paid to associates in the period that is NOT on a work the report lists (no booking on it, or a booking outside the period), so
 * Accounts can reconcile: { count, amount }.
 */
export const elsewhere = ({ payouts, rows }) => {
  const listed = new Set(rows.map((r) => `${r.associateId}|${r.bookingId}`));
  const loose = payouts.filter((p) => p.status !== 'cancelled' && !listed.has(`${idOf(p.employeeId)}|${idOf(p.bookingId)}`));
  return { count: loose.length, amount: toRupees(loose.reduce((s, p) => s + toPaise(p.amount), 0)) };
};
