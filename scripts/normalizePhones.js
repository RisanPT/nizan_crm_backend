/**
 * One-off cleanup: strips whitespace from every stored phone number.
 *
 * The schema `set:` normaliser only runs when the phone path is assigned, so
 * records written before it existed still hold values like "70341 09552".
 * This rewrites them in place via bulkWrite.
 *
 * Usage:
 *   node scripts/normalizePhones.js            # dry run, changes nothing
 *   node scripts/normalizePhones.js --apply    # write the changes
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import Booking from '../models/Booking.js';
import Customer from '../models/Customer.js';

const APPLY = process.argv.includes('--apply');

const normalize = (value) => String(value ?? '').replace(/\s+/g, '').trim();

const sweep = async (Model, label) => {
  const docs = await Model.find({}, 'phone').lean();
  const ops = [];
  const samples = [];

  for (const d of docs) {
    const current = d.phone ?? '';
    const cleaned = normalize(current);
    if (cleaned === current) continue;
    if (samples.length < 3) {
      samples.push(`    "${current}" → "${cleaned}"`);
    }
    ops.push({
      updateOne: { filter: { _id: d._id }, update: { $set: { phone: cleaned } } },
    });
  }

  console.log(`${label}: ${ops.length} of ${docs.length} need cleaning`);
  if (samples.length) console.log(samples.join('\n'));
  if (APPLY && ops.length) {
    const res = await Model.bulkWrite(ops);
    console.log(`    updated ${res.modifiedCount}`);
  }
  return ops.length;
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN'}\n`);

  let total = 0;
  total += await sweep(Lead, 'Leads');
  total += await sweep(Booking, 'Bookings');
  total += await sweep(Customer, 'Customers');

  console.log(`\nTotal records ${APPLY ? 'cleaned' : 'to clean'}: ${total}`);
  if (!APPLY) console.log('DRY RUN — nothing changed. Re-run with --apply.');

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Normalisation failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
