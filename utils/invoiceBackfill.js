// Pure checks for scripts/backfillInvoiceNumbers.js — no database access, so
// the rules can be tested on their own. Mirrors utils/invoiceNumber.js
// (isFullyPaid) but recounts the money from the Collection records instead of
// trusting the stored Booking.collectedAmount.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * @param booking      lean Booking
 * @param collections  this booking's Collection docs (any status)
 * @returns {{ verdict, reason, net, advance, collectedStored, collectedRecount,
 *             received, paidOn }}
 *   verdict: 'eligible' | 'owing' | 'skip' | 'check'
 *     eligible → fully paid, all checks pass → gets a number
 *     owing    → not fully paid → no number
 *     skip     → not an invoice (cancelled, zero value, already numbered)
 *     check    → looks paid but a cross-check failed → held for review, no number
 */
export const classifyForInvoice = (booking, collections = []) => {
  const status = String(booking.status || '').toLowerCase();
  const net = round2((booking.totalPrice || 0) - (booking.discountAmount || 0));
  const advanceStatus = booking.advanceStatus || '';
  const advanceCounts = !['pending', 'rejected'].includes(advanceStatus);
  const advance = advanceCounts ? round2(booking.advanceAmount || 0) : 0;
  const verified = collections.filter((c) => c.status === 'verified');
  const collectedRecount = round2(verified.reduce((s, c) => s + (Number(c.amount) || 0), 0));
  const collectedStored = round2(booking.collectedAmount || 0);
  const received = round2(advance + collectedRecount);

  // When the balance was settled: the last verified payment.
  const times = [];
  if (advanceCounts && booking.advanceAmount > 0) {
    times.push(new Date(booking.advanceVerifiedAt || booking.createdAt || booking.bookingDate));
  }
  for (const c of verified) times.push(new Date(c.verifiedAt || c.date || c.createdAt));
  const valid = times.filter((d) => !Number.isNaN(d.getTime()));
  const paidOn = valid.length ? new Date(Math.max(...valid.map((d) => d.getTime()))) : null;

  const base = { net, advance, collectedStored, collectedRecount, received, paidOn };

  if (booking.invoiceNumber) return { ...base, verdict: 'skip', reason: `already has ${booking.invoiceNumber}` };
  if (status !== 'confirmed' && status !== 'completed') return { ...base, verdict: 'skip', reason: `status ${status || 'blank'}` };
  if (net <= 0) return { ...base, verdict: 'skip', reason: 'zero value' };

  if (collectedRecount !== collectedStored) {
    // Paid on one count but not the other → a human must decide.
    const paidEither = received >= net || round2(advance + collectedStored) >= net;
    return paidEither
      ? { ...base, verdict: 'check', reason: `stored collected ${collectedStored} ≠ verified collections ${collectedRecount}` }
      : { ...base, verdict: 'owing', reason: `owes ${round2(net - Math.max(received, advance + collectedStored))}` };
  }
  if (received < net) {
    const pendingAdv = !advanceCounts && booking.advanceAmount > 0 && round2(received + booking.advanceAmount) >= net;
    return pendingAdv
      ? { ...base, verdict: 'check', reason: `paid only if the ${advanceStatus} advance of ${booking.advanceAmount} counts` }
      : { ...base, verdict: 'owing', reason: `owes ${round2(net - received)}` };
  }
  if (!paidOn) return { ...base, verdict: 'check', reason: 'paid but no payment date found' };
  if (received > net + 1) {
    return { ...base, verdict: 'check', reason: `overpaid by ${round2(received - net)}` };
  }
  return { ...base, verdict: 'eligible', reason: 'fully paid' };
};
