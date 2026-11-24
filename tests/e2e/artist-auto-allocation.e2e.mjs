// End-to-end check of AUTOMATIC ARTIST ALLOCATION (settings autoAllocate on, with the allocation in suggest mode):
//   1. the CRM team (any CRM member) sets each team's main artist, assistants and PREFERRED LOCATIONS;
//   2. the moment a NEW booking is confirmed — a salesperson's booking (confirmed when made) or a request CRM accepts — each package
//      goes to the top team on its own when the match is clean (Nihala prefers Kozhikode → a Kozhikode booking is hers; a job near her
//      route continues it); anything doubtful (nobody prefers the place, no start time…) waits on the Allocation Board and CRM is told why;
//   3. the salesperson reads their booking's artist (or why it waits), and hears when CRM gives it later.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/artist-auto-allocation.e2e.mjs
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
await mongoose.connect('mongodb://127.0.0.1:27099/artist_auto_allocation_e2e');
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
const { ensureDefaultRoles } = await mod('controllers/roleController.js');
const { sanitizeErrorResponses, errorHandler } = await mod('middleware/errorMiddleware.js');
const { _resetTeamCache } = await mod('services/artistTeams.js');
const { addDays, istDayKey } = await mod('utils/istDate.js');
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
// the company's day cap (HR → Slot capacity) sized to the teams' 12 morning + 6 evening slots, so it never stops these bookings first
await SlotCapacity.create({ date: null, morning: 12, evening: 6 });
const north = await Region.create({ name: 'Kerala North' });
const south = await Region.create({ name: 'Kerala South' });
const kkd = await District.create({ name: 'Kozhikode', region: north._id }); // Calicut is Kozhikode: one district
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
const NAMES = ['Nihala', 'Irfana', 'Sandra'];
const leads = [];
const assistants = [];
for (const [i, name] of NAMES.entries()) {
  leads.push(await Employee.create({ name, phone: `91000000${i}0`, artistRole: 'artist', status: 'active', type: 'in-house', specialization: 'Bridal' }));
  assistants.push(await Employee.create({ name: `${name}'s assistant`, phone: `91000000${i}1`, artistRole: 'assistant', status: 'active', type: 'in-house' }));
}
const admin = await login('Admin', 'admin');
const crmHead = await login('Riya', 'crm_manager');
const crm = await login('Sana', 'crm');
const sales = await login('Sam', 'sales');
const sales2 = await login('Tara', 'sales_executive');
const artist = await login('Nihala', 'artist', { employeeId: leads[0]._id });

const D = addDays(istDayKey(new Date()), 12);
const iso = (day, hhmm) => `${day}T${hhmm}:00+05:30`;
let phone = 9897000000;
/** A booking made in the app (staff → confirmed at once), the way the Add Booking screen sends it. */
const book = (who, o = {}) => {
  phone += 1;
  const day = o.day ?? D;
  return api('POST', '/bookings', who, {
    customerName: o.client ?? `Client ${phone}`,
    phone: String(phone),
    email: `c${phone}@client.test`,
    service: o.service ?? 'Bridal Makeup',
    totalPrice: 20000,
    bookingDate: day,
    selectedDates: [day],
    ...(o.noTime ? {} : { serviceStart: iso(day, o.start ?? '10:30'), serviceEnd: iso(day, o.end ?? '12:30') }),
    pincode: o.pin ?? PIN.calicut,
    // (Add Booking sends no district when the packages are at base price — the pincode says where it is)
    ...(o.noDistrict ? {} : { districtId: String(o.pin === PIN.kollam ? klm._id : kkd._id) }),
    ...(o.staff ? { assignedStaff: o.staff } : {}),
  });
};

