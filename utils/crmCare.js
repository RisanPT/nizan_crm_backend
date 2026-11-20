// The CRM's care of a booking around its work days (models/CrmBookingCare.js): which days a booking is worked on, the "verified with the
// client" and "photos collected" ticks, the client's medical conditions, and who may read them. Pure — tests/crmCare.test.js.

import { istDayKey } from './istDate.js';
import { MEDICAL_CONDITIONS } from '../models/CrmBookingCare.js';

const lc = (v) => String(v ?? '').trim().toLowerCase();
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/// Bookings that are not work: cancelled, rejected, lost, a draft — or a request nobody has confirmed yet.
const NOT_WORK = new Set(['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending']);
export const isWork = (booking) => !NOT_WORK.has(lc(booking?.status));

/// The IST days a booking is worked on: its dates when it has them (from the booking or its package items), else its first day.
export const eventDaysOf = (booking) => {
  const raw = [...(booking?.selectedDates ?? []), ...(booking?.bookingItems ?? []).flatMap((i) => i?.selectedDates ?? [])];
  const days = [...new Set(raw.map((d) => String(d).slice(0, 10)).filter((d) => DAY_RE.test(d)))].sort();
  if (days.length) return days;
  const first = booking?.serviceStart ?? booking?.bookingDate;
  const t = first ? new Date(first).getTime() : NaN;
  return Number.isFinite(t) ? [istDayKey(new Date(t))] : [];
};

/// The works in [from, to] (IST days, inclusive): one { booking, day } per booking and day, the earliest first.
export const worksBetween = (bookings, from, to) => {
  const out = [];
  for (const b of bookings) {
    if (!isWork(b)) continue;
    for (const day of eventDaysOf(b)) if (day >= from && day <= to) out.push({ booking: b, day });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || String(a.booking.customerName ?? '').localeCompare(String(b.booking.customerName ?? '')));
};

/// Is [day] ticked in [marks] (a verifications / photos list)?
export const hasMark = (marks, day) => (marks ?? []).some((m) => m?.day === day);

/**
 * The list after ticking ([done] true) or unticking [day]. Ticking a day already ticked keeps the first tick (who did it first stays).
 * → { marks, changed }
 */
export const setMark = (marks, day, done, { user = null, note = '', now = new Date() } = {}) => {
  const list = [...(marks ?? [])];
  const i = list.findIndex((m) => m?.day === day);
  if (done) {
    if (i >= 0) return { marks: list, changed: false };
    list.push({ day, at: now, by: user?._id ?? null, byName: user?.name ?? '', note: String(note ?? '').trim().slice(0, 500) });
    return { marks: list.sort((a, b) => a.day.localeCompare(b.day)), changed: true };
  }
  if (i < 0) return { marks: list, changed: false };
  list.splice(i, 1);
  return { marks: list, changed: true };
};

/// Is [day] one of the booking's work days? (A tick can only be for a day the booking is worked.)
export const isWorkDay = (booking, day) => DAY_RE.test(String(day ?? '')) && eventDaysOf(booking).includes(day);

/**
 * The medical details as sent: conditions from the list, a note. → { conditions, note } or { error }.
 * "Other" needs a note (otherwise nobody knows what it is).
 */
export const cleanMedical = (input = {}) => {
  const asked = Array.isArray(input.conditions) ? input.conditions.map(lc).filter(Boolean) : [];
  const bad = asked.filter((c) => !MEDICAL_CONDITIONS.includes(c));
  if (bad.length) return { error: `Unknown condition: ${bad.join(', ')}. Use ${MEDICAL_CONDITIONS.join(', ')}.` };
  const conditions = MEDICAL_CONDITIONS.filter((c) => asked.includes(c));
  const note = String(input.note ?? '').trim().slice(0, 1000);
  if (conditions.includes('other') && note.length < 3) return { error: 'Say what the other condition is in the note.' };
  return { conditions, note };
};

export const MEDICAL_LABEL = { allergy: 'Allergy', skin: 'Skin condition', pregnancy: 'Pregnancy', other: 'Other' };

/// Is [employeeId] on [booking]'s team (on the booking or on any of its package items)?
export const isOnBookingTeam = (booking, employeeId) => {
  const id = idOf(employeeId);
  if (!id) return false;
  const on = (list) => (list ?? []).some((s) => idOf(s?.employeeId) === id);
  return on(booking?.assignedStaff) || (booking?.bookingItems ?? []).some((i) => on(i?.assignedStaff));
};

/**
 * May this user READ a booking's care (and so the client's medical notes)? The CRM team, management and leadership (crmViewer not
 * 'none'), and the people working it — an artist sees the client's conditions before the work. Nobody else (sales, accounts …).
 */
export const mayReadCare = ({ viewer, employeeId, booking }) => (viewer && viewer !== 'none') || isOnBookingTeam(booking, employeeId);
