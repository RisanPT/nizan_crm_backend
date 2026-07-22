/**
 * One-off backfill: links existing bookings to the leads that produced them.
 *
 * The live linking in bookingController only runs when a NEW booking is
 * created, so leads and bookings that already existed were never connected.
 * That makes converted counts read 0 and revenue unattributable.
 *
 * Matching is on the last 10 digits of the phone number, exactly as the live
 * linking does, so results are consistent.
 *
 * Usage:
 *   node scripts/backfillLeadBookings.js            # dry run, changes nothing
 *   node scripts/backfillLeadBookings.js --apply    # write the changes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import Booking from '../models/Booking.js';

const APPLY = process.argv.includes('--apply');

const phoneKey = (value = '') => {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  const bookings = await Booking.find(
    {},
    'phone bookingDate address pincode regionId districtId region district createdAt'
  ).lean();
  const leads = await Lead.find({});

  // Earliest booking wins for a phone number, so a lead links to the booking
  // it actually produced rather than a later repeat booking.
  const byPhone = new Map();
  for (const b of bookings) {
    const key = phoneKey(b.phone);
    if (key.length < 10) continue;
    const existing = byPhone.get(key);
    const when = b.createdAt ?? b.bookingDate ?? new Date(0);
    if (!existing || when < (existing.createdAt ?? existing.bookingDate ?? new Date(0))) {
      byPhone.set(key, b);
    }
  }

  let matched = 0;
  let alreadyLinked = 0;
  let noMatch = 0;
  const samples = [];

  for (const lead of leads) {
    const key = phoneKey(lead.phone);
    if (key.length < 10) {
      noMatch++;
      continue;
    }
    const booking = byPhone.get(key);
    if (!booking) {
      noMatch++;
      continue;
    }
    if (lead.bookingId && String(lead.bookingId) === String(booking._id)) {
      alreadyLinked++;
      continue;
    }

    matched++;
    if (samples.length < 10) {
      samples.push(
        `  ${lead.name} (${lead.phone}) → booking ${booking._id} [${lead.status} → Converted]`
      );
    }

    if (APPLY) {
      lead.status = 'Converted';
      lead.bookingId = booking._id;
      lead.bookedDate = lead.bookedDate ?? booking.bookingDate ?? new Date();
      lead.address = booking.address || lead.address;
      lead.pincode = booking.pincode || lead.pincode;
      lead.regionId = booking.regionId || lead.regionId;
      lead.districtId = booking.districtId || lead.districtId;
      lead.region = booking.region || lead.region;
      lead.district = booking.district || lead.district;
      await lead.save();
    }
  }

  console.log('Sample matches:');
  console.log(samples.length ? samples.join('\n') : '  (none)');
  console.log('\n──────── Summary ────────');
  console.log(`Leads examined      : ${leads.length}`);
  console.log(`Bookings examined   : ${bookings.length}`);
  console.log(`Would link / linked : ${matched}`);
  console.log(`Already linked      : ${alreadyLinked}`);
  console.log(`No matching booking : ${noMatch}`);
  console.log(
    APPLY
      ? '\nChanges written.'
      : '\nDRY RUN — nothing changed. Re-run with --apply to write.'
  );

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Backfill failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
