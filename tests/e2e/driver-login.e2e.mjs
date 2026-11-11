// End-to-end check of TEMPORARY driver logins (an outsourced driver): the fleet manager gives one
// with an end date, it stops working when that day is over, and can be renewed or switched off.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else, and drops its database first):
//
//   mkdir -p /tmp/drv-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/drv-e2e --fork --logpath /tmp/drv-e2e/log
//   node tests/e2e/driver-login.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/driver_login_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root)); // the employee routes populate several
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const { todayIst, addDays } = await import(new URL('utils/istDate.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/auth', await imp('routes/authRoutes.js'));
app.use('/api/employees', await imp('routes/employeeRoutes.js'));
app.use('/api/fleet', await imp('routes/fleetRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const api = async (method, path, token, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const signIn = (id, password) => api('POST', '/auth/login', null, { email: id, password });

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try {
    await fn();
    pass += 1;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 7).join('\n      ')}`);
  }
};

const mk = async (key, role) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const fleet = await mk('fleetmgr', 'fleet_manager');
const admin = await mk('boss', 'admin');
const artist = await mk('artist', 'artist');

// Created directly: creating one through POST /employees also starts a background Timebox sync that
// inserts other staff at the same moment, and two inserts can race for the same staff code.
const newDriver = async (name, phone = '9895000000') =>
  String((await Employee.create({ name, type: 'outsource', artistRole: 'driver', phone, category: 'operations', department: 'Operations', role: 'Driver' }))._id);
const grant = (body, token = fleet.token) => api('POST', '/auth/users/driver-login', token, body);
const in7 = addDays(todayIst(), 7);

const suresh = await newDriver('Suresh (vendor)');
let sureshToken = '';

// ── giving a temporary login ────────────────────────────────────────────────
await check('the fleet manager gives an outsource driver a login that ends on a date', async () => {
  const r = await grant({ name: 'Suresh', email: 'Suresh@Vendor.test', password: 'temp1234', employeeId: suresh, expiresOn: in7 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.loginId, 'suresh@vendor.test');
  assert.equal(r.body.role, 'driver');
  assert.ok(r.body.accessExpiresAt);
  assert.equal(new Date(r.body.accessExpiresAt).toISOString().slice(0, 10) >= in7, true);
});

await check('the driver signs in and uses the app until then', async () => {
  const r = await signIn('suresh@vendor.test', 'temp1234');
  assert.equal(r.status, 200);
  sureshToken = r.body.token;
  assert.equal((await api('GET', '/fleet/driver/jobs', sureshToken)).status, 200);
});

await check('without an end date the login is permanent, as before', async () => {
  const emp = await newDriver('Kumar (staff)', '9446000000');
  const r = await grant({ name: 'Kumar', email: 'kumar@x.test', password: 'perm1234', employeeId: emp });
  assert.equal(r.status, 201);
  assert.equal(r.body.accessExpiresAt, null);
});

await check('a driver with no email signs in with their mobile number', async () => {
  const emp = await newDriver('Ramu', '9744111222');
  const r = await grant({ name: 'Ramu', email: '', phone: '+91 97441 11222', password: 'ramu1234', employeeId: emp, expiresOn: in7 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.loginId, '9744111222');
  assert.equal((await signIn('9744111222', 'ramu1234')).status, 200);
  assert.equal((await signIn('+91 97441 11222', 'ramu1234')).status, 200);
  assert.equal((await signIn('9744111222', 'wrong')).status, 401);
});

await check('the end date today is fine; a date that has passed, one too far off, or nonsense is refused', async () => {
  const emp = await newDriver('Today', '9000000001');
  assert.equal((await grant({ email: 'today@x.test', password: 'abcdef', employeeId: emp, expiresOn: todayIst() })).status, 201);
  assert.equal((await grant({ email: 'past@x.test', password: 'abcdef', expiresOn: addDays(todayIst(), -1) })).status, 400);
  assert.equal((await grant({ email: 'far@x.test', password: 'abcdef', expiresOn: addDays(todayIst(), 400) })).status, 400);
  assert.equal((await grant({ email: 'junk@x.test', password: 'abcdef', expiresOn: 'whenever' })).status, 400);
});

await check('a login needs an email or a mobile number, and a 6-character password', async () => {
  assert.equal((await grant({ name: 'x', password: 'abcdef' })).status, 400);
  assert.equal((await grant({ name: 'x', email: 'a@b.test', password: '123' })).status, 400);
});

// ── it ends ─────────────────────────────────────────────────────────────────
await check('after the end date the driver cannot sign in, and is told why', async () => {
  await User.updateOne({ email: 'suresh@vendor.test' }, { accessExpiresAt: new Date(Date.now() - 60_000) });
  const r = await signIn('suresh@vendor.test', 'temp1234');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'LOGIN_EXPIRED');
  assert.match(r.body.message, /temporary login has ended/);
});

await check('a wrong password still gets the plain error (the expiry is not leaked)', async () => {
  const r = await signIn('suresh@vendor.test', 'nope');
  assert.equal(r.status, 401);
  assert.equal(r.body.message, 'Invalid email or password');
});

await check('a token issued before the end date stops working too', async () => {
  const r = await api('GET', '/fleet/driver/jobs', sureshToken);
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'LOGIN_EXPIRED');
});

// ── renew / end it early ────────────────────────────────────────────────────
await check('the fleet manager renews it without knowing or changing the password', async () => {
  const r = await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { expiresOn: in7 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 200);
  assert.equal((await api('GET', '/fleet/driver/jobs', sureshToken)).status, 200); // the old token works again
});

await check('…or makes it permanent (null)', async () => {
  const r = await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { expiresOn: null });
  assert.equal(r.body.accessExpiresAt, null);
});

await check('…or switches it off at once, and back on', async () => {
  await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { expiresOn: in7 });
  const off = await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { active: false });
  assert.equal(off.body.active, false);
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 401);
  assert.equal((await api('GET', '/fleet/driver/jobs', sureshToken)).status, 401);
  await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { active: true });
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 200);
});

await check('a bad date on renew is refused and changes nothing', async () => {
  const before = (await User.findOne({ email: 'suresh@vendor.test' })).accessExpiresAt.getTime();
  assert.equal((await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { expiresOn: addDays(todayIst(), -3) })).status, 400);
  assert.equal((await User.findOne({ email: 'suresh@vendor.test' })).accessExpiresAt.getTime(), before);
});

await check('a driver with no login yet → 404', async () => {
  const emp = await newDriver('NoLogin', '9000000002');
  assert.equal((await api('PUT', `/auth/users/driver-login/${emp}`, fleet.token, { active: false })).status, 404);
});

// ── "Inactive" in the driver dialog now really switches the login off ───────
await check('setting the driver Inactive closes the login; Active opens it again', async () => {
  assert.equal((await api('PUT', `/employees/${suresh}`, fleet.token, { name: 'Suresh (vendor)', type: 'outsource', status: 'inactive', artistRole: 'driver' })).status, 200);
  assert.equal((await User.findOne({ email: 'suresh@vendor.test' })).active, false);
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 401);
  await api('PUT', `/employees/${suresh}`, fleet.token, { name: 'Suresh (vendor)', type: 'outsource', status: 'active', artistRole: 'driver' });
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 200);
});

await check('editing another field leaves the login alone', async () => {
  await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { active: false });
  await api('PUT', `/employees/${suresh}`, fleet.token, { name: 'Suresh (vendor)', type: 'outsource', phone: '9895000009', artistRole: 'driver' }); // no status sent
  assert.equal((await User.findOne({ email: 'suresh@vendor.test' })).active, false);
  await api('PUT', `/auth/users/driver-login/${suresh}`, fleet.token, { active: true });
});

// ── nobody else's account is touched ────────────────────────────────────────
await check('"granting a driver login" to the admin\'s email is refused, and the admin is untouched', async () => {
  const r = await grant({ name: 'x', email: 'boss@e2e.test', password: 'hacked99' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /admin account/);
  const u = await User.findOne({ email: 'boss@e2e.test' });
  assert.equal(u.role, 'admin');
  assert.equal(await u.matchPassword('secret123'), true);
  assert.equal(await u.matchPassword('hacked99'), false);
});

await check('another driver\'s email is refused too; the first driver keeps their login', async () => {
  const other = await newDriver('Other', '9000000003');
  const r = await grant({ name: 'Other', email: 'suresh@vendor.test', password: 'other5678', employeeId: other });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /another driver/);
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 200);
});

await check('the same driver can be given a fresh password and date again', async () => {
  const r = await grant({ name: 'Suresh', email: 'suresh@vendor.test', password: 'newpass99', employeeId: suresh, expiresOn: addDays(todayIst(), 14) });
  assert.equal(r.status, 200);
  assert.equal(r.body.created, false);
  assert.equal((await signIn('suresh@vendor.test', 'newpass99')).status, 200);
  assert.equal((await signIn('suresh@vendor.test', 'temp1234')).status, 401);
});

await check('the renew endpoint only ever touches driver accounts', async () => {
  const emp = await Employee.create({ name: 'Artist person', artistRole: 'artist' });
  await User.updateOne({ email: 'artist@e2e.test' }, { employeeId: emp._id });
  assert.equal((await api('PUT', `/auth/users/driver-login/${emp._id}`, fleet.token, { active: false })).status, 404);
  assert.equal((await User.findOne({ email: 'artist@e2e.test' })).active, true);
});

await check('only fleet managers / managers / admins can give or change a login', async () => {
  assert.equal((await grant({ email: 'z@x.test', password: 'abcdef' }, artist.token)).status, 403);
  assert.equal((await api('PUT', `/auth/users/driver-login/${suresh}`, artist.token, { active: false })).status, 403);
  assert.equal((await grant({ email: 'adm@x.test', password: 'abcdef' }, admin.token)).status, 201);
});

await check('the user list shows each login\'s end date', async () => {
  const list = (await api('GET', '/auth/users', fleet.token)).body;
  const s = list.find((u) => u.email === 'suresh@vendor.test');
  assert.ok(s.accessExpiresAt);
  assert.equal(list.find((u) => u.email === 'kumar@x.test').accessExpiresAt, null);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