console.log('\n— 1. the CRM team sets the teams and their preferred locations —');
let teams;
await check('a CRM member (not only the Head) adds the teams with main artist, assistant and preferred location; sales can\'t', async () => {
  assert.equal((await api('POST', '/artist-teams', sales, { leadEmployeeId: String(leads[0]._id) })).status, 403);
  // Nihala prefers Kozhikode (the district), Irfana the Feroke pincode area, Sandra none
  const prefs = [{ preferredDistrictIds: [String(kkd._id)] }, { preferredPincodes: [PIN.feroke] }, {}];
  for (const [i] of NAMES.entries()) {
    const r = await api('POST', '/artist-teams', crm, { leadEmployeeId: String(leads[i]._id), assistantEmployeeIds: [String(assistants[i]._id)], ...prefs[i] });
    assert.equal(r.status, 201, r.text);
  }
  teams = (await api('GET', `/artist-teams?day=${D}`, crm)).body.teams;
  assert.deepEqual([teams[0].preferredDistricts[0].name, teams[1].preferredPincodes[0]], ['Kozhikode', PIN.feroke]);
  // and changes them later
  const r = await api('PUT', `/artist-teams/${teams[2].id}`, crm, { preferredDistrictIds: [String(klm._id)] });
  assert.equal(r.status, 200, r.text);
  assert.equal((await api('PUT', `/artist-teams/${teams[2].id}`, crm, { preferredDistrictIds: [] })).status, 200);
});

console.log('\n— switching it on —');
await sleep(1100); // bookings from here on are "new"
await check('only an admin turns on automatic allocation; the CRM Head can\'t; the settings say so', async () => {
  const on = await api('PUT', '/allocation/settings', admin, { mode: 'suggest' });
  assert.equal(on.body.autoOn, false, 'suggest alone does not allocate on its own');
  assert.equal((await api('PUT', '/allocation/settings', crmHead, { autoAllocate: 'on' })).status, 403);
  assert.equal((await api('PUT', '/allocation/settings', admin, { autoAllocate: 'maybe' })).status, 400);
  const r = await api('PUT', '/allocation/settings', admin, { autoAllocate: 'on' });
  assert.deepEqual([r.status, r.body.autoAllocate, r.body.autoOn], [200, 'on', true]);
});

