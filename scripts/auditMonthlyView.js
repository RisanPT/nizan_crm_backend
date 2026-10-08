/**
 * READ-ONLY audit of Sales & Invoices → Monthly View for one financial year.
 * Rebuilds the table exactly as the app does (sales_monthly_summary.dart) by
 * Booking Date and by Event Date, and again with imported bookings moved to
 * the real sale date stored in their remarks. Writes NOTHING (raw driver
 * find() reads only, no Mongoose models / index builds).
 *
 * Usage:  node scripts/auditMonthlyView.js 2026-27
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const fy = /^\d{4}-\d{2}$/.test(process.argv[2] ?? '') ? process.argv[2] : '2026-27';
const startYear = Number(fy.slice(0, 4));
const IST_MS = 330 * 60 * 1000;
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10) : '');
const inr = (n) => Math.round(n).toLocaleString('en-IN');
const MONTHS = Array.from({ length: 12 }, (_, i) => {
  const m = ((3 + i) % 12) + 1;
  const y = m >= 4 ? startYear : startYear + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
});
const LABEL = (k) =>
  `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;

/// Same as the app: event = first selected date, else bookingDate.
const eventDay = (b) =>
  Array.isArray(b.selectedDates) && b.selectedDates.length ? String(b.selectedDates[0]).slice(0, 10) : istDay(b.bookingDate);
const bookedDay = (b) => istDay(b.createdAt ?? b.bookingDate);

/// "Sale date: 2026-03-12" | "12/03/2026" → YYYY-MM-DD.
const saleDay = (b) => {
  const m = String(b.internalRemarks ?? '').match(/Sale date:\s*([0-9]{1,4}[-/.][0-9]{1,2}[-/.][0-9]{1,4})/i);
  if (!m) return null;
  const p = m[1].split(/[-/.]/).map(Number);
  let [y, mo, d] = p[0] > 999 ? p : [p[2], p[1], p[0]];
  if (y < 100) y += 2000;
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  const [bookings, excludedUsers] = await Promise.all([
    db.collection('bookings').find({}, {
      projection: {
        createdAt: 1, bookingDate: 1, selectedDates: 1, status: 1, totalPrice: 1, discountAmount: 1,
        advanceAmount: 1, createdBy: 1, internalRemarks: 1, bookingItems: 1,
      },
    }).toArray(),
    db.collection('users').find({ countInSalesTotals: false }, { projection: { _id: 1 } }).toArray(),
  ]);
  const excluded = new Set(excludedUsers.map((u) => String(u._id)));
  const counts = (b) => !excluded.has(String(b.createdBy ?? ''));
  const importDays = new Set(['2026-04-13', '2026-04-16']);
  const isImport = (b) => importDays.has(istDay(b.createdAt));

  /// The app's monthly table for a given "which day" function.
  const table = (dayOf) => {
    const rows = new Map(MONTHS.map((k) => [k, { bookings: 0, packages: 0, sales: 0, advance: 0, forecast: 0, completed: 0, cancelled: 0, imported: 0, unknown: 0 }]));
    for (const b of bookings) {
      const d = dayOf(b);
      if (d === undefined) continue;
      const r = rows.get(d?.slice(0, 7));
      if (!r) continue;
      const s = String(b.status ?? '').toLowerCase();
      r.bookings += 1;
      r.packages += Array.isArray(b.bookingItems) && b.bookingItems.length ? b.bookingItems.length : 1;
      if (s !== 'cancelled' && s !== 'postponed') {
        if (counts(b)) r.sales += Number(b.totalPrice) || 0;
        r.advance += Number(b.advanceAmount) || 0;
        if (s !== 'completed' && counts(b)) {
          r.forecast += Math.max(0, (Number(b.totalPrice) || 0) - (Number(b.advanceAmount) || 0) - (Number(b.discountAmount) || 0));
        }
      }
      if (s === 'completed') r.completed += 1;
      else if (s === 'cancelled') r.cancelled += 1;
      if (isImport(b)) r.imported += 1;
    }
    return rows;
  };

  const print = (title, rows) => {
    console.log(`\n=== ${title} ===`);
    console.log('Month      Bookings  Pkgs  Gross sales     Advance   Forecast  Done  Canc  (imported)');
    let t = { bookings: 0, sales: 0 };
    for (const [k, r] of rows) {
      t.bookings += r.bookings;
      t.sales += r.sales;
      console.log(
        `${LABEL(k).padEnd(9)} ${String(r.bookings).padStart(8)} ${String(r.packages).padStart(5)} ${inr(r.sales).padStart(12)} ${inr(r.advance).padStart(11)} ${inr(r.forecast).padStart(10)} ${String(r.completed).padStart(5)} ${String(r.cancelled).padStart(5)}  ${r.imported ? `(${r.imported})` : ''}`
      );
    }
    console.log(`FY total  ${String(t.bookings).padStart(8)}       ${inr(t.sales).padStart(12)}`);
  };

  const byBooked = table(bookedDay);
  const byEvent = table(eventDay);
  // Imported bookings moved to their real sale date; any import without one
  // is left out (undefined) and counted separately.
  const noSale = bookings.filter((b) => isImport(b) && !saleDay(b));
  const byReal = table((b) => (isImport(b) ? saleDay(b) ?? undefined : bookedDay(b)));

  print(`FY ${fy} by BOOKING DATE — as the screen shows now`, byBooked);
  print(`FY ${fy} by BOOKING DATE — imports moved to their real sale date`, byReal);
  print(`FY ${fy} by EVENT DATE — as the screen shows`, byEvent);

  // Where the imports really belong.
  const bySaleMonth = {};
  for (const b of bookings.filter(isImport)) {
    const k = saleDay(b)?.slice(0, 7) ?? '(no sale date)';
    bySaleMonth[k] = (bySaleMonth[k] ?? 0) + 1;
  }
  console.log(`\nImported bookings (created 13/16 Apr 2026): ${bookings.filter(isImport).length}`);
  console.log('Real sale month of those imports:', Object.fromEntries(Object.entries(bySaleMonth).sort()));
  console.log(`Imports with no sale date in remarks: ${noSale.length}`);
  const nsStatus = {};
  for (const b of noSale) nsStatus[String(b.status ?? '').toLowerCase()] = (nsStatus[String(b.status ?? '').toLowerCase()] ?? 0) + 1;
  if (noSale.length) console.log('   their statuses:', nsStatus, '· event months:', [...new Set(noSale.map((b) => eventDay(b).slice(0, 7)))].sort().join(', '));

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
