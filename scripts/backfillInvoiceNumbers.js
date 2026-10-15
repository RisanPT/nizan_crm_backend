/**
 * One-time backfill: give a tax invoice number ("TN/26-27/0001") to bookings
 * that were ALREADY fully paid before invoice numbers existed. New payments
 * get theirs automatically (utils/invoiceNumber.js).
 *
 * Cross-checks every booking before numbering it (utils/invoiceBackfill.js):
 *   • only confirmed / completed bookings with a value;
 *   • money is recounted from the VERIFIED Collection records — if that
 *     disagrees with the stored Booking.collectedAmount the booking is held
 *     back ("check"), never numbered;
 *   • an advance still pending / rejected by Accounts doesn't count;
 *   • overpaid or undated payments are held back too.
 * Eligible bookings are numbered in the order they became fully paid, in the
 * financial year of that date, and invoiceDate = that date.
 *
 * DRY RUN by default — reads only, writes a CSV report, changes nothing.
 * Idempotent: only bookings without an invoice number are touched.
 *
 * Usage:
 *   node scripts/backfillInvoiceNumbers.js                  # dry run + report
 *   node scripts/backfillInvoiceNumbers.js --apply          # number them
 *   node scripts/backfillInvoiceNumbers.js --report=path.csv
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import Counter from '../models/Counter.js';
import { financialYearKey } from '../utils/invoiceNumber.js';
import { classifyForInvoice } from '../utils/invoiceBackfill.js';

const APPLY = process.argv.includes('--apply');
const ONLY_COMPLETED = process.argv.includes('--only-completed');
const reportArg = process.argv.find((a) => a.startsWith('--report='));
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const REPORT = reportArg
  ? reportArg.slice('--report='.length)
  : path.resolve(`invoice-backfill-${APPLY ? 'applied' : 'dryrun'}-${stamp}.csv`);

// Never build indexes from a script — the server owns that.
mongoose.set('autoIndex', false);

const csvCell = (v) => {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const run = async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGO_URI is not set. Aborting.');
    process.exit(1);
  }
  await mongoose.connect(uri);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`Connected to "${dbName}". Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

  const bookings = await Booking.find({})
    .select('bookingNumber customerName status totalPrice discountAmount advanceAmount advanceStatus ' +
      'advanceVerifiedAt collectedAmount invoiceNumber bookingDate createdAt legacyBooking')
    .lean();
  const collections = await Collection.find({ bookingId: { $ne: null } })
    .select('bookingId amount status date verifiedAt createdAt')
    .lean();
  const byBooking = new Map();
  for (const c of collections) {
    const k = String(c.bookingId);
    if (!byBooking.has(k)) byBooking.set(k, []);
    byBooking.get(k).push(c);
  }

  const rows = bookings.map((b) => ({ b, r: classifyForInvoice(b, byBooking.get(String(b._id)) || []) }));
  // --only-completed: a fully paid booking whose event isn't completed yet
  // stays pending (it gets its number when marked completed).
  if (ONLY_COMPLETED) {
    for (const x of rows) {
      if (x.r.verdict === 'eligible' && String(x.b.status || '').toLowerCase() !== 'completed') {
        x.r = { ...x.r, verdict: 'owing', reason: 'fully paid but not completed yet' };
      }
    }
  }
  const eligible = rows
    .filter((x) => x.r.verdict === 'eligible')
    .sort((x, y) => x.r.paidOn - y.r.paidOn || String(x.b._id).localeCompare(String(y.b._id)));

  // Plan numbers per financial year, continuing any live counter.
  const counters = new Map(
    (await Counter.find({ _id: /^invoice:/ }).lean()).map((c) => [c._id, c.seq])
  );
  const startSeq = new Map(counters);
  const plan = new Map();
  for (const x of eligible) {
    const fy = financialYearKey(x.r.paidOn);
    const key = `invoice:${fy}`;
    const seq = (counters.get(key) || 0) + 1;
    counters.set(key, seq);
    plan.set(String(x.b._id), { fy, seq, invoiceNumber: `TN/${fy}/${String(seq).padStart(4, '0')}` });
  }

  const tally = {};
  for (const { r } of rows) tally[r.verdict] = (tally[r.verdict] || 0) + 1;
  console.log('Bookings scanned:', rows.length);
  console.log('  eligible (fully paid, checks pass):', tally.eligible || 0);
  console.log('  check    (held back — needs a look):', tally.check || 0);
  console.log('  owing    (not fully paid):', tally.owing || 0);
  console.log('  skip     (cancelled / zero / already numbered):', tally.skip || 0);
  for (const [key, seq] of counters) {
    const before = startSeq.get(key) || 0;
    if (seq !== before) {
      console.log(`  ${key.slice(8)}: numbers ${String(before + 1).padStart(4, '0')}–${String(seq).padStart(4, '0')}` +
        (before > 0 ? `  (continues after ${before} already issued live)` : ''));
    }
  }

  // Report — every booking that isn't plain "skip", eligible first.
  const order = { eligible: 0, check: 1, owing: 2, skip: 3 };
  const lines = [[
    'verdict', 'reason', 'invoiceNumber', 'invoiceDate', 'bookingNumber', 'customer', 'status',
    'net', 'advance', 'advanceStatus', 'collectedStored', 'collectedRecount', 'received', 'legacy',
  ].join(',')];
  for (const { b, r } of [...rows].sort((x, y) => order[x.r.verdict] - order[y.r.verdict] || (x.r.paidOn || 0) - (y.r.paidOn || 0))) {
    if (r.verdict === 'skip' && !b.invoiceNumber) continue;
    const p = plan.get(String(b._id));
    lines.push([
      r.verdict, r.reason, p?.invoiceNumber || b.invoiceNumber || '', p ? r.paidOn : '',
      b.bookingNumber, b.customerName, b.status, r.net, r.advance, b.advanceStatus || '',
      r.collectedStored, r.collectedRecount, r.received, b.legacyBooking ? 'yes' : '',
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(REPORT, lines.join('\n'));
  console.log(`\nReport: ${REPORT}`);

  if (!APPLY) {
    console.log('\nDry run — nothing written. Review the report, then re-run with --apply.');
    await mongoose.disconnect();
    return;
  }

  // Reserve the planned block first (compare-and-set): if the live server has
  // issued a number since the plan was made, stop before writing anything.
  for (const [key, seq] of counters) {
    const before = startSeq.get(key) || 0;
    if (seq === before) continue;
    const reserved = await Counter.findOneAndUpdate(
      before === 0 ? { _id: key, $or: [{ seq: 0 }, { seq: { $exists: false } }] } : { _id: key, seq: before },
      { $set: { seq } },
      { new: true }
    ).catch(() => null)
      ?? (before === 0
        ? await Counter.create({ _id: key, seq }).catch(() => null)
        : null);
    if (!reserved) {
      console.error(`\nCounter ${key} changed since the plan (a live invoice was issued). Nothing written — run again.`);
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  // Apply: conditional per booking (only if still un-numbered).
  let written = 0;
  for (const x of eligible) {
    const p = plan.get(String(x.b._id));
    const res = await Booking.updateOne(
      { _id: x.b._id, invoiceNumber: { $exists: false } },
      { $set: { invoiceNumber: p.invoiceNumber, invoiceDate: x.r.paidOn } }
    );
    if (res.modifiedCount) written += 1;
    else console.warn(`  ! ${x.b.bookingNumber} was numbered meanwhile — ${p.invoiceNumber} unused`);
  }
  console.log(`\nApplied: ${written} bookings numbered.`);
  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