console.log('\n— 2. a salesperson books: the system assigns —');
let kz;
await check('Sam books in Kozhikode → Nihala (prefers Kozhikode) is put on at once: lead + assistant, slot M1, decided "auto"; she is told', async () => {
  const r = await book(sales, { client: 'Amina K', start: '10:30', end: '12:30' });
  assert.equal(r.status, 201, r.text);
  kz = r.body;
  assert.equal(kz.status, 'confirmed');
  assert.deepEqual(kz.allocation.units.map((u) => [u.status, u.teamName]), [['assigned', 'Team Nihala']]);
  assert.equal(kz.allocation.units[0].reason, 'Starts a new route — prefers Kozhikode');
  assert.deepEqual(kz.assignedStaff.map((s) => [s.artistName, s.roleType]), [['Nihala', 'lead'], ["Nihala's assistant", 'assistant']], 'the response already carries the team');
  const row = await ArtistAllocation.findOne({ bookingId: kz._id, kind: 'allocation', active: true }).lean();
  assert.deepEqual([row.slotKey, row.decision, row.source, row.decidedByName], ['M1', 'auto', 'create', 'Automatic (confirmed by Sam)']);
  assert.ok(await Notification.findOne({ recipient: artist.id, type: 'artist_assigned' }).lean(), 'Nihala is told');
  assert.equal(await Notification.countDocuments({ recipient: sales.id, type: 'booking_artist_assigned' }), 0, 'Sam saw it on screen — no notification to himself');
});
await check('Sam reads his booking\'s artist: Team Nihala, Nihala with her assistant, given automatically', async () => {
  const s = await api('GET', `/allocation/booking/${kz._id}/status`, sales);
  assert.equal(s.status, 200, s.text);
  assert.deepEqual([s.body.auto, s.body.eligible, s.body.units.length], [true, true, 1]);
  const u = s.body.units[0];
  assert.deepEqual([u.status, u.teamName, u.lead, u.assistants, u.how], ['assigned', 'Team Nihala', 'Nihala', ["Nihala's assistant"], 'auto']);
  // sales reads one booking's status — not the board, the suggestions or the teams
  assert.equal((await api('GET', `/allocation/booking/${kz._id}`, sales)).status, 403);
  assert.equal((await api('GET', `/allocation/day?date=${D}`, sales)).status, 403);
  assert.equal((await api('GET', `/allocation/booking/${kz._id}/status`, artist)).status, 403, 'an artist does not');
});
await check('the next booking near her Kozhikode job continues Nihala\'s route (Feroke, 1:30 PM → slot M2)', async () => {
  const r = await book(sales, { client: 'Neha R', pin: PIN.feroke, start: '13:30', end: '15:00' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.allocation.units[0].teamName, 'Team Nihala');
  assert.match(r.body.allocation.units[0].reason, /^Same area as her 10:30 AM Kozhikode job — \d+ min/);
  const row = await ArtistAllocation.findOne({ bookingId: r.body._id, kind: 'allocation', active: true }).lean();
  assert.equal(row.slotKey, 'M2');
});

console.log('\n— doubtful ones wait for CRM —');
let kollam;
await check('nobody prefers Kollam: the booking waits, Sam sees why, the CRM team is told (Sam is not)', async () => {
  const r = await book(sales, { client: 'Diya', pin: PIN.kollam, start: '10:00', end: '12:00' });
  assert.equal(r.status, 201, r.text);
  kollam = r.body;
  assert.deepEqual([kollam.allocation.units[0].status, kollam.assignedStaff.length], ['waiting', 0]);
  assert.match(kollam.allocation.units[0].reason, /^No free artist has Kollam as a preferred location/);
  assert.equal(await ArtistAllocation.countDocuments({ bookingId: kollam._id, active: true }), 0, 'no slot is held');
  for (const who of [crm, crmHead]) {
    const note = await Notification.findOne({ recipient: who.id, type: 'allocation_needed', bookingId: kollam._id }).lean();
    assert.ok(note, `${who.name} is told`);
    assert.match(note.body, /Kollam as a preferred location/);
  }
  assert.equal(await Notification.countDocuments({ recipient: sales.id, type: 'allocation_needed' }), 0);
  const s = await api('GET', `/allocation/booking/${kollam._id}/status`, sales);
  assert.equal(s.body.units[0].status, 'waiting');
  assert.match(s.body.units[0].reason, /^Waiting for CRM — No free artist has Kollam/);
});
await check('CRM gives it on the Board → the team is written and Sam hears which one', async () => {
  const sug = await api('GET', `/allocation/booking/${kollam._id}`, crm);
  const top = sug.body.units[0].candidates[0];
  const c = await api('POST', '/allocation/confirm', crm, { bookingId: String(kollam._id), picks: [{ unitKey: 'b', teamId: top.teamId }], source: 'board' });
  assert.equal(c.status, 200, c.text);
  const note = await Notification.findOne({ recipient: sales.id, type: 'booking_artist_assigned', bookingId: kollam._id }).lean();
  assert.ok(note, 'Sam is told');
  assert.match(note.body, new RegExp(`Diya .*${top.teamName}`));
  const s = await api('GET', `/allocation/booking/${kollam._id}/status`, sales);
  assert.deepEqual([s.body.units[0].status, s.body.units[0].how, s.body.units[0].teamName], ['assigned', 'crm', top.teamName]);
});
await check('a booking with no start time waits ("add it"); one made with its artist already chosen is left as it is', async () => {
  const r = await book(sales, { client: 'No Time', noTime: true });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.allocation.units[0].status, r.body.allocation.units[0].reason], ['waiting', 'The booking has no start time — add it so the route can be checked']);
  const withArtist = await book(crm, { client: 'Chosen', pin: PIN.kollam, start: '07:00', end: '08:00', staff: [{ employeeId: String(leads[2]._id), artistName: 'Sandra', roleType: 'lead' }] });
  assert.equal(withArtist.status, 201, withArtist.text);
  assert.deepEqual(withArtist.body.allocation.units.map((u) => u.status), ['had_artist']);
  assert.equal(withArtist.body.assignedStaff[0].artistName, 'Sandra');
});

