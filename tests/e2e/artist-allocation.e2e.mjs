// End-to-end check of the SMART BOOKING ALLOCATION (/api/allocation, /api/artist-teams, and the booking saves that feed it):
// the teams set up on Artist Management; for a NEW booking the teams ranked (the deck's rule — the same artist while the route fits,
// else the next in rotation); the coordinator's confirm (lead + assistants written on the package, the slot held once, the artist
// told); two coordinators racing for one slot; EXTRA slots waiting for the Artist Head; bookings from before go-live left alone (but
// still busy time); the rows following later edits; leave; shadow mode's match figures; the Allocation Board.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/artist-allocation.e2e.mjs
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound key is blanked (the code loads the real .env, which never overrides a set variable)
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'DROPBOX_ACCESS_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'ARTIST_ALLOCATION', 'ARTIST_ASSIGNMENT_GUARD']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/artist_allocation_e2e');
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
const LeaveRequest = await imp('models/LeaveRequest.js');
const Notification = await imp('models/Notification.js');
const ArtistAllocation = await imp('models/ArtistAllocation.js');
const ArtistTeam = await imp('models/ArtistTeam.js');
const AllocationSettings = await imp('models/AllocationSettings.js');
const { ensureDefaultRoles } = await mod('controllers/roleController.js');
const { sanitizeErrorResponses, errorHandler } = await mod('middleware/errorMiddleware.js');
const { _resetTeamCache } = await mod('services/artistTeams.js');
const { addDays, istDayKey } = await mod('utils/istDate.js');
await mod('utils/asyncErrors.js');
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
await ArtistAllocation.init(); // the slot locks must exist before two confirms race
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
const api = async (method, path, who, body, headers = {}) => {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
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

// ── the world: places, people, logins ────────────────────────────────────────
const region = await Region.create({ name: 'Kerala North' });
const south = await Region.create({ name: 'Kerala South' });
const kkd = await District.create({ name: 'Calicut', region: region._id });
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
  const user = await User.create({ name, email: `a${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const NAMES = ['Nihala', 'Irfana', 'Sandra', 'Fidha', 'Anagha', 'Nedha'];
const leads = [];
const assistants = [];
for (const [i, name] of NAMES.entries()) {
  leads.push(await Employee.create({ name, phone: `90000000${i}0`, artistRole: 'artist', status: 'active', type: 'in-house', specialization: 'Bridal' }));
  assistants.push(await Employee.create({ name: `${name}'s assistant`, phone: `90000000${i}1`, artistRole: 'assistant', status: 'active', type: 'in-house' }));
}
const freelancer = await Employee.create({ name: 'Freelancer', artistRole: 'artist', status: 'active', isAssociate: true, type: 'outsource' });
const admin = await login('Admin', 'admin');
const crmHead = await login('Riya', 'crm_manager');
const crm = await login('Sana', 'crm');
const artistHead = await login('Shabna', 'artist_head');
const sales = await login('Sam', 'sales');
const ceo = await login('Chief', 'ceo');
const nihalaUser = await login('Nihala', 'artist', { employeeId: leads[0]._id });

const D = addDays(istDayKey(new Date()), 10);
const D2 = addDays(D, 1);
const at = (day, hhmm) => new Date(`${day}T${hhmm}:00+05:30`);
let seq = 0;
const makeBooking = (o = {}) => {
  seq += 1;
  const day = o.day ?? D;
  return Booking.create({
    bookingNumber: o.number ?? `BK-${3000 + seq}`,
    customerName: o.client ?? `Client ${seq}`,
    phone: `98000000${String(seq).padStart(2, '0')}`,
    email: `client${seq}@e2e.test`,
    service: 'Bridal Makeup',
    totalPrice: 20000,
    status: o.status ?? 'confirmed',
    origin: o.status === 'pending' ? 'public' : 'staff',
    bookingDate: at(day, '00:00'),
    selectedDates: [day],
    serviceStart: at(day, o.start ?? '09:00'),
    serviceEnd: at(day, o.end ?? '11:00'),
    pincode: o.pin ?? PIN.calicut,
    districtId: o.pin === PIN.kollam ? klm._id : kkd._id,
    assignedStaff: o.staff ?? [],
    bookingItems: o.items,
  });
};
const leadOn = (i) => ({ employeeId: leads[i]._id, artistName: NAMES[i], roleType: 'lead' });

console.log('\n— Artist Management —');
let teams;
await check('the CRM Head sets up the six teams (any CRM member may too; the CEO only looks); she can\'t lead two; a main artist is no one\'s assistant', async () => {
  // a CRM member is let in (the whole CRM team keeps the teams) — this one only forgot the main artist
  assert.equal((await api('POST', '/artist-teams', crm, {})).status, 400);
  assert.equal((await api('PUT', '/allocation/settings', crm, { travelLimitMin: 30 })).status, 403, 'the rules stay with the heads');
  assert.equal((await api('POST', '/artist-teams', ceo, { leadEmployeeId: String(leads[0]._id) })).status, 403);
  assert.equal((await api('GET', '/artist-teams', ceo)).status, 200, 'the CEO reads');
  assert.equal((await api('GET', '/artist-teams', sales)).status, 403);
  for (const [i] of NAMES.entries()) {
    const r = await api('POST', '/artist-teams', crmHead, { leadEmployeeId: String(leads[i]._id), assistantEmployeeIds: [String(assistants[i]._id)], preferredDistrictIds: i === 3 ? [String(klm._id)] : [] });
    assert.equal(r.status, 201, r.text);
  }
  assert.equal((await api('POST', '/artist-teams', crmHead, { leadEmployeeId: String(leads[0]._id) })).status, 409);
  const asstLead = await api('POST', '/artist-teams', crmHead, { leadEmployeeId: String(leads[0]._id), assistantEmployeeIds: [String(leads[1]._id)] });
  assert.ok([400, 409].includes(asstLead.status));
  const assoc = await api('POST', '/artist-teams', crmHead, { leadEmployeeId: String(freelancer._id) });
  assert.equal(assoc.status, 400);
  assert.match(assoc.body.message, /in-house artist/);
  const list = await api('GET', `/artist-teams?day=${D}`, crmHead);
  teams = list.body.teams;
  assert.deepEqual(teams.map((t) => t.name), NAMES.map((x) => `Team ${x}`));
  assert.deepEqual([teams[0].slots, teams[0].assistants[0].name, teams[3].preferredDistricts[0].name], [{ morning: 2, evening: 1 }, "Nihala's assistant", 'Kollam']);
  const cand = await api('GET', '/artist-teams/candidates', crm);
  assert.ok(cand.body.people.find((p) => p.name === 'Nihala').leadsTeam);
});
await check('the rotation is reordered by sending every team once', async () => {
  const ids = teams.map((t) => t.id);
  assert.equal((await api('PUT', '/artist-teams/order', crmHead, { ids: ids.slice(1) })).status, 400);
  const r = await api('PUT', '/artist-teams/order', crmHead, { ids: [ids[1], ids[0], ...ids.slice(2)] });
  assert.deepEqual(r.body.teams.slice(0, 2).map((t) => t.name), ['Team Irfana', 'Team Nihala']);
  await api('PUT', '/artist-teams/order', crmHead, { ids });
});

console.log('\n— going live: only new bookings —');
const D0 = addDays(D, -1); // a day of its own for the booking from before go-live (so the deck's example on D is untouched)
const oldBooking = await makeBooking({ day: D0, start: '09:00', end: '11:00', staff: [leadOn(3)] }); // Fidha, booked before go-live
await sleep(1100);
await check('only an admin switches the allocation on; that moment is when "new bookings" begin', async () => {
  assert.equal((await api('PUT', '/allocation/settings', crmHead, { mode: 'suggest' })).status, 403);
  const ok = await api('PUT', '/allocation/settings', crmHead, { travelLimitMin: 30, eveningCutoff: '14:00' });
  assert.equal(ok.status, 200, ok.text);
  const r = await api('PUT', '/allocation/settings', admin, { mode: 'suggest' });
  assert.equal(r.body.mode, 'suggest');
  assert.ok(r.body.liveSince);
});
await check('a booking from before go-live: no suggestions, no confirm — but its artist is busy for the new ones', async () => {
  const s = await api('GET', `/allocation/booking/${oldBooking._id}`, crm);
  assert.deepEqual([s.status, s.body.eligible, s.body.units.length], [200, false, 0]);
  const c = await api('POST', '/allocation/confirm', crm, { bookingId: String(oldBooking._id), picks: [{ unitKey: 'b', teamId: teams[0].id }] });
  assert.deepEqual([c.status, c.body.code], [409, 'NOT_NEW']);
  const probe = await makeBooking({ day: D0, start: '09:30', end: '10:30' });
  const r = await api('GET', `/allocation/booking/${probe._id}`, crm);
  assert.match(r.body.units[0].candidates.find((x) => x.teamName === 'Team Fidha').reason, /^Already on #BK-\d+ 9:00 AM–11:00 AM$/);
  await Booking.deleteOne({ _id: probe._id });
});

console.log('\n— the deck\'s example —');
let b1;
let b2;
let b3;
await check('a public request is confirmed, then allocated: Nihala starts the route — lead + assistant on the package, slot M1, she is told', async () => {
  b1 = await makeBooking({ number: 'B1', status: 'pending', start: '09:00', end: '11:00', items: [{ service: 'Bridal Makeup' }] });
  const pre = await api('GET', `/allocation/booking/${b1._id}`, crm);
  assert.equal(pre.body.eligible, true);
  const top = pre.body.units[0].candidates[0];
  assert.deepEqual([top.teamName, top.tier, top.reason], ['Team Nihala', 'new_route', 'Starts a new route — next in rotation']);
  // the request is confirmed (the CRM's step), then the team is confirmed
  const full = (await api('GET', `/bookings/${b1._id}`, crm)).body;
  const put = await api('PUT', `/bookings/${b1._id}`, crm, { ...full, status: 'confirmed' });
  assert.equal(put.status, 200, put.text);
  const c = await api('POST', '/allocation/confirm', crm, { bookingId: String(b1._id), bookingUpdatedAt: put.body.updatedAt, picks: [{ unitKey: 'i:0', teamId: top.teamId }], source: 'requests' });
  assert.equal(c.status, 200, c.text);
  assert.deepEqual(c.body.results[0].slotKeys, ['M1']);
  const after = await Booking.findById(b1._id).lean();
  assert.deepEqual(after.bookingItems[0].assignedStaff.map((s) => [s.artistName, s.roleType]), [['Nihala', 'lead'], ["Nihala's assistant", 'assistant']]);
  assert.deepEqual(after.assignedStaff.map((s) => s.artistName), ['Nihala', "Nihala's assistant"]);
  const row = await ArtistAllocation.findOne({ bookingId: b1._id, kind: 'allocation', active: true }).lean();
  assert.deepEqual([row.slotKey, row.decision, row.suggestion.chosenRank], ['M1', 'accepted', 1]);
  const note = await Notification.findOne({ recipient: nihalaUser.id, type: 'artist_assigned' }).lean();
  assert.ok(note, 'Nihala is told');
  assert.match(note.body, /#B1/);
});
await check('B2 nearby continues Nihala\'s route; B3 in Kollam goes to Irfana — and the rotation moves on', async () => {
  b2 = await makeBooking({ number: 'B2', pin: PIN.feroke, start: '12:00', end: '14:00' });
  const s2 = await api('GET', `/allocation/booking/${b2._id}`, crm);
  const t2 = s2.body.units[0].candidates[0];
  assert.deepEqual([t2.teamName, t2.tier], ['Team Nihala', 'continue']);
  assert.match(t2.reason, /^Same area as her 9:00 AM Calicut job — \d+ min/);
  assert.equal((await api('POST', '/allocation/confirm', crm, { bookingId: String(b2._id), picks: [{ unitKey: 'b', teamId: t2.teamId }] })).status, 200);
  b3 = await makeBooking({ number: 'B3', pin: PIN.kollam, start: '16:00', end: '19:00' });
  const s3 = await api('GET', `/allocation/booking/${b3._id}`, crm);
  const t3 = s3.body.units[0].candidates[0];
  assert.deepEqual([t3.teamName, t3.tier], ['Team Fidha', 'new_route'], 'Fidha prefers Kollam: the new Kollam route is hers');
  assert.equal(t3.reason, 'Starts a new route — prefers Kollam');
  // without that preference the next in rotation (Irfana) starts it — the deck's example
  const pref = await api('PUT', `/artist-teams/${teams[3].id}`, crmHead, { preferredDistrictIds: [] });
  assert.equal(pref.status, 200, pref.text);
  const again = (await api('GET', `/allocation/booking/${b3._id}`, crm)).body.units[0].candidates[0];
  assert.deepEqual([again.teamName, again.tier], ['Team Irfana', 'new_route']);
  await api('PUT', `/artist-teams/${teams[3].id}`, crmHead, { preferredDistrictIds: [String(klm._id)] });
  assert.match(s3.body.units[0].candidates.find((c) => c.teamName === 'Team Nihala').reason, /^Can't be ready/);
  assert.equal((await api('POST', '/allocation/confirm', crm, { bookingId: String(b3._id), picks: [{ unitKey: 'b', teamId: again.teamId }] })).status, 200);
  const st = await AllocationSettings.findOne({}).lean();
  assert.equal(String(st.rotation.lastStartedTeamId), teams[1].id);
});
await check('choosing another team is an override, with the reason kept; a stale screen is refused (BOOKING_CHANGED)', async () => {
  const b = await makeBooking({ pin: PIN.calicut, start: '15:00', end: '16:30' });
  const s = await api('GET', `/allocation/booking/${b._id}`, crm);
  const second = s.body.units[0].candidates.find((c) => c.tier !== 'blocked' && !c.recommended);
  const stale = await api('POST', '/allocation/confirm', crm, { bookingId: String(b._id), bookingUpdatedAt: '2020-01-01T00:00:00.000Z', picks: [{ unitKey: 'b', teamId: second.teamId }] });
  assert.deepEqual([stale.status, stale.body.code], [409, 'BOOKING_CHANGED']);
  const r = await api('POST', '/allocation/confirm', crm, { bookingId: String(b._id), bookingUpdatedAt: s.body.updatedAt, picks: [{ unitKey: 'b', teamId: second.teamId, overrideReason: 'Client asked for her' }] });
  assert.equal(r.status, 200, r.text);
  const row = await ArtistAllocation.findOne({ bookingId: b._id, active: true }).lean();
  assert.deepEqual([row.decision, row.overrideReason], ['override', 'Client asked for her']);
});
await check('someone saves the booking just as the team is written: refused (BOOKING_CHANGED), the slot let go, nothing half-done', async () => {
  const { _setBeforeStaffWrite } = await mod('services/artistAllocation.js');
  const b = await makeBooking({ start: '07:00', end: '08:00', pin: PIN.calicut });
  _setBeforeStaffWrite(async () => {
    await Booking.updateOne({ _id: b._id }, { $set: { notes: 'edited by someone else meanwhile' } });
  });
  const r = await api('POST', '/allocation/confirm', crm, { bookingId: String(b._id), picks: [{ unitKey: 'b', teamId: teams[4].id }] });
  _setBeforeStaffWrite(null);
  assert.deepEqual([r.status, r.body.code], [409, 'BOOKING_CHANGED'], r.text);
  assert.equal(await ArtistAllocation.countDocuments({ bookingId: b._id, active: true }), 0, 'the slot it took is let go');
  assert.equal((await Booking.findById(b._id).lean()).assignedStaff.length, 0);
});
await check('two coordinators take the same last slot at once: one gets it, the other is told (SLOT_TAKEN)', async () => {
  // Nedha's evening: one slot (both works fit her clock — only the slot is in question)
  const e1 = await makeBooking({ start: '15:00', end: '16:30', pin: PIN.calicut });
  const e2 = await makeBooking({ start: '17:30', end: '19:00', pin: PIN.calicut });
  const sandra = teams[5].id;
  const [a, b] = await Promise.all([
    api('POST', '/allocation/confirm', crm, { bookingId: String(e1._id), picks: [{ unitKey: 'b', teamId: sandra }] }),
    api('POST', '/allocation/confirm', crmHead, { bookingId: String(e2._id), picks: [{ unitKey: 'b', teamId: sandra }] }),
  ]);
  const codes = [a, b].map((r) => (r.status === 200 ? 'ok' : r.body.code)).sort();
  assert.deepEqual(codes, ['SLOT_TAKEN', 'ok'], JSON.stringify([a.body, b.body]));
  const loser = a.status === 200 ? e2 : e1;
  assert.equal((await Booking.findById(loser._id).lean()).assignedStaff.length, 0, 'nothing written for the one refused');
});

console.log('\n— a peak day: EXTRA slots —');
await check('every morning slot full → the best fit gets an EXTRA that waits for the Artist Head; her yes writes the team', async () => {
  for (let i = 0; i < 6; i += 1) {
    await makeBooking({ day: D2, start: '07:00', end: '08:30', staff: [leadOn(i)] });
    await makeBooking({ day: D2, start: '09:30', end: '11:00', pin: i === 2 ? PIN.feroke : PIN.kollam, staff: [leadOn(i)] });
  }
  const x = await makeBooking({ day: D2, number: 'X1', pin: PIN.feroke, start: '12:00', end: '13:30' });
  const s = await api('GET', `/allocation/booking/${x._id}`, crm);
  const top = s.body.units[0].candidates[0];
  assert.deepEqual([top.teamName, top.tier, top.needsApproval], ['Team Sandra', 'extra', true]);
  const c = await api('POST', '/allocation/confirm', crm, { bookingId: String(x._id), picks: [{ unitKey: 'b', teamId: top.teamId }] });
  assert.equal(c.status, 200, c.text);
  assert.deepEqual([c.body.results[0].approval, c.body.results[0].slotKeys[0]], ['pending', 'X1']);
  assert.equal((await Booking.findById(x._id).lean()).assignedStaff.length, 0, 'not written before the yes');
  assert.ok(await Notification.findOne({ type: 'extra_slot_request' }).lean(), 'the Artist Head is asked');
  const row = await ArtistAllocation.findOne({ bookingId: x._id, active: true }).lean();
  assert.equal((await api('POST', `/allocation/${row._id}/approve`, crm)).status, 403, 'a CRM member can not OK it');
  const yes = await api('POST', `/allocation/${row._id}/approve`, artistHead);
  assert.equal(yes.status, 200, yes.text);
  assert.equal((await Booking.findById(x._id).lean()).assignedStaff[0].artistName, 'Sandra');
});
await check('the second extra of the day; a third is not offered — and forcing it needs "assign anyway"', async () => {
  // in Kollam at noon: the teams whose 9:30 job is in Kollam can be there — their morning is full, so it is an extra
  const y = await makeBooking({ day: D2, pin: PIN.kollam, start: '12:00', end: '13:00' });
  const s = await api('GET', `/allocation/booking/${y._id}`, artistHead);
  const top = s.body.units[0].candidates[0];
  assert.equal(top.tier, 'extra');
  const c = await api('POST', '/allocation/confirm', artistHead, { bookingId: String(y._id), picks: [{ unitKey: 'b', teamId: top.teamId }] });
  assert.equal(c.body.results[0].approval, 'approved', 'the Artist Head\'s own extra needs no second OK');
  const z = await makeBooking({ day: D2, pin: PIN.kollam, start: '12:15', end: '13:00' });
  const s3 = await api('GET', `/allocation/booking/${z._id}`, crm);
  assert.ok(s3.body.units[0].candidates.every((x) => x.tier === 'blocked'));
  const forced = await api('POST', '/allocation/confirm', crm, { bookingId: String(z._id), picks: [{ unitKey: 'b', teamId: teams[5].id }] });
  assert.deepEqual([forced.status, forced.body.code], [409, 'ARTIST_CONFLICT']);
  assert.ok(forced.body.problems.length);
});

console.log('\n— the rows follow later edits —');
await check('Manage Booking takes the lead off → her slot is let go; a cancelled booking lets all go', async () => {
  const full = (await api('GET', `/bookings/${b2._id}`, crm)).body;
  const r = await api('PUT', `/bookings/${b2._id}`, crm, { ...full, assignedStaff: [] });
  assert.equal(r.status, 200, r.text);
  assert.equal(await ArtistAllocation.countDocuments({ bookingId: b2._id, active: true, kind: 'allocation' }), 0);
  const full3 = (await api('GET', `/bookings/${b3._id}`, crm)).body;
  await api('PUT', `/bookings/${b3._id}`, crm, { ...full3, status: 'cancelled' });
  const rows = await ArtistAllocation.find({ bookingId: b3._id, kind: 'allocation' }).lean();
  assert.ok(rows.length && rows.every((x) => !x.active && x.releasedReason === 'cancelled'));
});
await check('a lead put on by hand (Manage Booking) takes her slot as a manual allocation; one from Suggest is recorded as such', async () => {
  const b = await makeBooking({ pin: PIN.calicut, start: '15:00', end: '16:00' });
  const full = (await api('GET', `/bookings/${b._id}`, crm)).body;
  const r = await api('PUT', `/bookings/${b._id}`, crm, { ...full, assignedStaff: [leadOn(4)], allocationIntent: { unitKey: 'b', teamId: teams[4].id, chosenRank: 2, overrideReason: 'Better route' } });
  assert.equal(r.status, 200, r.text);
  const row = await ArtistAllocation.findOne({ bookingId: b._id, active: true, kind: 'allocation' }).lean();
  assert.deepEqual([row.slotKey, row.decision, row.overrideReason, String(row.teamId)], ['E1', 'override', 'Better route', teams[4].id]);
});
await check('approved leave keeps a team out', async () => {
  await LeaveRequest.create({ employeeId: leads[4]._id, fromDate: at(D, '00:00'), toDate: at(D, '23:00'), status: 'approved' });
  const b = await makeBooking({ pin: PIN.calicut, start: '07:00', end: '08:00' });
  const s = await api('GET', `/allocation/booking/${b._id}`, crm);
  assert.match(s.body.units[0].candidates.find((c) => c.teamName === 'Team Anagha').reason, /on leave/);
});

console.log('\n— the clash guard (Manage Booking saves) —');
await check('guard on: a lead put on a new booking while already on another work → 409 ARTIST_CONFLICT; "assign anyway" saves; a status-only save is never stopped', async () => {
  await api('PUT', '/allocation/settings', admin, { guard: 'on' });
  // Irfana is on B3 16:00–19:00 (cancelled since) — use Nedha, on the 15:00 work from the race
  const nedhaWork = await ArtistAllocation.findOne({ teamId: teams[5].id, active: true, kind: 'allocation', day: D }).lean();
  assert.ok(nedhaWork, 'Nedha has a work on D');
  const b = await makeBooking({ start: nedhaWork.start, end: nedhaWork.end });
  const full = (await api('GET', `/bookings/${b._id}`, crm)).body;
  const blocked = await api('PUT', `/bookings/${b._id}`, crm, { ...full, assignedStaff: [leadOn(5)] });
  assert.deepEqual([blocked.status, blocked.body.code], [409, 'ARTIST_CONFLICT'], blocked.text);
  assert.match(blocked.body.problems[0].reason, /^Already on #BK-\d+/);
  assert.equal((await Booking.findById(b._id).lean()).assignedStaff.length, 0, 'not saved');
  const forced = await api('PUT', `/bookings/${b._id}`, crm, { ...full, assignedStaff: [leadOn(5)] }, { 'X-Confirm-Artist-Conflict': '1' });
  assert.equal(forced.status, 200, forced.text);
  // a status-only change of that booking passes, however its staff stands
  const again = (await api('GET', `/bookings/${b._id}`, crm)).body;
  assert.equal((await api('PUT', `/bookings/${b._id}`, crm, { ...again, status: 'confirmed' })).status, 200);
  // a booking from before go-live is never stopped
  const old = (await api('GET', `/bookings/${oldBooking._id}`, crm)).body;
  const probe = await makeBooking({ day: D0, start: '09:00', end: '11:00', staff: [leadOn(0)] });
  assert.ok(probe);
  assert.equal((await api('PUT', `/bookings/${oldBooking._id}`, crm, { ...old, assignedStaff: [leadOn(0)] })).status, 200);
  await api('PUT', '/allocation/settings', admin, { guard: 'off' });
  // guard off → the same clash saves
  const c = await makeBooking({ start: nedhaWork.start, end: nedhaWork.end });
  const fc = (await api('GET', `/bookings/${c._id}`, crm)).body;
  assert.equal((await api('PUT', `/bookings/${c._id}`, crm, { ...fc, assignedStaff: [leadOn(5)] })).status, 200);
});

console.log('\n— the Allocation Board —');
await check('the day: each team\'s slots in rotation order, the new works with no artist yet (with a suggestion), extras', async () => {
  const r = await api('GET', `/allocation/day?date=${D}`, crm);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.teams.map((t) => t.name), NAMES.map((x) => `Team ${x}`));
  const nihala = r.body.teams[0];
  assert.deepEqual(nihala.slots.filter((s) => s.half === 'morning').map((s) => s.job?.bookingNumber ?? null), ['B1', null], 'B2 was taken off her');
  // each taken slot names its client (the board's slot card shows who it is for)
  const b1Slot = nihala.slots.find((s) => s.job?.bookingNumber === 'B1');
  assert.deepEqual([b1Slot.job.customerName, b1Slot.job.start, b1Slot.job.end], [(await Booking.findById(b1._id).lean()).customerName, '09:00', '11:00']);
  // the week the day is in (Mon–Sun), each day counted — the little lines on the board's cards
  assert.equal(r.body.week.length, 7);
  assert.ok(r.body.week.some((w) => w.day === D));
  const wd = r.body.week.find((w) => w.day === D);
  assert.deepEqual([wd.booked, wd.toAllocate], [r.body.summary.booked, r.body.summary.unallocated], 'the day\'s own point matches its cards');
  const d2w = r.body.week.find((w) => w.day === D2);
  if (d2w) assert.equal(d2w.extras, 2, 'the two extras of the next day');
  assert.ok(r.body.queue.length >= 1, 'new works with no artist yet');
  assert.ok(r.body.queue.every((q) => q.top === null || q.top.teamName));
  assert.equal(typeof r.body.summary.planned, 'number');
  const d2 = await api('GET', `/allocation/day?date=${D2}`, artistHead);
  assert.deepEqual([d2.body.summary.extrasUsed, d2.body.teams.find((t) => t.name === 'Team Sandra').slots.some((s) => s.extra)], [2, true]);
  assert.equal((await api('GET', `/allocation/day?date=${D}`, sales)).status, 403);
});

console.log('\n— shadow mode —');
await check('shadow: the ERP quietly notes its pick for a new booking; the coordinator\'s own pick is compared', async () => {
  await api('PUT', '/allocation/settings', admin, { mode: 'shadow' });
  const s = await AllocationSettings.findOne({}).lean();
  assert.ok(s.shadowSince);
  await sleep(1100);
  const b = await makeBooking({ status: 'pending', start: '07:00', end: '08:00', pin: PIN.kollam, day: addDays(D, 3) });
  const full = (await api('GET', `/bookings/${b._id}`, crm)).body;
  await api('PUT', `/bookings/${b._id}`, crm, { ...full, status: 'confirmed' });
  const sh = await ArtistAllocation.findOne({ bookingId: b._id, kind: 'shadow' }).lean();
  assert.ok(sh?.shadow?.suggestedTeamId, 'noted');
  const suggested = teams.find((t) => t.id === String(sh.shadow.suggestedTeamId));
  const i = NAMES.indexOf(suggested.name.replace('Team ', ''));
  const again = (await api('GET', `/bookings/${b._id}`, crm)).body;
  await api('PUT', `/bookings/${b._id}`, crm, { ...again, assignedStaff: [leadOn(i)] });
  const m = await api('GET', `/allocation/metrics?from=${D}&to=${addDays(D, 5)}`, admin);
  assert.deepEqual([m.body.shadow.compared, m.body.shadow.matched], [1, 1]);
  assert.ok(m.body.accepted >= 1 && m.body.overridden >= 1);
  // the two approved on D2, and the guard test's forced saves past Nedha's slot (extras waiting for the Artist Head)
  assert.equal(m.body.extras.approved, 2);
  assert.equal(m.body.extras.pending, m.body.extras.requested - 2);
  assert.ok(m.body.conflictsConfirmed >= 0);
});
await check('switched off: nothing changes for anyone (no suggestions, no confirm)', async () => {
  await api('PUT', '/allocation/settings', admin, { mode: 'off' });
  const b = await makeBooking({ start: '07:00', end: '08:00' });
  const s = await api('GET', `/allocation/booking/${b._id}`, crm);
  assert.deepEqual([s.body.mode, s.body.units.length], ['off', 0]);
  assert.deepEqual((await api('POST', '/allocation/confirm', crm, { bookingId: String(b._id), picks: [{ unitKey: 'b', teamId: teams[0].id }] })).body.code, 'ALLOCATION_OFF');
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
