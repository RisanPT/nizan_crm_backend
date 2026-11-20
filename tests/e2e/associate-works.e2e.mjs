// End-to-end check of the Associate Works report and the associate quick-add — against a THROWAWAY local MongoDB (needs a mongod on
// 127.0.0.1:27099; refuses to run against anything else and drops its own database first):
//
//   mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/associate-works.e2e.mjs
//
// The method: create the records ONCE (associates, a freelancer who is not one, works with team assignments on the booking and on its items,
// artist payouts), then the report reflects all of them — works from the bookings, money from the payouts — and shows each viewer only what
// they may see. Plus the quick-add (new / same number again / a number that belongs to someone else), bad input, and the rules on the flag.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first. Creating an employee starts a Timebox sync, which then runs on the demo fixtures.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_URL', 'TIMEBOX_API_KEY', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/associate_works_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'associate_works_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Booking = await imp('models/Booking.js');
const ArtistPayout = await imp('models/ArtistPayout.js');
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
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 10).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
let n = 0;
const login = async (key, role, extra = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Operations' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, ...extra });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await login('admin', 'admin');
const accounts = await login('accounts', 'accounts');
const crm = await login('crm', 'crm');
const head = await login('head', 'artist_head');
const sales = await login('sales', 'sales');
const artist = await login('artist', 'artist');
const ceo = await login('ceo', 'ceo');

// the associates and the people who are NOT
const mkEmp = (extra) => Employee.create({ department: 'Operations', status: 'active', artistRole: 'assistant', ...extra });
const asha = await mkEmp({ name: 'Asha', phone: '9000000001', type: 'outsource', isAssociate: true, specialization: 'Hair' });
const binu = await mkEmp({ name: 'Binu', phone: '9000000002', type: 'outsource', isAssociate: true });
const ravi = await mkEmp({ name: 'Ravi', phone: '9000000003', type: 'outsource' }); // a freelancer, NOT an associate
const meera = await mkEmp({ name: 'Meera', phone: '9000000004', type: 'in-house' });

// the works (November 2026); the report is asked for the whole month
const FROM = '2026-11-01';
const TO = '2026-11-30';
const RANGE = `from=${FROM}&to=${TO}`;
const at = (day, hh = 10) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+05:30`);
const staff = (emp, roleType = 'assistant', role = '') => ({ employeeId: emp._id, artistName: emp.name, roleType, role });
const work = (extra) => Booking.create({ customerName: 'Bride', service: 'Bridal', bookingDate: at('2026-10-01'), serviceStart: at('2026-11-10'), serviceEnd: at('2026-11-10', 18), status: 'confirmed', totalPrice: 20000, ...extra });
const b1 = await work({ customerName: 'Anjali', selectedDates: ['2026-11-10', '2026-11-11'], district: 'Kozhikode', region: 'Calicut', assignedStaff: [staff(asha, 'assistant', 'Hair'), staff(meera, 'lead')] });
const b2 = await work({
  customerName: 'Meera K', serviceStart: at('2026-11-20'), serviceEnd: at('2026-11-22', 18), selectedDates: ['2026-11-20', '2026-11-21', '2026-11-22'], district: 'Kochi',
  bookingItems: [
    { service: 'Reception', selectedDates: ['2026-11-22'], assignedStaff: [staff(asha)] },
    { service: 'Wedding', selectedDates: ['2026-11-20', '2026-11-21'], assignedStaff: [staff(binu, 'lead')] },
  ],
});
const bDead = await work({ customerName: 'Cancelled one', status: 'cancelled', assignedStaff: [staff(asha)] });
const bOut = await work({ customerName: 'Last month', serviceStart: at('2026-10-25'), serviceEnd: at('2026-10-25', 18), assignedStaff: [staff(asha)] });
const bRavi = await work({ customerName: 'Ravi only', assignedStaff: [staff(ravi)] });
const bDriver = await work({ customerName: 'Driver asha', assignedStaff: [{ employeeId: asha._id, artistName: 'Asha', roleType: 'driver' }] });
const bLate = await work({ customerName: 'Late work', serviceStart: at('2026-11-28'), serviceEnd: at('2026-11-28', 18), assignedStaff: [staff(binu)] });

const pay = (emp, booking, amount, status, extra = {}) => ArtistPayout.create({ employeeId: emp._id, employeeName: emp.name, bookingId: booking?._id ?? null, bookingNumber: booking?.bookingNumber ?? '', amount, status, date: at('2026-11-15'), ...extra });
await pay(asha, b1, 1500, 'paid');
await pay(asha, b1, 500, 'pending');
await pay(asha, b1, 999, 'cancelled');
await pay(binu, b2, 700, 'approved');
await pay(asha, null, 300, 'paid'); //                          not on any work
await pay(asha, bOut, 250, 'paid', { date: at('2026-10-26') }); // a work last month, paid last month: not this period's business
await pay(ravi, bRavi, 400, 'paid'); //                         a freelancer, not an associate

// ── the report ────────────────────────────────────────────────────────────────
let R = null;
await check('Accounts sees the month: works from the bookings, money from the payouts, with the totals adding up', async () => {
  const r = await call('GET', `/associate-works?${RANGE}`, accounts);
  assert.equal(r.status, 200, r.text);
  R = r.body;
  assert.equal(R.canSeeFees, true);
  assert.equal(R.registered, 2);
  assert.deepEqual([R.summary.associates, R.summary.works, R.summary.days], [2, 4, 6]);
  // Asha: B1 (2 days, 2000 fee: 1500 paid + 500 pending), B2 reception (1 day, no fee); Binu: B2 wedding (2 days, 700 owed), late work (1 day, no fee)
  assert.deepEqual([R.summary.fee, R.summary.paid, R.summary.owed, R.summary.noFee], [2700, 1500, 1200, 2]);
});

await check('only associates: a freelancer who is not one, a driver listing, a cancelled booking and last month\'s work are left out', async () => {
  const names = R.items.map((x) => x.customerName).sort();
  assert.deepEqual(names, ['Anjali', 'Late work', 'Meera K', 'Meera K']);
  assert.ok(!R.items.some((x) => ['Ravi only', 'Driver asha', 'Cancelled one', 'Last month'].includes(x.customerName)));
});

await check('each row says who, which work, how many days, in what role, and the fee state', async () => {
  const anjali = R.items.find((x) => x.customerName === 'Anjali');
  assert.deepEqual([anjali.associateName, anjali.days, anjali.role, anjali.firstDay, anjali.place], ['Asha', 2, 'Hair', '2026-11-10', 'Kozhikode, Calicut']);
  assert.deepEqual([anjali.fee, anjali.paid, anjali.owed, anjali.payout], [2000, 1500, 500, 'owed']);
  const wedding = R.items.find((x) => x.associateName === 'Binu' && x.customerName === 'Meera K');
  assert.deepEqual([wedding.days, wedding.services, wedding.roleType, wedding.fee, wedding.payout], [2, ['Wedding'], 'lead', 700, 'owed']);
  const reception = R.items.find((x) => x.associateName === 'Asha' && x.customerName === 'Meera K');
  assert.deepEqual([reception.days, reception.services, reception.payout], [1, ['Reception'], 'none']);
  assert.equal(R.items[0].customerName, 'Late work', 'latest work first');
});

await check('a line per associate adds back to the totals', async () => {
  const [a, b] = R.associates;
  assert.deepEqual([a.name, a.works, a.days, a.fee, a.paid, a.owed, a.noFee, a.lastDay], ['Asha', 2, 3, 2000, 1500, 500, 1, '2026-11-20']);
  assert.deepEqual([b.name, b.works, b.days, b.fee, b.paid, b.owed, b.noFee], ['Binu', 2, 3, 700, 0, 700, 1]);
  assert.equal(R.associates.reduce((s, x) => s + x.fee, 0), R.summary.fee);
});

await check('money paid to associates that is not on a listed work is shown beside the totals', async () => {
  assert.deepEqual(R.elsewhere, { count: 1, amount: 300 });
});

await check('filters: one associate, one payout state, a search; the totals keep covering the whole period', async () => {
  const one = await call('GET', `/associate-works?${RANGE}&associateId=${binu._id}`, accounts);
  assert.deepEqual(one.body.items.map((x) => x.associateName), ['Binu', 'Binu']);
  assert.equal(one.body.summary.works, 4, 'summary is not cut by the table filters');
  const owed = await call('GET', `/associate-works?${RANGE}&payout=owed`, accounts);
  assert.equal(owed.body.totalItems, 2);
  const none = await call('GET', `/associate-works?${RANGE}&payout=none`, accounts);
  assert.equal(none.body.totalItems, 2);
  const paidOnly = await call('GET', `/associate-works?${RANGE}&payout=paid`, accounts);
  assert.equal(paidOnly.body.totalItems, 0, 'B1 is partly owed, so it is "owed", not "paid"');
  const q = await call('GET', `/associate-works?${RANGE}&search=anjali`, accounts);
  assert.equal(q.body.totalItems, 1);
  assert.equal(q.body.summary.works, 1, 'the search narrows the totals too');
});

await check('paging and export', async () => {
  const p1 = await call('GET', `/associate-works?${RANGE}&limit=3&page=1`, accounts);
  const p2 = await call('GET', `/associate-works?${RANGE}&limit=3&page=2`, accounts);
  assert.deepEqual([p1.body.items.length, p2.body.items.length, p1.body.totalPages, p1.body.totalItems], [3, 1, 2, 4]);
  const all = await call('GET', `/associate-works?${RANGE}&export=1`, accounts);
  assert.equal(all.body.items.length, 4);
  assert.equal(all.body.truncated, false);
});

await check('a narrower period only has the works whose first day is in it', async () => {
  const r = await call('GET', '/associate-works?from=2026-11-15&to=2026-11-25', accounts);
  assert.deepEqual(r.body.items.map((x) => x.customerName).sort(), ['Meera K', 'Meera K']);
  const empty = await call('GET', '/associate-works?from=2025-01-01&to=2025-01-31', accounts);
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.summary.works, empty.body.items.length, empty.body.associates.length], [0, 0, 0]);
});

await check('the owner roles see money too: admin, artist head, CEO (read-only)', async () => {
  for (const who of [admin, head, ceo]) {
    const r = await call('GET', `/associate-works?${RANGE}`, who);
    assert.equal(r.status, 200, who.name);
    assert.equal(r.body.canSeeFees, true, who.name);
    assert.equal(r.body.summary.fee, 2700, who.name);
  }
});

await check('Operations (CRM) sees the works but not a rupee: no fee, no payout state, no money line, the payout filter does nothing', async () => {
  const r = await call('GET', `/associate-works?${RANGE}&payout=paid`, crm);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.canSeeFees, false);
  assert.equal(r.body.totalItems, 4, 'a money filter means nothing here');
  assert.ok(r.body.items.every((x) => x.fee === null && x.paid === null && x.owed === null && x.payout === null));
  assert.deepEqual([r.body.summary.fee, r.body.summary.paid, r.body.summary.noFee, r.body.elsewhere], [null, null, null, null]);
  assert.ok(r.body.associates.every((a) => a.fee === null));
  assert.ok(!/\b(1500|700|2700|500)\b/.test(r.text.replace(/"days":\d+/g, '')), 'no amount anywhere in the answer');
});

await check('everyone else is refused; no login is refused', async () => {
  for (const who of [sales, artist]) assert.equal((await call('GET', `/associate-works?${RANGE}`, who)).status, 403, who.name);
  assert.equal((await call('GET', `/associate-works?${RANGE}`, null)).status, 401);
});

await check('bad input is refused in plain words', async () => {
  for (const q of ['from=2026-11-30&to=2026-11-01', 'from=nope&to=2026-11-01', 'from=2024-01-01&to=2026-11-30', 'payout=maybe', 'associateId=123']) {
    const r = await call('GET', `/associate-works?${q}`, accounts);
    assert.equal(r.status, 400, q);
    assert.ok(r.body.message && r.body.message.length > 5, q);
  }
});

await check('the report is read-only and only reads: nothing was created or changed', async () => {
  assert.equal(await Booking.countDocuments(), 7);
  assert.equal(await ArtistPayout.countDocuments(), 7);
  assert.equal(await Employee.countDocuments({ isAssociate: true }), 2);
});

// ── adding an associate while assigning a work ───────────────────────────────
console.log('\n— quick-add —');
await check('Operations adds a new associate: an outsource artist, no login, flagged, per-booking pay', async () => {
  const r = await call('POST', '/employees/associates', crm, { name: '  Divya   Nair ', phone: '98765 43210', specialization: 'Saree draping' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.existing, false);
  const e = await Employee.findById(r.body.employee._id).lean();
  assert.deepEqual([e.name, e.phone, e.type, e.isAssociate, e.artistRole, e.salaryType, e.specialization, e.status], ['Divya Nair', '9876543210', 'outsource', true, 'assistant', 'per_booking', 'Saree draping', 'active']);
  assert.deepEqual(e.works, ['Saree draping']);
  assert.equal(await User.countDocuments({ employeeId: e._id }), 0, 'no login is made for an associate');
});

await check('the same number typed another way is the same person: no duplicate, the existing associate comes back', async () => {
  const before = await Employee.countDocuments();
  const r = await call('POST', '/employees/associates', crm, { name: 'Divya N', phone: '+91 98765-43210' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.existing, true);
  assert.equal(r.body.employee.name, 'Divya Nair');
  assert.equal(await Employee.countDocuments(), before);
});

await check('a number that belongs to someone on the team who is NOT an associate is refused, naming them', async () => {
  const r = await call('POST', '/employees/associates', crm, { name: 'Someone', phone: '9000000004' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Meera/);
  const ravi2 = await call('POST', '/employees/associates', crm, { name: 'Someone', phone: '90000 00003' });
  assert.equal(ravi2.status, 409, 'a freelancer is not an associate either');
});

await check('an associate may be added without a phone number; bad names and numbers are refused', async () => {
  assert.equal((await call('POST', '/employees/associates', crm, { name: 'No Phone' })).status, 201);
  assert.equal((await call('POST', '/employees/associates', crm, { name: 'No Phone Again' })).status, 201, 'two without a number are two people');
  for (const body of [{ name: '' }, { name: 'A' }, { name: 'x'.repeat(81) }, { name: 'Ok Name', phone: '12' }, { name: 'Ok Name', phone: '1'.repeat(16) }, {}]) {
    assert.equal((await call('POST', '/employees/associates', crm, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
});

await check('who may add one: whoever works with bookings; not an artist; not the CEO (read-only); not without login', async () => {
  for (const who of [admin, sales, accounts, head]) assert.equal((await call('POST', '/employees/associates', who, { name: `By ${who.name}`, phone: '' })).status, 201, who.name);
  assert.equal((await call('POST', '/employees/associates', artist, { name: 'By artist' })).status, 403);
  assert.equal((await call('POST', '/employees/associates', ceo, { name: 'By ceo' })).status, 403);
  assert.equal((await call('POST', '/employees/associates', null, { name: 'Nobody' })).status, 401);
});

await check('a newly added associate appears in the report once assigned to a work', async () => {
  const divya = await Employee.findOne({ name: 'Divya Nair' });
  await work({ customerName: 'New bride', serviceStart: at('2026-11-12'), serviceEnd: at('2026-11-12', 18), assignedStaff: [staff(divya, 'assistant', 'Draping')] });
  const r = await call('GET', `/associate-works?${RANGE}&search=new%20bride`, accounts);
  assert.deepEqual(r.body.items.map((x) => [x.associateName, x.role, x.payout]), [['Divya Nair', 'Draping', 'none']]);
});

// ── the flag itself ──────────────────────────────────────────────────────────
console.log('\n— the associate flag —');
await check('an in-house employee cannot be flagged as an associate (they are on payroll); the refusal says why', async () => {
  const r = await call('PUT', `/employees/${meera._id}`, admin, { isAssociate: true });
  assert.equal(r.status, 400, r.text);
  assert.match(r.body.message, /outside artist/i);
  assert.equal((await Employee.findById(meera._id).lean()).isAssociate, false);
});

await check('an outsource freelancer can be flagged — then they are in the report with their work and fee; un-flagging takes them out', async () => {
  const on = await call('PUT', `/employees/${ravi._id}`, admin, { isAssociate: true });
  assert.equal(on.status, 200, on.text);
  const e = await Employee.findById(ravi._id).lean();
  assert.deepEqual([e.isAssociate, e.type, e.salaryType], [true, 'outsource', 'per_booking']);
  const r = await call('GET', `/associate-works?${RANGE}&search=ravi`, accounts);
  assert.deepEqual(r.body.items.map((x) => [x.associateName, x.customerName, x.fee, x.payout]), [['Ravi', 'Ravi only', 400, 'paid']]);
  const off = await call('PUT', `/employees/${ravi._id}`, admin, { isAssociate: false });
  assert.equal(off.status, 200);
  assert.equal((await call('GET', `/associate-works?${RANGE}&search=ravi`, accounts)).body.totalItems, 0);
});

await check('an associate cannot be switched to a payroll type while flagged', async () => {
  const r = await call('PUT', `/employees/${asha._id}`, admin, { type: 'in-house' });
  assert.equal(r.status, 400, r.text);
  assert.equal((await Employee.findById(asha._id).lean()).type, 'outsource');
});

await check('creating a person as an associate forces the outsource type; a payroll type is refused', async () => {
  const ok = await call('POST', '/employees', admin, { name: 'Created Associate', phone: '9111111111', isAssociate: true, artistRole: 'assistant' });
  assert.equal(ok.status, 201, ok.text);
  const e = await Employee.findById(ok.body._id ?? ok.body.employee?._id ?? ok.body.id).lean();
  assert.deepEqual([e.isAssociate, e.type], [true, 'outsource']);
  const no = await call('POST', '/employees', admin, { name: 'Bad Associate', phone: '9222222222', isAssociate: true, type: 'in-house' });
  assert.equal(no.status, 400, no.text);
});

await check('the quick-add is not a way round HR: it creates nothing but an associate and ignores any pay fields sent with it', async () => {
  const r = await call('POST', '/employees/associates', crm, { name: 'Sneaky', phone: '9333333333', baseSalary: 90000, type: 'in-house', role: 'admin', isAssociate: false, salaryType: 'fixed_monthly' });
  assert.equal(r.status, 201, r.text);
  const e = await Employee.findById(r.body.employee._id).lean();
  assert.deepEqual([e.baseSalary, e.type, e.isAssociate, e.salaryType], [0, 'outsource', true, 'per_booking']);
});

// the Timebox sync started by the creates above may still be running: let it finish before the database goes away
await (await import(new URL('controllers/timeboxController.js', root))).timeboxSyncIdle();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