console.log('\n— a request CRM accepts —');
await check('a public request (credited to Tara) is accepted by CRM → assigned at that moment; Tara hears of it', async () => {
  // Nihala's last job ends 3:00 PM in Feroke: a 4:30 PM Kozhikode reception continues her route in the evening slot
  const req = await Booking.create({
    bookingNumber: 'REQ-1', customerName: 'Fathima S', phone: '9897100001', email: 'f@client.test', service: 'Reception', totalPrice: 15000, status: 'pending', origin: 'public',
    bookingDate: new Date(iso(D, '00:00')), selectedDates: [D], serviceStart: new Date(iso(D, '16:30')), serviceEnd: new Date(iso(D, '18:30')),
    pincode: PIN.calicut, districtId: kkd._id, salesPersonId: sales2.id,
  });
  const pre = await api('GET', `/allocation/booking/${req._id}/status`, sales2);
  assert.deepEqual([pre.body.units[0].status, pre.body.units[0].reason], ['waiting', 'The artist is assigned once the booking is confirmed']);
  const full = (await api('GET', `/bookings/${req._id}`, crm)).body;
  const put = await api('PUT', `/bookings/${req._id}`, crm, { ...full, status: 'confirmed' });
  assert.equal(put.status, 200, put.text);
  assert.deepEqual(put.body.allocation.units.map((u) => [u.status, u.teamName]), [['assigned', 'Team Nihala']]);
  assert.equal(put.body.assignedStaff[0].artistName, 'Nihala');
  const row = await ArtistAllocation.findOne({ bookingId: req._id, kind: 'allocation', active: true }).lean();
  assert.deepEqual([row.slotKey, row.decision, row.decidedByName], ['E1', 'auto', 'Automatic (confirmed by Sana)']);
  const note = await Notification.findOne({ recipient: sales2.id, type: 'booking_artist_assigned' }).lean();
  assert.ok(note, 'Tara is told');
  assert.match(note.body, /Fathima S .*Team Nihala, assigned automatically/);
  // saving it again (already confirmed) does not re-run anything
  const again = await api('PUT', `/bookings/${req._id}`, crm, { ...put.body, notes: 'saved again' });
  assert.equal(again.body.allocation, undefined);
});
await check('Nihala\'s day is now full (M1, M2, E1): the next Kozhikode morning booking waits — no extra slot is asked for on its own', async () => {
  const r = await book(sales, { client: 'Peak Day', start: '08:00', end: '09:30', pin: PIN.calicut });
  assert.equal(r.status, 201, r.text);
  const u = r.body.allocation.units[0];
  // Irfana (Kollam at 10:00) and Sandra (Kollam at 7:00) can't make it; Nihala fits only as an EXTRA — the Artist Head's call, so CRM decides
  assert.deepEqual([u.status, u.reason], ['waiting', "Every morning slot that day is full — CRM decides (an extra slot needs the Artist Head's OK)"]);
  assert.equal(await ArtistAllocation.countDocuments({ extra: true }), 0, 'never an EXTRA without a person');
});

