// End-to-end check of the INFLUENCER WORK tick on a booking (its own colour on the Calendar Scheduler):
//   a booking saved with it ticked keeps it; one saved without it is not one; an edit that doesn't mention it leaves it as it was;
//   unticking clears it; the bookings list carries it to the calendar.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/booking-influencer.e2e.mjs
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound key is blanked (the code loads the real .env, which never overrides a set variable)
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'META_ACCESS_TOKEN', 'DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'ARTIST_ALLOCATION', 'ARTIST_ASSIGNMENT_GUARD', 'ARTIST_AUTO_ALLOCATE']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/booking_influencer_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const mod = (p) => import(new URL(p, root));
const User = await imp('models/User.js');
const Booking = await imp('models/Booking.js');
const { ensureDefaultRoles } = await mod('controllers/roleController.js');
const { sanitizeErrorResponses, errorHandler } = await mod('middleware/errorMiddleware.js');
const { addDays, istDayKey } = await mod('utils/istDate.js');
await mod('utils/asyncErrors.js');
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
assert.equal(process.env.ORS_API_KEY, '', 'SAFETY: nothing re-loaded the real .env over the blanked keys');

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/bookings', await imp('routes/bookingRoutes.js'));
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

let n = 0;
const login = async (name, role) => {
  n += 1;
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role });
  return { id: String(user._id), name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const crm = await login('Sana', 'crm');

const D = addDays(istDayKey(new Date()), 10);
let phone = 9897300000;
const draft = (o = {}) => ({
  customerName: o.client ?? `Client ${phone}`,
  phone: String(++phone),
  email: `c${phone}@client.test`,
  service: 'Party Makeup',
  totalPrice: 8000,
  bookingDate: o.day ?? D,
  selectedDates: [o.day ?? D],
  bookingItems: [{ service: 'Party Makeup', selectedDates: [o.day ?? D], startTime: '10:00', endTime: '12:00' }],
  ...(o.extra ?? {}),
});
const stored = async (id) => (await Booking.findById(id).lean()).influencerWork;

let ticked;
let plain;
await check('a booking saved with "Influencer work" ticked keeps it', async () => {
  const r = await api('POST', '/bookings', crm, draft({ client: 'Ayesha Collab', extra: { influencerWork: true } }));
  assert.equal(r.status, 201, r.text);
  ticked = r.body;
  assert.equal(r.body.influencerWork, true);
  assert.equal(await stored(ticked._id), true);
});

await check('a booking saved without it is not an influencer work', async () => {
  const r = await api('POST', '/bookings', crm, draft({ day: addDays(D, 1) }));
  assert.equal(r.status, 201, r.text);
  plain = r.body;
  assert.equal(r.body.influencerWork, false);
  assert.equal(await stored(plain._id), false);
});

await check('an edit that does not mention it leaves it as it was', async () => {
  const full = (await api('GET', `/bookings/${ticked._id}`, crm)).body;
  delete full.influencerWork;
  const r = await api('PUT', `/bookings/${ticked._id}`, crm, { ...full, internalRemarks: 'Reel at the venue' });
  assert.equal(r.status, 200, r.text);
  assert.equal(await stored(ticked._id), true);
});

await check('unticking clears it; ticking a plain booking marks it (a "true" string from a form counts)', async () => {
  const full = (await api('GET', `/bookings/${ticked._id}`, crm)).body;
  assert.equal((await api('PUT', `/bookings/${ticked._id}`, crm, { ...full, influencerWork: false })).status, 200);
  assert.equal(await stored(ticked._id), false);
  const other = (await api('GET', `/bookings/${plain._id}`, crm)).body;
  assert.equal((await api('PUT', `/bookings/${plain._id}`, crm, { ...other, influencerWork: 'true' })).status, 200);
  assert.equal(await stored(plain._id), true);
});

await check('the bookings list carries it to the calendar', async () => {
  const r = await api('GET', '/bookings', crm);
  assert.equal(r.status, 200, r.text);
  const rows = Array.isArray(r.body) ? r.body : (r.body.items ?? r.body.bookings ?? []);
  const byId = Object.fromEntries(rows.map((b) => [String(b._id), b.influencerWork]));
  assert.deepEqual([byId[String(ticked._id)], byId[String(plain._id)]], [false, true]);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
