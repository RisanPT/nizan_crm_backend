/**
 * READ-ONLY look-up of one customer by phone: their bookings, enquiries
 * (leads) and payments (collections), with every date in IST. Writes NOTHING
 * (raw driver find() reads only, no Mongoose models / index builds).
 *
 * Usage:  node scripts/checkCustomer.js 9846779056
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const digits = String(process.argv[2] ?? '').replace(/\D/g, '').slice(-10);
if (digits.length !== 10) {
  console.error('Give a 10-digit phone number.');
  process.exit(1);
}
// Matches the number with any separators / country code in between.
const phoneRx = new RegExp(digits.split('').join('[^0-9]*') + '$');
const IST_MS = 330 * 60 * 1000;
const ist = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().replace('T', ' ').slice(0, 16) : '—');
const day = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10) : '—');
const inr = (n) => `₹${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

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

  const bookings = await db.collection('bookings')
    .find({ $or: [{ phone: phoneRx }, { secondaryContact: phoneRx }] })
    .sort({ createdAt: 1 })
    .toArray();
  const leads = await db.collection('leads')
    .find({ $or: [{ phone: phoneRx }, { alternateNumber: phoneRx }, { bookingId: { $in: bookings.map((b) => b._id) } }] })
    .sort({ createdAt: 1 })
    .toArray();
  const collections = await db.collection('collections')
    .find({ bookingId: { $in: bookings.map((b) => b._id) } })
    .sort({ date: 1 })
    .toArray();
  const userIds = [...new Set([...bookings.flatMap((b) => [b.createdBy, b.salesPersonId]), ...leads.flatMap((l) => [l.assignedTo, l.createdBy])]
    .filter(Boolean).map(String))];
  const users = await db.collection('users')
    .find({ _id: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) } }, { projection: { name: 1, role: 1, countInSalesTotals: 1 } })
    .toArray();
  const who = (id) => {
    const u = users.find((x) => String(x._id) === String(id ?? ''));
    return u ? `${u.name} (${u.role}${u.countInSalesTotals === false ? ', NOT in sales totals' : ''})` : id ? String(id) : '—';
  };

  console.log(`Phone …${digits}: ${bookings.length} booking(s), ${leads.length} enquir(y/ies), ${collections.length} payment(s)\n`);

  for (const b of bookings) {
    const net = (Number(b.totalPrice) || 0) - (Number(b.discountAmount) || 0);
    console.log(`BOOKING #${b.bookingNumber ?? '—'}  ${b.customerName}  phone ${b.phone}`);
    console.log(`  status ${b.status} · trip ${b.tripStatus ?? '—'} · legacy ${!!b.legacyBooking}`);
    console.log(`  booked on (createdAt) ${ist(b.createdAt)} · last updated ${ist(b.updatedAt)}`);
    console.log(`  event (bookingDate) ${day(b.bookingDate)} · selectedDates ${JSON.stringify(b.selectedDates ?? [])} · service ${ist(b.serviceStart)} → ${ist(b.serviceEnd)}`);
    console.log(`  package ${b.service}${(b.bookingItems ?? []).length ? ` · items: ${b.bookingItems.map((i) => `${i.service} [${(i.selectedDates ?? []).join(',')}] ${inr(i.totalPrice)}`).join(' | ')}` : ''}`);
    console.log(`  total ${inr(b.totalPrice)} · discount ${inr(b.discountAmount)} · net ${inr(net)} · advance ${inr(b.advanceAmount)} · collected ${inr(b.collectedAmount)} · balance ${inr(net - (b.advanceAmount || 0) - (b.collectedAmount || 0))}`);
    console.log(`  entered by ${who(b.createdBy)} (name on record: ${b.createdByName || '—'}) · salesperson ${who(b.salesPersonId)} · leadId ${b.leadId ?? '—'}`);
    console.log(`  district ${b.district ?? '—'} · region ${b.region ?? '—'} · address ${String(b.address ?? '').slice(0, 60)}`);
    if (b.internalRemarks) console.log(`  remarks: ${String(b.internalRemarks).replace(/\s+/g, ' ').slice(0, 200)}`);
    const cs = collections.filter((c) => String(c.bookingId) === String(b._id));
    for (const c of cs) {
      console.log(`  PAYMENT ${inr(c.amount)} on ${day(c.date)} · ${c.paymentMode} · ${c.status} · logged ${ist(c.createdAt)}${c.notes ? ` · "${String(c.notes).slice(0, 60)}"` : ''}`);
    }
    console.log('');
  }

  for (const l of leads) {
    console.log(`ENQUIRY ${l.name}  phone ${l.phone}  status ${l.status}  source ${l.source || '—'}`);
    console.log(`  enquiry date ${day(l.leadDate ?? l.enquiryDate)} · created ${ist(l.createdAt)} · booked-on ${day(l.bookedDate)} · event ${day(l.eventDate)}`);
    console.log(`  assigned to ${who(l.assignedTo)} · linked booking ${l.bookingId ? `#${bookings.find((b) => String(b._id) === String(l.bookingId))?.bookingNumber ?? l.bookingId}` : '—'}`);
    console.log('');
  }

  await mongoose.disconnect();
};

run().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