console.log('\n— the Add Booking form shows the artist before saving —');
await check('Edappal (a pincode NOT in our list; the place lookup filed it under Malappuram): the form shows Sandra\'s team, then the booking goes to her', async () => {
  const mlp = await District.create({ name: 'Malappuram', region: north._id });
  await GeoCache.create({ key: 'pin:679576', status: 'ok', lat: 10.7867, lng: 75.9781, district: 'Malappuram District', label: 'Edappal' });
  assert.equal(await Pincode.countDocuments({ code: '679576' }), 0, 'not in the pincode list');
  assert.equal((await api('PUT', `/artist-teams/${teams[2].id}`, crm, { preferredDistrictIds: [String(mlp._id)] })).status, 200);
  _resetTeamCache();
  // only the pincode typed: the area and who prefers it
  const area = await api('POST', '/allocation/preview', sales, { pincode: '679576' });
  assert.equal(area.status, 200, area.text);
  assert.deepEqual([area.body.on, area.body.auto, area.body.area.districtName, area.body.units.length], [true, true, 'Malappuram', 0]);
  assert.deepEqual(area.body.area.preferredTeams.map((t) => [t.teamName, t.lead, t.assistants, t.match]), [['Team Sandra', 'Sandra', ["Sandra's assistant"], 'district']]);
  // half a pincode: nothing known yet
  const half = await api('POST', '/allocation/preview', sales, { pincode: '67' });
  assert.deepEqual([half.body.area.pincode, half.body.area.preferredTeams.length], ['', 0]);
  // the event day and time added: she would take it, automatically
  const day = addDays(D, 5);
  const full = await api('POST', '/allocation/preview', sales, { pincode: '679576', selectedDates: [`${day}T00:00:00.000`], bookingItems: [{ service: 'Bridal Makeup', selectedDates: [`${day}T00:00:00.000`], startTime: '10:00', endTime: '12:00' }] });
  assert.equal(full.status, 200, full.text);
  const u = full.body.units[0];
  assert.deepEqual([u.ok, u.top.teamName, u.reason, u.label], [true, 'Team Sandra', 'Starts a new route — prefers Malappuram', 'Bridal Makeup']);
  assert.equal(await ArtistAllocation.countDocuments({ day }), 0, 'a preview writes nothing');
  // saved: the same answer
  const r = await book(sales, { client: 'Edappal Bride', day, pin: '679576', noDistrict: true, start: '10:00', end: '12:00' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual(r.body.allocation.units.map((x) => [x.status, x.teamName]), [['assigned', 'Team Sandra']]);
  // an artist can't ask; with the allocation off the form shows nothing
  assert.equal((await api('POST', '/allocation/preview', artist, { pincode: '679576' })).status, 403);
  await api('PUT', '/allocation/settings', admin, { mode: 'off' });
  assert.deepEqual((await api('POST', '/allocation/preview', sales, { pincode: '679576' })).body.on, false);
  await api('PUT', '/allocation/settings', admin, { mode: 'suggest' });
});

console.log('\n— off —');
await check('automatic allocation off (suggest stays): a new booking waits for CRM as before; the kill switch wins too', async () => {
  await api('PUT', '/allocation/settings', admin, { autoAllocate: 'off' });
  const r = await book(sales, { client: 'Off Day', day: addDays(D, 1), start: '10:30', end: '12:30' });
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.allocation, r.body.assignedStaff.length], [undefined, 0]);
  const s = await api('GET', `/allocation/booking/${r.body._id}/status`, sales);
  assert.deepEqual([s.body.auto, s.body.units[0].status], [false, 'waiting']);
  await api('PUT', '/allocation/settings', admin, { autoAllocate: 'on' });
  process.env.ARTIST_AUTO_ALLOCATE = 'off';
  const k = await book(sales, { client: 'Kill Switch', day: addDays(D, 2), start: '10:30', end: '12:30' });
  assert.deepEqual([k.body.allocation, k.body.assignedStaff.length], [undefined, 0]);
  process.env.ARTIST_AUTO_ALLOCATE = '';
  const on = await book(sales, { client: 'Back On', day: addDays(D, 3), start: '10:30', end: '12:30' });
  assert.equal(on.body.allocation.units[0].teamName, 'Team Nihala');
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
