// READ-ONLY. Discovers what culture/ceremony signals already exist in the
// booking data so we can decide how to backfill Booking.culture. Writes nothing.
//
//   cd backend && node scripts/discover-culture-signals.js
//
// It prints the most common package/service names, event slots and add-on names
// (booking-level + per-item), plus how many bookings already carry `culture`.
import 'dotenv/config';
import mongoose from 'mongoose';
import connectDB from '../config/db.js';
import Booking from '../models/Booking.js';

// Words that hint at a community/ceremony. Tweak freely — this is only used to
// FLAG likely-cultural values in the output, not to write anything.
const HINTS = {
  Hindu: /hindu|muhurt|kalyan|mangal|saptapadi|pooja|tamil|brahmin|nair|ezhava|thali/i,
  Muslim: /muslim|nikah|nikkah|walima|mappila|islam|mehendi|henna/i,
  Christian: /christ|church|white wedding|nasrani|marthoma|catholic|syrian|jacobite/i,
};
const hintFor = (s) => {
  for (const [k, re] of Object.entries(HINTS)) if (re.test(s)) return k;
  return '';
};

const tally = (map, raw) => {
  const v = String(raw ?? '').trim();
  if (!v) return;
  map.set(v, (map.get(v) || 0) + 1);
};
const top = (map, n = 40) =>
  [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

const print = (title, map) => {
  console.log(`\n=== ${title} (${map.size} distinct) ===`);
  for (const [val, count] of top(map)) {
    const hint = hintFor(val);
    console.log(`  ${String(count).padStart(5)}  ${val}${hint ? `   → likely ${hint}` : ''}`);
  }
};

const run = async () => {
  await connectDB();
  const bookings = await Booking.find({})
    .select('service eventSlot culture addons bookingItems.service bookingItems.eventSlot bookingItems.addons')
    .lean();

  const services = new Map();
  const slots = new Map();
  const addons = new Map();
  let withCulture = 0;

  for (const b of bookings) {
    if (String(b.culture ?? '').trim()) withCulture += 1;
    tally(services, b.service);
    tally(slots, b.eventSlot);
    for (const a of b.addons || []) tally(addons, a.service);
    for (const it of b.bookingItems || []) {
      tally(services, it.service);
      tally(slots, it.eventSlot);
      for (const a of it.addons || []) tally(addons, a.service);
    }
  }

  console.log(`\nTotal bookings: ${bookings.length}`);
  console.log(`Already have culture set: ${withCulture}`);
  print('PACKAGE / SERVICE names', services);
  print('EVENT SLOTS', slots);
  print('ADD-ON names', addons);

  // How many bookings would a keyword match tag, using the hint patterns above?
  let matchable = 0;
  for (const b of bookings) {
    const blob = [
      b.service, b.eventSlot,
      ...(b.addons || []).map((a) => a.service),
      ...(b.bookingItems || []).flatMap((it) => [it.service, it.eventSlot,
        ...((it.addons || []).map((a) => a.service))]),
    ].join(' ');
    if (hintFor(blob)) matchable += 1;
  }
  console.log(`\nBookings a keyword rule COULD auto-tag right now: ${matchable} / ${bookings.length}`);

  await mongoose.disconnect();
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
