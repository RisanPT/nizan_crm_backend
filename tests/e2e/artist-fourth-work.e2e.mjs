// End-to-end check of the 4TH WORK ON A FULL DATE (smart allocation on):
//   the date has reached HR's day limit; Add Booking's preview shows where a 4th work is still possible — an artist whose works that day
//   are close together and who has a gap that fits (both drives + ready time, within 30 minutes) — or the times it would fit;
//   sales can't save it (the refusal says where and when, "ask CRM"); CRM can — it goes to that artist as a work past her slots, waiting
//   for the Artist Head's OK; at most one such work per artist a day, and at most `extrasPerDay` bookings past the day's limit.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/artist-fourth-work.e2e.mjs
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound key is blanked (the code loads the real .env, which never overrides a set variable)
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'ARTIST_ALLOCATION', 'ARTIST_ASSIGNMENT_GUARD', 'ARTIST_AUTO_ALLOCATE']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/artist_fourth_work_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const mod = (p) => import(new URL(p, root));
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const Region = await imp('models/Region.js');
const District = await imp('models/District.js');
const Pincode = await imp('models/Pincode.js');
const GeoCache = await imp('models/GeoCache.js');
const Notification = await imp('models/Notification.js');
const ArtistAllocation = await imp('models/ArtistAllocation.js');
const SlotCapacity = await imp('models/SlotCapacity.js');
const BlockedDate = await imp('models/BlockedDate.js');
const { ensureDefaultRoles } = await mod('controllers/roleController.js');
const { sanitizeErrorResponses, errorHandler } = await mod('middleware/errorMiddleware.js');
const { _resetTeamCache } = await mod('services/artistTeams.js');
const { addDays, istDayKey } = await mod('utils/istDate.js');
const { dayKey } = await mod('utils/slots.js');
await mod('utils/asyncErrors.js');
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
await ArtistAllocation.init();
assert.equal(process.env.ORS_API_KEY, '', 'SAFETY: nothing re-loaded the real .env over the blanked keys');

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/bookings', await imp('routes/bookingRoutes.js'));
app.use('/api/allocation', await imp('routes/allocationRoutes.js'));
app.use('/api/artist-teams', await imp('routes/artistTeamRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const api = async (method, path, who, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: json, text };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the world ────────────────────────────────────────────────────────────────
const north = await Region.create({ name: 'Kerala North' });
const south = await Region.create({ name: 'Kerala South' });
const kkd = await District.create({ name: 'Kozhikode', region: north._id });
const klm = await District.create({ name: 'Kollam', region: south._id });
const PIN = { calicut: '673001', feroke: '673631', kollam: '691001' };
await Pincode.create([{ code: PIN.calicut, district: kkd._id }, { code: PIN.feroke, district: kkd._id }, { code: PIN.kollam, district: klm._id }]);
await GeoCache.create([
  { key: `pin:${PIN.calicut}`, status: 'ok', lat: 11.2588, lng: 75.7804 },
  { key: `pin:${PIN.feroke}`, status: 'ok', lat: 11.1786, lng: 75.8418 },
  { key: `pin:${PIN.kollam}`, status: 'ok', lat: 8.8932, lng: 76.6141 },
]);
let n = 0;
const login = async (name, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const NAMES = ['Nihala', 'Irfana'];
const leads = [];
const assistants = [];
for (const [i, name] of NAMES.entries()) {
  leads.push(await Employee.create({ name, phone: `92000000${i}0`, artistRole: 'artist', status: 'active', type: 'in-house', specialization: 'Bridal' }));
  assistants.push(await Employee.create({ name: `${name}'s assistant`, phone: `92000000${i}1`, artistRole: 'assistant', status: 'active', type: 'in-house' }));
}
const admin = await login('Admin', 'admin');
const crm = await login('Sana', 'crm');
const artistHead = await login('Shabna', 'artist_head');
const sales = await login('Sam', 'sales');

const D = addDays(istDayKey(new Date()), 14);
const iso = (day, hhmm) => `${day}T${hhmm}:00+05:30`;
// a date as the booking save stores it (local midnight) — the day limit counts it the same way
const localDay = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
};
let phone = 9897200000;
const draft = (o = {}) => {
  const day = o.day ?? D;
  return {
    customerName: o.client ?? `Client ${phone}`,
    phone: String(++phone),
    email: `c${phone}@client.test`,
    service: 'Bridal Makeup',
    totalPrice: 20000,
    bookingDate: day,
    selectedDates: [day],
    pincode: o.pin ?? PIN.calicut,
    bookingItems: [{ service: 'Bridal Makeup', selectedDates: [day], startTime: o.start ?? '14:30', endTime: o.end ?? '16:00' }],
  };
};
const preview = (who, o) => {
  const d = draft(o);
  return api('POST', '/allocation/preview', who, { pincode: d.pincode, selectedDates: d.selectedDates, bookingItems: d.bookingItems });
};
let seq = 0;
const work = (lead, pin, start, end, day = D) => {
  seq += 1;
  return Booking.create({
    bookingNumber: `BK-${4000 + seq}`, customerName: `Booked ${seq}`, phone: `98100000${String(seq).padStart(2, '0')}`, email: `b${seq}@client.test`,
    service: 'Bridal Makeup', totalPrice: 20000, status: 'confirmed', origin: 'staff', bookingDate: localDay(day), selectedDates: [day],
    serviceStart: new Date(iso(day, start)), serviceEnd: new Date(iso(day, end)), pincode: pin, districtId: pin === PIN.kollam ? klm._id : kkd._id,
    assignedStaff: lead === null ? [] : [{ employeeId: leads[lead]._id, artistName: NAMES[lead], roleType: 'lead' }],
  });
};

console.log('\n— a full date —');
let teams;
await check('teams set up, the allocation on; six works fill the day (HR\'s day limit: 6)', async () => {
  for (const [i] of NAMES.entries()) assert.equal((await api('POST', '/artist-teams', crm, { leadEmployeeId: String(leads[i]._id), assistantEmployeeIds: [String(assistants[i]._id)] })).status, 201);
  teams = (await api('GET', '/artist-teams', crm)).body.teams;
  await sleep(1100);
  assert.equal((await api('PUT', '/allocation/settings', admin, { mode: 'suggest' })).status, 200);
  await sleep(1100); // the day's works are made after go-live, so they hold their slots
  // Nihala's close route in Kozhikode: 9:00 Calicut, 12:00 Feroke, 5:00 PM Calicut; Irfana's in Kollam
  for (const [lead, pin, s, e] of [[0, PIN.calicut, '09:00', '11:00'], [0, PIN.feroke, '12:00', '13:30'], [0, PIN.calicut, '17:00', '19:00'], [1, PIN.kollam, '09:00', '11:00'], [1, PIN.kollam, '12:00', '13:00'], [1, PIN.kollam, '17:00', '19:00']]) await work(lead, pin, s, e);
  await SlotCapacity.create({ date: null, morning: 4, evening: 2 }); // the day's limit: 6 — reached
  const p = await preview(sales, { start: '09:30', end: '10:30', day: addDays(D, 1) });
  assert.deepEqual([p.status, p.body.day.full], [200, false], 'the next day is not full');
});

await check('Add Booking at 2:30 PM in Calicut: "fully booked — a 4th work is possible with Team Nihala", ask CRM (sales)', async () => {
  const p = await preview(sales, { start: '14:30', end: '16:00' });
  assert.equal(p.status, 200, p.text);
  const d = p.body.day;
  assert.deepEqual([d.full, d.booked, d.capacity, d.left, d.canBook], [true, 6, 6, 2, false]);
  const u = d.units[0];
  assert.deepEqual([u.fit.teamName, u.fit.tier, u.fit.needsOk], ['Team Nihala', 'extra', true]);
  assert.match(d.message, /^That date is fully booked \(6\/6\)\. A 4th work is possible — Team Nihala at 2:30 PM \(her 12:00 PM Kozhikode job — \d+ min \(\d+ km\) away by pincode\)\. Ask CRM to book it\.$/);
  // the gap it fits in, and nobody else's (Irfana is in Kollam)
  assert.deepEqual(u.options.map((o) => o.teamName), ['Team Nihala']);
  assert.match(`${u.options[0].windows[0].from}–${u.options[0].windows[0].to}`, /^14:\d\d–16:\d\d$/);
});

await check('at 2:00 PM it doesn\'t fit (she can\'t be ready after Feroke) — the times it would fit are shown', async () => {
  const p = await preview(sales, { start: '14:00', end: '15:30' });
  const d = p.body.day;
  assert.equal(d.units[0].fit, null);
  // her gap nearest the asked time comes first (2:22–4:25 PM), then the next one
  assert.match(d.message, /Not at that time — a 4th work fits: Team Nihala 2:\d\d PM–4:\d\d PM( or [^.;]+)?\. Ask CRM to book it at one of these times\.$/);
  const crmView = await preview(crm, { start: '14:00', end: '15:30' });
  assert.match(crmView.body.day.message, /Change the time to one of these\.$/);
});

await check('Kollam at 2:30 PM goes to Irfana (her Kollam works are close; her gap fits) — Nihala is far', async () => {
  const p = await preview(sales, { pin: PIN.kollam, start: '14:30', end: '16:00' });
  const d = p.body.day;
  assert.deepEqual([d.units[0].fit.teamName, d.units[0].fit.tier], ['Team Irfana', 'extra']);
  assert.deepEqual(d.units[0].options.map((o) => o.teamName), ['Team Irfana']);
});

let crmBooking;
await check('sales can\'t save it — the refusal says where and when; CRM can: it goes to Nihala as her 4th work, waiting for the Artist Head', async () => {
  const s = await api('POST', '/bookings', sales, draft({ client: 'Peak Bride', start: '14:30', end: '16:00' }));
  assert.deepEqual([s.status, s.body.code], [409, 'DAY_FULL']);
  assert.match(s.body.message, /A 4th work is possible — Team Nihala at 2:30 PM .*Ask CRM to book it\.$/);
  const c = await api('POST', '/bookings', crm, draft({ client: 'Peak Bride', start: '14:30', end: '16:00' }));
  assert.equal(c.status, 201, c.text);
  crmBooking = c.body;
  assert.deepEqual(c.body.fourthWork.map((r) => [r.teamName, r.tier, r.extra, r.pending]), [['Team Nihala', 'extra', true, true]]);
  const row = await ArtistAllocation.findOne({ bookingId: c.body._id, kind: 'allocation', active: true }).lean();
  assert.deepEqual([row.extra, row.approval.status, row.source, row.slotKey], [true, 'pending', 'fourth', 'X1']);
  assert.equal(c.body.assignedStaff.length, 0, 'her name goes on with the Artist Head\'s OK');
  assert.ok(await Notification.findOne({ recipient: artistHead.id, type: 'extra_slot_request', bookingId: c.body._id }).lean(), 'the Artist Head is asked');
});

await check('the Artist Head OKs it → Nihala is on it; her day now has one work past her slots', async () => {
  const row = await ArtistAllocation.findOne({ bookingId: crmBooking._id, kind: 'allocation', active: true }).lean();
  const ok = await api('POST', `/allocation/${row._id}/approve`, artistHead);
  assert.equal(ok.status, 200, ok.text);
  const b = await Booking.findById(crmBooking._id).lean();
  assert.equal(b.assignedStaff.find((x) => x.roleType === 'lead')?.artistName, 'Nihala');
});

await check('one 4th work per artist a day: the next Calicut work finds no artist (Irfana is far)', async () => {
  const p = await preview(crm, { start: '20:00', end: '21:30' });
  const d = p.body.day;
  assert.deepEqual([d.booked, d.left, d.units[0].fit], [7, 1, null]);
  assert.deepEqual(d.units[0].options, [], 'Nihala has her one already');
  assert.match(d.message, /No artist has time for another work near Kozhikode that day/);
  const c = await api('POST', '/bookings', crm, draft({ start: '20:00', end: '21:30' }));
  assert.deepEqual([c.status, c.body.code], [409, 'DAY_FULL']);
});

await check('the day\'s limit + 2 is the most: with both used, nothing more', async () => {
  await work(null, PIN.kollam, '06:00', '07:00'); // an 8th booking (no artist) — the day is now at its limit + 2
  const p = await preview(crm, { pin: PIN.kollam, start: '14:30', end: '16:00' });
  assert.deepEqual([p.body.day.booked, p.body.day.left], [8, 0]);
  assert.match(p.body.day.message, /Both works past the day's limit are taken too/);
});

await check('an HR-blocked date says so; with the allocation off the old refusal stands', async () => {
  const blockedDay = addDays(D, 2);
  await BlockedDate.create({ date: dayKey(localDay(blockedDay)), active: true, reason: 'Holiday' });
  const b = await api('POST', '/bookings', crm, draft({ day: blockedDay }));
  assert.deepEqual([b.status, b.body.code], [409, 'DAY_BLOCKED']);
  await api('PUT', '/allocation/settings', admin, { mode: 'off' });
  const off = await api('POST', '/bookings', crm, draft({ start: '14:30', end: '16:00' }));
  assert.equal(off.status, 409);
  assert.match(off.body.message, /^That date is fully booked — all 6 slots are taken/);
  assert.equal((await preview(sales, {})).body.on, false);
});

_resetTeamCache();
await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
