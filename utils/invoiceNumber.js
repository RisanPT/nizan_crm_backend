import Booking from '../models/Booking.js';
import Counter from '../models/Counter.js';

// Tax invoice numbers: "TN/26-27/0001" — prefix / Indian financial year
// (April–March, IST) / running number that restarts each financial year.
// GST wants these sequential, unique per FY and at most 16 characters.
const PREFIX = 'TN';
const IST_OFFSET_MS = 330 * 60 * 1000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

export const financialYearKey = (date = new Date()) => {
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  const start = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  const yy = (y) => String(y % 100).padStart(2, '0');
  return `${yy(start)}-${yy(start + 1)}`;
};

// Money actually received: verified collections + an advance that is not
// waiting on (or refused by) Accounts. Legacy advances ('' status) count.
const isFullyPaid = (b) => {
  const status = String(b.status || '').toLowerCase();
  if (status !== 'confirmed' && status !== 'completed') return false;
  const net = round2((b.totalPrice || 0) - (b.discountAmount || 0));
  if (net <= 0) return false;
  const advanceCounts = !['pending', 'rejected'].includes(b.advanceStatus || '');
  const received = round2((advanceCounts ? b.advanceAmount || 0 : 0) + (b.collectedAmount || 0));
  return received >= net;
};

/**
 * Issues the booking's invoice number if it has just become fully paid.
 * Idempotent — returns the existing number when one is already issued, and
 * null while the booking is still owing. Call after any write that can change
 * price, discount, advance (or its verification) or collected amount.
 * Never throws: a failure here must not fail the payment that triggered it.
 */
export const ensureInvoiceNumber = async (bookingId) => {
  if (!bookingId) return null;
  try {
    const b = await Booking.findById(bookingId)
      .select('status totalPrice discountAmount advanceAmount advanceStatus collectedAmount invoiceNumber')
      .lean();
    if (!b) return null;
    if (b.invoiceNumber) return b.invoiceNumber;
    if (!isFullyPaid(b)) return null;

    // Claim the booking first so two concurrent payments can't both draw a
    // number from the counter (which would leave a gap in the sequence).
    const claim = await Booking.updateOne(
      { _id: b._id, invoiceNumber: { $exists: false } },
      { $set: { invoiceNumber: `CLAIM-${b._id}` } }
    );
    if (!claim.modifiedCount) return null;

    try {
      const now = new Date();
      const fy = financialYearKey(now);
      const counter = await Counter.findOneAndUpdate(
        { _id: `invoice:${fy}` },
        { $inc: { seq: 1 } },
        { upsert: true, new: true }
      );
      const invoiceNumber = `${PREFIX}/${fy}/${String(counter.seq).padStart(4, '0')}`;
      await Booking.updateOne(
        { _id: b._id },
        { $set: { invoiceNumber, invoiceDate: now } }
      );
      return invoiceNumber;
    } catch (err) {
      await Booking.updateOne({ _id: b._id }, { $unset: { invoiceNumber: '' } });
      throw err;
    }
  } catch (err) {
    console.error('ensureInvoiceNumber failed:', err.message);
    return null;
  }
};
