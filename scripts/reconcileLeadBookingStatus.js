/**
 * Finds leads whose mobile number has a booking but whose status / link says
 * otherwise, and (with --apply) converts + links them.
 *
 * Match: last 10 digits of the lead's phone OR alternate number against the
 * booking's phone OR secondary contact. Cancelled / rejected bookings are
 * ignored. A lead already linked to a booking that still exists keeps that
 * link (only its status is fixed). Otherwise the lead links to the EARLIEST
 * live booking for its number — the one it produced, not a later repeat.
 *
 * Default is a DRY RUN: raw driver find() reads only — no Mongoose models, no
 * index builds, nothing written.
 *
 * Usage:
 *   node scripts/reconcileLeadBookingStatus.js                  # dry run
 *   node scripts/reconcileLeadBookingStatus.js --skip-legacy    # ignore imported bookings
 *   node scripts/reconcileLeadBookingStatus.js --apply          # write
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const SKIP_LEGACY = process.argv.includes('--skip-legacy');
const DEAD = ['cancelled', 'canceled', 'rejected'];
const IST_MS = 330 * 60 * 1000;
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10) : '-');

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
  await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db;
  console.log(`Connected. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (read-only)'}${SKIP_LEGACY ? ', skipping legacy imports' : ''}\n`);

  const bookings = await db
    .collection('bookings')
    .find({}, {
      projection: {
        phone: 1, secondaryContact: 1, status: 1, customerName: 1, createdAt: 1, bookingDate: 1, serviceStart: 1,
        address: 1, pincode: 1, regionId: 1, districtId: 1, region: 1, district: 1, legacyBooking: 1,
      },
    })
    .toArray();
  const leads = await db
    .collection('leads')
    .find({}, { projection: { name: 1, phone: 1, alternateNumber: 1, status: 1, bookingId: 1 } })
    .toArray();

  const byId = new Map(bookings.map((b) => [String(b._id), b]));
  const live = bookings.filter(
    (b) => !DEAD.includes(String(b.status ?? '').toLowerCase()) && !(SKIP_LEGACY && b.legacyBooking)
  );
  // number → earliest live booking
  const byPhone = new Map();
  const when = (b) => new Date(b.createdAt ?? b.bookingDate ?? 0).getTime();
  for (const b of live) {
    for (const k of new Set([phoneKey(b.phone), phoneKey(b.secondaryContact)])) {
      if (k.length !== 10) continue;
      const cur = byPhone.get(k);
      if (!cur || when(b) < when(cur)) byPhone.set(k, b);
    }
  }

  const fixes = [];
  let ok = 0;
  for (const lead of leads) {
    const linked = lead.bookingId ? byId.get(String(lead.bookingId)) : null;
    const linkedLive = linked && !DEAD.includes(String(linked.status ?? '').toLowerCase());
    let target = linkedLive ? linked : null;
    if (!target) {
      for (const k of [phoneKey(lead.phone), phoneKey(lead.alternateNumber)]) {
        if (k.length === 10 && byPhone.has(k)) { target = byPhone.get(k); break; }
      }
    }
    if (!target) continue;
    const sameLink = lead.bookingId && String(lead.bookingId) === String(target._id);
    if (sameLink && lead.status === 'Converted') { ok++; continue; }
    fixes.push({ lead, booking: target, relink: !sameLink });
  }

  const byStatus = {};
  for (const f of fixes) byStatus[f.lead.status || '(none)'] = (byStatus[f.lead.status || '(none)'] || 0) + 1;

  console.log('Mismatches (first 40):');
  for (const f of fixes.slice(0, 40)) {
    console.log(
      `  ${String(f.lead.name).padEnd(24)} ${String(f.lead.phone).padEnd(14)} ${String(f.lead.status).padEnd(22)}` +
        ` → booking ${istDay(f.booking.createdAt)} (${f.booking.status})${f.booking.legacyBooking ? ' [legacy import]' : ''}` +
        `${f.relink ? '' : ' [status only]'}`
    );
  }
  console.log('\n──────── Summary ────────');
  console.log(`Leads examined            : ${leads.length}`);
  console.log(`Live bookings considered  : ${live.length}`);
  console.log(`Already correct           : ${ok}`);
  console.log(`To fix                    : ${fixes.length}`);
  console.log(`  of which legacy imports : ${fixes.filter((f) => f.booking.legacyBooking).length}`);
  console.log(`  by current status       : ${JSON.stringify(byStatus)}`);

  if (APPLY && fixes.length) {
    const ops = fixes.map(({ lead, booking: b }) => ({
      updateOne: {
        filter: { _id: lead._id },
        update: {
          $set: {
            status: 'Converted',
            bookingId: b._id,
            bookedDate: b.createdAt ?? new Date(),
            eventDate: b.serviceStart ?? b.bookingDate ?? null,
            ...(b.address ? { address: b.address } : {}),
            ...(b.pincode ? { pincode: b.pincode } : {}),
            ...(b.regionId ? { regionId: b.regionId } : {}),
            ...(b.districtId ? { districtId: b.districtId } : {}),
            ...(b.region ? { region: b.region } : {}),
            ...(b.district ? { district: b.district } : {}),
          },
        },
      },
    }));
    const r = await db.collection('leads').bulkWrite(ops, { ordered: false });
    console.log(`\nWritten: ${r.modifiedCount} leads updated.`);
  } else {
    console.log('\nDRY RUN — nothing changed. Re-run with --apply to write.');
  }
  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Reconcile failed:', error);
  await mongoose.disconnect();
  process.exit(1);
});
