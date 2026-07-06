/**
 * fixCollectedAmountMigration.js
 *
 * One-time migration script to:
 *   1. Populate Booking.collectedAmount from existing verified Collection records
 *   2. Identify "ghost PAID" bookings where advanceAmount >= totalPrice but
 *      no verified Collection exists — logs them for manual review
 *
 * Usage:
 *   DRY_RUN=true  node --env-file=.env scripts/fixCollectedAmountMigration.js
 *   DRY_RUN=false node --env-file=.env scripts/fixCollectedAmountMigration.js
 *
 * The script is safe to run multiple times — it only sets collectedAmount
 * to the sum of verified collections (idempotent).
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = (process.env.DRY_RUN ?? 'true').trim().toLowerCase() !== 'false';

// ─── Inline minimal schemas (avoids importing app models with side effects) ───
const collectionSchema = new mongoose.Schema({
  bookingId: mongoose.Schema.Types.ObjectId,
  amount: Number,
  status: String,
});
const bookingSchema = new mongoose.Schema({
  bookingNumber: String,
  customerName: String,
  totalPrice: Number,
  advanceAmount: Number,
  collectedAmount: { type: Number, default: 0 },
  serviceStart: Date,
});
const Collection = mongoose.model('Collection', collectionSchema);
const Booking = mongoose.model('Booking', bookingSchema);
// ──────────────────────────────────────────────────────────────────────────────

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log(`\n✅ Connected to MongoDB`);
  console.log(`🔍 DRY_RUN = ${DRY_RUN} (${DRY_RUN ? 'no writes' : 'WILL WRITE'})\n`);

  // ── Step 1: Build map of bookingId → sum of verified collections ────────────
  const verifiedCollections = await Collection.find({ status: 'verified' })
    .select('bookingId amount')
    .lean();

  const collectedByBooking = new Map();
  for (const col of verifiedCollections) {
    const key = String(col.bookingId);
    collectedByBooking.set(key, (collectedByBooking.get(key) || 0) + (Number(col.amount) || 0));
  }

  console.log(`📦 Found ${collectedByBooking.size} bookings with verified collections\n`);

  // ── Step 2: Update all bookings that have collections ───────────────────────
  let updatedCount = 0;
  for (const [bookingId, totalCollected] of collectedByBooking.entries()) {
    const booking = await Booking.findById(bookingId).lean();
    if (!booking) {
      console.warn(`  ⚠️  Booking ${bookingId} not found (orphaned collection?)`);
      continue;
    }

    const currentCollected = Number(booking.collectedAmount) || 0;
    if (currentCollected === totalCollected) {
      // Already correct — skip
      continue;
    }

    console.log(
      `  📝 Booking #${booking.bookingNumber || bookingId} | ${booking.customerName}` +
      ` | collectedAmount: ${currentCollected} → ${totalCollected}`
    );

    if (!DRY_RUN) {
      await Booking.findByIdAndUpdate(bookingId, { collectedAmount: totalCollected });
    }
    updatedCount++;
  }

  console.log(`\n✅ ${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${updatedCount} booking(s) with collectedAmount\n`);

  // ── Step 3: Audit "ghost PAID" bookings ─────────────────────────────────────
  // These are bookings where advanceAmount >= totalPrice but no verified
  // collection exists. They show as PAID in the Flutter app incorrectly.
  console.log('🔍 Scanning for suspicious "ghost PAID" bookings...\n');

  const suspiciousBookings = await Booking.find({
    $expr: { $gte: ['$advanceAmount', '$totalPrice'] },
  })
    .select('bookingNumber customerName totalPrice advanceAmount serviceStart')
    .lean();

  let ghostCount = 0;
  for (const booking of suspiciousBookings) {
    const totalCollected = collectedByBooking.get(String(booking._id)) || 0;
    const isActuallyPaid =
      totalCollected + (Number(booking.advanceAmount) || 0) >= (Number(booking.totalPrice) || 0);

    if (!totalCollected) {
      // advanceAmount = totalPrice but NO verified collections — this is a ghost
      ghostCount++;
      console.log(
        `  🚨 GHOST PAID | #${booking.bookingNumber} | ${booking.customerName}` +
        ` | total=${booking.totalPrice} advance=${booking.advanceAmount}` +
        ` | serviceStart=${booking.serviceStart?.toISOString?.() ?? 'N/A'}`
      );
    }
  }

  if (ghostCount === 0) {
    console.log('  ✅ No ghost PAID bookings found!\n');
  } else {
    console.log(
      `\n  ⚠️  Found ${ghostCount} ghost PAID booking(s). These need manual review.\n` +
      `     They have advanceAmount >= totalPrice but NO verified artist collections.\n` +
      `     Possible cause: legacy import scripts that set advanceAmount = totalPrice.\n` +
      `     To fix: manually correct advanceAmount in the database for these bookings.\n`
    );
  }

  await mongoose.disconnect();
  console.log('✅ Done. Disconnected from MongoDB.\n');
};

run().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
