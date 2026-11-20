// WHO DID WHAT TO A BOOKING, AND WHEN — the record the CRM figures are built from. Pure — tests/crmBookingAudit.test.js.
//
// A booking REQUEST is a booking that arrives as `pending` from the public form (a booking staff create is confirmed at once —
// controllers/bookingController.js createBooking). The CRM team decides it: confirm, reject (or postpone, cancel). These helpers
// stamp, on the booking itself:
//   origin               'public' (a request) | 'staff' (made in the app)
//   statusHistory[]      every status change: { status, from, at, by, byName }
//   requestDecision…     the FIRST decision on a request — what it became, when and by whom — and who OWNED it then (the credit)
//
// Nothing here is ever filled in for the past: a booking from before this existed has no history, and the figures say "—" for it.

const lc = (v) => String(v ?? '').trim().toLowerCase();

/// The person behind a change, as stored: the login's id and name (none for the public form).
const actorOf = (user) => ({ by: user?._id ?? null, byName: String(user?.name ?? '').trim() });

/**
 * A booking being created. [user] is the staff login (none for the public form).
 * Returns the fields to create it with: { origin, statusHistory }.
 */
export const creationAudit = ({ status, user, now = new Date() }) => ({
  origin: user ? 'staff' : 'public',
  statusHistory: [{ status: lc(status) || 'pending', from: '', at: now, ...actorOf(user) }],
});

/// Has the request (a booking that started as `pending`) been decided yet?
export const isDecided = (booking) => Boolean(booking?.requestDecidedAt);

/**
 * A booking's status changing from [from] to [to] — called just before it is saved. Records the change in the history and, the first
 * time a pending booking leaves `pending`, the decision. Mutates [booking]; returns true when anything was recorded.
 * The same status again (the app re-sends the whole booking on every save) records nothing.
 */
export const recordStatusChange = (booking, { from, to, user, now = new Date() }) => {
  const prev = lc(from);
  const next = lc(to);
  if (!next || next === prev) return false;
  const actor = actorOf(user);
  if (!Array.isArray(booking.statusHistory)) booking.statusHistory = [];
  booking.statusHistory.push({ status: next, from: prev, at: now, ...actor });
  // the decision on a request — only the first one counts (a later change of mind is in the history, not the decision)
  if (prev === 'pending' && !isDecided(booking)) {
    booking.requestDecision = next;
    booking.requestDecidedAt = now;
    booking.requestDecidedBy = actor.by;
    booking.requestDecidedByName = actor.byName;
    // the credit goes to whoever OWNED the request then; with no owner, to whoever decided it
    booking.decidedOwnerId = booking.crmOwnerId ?? null;
  }
  return true;
};

/// When the request arrived: the first entry of its history, else (a booking from before there was one) when it was created.
export const requestArrivedAt = (booking) => booking?.statusHistory?.[0]?.at ?? booking?.createdAt ?? null;

/// Who gets the credit for deciding a request: its owner at that moment, else whoever decided it.
export const decisionCreditOf = (booking) => booking?.decidedOwnerId ?? booking?.requestDecidedBy ?? null;
