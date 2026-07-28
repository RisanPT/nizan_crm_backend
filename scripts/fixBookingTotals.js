/**
 * One-off fix: removes the ₹3000-per-package charge that was wrongly ADDED to
 * the total price of item-based bookings.
 *
 * The ₹3000 per package is the ADVANCE, not part of the bill. Older bookings
 * were stored with `totalPrice = Σ item.totalPrice + add-ons + (packageCount ×
 * 3000)`, inflating every invoice by ₹3000 per package. New bookings are now
 * computed correctly; this script corrects the ones already in the database.
 *
 * Correct total = Σ item.totalPrice + add-ons. Only bookings whose stored
 * total exceeds that (i.e. still carry the extra charge) are touched, so the
 * script is safe to run more than once.
 *
 * Only item-based bookings (bookingItems present) are affected — single/legacy
 * bookings use a different per-date charge that was left unchanged.
 *
 * Usage:
 *   node scripts/fixBookingTotals.js            # dry run, changes nothing
 *   node scripts/fixBookingTotals.js --apply    # write the corrected totals
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';

const APPLY = process.argv.includes('--apply');

const addonsTotalOf = (addons = []) =>
  (Array.isArray(addons) ? addons : []).reduce(
    (sum, a) =>
      sum + (Number(a?.amount) || 0) * Math.max(1, Number(a?.persons) || 1),
    0
  );

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  const bookings = await Booking.find({
    bookingItems: { $exists: true, $not: { $size: 0 } },
  });

  let corrected = 0;
  let alreadyCorrect = 0;
  let totalRemoved = 0;
  const samples = [];

  for (const b of bookings) {
    const items = Array.isArray(b.bookingItems) ? b.bookingItems : [];
    if (items.length === 0) continue;

    const itemsBase = items.reduce(
      (sum, it) => sum + (Number(it?.totalPrice) || 0),
      0
    );
    const correctTotal = itemsBase + addonsTotalOf(b.addons);
    const current = Number(b.totalPrice) || 0;
    const diff = current - correctTotal;

    // Only correct rows that are still inflated (diff ≈ packageCount × 3000).
    // A 1-rupee tolerance avoids touching already-correct or rounded rows.
    if (diff <= 0.5) {
      alreadyCorrect++;
      continue;
    }

    if (samples.length < 15) {
      samples.push(
        `  #${b.bookingNumber || b._id}: ${current.toFixed(0)} -> ${correctTotal.toFixed(0)} (removed ${diff.toFixed(0)}, ${items.length} pkg)`
      );
    }
    corrected++;
    totalRemoved += diff;

    if (APPLY) {
      b.totalPrice = correctTotal;
      await b.save();
    }
  }

  console.log(`Item-based bookings scanned: ${bookings.length}`);
  console.log(`Already correct:            ${alreadyCorrect}`);
  console.log(`${APPLY ? 'Corrected' : 'Would correct'}:            ${corrected}`);
  console.log(`Total ₹ removed from bills:  ${totalRemoved.toFixed(0)}`);
  if (samples.length > 0) {
    console.log('\nSamples:');
    console.log(samples.join('\n'));
  }
  if (!APPLY && corrected > 0) {
    console.log('\nDry run only — re-run with --apply to write these changes.');
  }

  await mongoose.disconnect();
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
