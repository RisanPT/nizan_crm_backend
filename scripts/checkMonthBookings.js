/**
 * READ-ONLY month check: bookings CREATED in a month vs bookings whose EVENT
 * is in that month (the two Sales & Invoices date filters). Writes NOTHING —
 * raw driver find() reads only, no Mongoose models / index builds.
 *
 * Usage:  node scripts/checkMonthBookings.js 2026-10
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const month = /^\d{4}-\d{2}$/.test(process.argv[2] ?? '') ? process.argv[2] : '2026-10';
const IST_MS = 330 * 60 * 1000;
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10) : '');
const utcDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const inMonth = (day) => day.slice(0, 7) === month;
const NOT_A_SALE = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/// Event day the way the app shows it: first selected date, else bookingDate (IST).
const eventDay = (b) =>
  Array.isArray(b.selectedDates) && b.selectedDates.length
    ? String(b.selectedDates[0]).slice(0, 10)
    : istDay(b.bookingDate);

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
        bookingNumber: 1, customerName: 1, createdAt: 1, bookingDate: 1, selectedDates: 1,
        status: 1, totalPrice: 1, discountAmount: 1, advanceAmount: 1, createdBy: 1,
        createdByName: 1, internalRemarks: 1, bookingItems: 1, service: 1,
      },
    }).toArray(),
    db.collection('users').find({ countInSalesTotals: false }, { projection: { _id: 1 } }).toArray(),
  ]);
  const excluded = new Set(excludedUsers.map((u) => String(u._id)));
  const counts = (b) => !excluded.has(String(b.createdBy ?? ''));

  const summarize = (label, list) => {
    const byStatus = {};
    let gross = 0;
    let net = 0;
    let advance = 0;
    let packages = 0;
    let notCounted = 0;
    for (const b of list) {
      const s = String(b.status ?? '').toLowerCase() || '(blank)';
      byStatus[s] = (byStatus[s] ?? 0) + 1;
      packages += Array.isArray(b.bookingItems) && b.bookingItems.length ? b.bookingItems.length : 1;
      if (!counts(b)) notCounted += 1;
      if (NOT_A_SALE.includes(s) || !counts(b)) continue;
      gross += Number(b.totalPrice) || 0;
      net += Math.max(0, (Number(b.totalPrice) || 0) - (Number(b.discountAmount) || 0));
      advance += Number(b.advanceAmount) || 0;
    }
    console.log(`\n=== ${label}: ${list.length} bookings · ${packages} packages ===`);
    console.log('   by status:', byStatus);
    console.log(`   sales (excl. pending/cancelled/rejected & non-counting users): gross ${inr(gross)} · net ${inr(net)} · advance ${inr(advance)}`);
    if (notCounted) console.log(`   ${notCounted} entered by users excluded from sales totals`);
  };

  const row = (b) =>
    `   #${String(b.bookingNumber ?? '—').padEnd(11)} ${String(b.customerName ?? '').slice(0, 22).padEnd(22)} ` +
    `booked ${istDay(b.createdAt)}  event ${eventDay(b)}  ${String(b.status ?? '').padEnd(10)} ` +
    `${inr(Number(b.totalPrice) || 0).padStart(10)}  by ${String(b.createdByName || '—').slice(0, 16)}` +
    (/Sale date:/i.test(b.internalRemarks ?? '') ? '  [imported]' : '');

  // A. Created in the month (IST).
  const created = bookings.filter((b) => inMonth(istDay(b.createdAt)))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  summarize(`CREATED in ${month} (Booking Date filter)`, created);
  created.forEach((b) => console.log(row(b)));

  // B. Event in the month (as the app shows the event date).
  const events = bookings.filter((b) => inMonth(eventDay(b)))
    .sort((a, b) => eventDay(a).localeCompare(eventDay(b)));
  summarize(`EVENT in ${month} (Event Date filter)`, events);
  events.forEach((b) => console.log(row(b)));

  // C. Both.
  const both = created.filter((b) => inMonth(eventDay(b)));
  console.log(`\n=== Created AND event in ${month}: ${both.length} ===`);

  // D. Where the server's month filter would disagree. The server builds the
  // month with the machine's local time; show both possible results.
  const [y, m] = month.split('-').map(Number);
  const utcStart = new Date(Date.UTC(y, m - 1, 1));
  const utcEnd = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  const istStart = new Date(utcStart.getTime() - IST_MS);
  const istEnd = new Date(utcEnd.getTime() - IST_MS);
  const between = (d, s, e) => d && new Date(d) >= s && new Date(d) <= e;
  const report = (name, field, truth) => {
    for (const [tz, s, e] of [['UTC server', utcStart, utcEnd], ['IST server', istStart, istEnd]]) {
      const server = new Set(bookings.filter((b) => between(b[field], s, e)).map((b) => String(b._id)));
      const want = new Set(truth.map((b) => String(b._id)));
      const extra = bookings.filter((b) => server.has(String(b._id)) && !want.has(String(b._id)));
      const missing = truth.filter((b) => !server.has(String(b._id)));
      console.log(`   ${name} · ${tz}: server returns ${server.size} · wrongly included ${extra.length} · missed ${missing.length}`);
      [...extra.map((b) => ['+', b]), ...missing.map((b) => ['-', b])].slice(0, 6)
        .forEach(([sign, b]) => console.log(`     ${sign}${row(b).trimStart()}`));
    }
  };
  console.log(`\n=== Server filter vs real IST dates for ${month} ===`);
  report('Booking Date (createdAt)', 'createdAt', created);
  report('Event Date (bookingDate)', 'bookingDate', events);

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
