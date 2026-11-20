// End-to-end check of "Convert old temporary staff" — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run
// against anything else and drops its own database first):
//
//   mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/temp-staff-convert.e2e.mjs
//
// The method: bookings shaped like the real ones (names typed into the free-text temporary-staff box — first names, spelling variants, a role,
// several names in one text, a phone number, a cancelled work, a blank box), then REVIEW (the rows) → CONVERT (create / link / merge / skip)
// → the associates are on the bookings' teams and the Associate Works report shows those works; again is a no-op; an edited text is offered again.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/temp_staff_convert_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'temp_staff_convert_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/associate-works', await imp('routes/associateWorksRoutes.js'));
app.use('/api/employees', await imp('routes/employeeRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const call = async (method, path, who, body) => {
  const res = await fetch(`${base}${path}`, { method, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); }
};

let n = 0;
const login = async (key, role) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Operations' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await login('admin', 'admin');
const crm = await login('crm', 'crm');
const sales = await login('sales', 'sales');
const artist = await login('artist', 'artist');
const ceo = await login('ceo', 'ceo');
const accounts = await login('accounts', 'accounts');

// people already in the system
const mkEmp = (extra) => Employee.create({ department: 'Operations', status: 'active', artistRole: 'assistant', ...extra });
const asha = await mkEmp({ name: 'Asha', phone: '9000000001', type: 'outsource', isAssociate: true });
const anu = await mkEmp({ name: 'Anu', phone: '9000000002', type: 'in-house', artistRole: 'artist' });
const ravi = await mkEmp({ name: 'Ravi Freelancer', phone: '9000000003', type: 'outsource' }); // NOT an associate

// bookings (November 2026)
const at = (day, hh = 10) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+05:30`);
const lead = (emp) => ({ employeeId: emp._id, artistName: emp.name, roleType: 'lead', role: 'Lead Artist' });
const item = (extra = {}) => ({ service: 'Bridal', eventSlot: 'Morning', selectedDates: ['2026-11-10'], totalPrice: 5000, assignedStaff: [], ...extra });
const work = (customerName, temp, extra = {}) => Booking.create({ customerName, service: 'Bridal', bookingDate: at('2026-10-01'), serviceStart: at('2026-11-10'), serviceEnd: at('2026-11-10', 18), selectedDates: ['2026-11-10'], status: 'completed', totalPrice: 20000, temporaryStaffDetails: temp, ...extra });
const b1 = await work('B1 Thesliya', 'thesliya', { assignedStaff: [lead(anu)], bookingItems: [item({ assignedStaff: [lead(anu)] })] });
const b2 = await work('B2 Both', 'thasliya & reem', { bookingItems: [item()] });
const b3 = await work('B3 No packages', 'Reem', { serviceStart: at('2026-11-12'), selectedDates: ['2026-11-12'] });
const b4 = await work('B4 Feeniya', 'feeniya maam & aswini  9000000099', { bookingItems: [item()] });
const b5 = await work('B5 Cancelled', 'reem', { status: 'cancelled' });
const b6 = await work('B6 Blank', '   ');
const b7 = await work('B7 Role', 'ajila saree drapist', { bookingItems: [item(), item({ service: 'Reception' })] });
const b8 = await work('B8 Existing', 'asha', { bookingItems: [item()] });
const b9 = await work('B9 Two looks', 'ani  for 1 st look \nsiniya (makeup) and reshma(saree)', { bookingItems: [item()] });
const b10 = await work('B10 Nobody', '2 assistants needed');
const get = (b) => Booking.findById(b._id).lean();
const teamOf = (b) => (b.assignedStaff ?? []).map((a) => `${a.artistName}:${a.roleType}:${a.role}`).sort();

let review = null;
await check('review: who may see it — Operations and admin yes; sales, artist, accounts and leadership no', async () => {
  for (const who of [crm, admin]) assert.equal((await call('GET', '/associate-works/temp-staff', who)).status, 200);
  for (const who of [sales, artist, ceo, accounts]) assert.equal((await call('GET', '/associate-works/temp-staff', who)).status, 403, who.name);
  assert.equal((await call('GET', '/associate-works/temp-staff', null)).status, 401);
});

await check('review: one row per person across the bookings, cancelled / blank / nobody-named texts left out', async () => {
  const r = await call('GET', '/associate-works/temp-staff', crm);
  assert.equal(r.status, 200, r.text);
  review = r.body;
  assert.equal(review.pendingBookings, 7, 'B1-B4, B7, B8, B9 — not B5 (cancelled), B6 (blank), B10 (names nobody)');
  const keys = review.rows.map((x) => x.key).sort();
  assert.deepEqual(keys, ['ajila', 'ani', 'asha', 'aswini', 'feeniyamaam', 'reem', 'reshma', 'siniya', 'thasliya', 'thesliya']);
  const reem = review.rows.find((x) => x.key === 'reem');
  assert.equal(reem.count, 2, 'B2 and B3 (B5 is cancelled)');
  assert.equal(review.rows.find((x) => x.key === 'ajila').roleHint, 'Saree draping');
  assert.equal(review.rows.find((x) => x.key === 'siniya').roleHint, 'Makeup');
  assert.equal(review.rows.find((x) => x.key === 'aswini').phone, '9000000099');
});

await check('review: lookalike spellings point at each other, a registered associate is suggested, and the associates are listed', async () => {
  const by = Object.fromEntries(review.rows.map((x) => [x.key, x]));
  assert.deepEqual(by.thesliya.similar, ['thasliya']);
  assert.deepEqual(by.asha.suggestion, { employeeId: String(asha._id), name: 'Asha', exact: true });
  assert.equal(by.reem.suggestion, null);
  assert.deepEqual(review.associates.map((a) => a.name), ['Asha']);
});

await check('convert: nothing for people who may not; bad requests are refused with a plain message', async () => {
  const ok = { rows: [{ key: 'reem', action: 'skip' }] };
  for (const who of [sales, artist, ceo, accounts]) assert.equal((await call('POST', '/associate-works/temp-staff/convert', who, ok)).status, 403, who.name);
  assert.equal((await call('POST', '/associate-works/temp-staff/convert', null, ok)).status, 401);
  for (const body of [{}, { rows: [] }, { rows: 'x' }, { rows: [{ key: 'reem', action: 'delete' }] }, { rows: [{ action: 'skip' }] }, { rows: [{ key: 'reem', action: 'skip' }, { key: 'Reem', action: 'skip' }] }]) {
    assert.equal((await call('POST', '/associate-works/temp-staff/convert', crm, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await Employee.countDocuments({ isAssociate: true })), 1, 'nothing was created');
});

let done = null;
await check('convert: create, merge a spelling into it, link a registered associate, skip a non-associate', async () => {
  const r = await call('POST', '/associate-works/temp-staff/convert', crm, {
    rows: [
      { key: 'thesliya', action: 'create', name: 'Thasliya', role: '' },
      { key: 'thasliya', action: 'merge', into: 'thesliya' },
      { key: 'reem', action: 'create', name: 'Reem' },
      { key: 'aswini', action: 'create', name: 'Aswini', phone: '9000000099' },
      { key: 'feeniyamaam', action: 'skip' },
      { key: 'ajila', action: 'create', name: 'Ajila', role: 'Saree draping' },
      { key: 'asha', action: 'link', employeeId: String(asha._id) },
    ],
  });
  assert.equal(r.status, 200, r.text);
  done = r.body;
  assert.deepEqual(done.errors, []);
  assert.deepEqual([done.created, done.linked, done.skipped], [4, 1, 1]);
  // B1, B2, B3, B4, B7, B8 got associates; B9 was not in the request
  assert.equal(done.bookingsUpdated, 6);
  assert.equal(done.bookingsReviewed, 6);
});

await check('convert: each associate is on the booking AND on each package, once, as the lead\'s assistant; the typed text is left as it was', async () => {
  const thas = await Employee.findOne({ name: 'Thasliya' }).lean();
  assert.deepEqual([thas.isAssociate, thas.type, thas.salaryType], [true, 'outsource', 'per_booking']);
  const x1 = await get(b1);
  assert.deepEqual(teamOf(x1), ['Anu:lead:Lead Artist', 'Thasliya:assistant:Associate']);
  assert.deepEqual(teamOf(x1.bookingItems[0]), ['Anu:lead:Lead Artist', 'Thasliya:assistant:Associate'], 'the package too');
  assert.equal(x1.temporaryStaffDetails, 'thesliya', 'the text is untouched');
  assert.deepEqual([x1.tempStaffConverted.text, String(x1.tempStaffConverted.by)], ['thesliya', crm.id]);
  const x2 = await get(b2);
  assert.deepEqual(teamOf(x2), ['Reem:assistant:Associate', 'Thasliya:assistant:Associate'], 'the merged spelling is the same person');
  assert.deepEqual(teamOf(x2.bookingItems[0]), ['Reem:assistant:Associate', 'Thasliya:assistant:Associate']);
  assert.deepEqual(teamOf(await get(b3)), ['Reem:assistant:Associate'], 'a booking with no packages: its own team');
  assert.equal((await get(b3)).bookingItems.length, 0);
  assert.equal(String(x2.assignedStaff[0].employeeId).length, 24);
});

await check('convert: a role in the text becomes the assignment\'s role; a skipped name is reviewed, not added; a phone is kept', async () => {
  const x7 = await get(b7);
  assert.deepEqual(teamOf(x7), ['Ajila:assistant:Saree draping']);
  assert.equal(x7.bookingItems.length, 2);
  for (const it of x7.bookingItems) assert.deepEqual(teamOf(it), ['Ajila:assistant:Saree draping'], 'every package');
  const x4 = await get(b4);
  assert.deepEqual(teamOf(x4), ['Aswini:assistant:Associate']);
  assert.ok(x4.tempStaffConverted, 'Feeniya was reviewed and skipped, so the booking is settled');
  const aswini = await Employee.findOne({ name: 'Aswini' }).lean();
  assert.equal(aswini.phone, '9000000099');
  assert.equal(aswini.specialization, '');
});

await check('convert: a link adds the registered associate; nobody is created for it', async () => {
  assert.deepEqual(teamOf(await get(b8)), ['Asha:assistant:Associate']);
  assert.equal(await Employee.countDocuments({ name: 'Asha' }), 1);
});

await check('convert: bookings that were not in the request, or are cancelled, are untouched', async () => {
  for (const b of [b5, b6, b9, b10]) {
    const x = await get(b);
    assert.deepEqual(x.assignedStaff, [], b.customerName);
    assert.equal(x.tempStaffConverted, undefined, b.customerName);
  }
});

await check('the Associate Works report now lists these works — per person, from the bookings\' teams', async () => {
  const r = await call('GET', '/associate-works?from=2026-11-01&to=2026-11-30', admin);
  assert.equal(r.status, 200, r.text);
  const by = {};
  for (const i of r.body.items) (by[i.associateName] ??= []).push(i.customerName);
  assert.deepEqual(Object.keys(by).sort(), ['Ajila', 'Asha', 'Aswini', 'Reem', 'Thasliya']);
  assert.deepEqual(by.Thasliya.sort(), ['B1 Thesliya', 'B2 Both']);
  assert.deepEqual(by.Reem.sort(), ['B2 Both', 'B3 No packages']);
  assert.deepEqual(by.Asha, ['B8 Existing']);
  assert.equal(r.body.registered, 5);
});

await check('review again: what was converted is not offered; what was not is', async () => {
  const r = await call('GET', '/associate-works/temp-staff', crm);
  assert.equal(r.body.pendingBookings, 1, 'only B9, which was not in the request');
  assert.deepEqual(r.body.rows.map((x) => x.key).sort(), ['ani', 'reshma', 'siniya']);
});

await check('convert again with the same answers: no new people, no double assignments, plain notes for the rows with nothing left', async () => {
  const before = await Employee.countDocuments({});
  const r = await call('POST', '/associate-works/temp-staff/convert', crm, {
    rows: [{ key: 'thesliya', action: 'create', name: 'Thasliya' }, { key: 'reem', action: 'create', name: 'Reem' }, { key: 'asha', action: 'link', employeeId: String(asha._id) }],
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(await Employee.countDocuments({}), before);
  assert.equal(r.body.errors.length, 3);
  assert.match(r.body.errors[0].message, /No booking has this name any more/);
  assert.equal(r.body.bookingsUpdated, 0);
  assert.deepEqual(teamOf(await get(b1)), ['Anu:lead:Lead Artist', 'Thasliya:assistant:Associate']);
});

await check('an edited text comes back for review — and its person is recognised as the associate already there', async () => {
  await Booking.updateOne({ _id: b1._id }, { $set: { temporaryStaffDetails: 'thesliya & zeena' } });
  const r = await call('GET', '/associate-works/temp-staff', crm);
  const by = Object.fromEntries(r.body.rows.map((x) => [x.key, x]));
  assert.ok(by.zeena && by.thesliya, 'both names of the edited text');
  assert.equal(by.thesliya.suggestion.name, 'Thasliya');
  assert.equal(by.thesliya.suggestion.exact, false, 'a lookalike spelling');
  assert.equal(by.zeena.suggestion, null);
  assert.equal(r.body.pendingBookings, 2, 'B9 and the edited B1');
});

await check('a row that cannot be resolved leaves its booking for another try, with a plain reason; the others still go through', async () => {
  const r = await call('POST', '/associate-works/temp-staff/convert', crm, {
    rows: [
      { key: 'zeena', action: 'create', name: 'Zeena', phone: '9000000003' }, // Ravi's number: he is on the team and is not an associate
      { key: 'thesliya', action: 'link', employeeId: String((await Employee.findOne({ name: 'Thasliya' }))._id) },
      { key: 'ani', action: 'create', name: 'A' }, // name too short
      { key: 'siniya', action: 'link', employeeId: String(ravi._id) }, // not an associate
      { key: 'reshma', action: 'merge', into: 'nobody' },
    ],
  });
  assert.equal(r.status, 200, r.text);
  const msg = Object.fromEntries(r.body.errors.map((e) => [e.key, e.message]));
  assert.match(msg.zeena, /Ravi Freelancer/);
  assert.match(msg.ani, /name/i);
  assert.match(msg.siniya, /registered associate/i);
  assert.match(msg.reshma, /same as/i);
  const x1 = await get(b1);
  assert.deepEqual(x1.tempStaffConverted.text, 'thesliya', 'b1 is not settled (Zeena failed): still the old marker');
  assert.equal(await Employee.countDocuments({ name: 'Zeena' }), 0);
  assert.equal(await Employee.countDocuments({ name: 'A' }), 0);
  const left = await call('GET', '/associate-works/temp-staff', crm);
  assert.ok(left.body.rows.some((x) => x.key === 'zeena'), 'zeena is still waiting');
});

await check('a merge must name a create or link row of the same request, never a skip or another merge', async () => {
  const r = await call('POST', '/associate-works/temp-staff/convert', crm, {
    rows: [{ key: 'zeena', action: 'skip' }, { key: 'thesliya', action: 'merge', into: 'zeena' }],
  });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.errors.find((e) => e.key === 'thesliya').message, /same as/i);
});

await check('the edit race: a text changed while converting is not overwritten', async () => {
  const b = await work('B11 Race', 'miya');
  const a = await call('GET', '/associate-works/temp-staff', crm);
  assert.ok(a.body.rows.some((x) => x.key === 'miya'));
  // the answers arrive after somebody rewrote the box
  await Booking.updateOne({ _id: b._id }, { $set: { temporaryStaffDetails: 'someone else' } });
  const r = await call('POST', '/associate-works/temp-staff/convert', crm, { rows: [{ key: 'miya', action: 'create', name: 'Miya' }] });
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.errors[0].message, /No booking has this name/);
  assert.deepEqual((await get(b)).assignedStaff, []);
});

await check('someone already on the team (typed in the box AND added by hand) is not added twice — to the booking or to a package', async () => {
  const both = await work('B14 Already there', 'asha', {
    assignedStaff: [lead(anu), { employeeId: asha._id, artistName: 'Asha', roleType: 'assistant', role: 'Hair' }],
    bookingItems: [item({ assignedStaff: [lead(anu), { employeeId: asha._id, artistName: 'Asha', roleType: 'assistant', role: 'Hair' }] }), item({ service: 'Reception' })],
  });
  const r = await call('POST', '/associate-works/temp-staff/convert', crm, { rows: [{ key: 'asha', action: 'link', employeeId: String(asha._id) }] });
  assert.equal(r.status, 200, r.text);
  const x = await get(both);
  assert.deepEqual(teamOf(x), ['Anu:lead:Lead Artist', 'Asha:assistant:Hair'], 'still once, with the role it already had');
  assert.deepEqual(teamOf(x.bookingItems[0]), ['Anu:lead:Lead Artist', 'Asha:assistant:Hair']);
  assert.deepEqual(teamOf(x.bookingItems[1]), ['Asha:assistant:Associate'], 'the package she was not on gets her');
  assert.equal(x.tempStaffConverted.text, 'asha');
});

await check('converting a name with no phone twice never doubles the person: the associate with that name is reused', async () => {
  await work('B12 Miya one', 'miya');
  const one = await call('POST', '/associate-works/temp-staff/convert', crm, { rows: [{ key: 'miya', action: 'create', name: 'Miya' }] });
  assert.deepEqual([one.body.created, one.body.reused], [1, 0], one.text);
  await work('B13 Miya two', 'Miya');
  const two = await call('POST', '/associate-works/temp-staff/convert', crm, { rows: [{ key: 'miya', action: 'create', name: 'Miya' }] });
  assert.deepEqual([two.body.created, two.body.reused, two.body.errors], [0, 1, []], two.text);
  assert.equal(await Employee.countDocuments({ name: 'Miya' }), 1);
  assert.equal(await Booking.countDocuments({ customerName: /^B1[23] Miya/, 'assignedStaff.artistName': 'Miya' }), 2);
});

await check('the quick-add still works the same way after sharing its code (new, same number again, a team member\'s number)', async () => {
  const a = await call('POST', '/employees/associates', crm, { name: 'Quick', phone: '9555555555' });
  assert.equal(a.status, 201, a.text);
  const again = await call('POST', '/employees/associates', crm, { name: 'Quick', phone: '95555 55555' });
  assert.deepEqual([again.status, again.body.existing, again.body.employee._id], [200, true, a.body.employee._id]);
  const clash = await call('POST', '/employees/associates', crm, { name: 'Other', phone: '9000000002' });
  assert.equal(clash.status, 409, clash.text);
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
