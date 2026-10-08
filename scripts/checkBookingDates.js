/**
 * READ-ONLY audit of booking dates (Sales & Invoices "Event Date" vs
 * "Booking Date" filters). Writes NOTHING: it uses the raw driver (no
 * Mongoose models, so no index builds) and only runs find() reads.
 *
 * Reports:
 *  1. Days with an unusual pile-up of createdAt ("booked on") — import days.
 *  2. Imported bookings whose remarks hold "Sale date: …" but whose createdAt
 *     is a different day (the booked date the Booking Date filter uses).
 *  3. Bookings whose serviceStart day ≠ bookingDate day (Event Date column vs
 *     Event Date filter), and whose first selectedDate ≠ bookingDate.
 *  4. FY 2026-27 quarter counts by both bases, to compare with the screen.
 *
 * Usage:  node scripts/checkBookingDates.js
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const IST_MS = 330 * 60 * 1000;
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10) : null);
const utcDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/// "Sale date: 2026-03-12" | "Sale date: 12/03/2026" | "12-03-2026" → YYYY-MM-DD.
const saleDateOf = (remarks) => {
  const m = String(remarks ?? '').match(/Sale date:\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4})/i);
  if (!m) return null;
  const parts = m[1].split(/[-/.]/).map(Number);
  let y, mo, d;
  if (parts[0] > 999) [y, mo, d] = parts;
  else [d, mo, y] = parts;
  if (y < 100) y += 2000;
  if (!y || !mo || !d || mo > 12 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};

const quarterOf = (day) => {
  const m = Number(day.slice(5, 7));
  return m >= 4 && m <= 6 ? 'Q1' : m >= 7 && m <= 9 ? 'Q2' : m >= 10 && m <= 12 ? 'Q3' : 'Q4';
};
const inFY2627 = (day) => day >= '2026-04-01' && day <= '2027-03-31';

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  console.log('Connected (read-only audit — no writes).\n');

  const bookings = await mongoose.connection.db
    .collection('bookings')
    .find({}, {
      projection: {
        bookingNumber: 1, customerName: 1, createdAt: 1, bookingDate: 1, serviceStart: 1,
        selectedDates: 1, internalRemarks: 1, legacyBooking: 1, status: 1,
      },
    })
    .toArray();
  console.log(`Bookings: ${bookings.length} (legacyBooking=true: ${bookings.filter((b) => b.legacyBooking).length})\n`);

  // 1. createdAt pile-ups.
  const perDay = new Map();
  for (const b of bookings) {
    const d = istDay(b.createdAt);
    if (d) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const days = [...perDay.entries()].sort((a, b) => b[1] - a[1]);
  const median = [...perDay.values()].sort((a, b) => a - b)[Math.floor(perDay.size / 2)] ?? 0;
  console.log(`1. Busiest "booked on" (createdAt) days — typical day has ~${median}:`);
  for (const [d, n] of days.slice(0, 10)) console.log(`   ${d}  ${String(n).padStart(5)} bookings`);

  // 2. Sale date in remarks vs createdAt.
  const withSale = bookings.map((b) => ({ b, sale: saleDateOf(b.internalRemarks) })).filter((x) => x.sale);
  const wrong = withSale.filter((x) => x.sale !== istDay(x.b.createdAt));
  console.log(`\n2. Bookings with "Sale date:" in remarks: ${withSale.length}`);
  console.log(`   …whose booked date (createdAt) is NOT that sale date: ${wrong.length}`);
  for (const { b, sale } of wrong.slice(0, 8)) {
    console.log(`   #${b.bookingNumber ?? '—'} ${String(b.customerName ?? '').slice(0, 24).padEnd(24)} sale ${sale} · booked-on ${istDay(b.createdAt)} · event ${utcDay(b.bookingDate)}`);
  }

  // 3. Event date consistency.
  const startMismatch = bookings.filter((b) => b.serviceStart && b.bookingDate && istDay(b.serviceStart) !== utcDay(b.bookingDate));
  const selMismatch = bookings.filter(
    (b) => Array.isArray(b.selectedDates) && b.selectedDates.length && b.bookingDate &&
      String(b.selectedDates[0]).slice(0, 10) !== utcDay(b.bookingDate)
  );
  console.log(`\n3. serviceStart day ≠ bookingDate (Event Date column vs filter): ${startMismatch.length}`);
  for (const b of startMismatch.slice(0, 5)) {
    console.log(`   #${b.bookingNumber ?? '—'} bookingDate ${utcDay(b.bookingDate)} · serviceStart ${istDay(b.serviceStart)}`);
  }
  console.log(`   first selectedDate ≠ bookingDate (app vs server event date): ${selMismatch.length}`);

  // 4. FY 2026-27 quarters by each basis (all statuses).
  const q = (dayOf) => {
    const out = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
    for (const b of bookings) {
      const d = dayOf(b);
      if (d && inFY2627(d)) out[quarterOf(d)] += 1;
    }
    return out;
  };
  console.log('\n4. FY 2026-27 bookings per quarter:');
  console.log('   by Event Date  ', q((b) => utcDay(b.bookingDate)));
  console.log('   by Booking Date', q((b) => istDay(b.createdAt)));
  console.log('   by Sale date in remarks, else booked-on', q((b) => saleDateOf(b.internalRemarks) ?? istDay(b.createdAt)));

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
