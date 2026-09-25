/**
 * One-off fix: separate "booked on" from "event date" on converted leads.
 *
 * Older conversions stored the booking's EVENT date in lead.bookedDate, so lead
 * cards showed the event date twice. For every lead linked to a booking this
 * sets:
 *   bookedDate = booking.createdAt                      (when it was booked)
 *   eventDate  = booking.serviceStart ?? bookingDate    (when the event is)
 *
 * Usage:
 *   node scripts/resyncLeadBookingDates.js            # dry run, changes nothing
 *   node scripts/resyncLeadBookingDates.js --apply    # write the changes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import Booking from '../models/Booking.js';

const APPLY = process.argv.includes('--apply');
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '—');
const same = (a, b) =>
  (a == null && b == null) ||
  (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  const leads = await Lead.find({ bookingId: { $ne: null } })
    .select('name phone bookingId bookedDate eventDate')
    .lean();
  const bookings = await Booking.find({ _id: { $in: leads.map((l) => l.bookingId) } })
    .select('createdAt serviceStart bookingDate')
    .lean();
  const byId = new Map(bookings.map((b) => [String(b._id), b]));

  let changed = 0;
  let unchanged = 0;
  let missing = 0;
  const samples = [];
  const ops = [];

  for (const lead of leads) {
    const b = byId.get(String(lead.bookingId));
    if (!b) {
      missing++;
      continue;
    }
    const bookedDate = b.createdAt ?? null;
    const eventDate = b.serviceStart ?? b.bookingDate ?? null;
    if (same(lead.bookedDate, bookedDate) && same(lead.eventDate, eventDate)) {
      unchanged++;
      continue;
    }
    changed++;
    if (samples.length < 15) {
      samples.push(
        `  ${lead.name} (${lead.phone}): booked ${day(lead.bookedDate)} → ${day(bookedDate)}, ` +
          `event ${day(lead.eventDate)} → ${day(eventDate)}`
      );
    }
    ops.push({
      updateOne: {
        filter: { _id: lead._id },
        update: { $set: { bookedDate, eventDate } },
      },
    });
  }

  if (APPLY && ops.length) await Lead.bulkWrite(ops, { ordered: false });

  console.log('Sample changes:');
  console.log(samples.length ? samples.join('\n') : '  (none)');
  console.log('\n──────── Summary ────────');
  console.log(`Linked leads examined : ${leads.length}`);
  console.log(`Would update / updated: ${changed}`);
  console.log(`Already correct       : ${unchanged}`);
  console.log(`Booking not found     : ${missing}`);
  console.log(APPLY ? '\nChanges written.' : '\nDRY RUN — nothing changed. Re-run with --apply to write.');
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Resync failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
