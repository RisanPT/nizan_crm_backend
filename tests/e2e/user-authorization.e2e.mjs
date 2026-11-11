// End-to-end check of WHO may change or delete a user (PUT / DELETE /api/auth/users/:id): admin and
// manager (Settings → Users), department heads for their own team (My Team), a fleet manager for
// drivers — and nobody else. Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099;
// refuses to run against anything else, and drops its database first):
//
//   mkdir -p /tmp/drv-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/drv-e2e --fork --logpath /tmp/drv-e2e/log
//   node tests/e2e/user-authorization.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/user_authorization_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root)); // server.js installs this first: a bad id must answer 400, not hang

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/auth', await imp('routes/authRoutes.js'));
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
const put = (id, token, body) => api('PUT', `/auth/users/${id}`, token, body);
const del = (id, token) => api('DELETE', `/auth/users/${id}`, token);

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

let n = 0;
const mk = async (key, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), email: user.email, name: key, role, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const fresh = (u) => User.findById(u.id);

// What the Flutter apps send on every save (UserService.updateUser fills the rest with these defaults).
const flutterPayload = (u, over = {}) => ({
  name: u.name, email: u.email, role: u.role, active: true,
  inventoryAccess: false, inventoryManage: false, isDepartmentHead: false, artistHead: false, countInSalesTotals: true,
  employeeId: null, zoneId: null, stateId: null, regionId: null, districtId: null, pincodeId: null,
  ...over,
});

const admin = await mk('boss', 'admin');
const admin2 = await mk('boss2', 'admin');
const manager = await mk('mgr', 'manager');
const manager2 = await mk('mgr2', 'manager');
const artist = await mk('artist', 'artist');
const fleet = await mk('fleetmgr', 'fleet_manager');

// ── an ordinary user manages nobody ─────────────────────────────────────────
await check('no token → 401', async () => {
  const v = await mk('v0', 'artist');
  assert.equal((await put(v.id, null, { active: false })).status, 401);
  assert.equal((await del(v.id, null)).status, 401);
});

await check('an artist cannot deactivate, re-role, re-password or delete another user (403, nothing changes)', async () => {
  const v = await mk('victim', 'sales');
  assert.equal((await put(v.id, artist.token, { active: false })).status, 403);
  assert.equal((await put(v.id, artist.token, { role: 'admin' })).status, 403);
  assert.equal((await put(v.id, artist.token, { password: 'hacked99' })).status, 403);
  assert.equal((await put(v.id, artist.token, { isDepartmentHead: true })).status, 403);
  assert.equal((await del(v.id, artist.token)).status, 403);
  const after = await fresh(v);
  assert.equal(after.active, true);
  assert.equal(after.role, 'sales');
  assert.equal(after.isDepartmentHead, false);
  assert.equal(await after.matchPassword('secret123'), true);
});

await check('…an admin account in particular: no deactivating, password reset or delete', async () => {
  assert.equal((await put(admin2.id, artist.token, { active: false })).status, 403);
  assert.equal((await put(admin2.id, artist.token, { password: 'hacked99' })).status, 403);
  assert.equal((await del(admin2.id, artist.token)).status, 403);
  const a = await fresh(admin2);
  assert.equal(a.active, true);
  assert.equal(await a.matchPassword('secret123'), true);
});

await check('…and cannot promote themselves (403, still an artist)', async () => {
  assert.equal((await put(artist.id, artist.token, { role: 'admin' })).status, 403);
  assert.equal((await put(artist.id, artist.token, { isDepartmentHead: true })).status, 403);
  const a = await fresh(artist);
  assert.equal(a.role, 'artist');
  assert.equal(a.isDepartmentHead, false);
});

await check('an artist asking about an id that does not exist is told 403, not 404 (no probing)', async () => {
  assert.equal((await put(new mongoose.Types.ObjectId().toString(), artist.token, { active: false })).status, 403);
  assert.equal((await del(new mongoose.Types.ObjectId().toString(), artist.token)).status, 403);
});

await check('a driver and an inventory-flagged artist are ordinary users too', async () => {
  const drv = await mk('anydriver', 'driver');
  const flagged = await mk('flagged', 'artist', { inventoryAccess: true, inventoryManage: true, artistHead: true });
  const v = await mk('v1', 'artist');
  assert.equal((await put(v.id, drv.token, { active: false })).status, 403);
  assert.equal((await put(v.id, flagged.token, { active: false })).status, 403);
  assert.equal((await del(v.id, flagged.token)).status, 403);
});

// ── admin ───────────────────────────────────────────────────────────────────
await check('an admin changes role, password, active and isDepartmentHead — as before', async () => {
  const v = await mk('v2', 'artist');
  const r = await put(v.id, admin.token, flutterPayload(v, { role: 'accounts', active: false, isDepartmentHead: true, password: 'newpass99', name: 'Renamed' }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.role, 'accounts');
  assert.equal(r.body.active, false);
  assert.equal(r.body.isDepartmentHead, true);
  const a = await fresh(v);
  assert.equal(a.name, 'Renamed');
  assert.equal(await a.matchPassword('newpass99'), true);
});

await check('an admin may make someone an admin or manager, and edit another admin', async () => {
  const v = await mk('v3', 'artist');
  assert.equal((await put(v.id, admin.token, { role: 'manager' })).status, 200);
  assert.equal((await put(v.id, admin.token, { role: 'admin' })).status, 200);
  assert.equal((await fresh(v)).role, 'admin');
  assert.equal((await put(admin2.id, admin.token, { name: 'Boss Two' })).status, 200);
});

await check('an admin deletes another user; a missing id is 404', async () => {
  const v = await mk('v4', 'artist');
  assert.equal((await del(v.id, admin.token)).status, 200);
  assert.equal(await fresh(v), null);
  assert.equal((await del(v.id, admin.token)).status, 404);
  assert.equal((await put(v.id, admin.token, { name: 'x' })).status, 404);
});

await check('the self-guards stand: nobody can deactivate or delete themselves', async () => {
  assert.equal((await put(admin.id, admin.token, { active: false })).status, 400);
  assert.equal((await del(admin.id, admin.token)).status, 400);
  assert.equal((await put(manager.id, manager.token, { active: false })).status, 400);
  assert.equal((await del(manager.id, manager.token)).status, 400);
  assert.equal((await fresh(admin)).active, true);
});

await check('the email stays unique (409) and a malformed id is a 400', async () => {
  const v = await mk('v5', 'artist');
  assert.equal((await put(v.id, admin.token, { email: artist.email })).status, 409);
  assert.equal((await put('not-an-id', admin.token, { name: 'x' })).status, 400);
});

// ── manager ─────────────────────────────────────────────────────────────────
await check('a manager has full access to ordinary accounts (role, password, active, delete)', async () => {
  const v = await mk('v6', 'artist');
  assert.equal((await put(v.id, manager.token, { role: 'accounts', active: false, password: 'mgrset99' })).status, 200);
  const a = await fresh(v);
  assert.equal(a.role, 'accounts');
  assert.equal(a.active, false);
  assert.equal(await a.matchPassword('mgrset99'), true);
  assert.equal((await del(v.id, manager.token)).status, 200);
});

await check('a manager cannot give the admin or manager role (any casing)', async () => {
  const v = await mk('v7', 'artist');
  for (const role of ['admin', 'manager', 'ADMIN', ' Manager ']) {
    assert.equal((await put(v.id, manager.token, { role })).status, 403, role);
  }
  assert.equal((await fresh(v)).role, 'artist');
});

await check('a manager cannot touch an admin account, and cannot demote it either', async () => {
  assert.equal((await put(admin2.id, manager.token, { password: 'hacked99' })).status, 403);
  assert.equal((await put(admin2.id, manager.token, { active: false })).status, 403);
  assert.equal((await put(admin2.id, manager.token, { role: 'artist' })).status, 403);
  assert.equal((await del(admin2.id, manager.token)).status, 403);
  const a = await fresh(admin2);
  assert.equal(a.role, 'admin');
  assert.equal(a.active, true);
  assert.equal(await a.matchPassword('secret123'), true);
});

await check('a manager saving a manager (own or another) with the role unchanged is fine', async () => {
  assert.equal((await put(manager.id, manager.token, flutterPayload(manager, { name: 'Me' }))).status, 200);
  assert.equal((await put(manager2.id, manager.token, flutterPayload(manager2, { name: 'Peer' }))).status, 200);
});

// ── fleet manager ───────────────────────────────────────────────────────────
await check('a fleet manager resets a driver\'s password, switches the login off, and deletes it', async () => {
  const d = await mk('drv1', 'driver');
  assert.equal((await put(d.id, fleet.token, flutterPayload(d, { password: 'fleetset9' }))).status, 200);
  assert.equal(await (await fresh(d)).matchPassword('fleetset9'), true);
  assert.equal((await put(d.id, fleet.token, flutterPayload(d, { active: false }))).status, 200);
  assert.equal((await fresh(d)).active, false);
  assert.equal((await del(d.id, fleet.token)).status, 200);
});

await check('…but cannot turn a driver into anything else', async () => {
  const d = await mk('drv2', 'driver');
  for (const role of ['artist', 'admin', 'manager']) assert.equal((await put(d.id, fleet.token, { role })).status, 403, role);
  assert.equal((await fresh(d)).role, 'driver');
});

await check('a fleet manager on an admin, a manager or an ordinary user\'s account → 403', async () => {
  const other = await mk('someartist', 'artist');
  for (const t of [admin2, manager2, other]) {
    assert.equal((await put(t.id, fleet.token, { password: 'hacked99' })).status, 403, t.name);
    assert.equal((await put(t.id, fleet.token, { active: false })).status, 403, t.name);
    assert.equal((await del(t.id, fleet.token)).status, 403, t.name);
  }
  const a = await fresh(admin2);
  assert.equal(a.active, true);
  assert.equal(await a.matchPassword('secret123'), true);
  assert.equal(await fresh(other) !== null, true);
});

// ── department heads ────────────────────────────────────────────────────────
const salesHead = await mk('saleshead', 'sales', { isDepartmentHead: true });
const crmHead = await mk('crmhead', 'crm', { isDepartmentHead: true });
const artistHead = await mk('arthead', 'artist', { isDepartmentHead: true });

await check('a department head edits, deactivates, resets and deletes a member they created (Team screen payload)', async () => {
  const m = await mk('smember', 'artist', { managedBy: salesHead.id });
  assert.equal((await put(m.id, salesHead.token, flutterPayload(m, { name: 'Renamed', password: 'headset99' }))).status, 200);
  assert.equal(await (await fresh(m)).matchPassword('headset99'), true);
  assert.equal((await put(m.id, salesHead.token, flutterPayload(m, { active: false }))).status, 200);
  assert.equal((await fresh(m)).active, false);
  assert.equal((await del(m.id, salesHead.token)).status, 200);
});

await check('…and a member whose role their role delegates, even if an admin created it (the My Team list)', async () => {
  const rep = await mk('salesrep', 'sales_executive');
  assert.equal((await put(rep.id, salesHead.token, flutterPayload(rep, { active: false }))).status, 200);
  assert.equal((await fresh(rep)).active, false);
});

await check('a department head cannot touch another team\'s member, or an unmanaged user of another role', async () => {
  const theirs = await mk('crmmember', 'artist', { managedBy: crmHead.id });
  const nobodys = await mk('loose', 'accounts');
  for (const t of [theirs, nobodys]) {
    assert.equal((await put(t.id, salesHead.token, { active: false })).status, 403, t.name);
    assert.equal((await put(t.id, salesHead.token, { password: 'hacked99' })).status, 403, t.name);
    assert.equal((await del(t.id, salesHead.token)).status, 403, t.name);
    assert.equal((await fresh(t)).active, true);
  }
  // …and the other head cannot reach the first head's member either
  const mine = await mk('smember2', 'artist', { managedBy: salesHead.id });
  assert.equal((await put(mine.id, crmHead.token, { active: false })).status, 403);
  assert.equal((await del(mine.id, crmHead.token)).status, 403);
});

await check('a department head can never make anyone an admin or manager, or touch one', async () => {
  const mine = await mk('smember3', 'artist', { managedBy: salesHead.id });
  for (const role of ['admin', 'manager', 'ADMIN']) {
    assert.equal((await put(mine.id, salesHead.token, { role })).status, 403, role);
    assert.equal((await put(mine.id, artistHead.token, { role })).status, 403, role); // a head with no delegated roles too
  }
  assert.equal((await fresh(mine)).role, 'artist');
  const theirAdmin = await mk('theiradmin', 'admin', { managedBy: salesHead.id });
  const theirManager = await mk('theirmanager', 'manager', { managedBy: salesHead.id });
  for (const t of [theirAdmin, theirManager, admin2, manager2]) {
    assert.equal((await put(t.id, salesHead.token, { password: 'hacked99' })).status, 403, t.name);
    assert.equal((await del(t.id, salesHead.token)).status, 403, t.name);
  }
  assert.equal(await (await fresh(theirAdmin)).matchPassword('secret123'), true);
});

await check('a head can only give the roles their own role delegates; one with none delegated can give any but admin / manager', async () => {
  const mine = await mk('smember4', 'sales', { managedBy: salesHead.id });
  assert.equal((await put(mine.id, salesHead.token, { role: 'accounts' })).status, 403);
  assert.equal((await put(mine.id, salesHead.token, { role: 'sales_executive' })).status, 200);
  const theirs = await mk('amember', 'artist', { managedBy: artistHead.id });
  assert.equal((await put(theirs.id, artistHead.token, { role: 'accounts' })).status, 200);
});

await check('a department head cannot edit their own account', async () => {
  assert.equal((await put(salesHead.id, salesHead.token, { password: 'selfset99' })).status, 403);
  assert.equal((await put(salesHead.id, salesHead.token, { isDepartmentHead: false, districtId: null })).status, 403);
  assert.equal((await del(salesHead.id, salesHead.token)).status, 400); // the existing self-guard
});

await check('a *_manager / *_admin role counts as a head, just as createUser treats it', async () => {
  const inv = await mk('invmgr', 'inventory_manager');
  const mine = await mk('invmember', 'artist', { managedBy: inv.id });
  assert.equal((await put(mine.id, inv.token, { active: false })).status, 200);
  assert.equal((await put(admin2.id, inv.token, { active: false })).status, 403);
});

// ── the rest of the endpoints around them are unchanged ─────────────────────
await check('creating users: an artist is still refused, an admin still creates', async () => {
  const body = { name: 'New', email: 'new@e2e.test', password: 'abcdef', role: 'artist' };
  assert.equal((await api('POST', '/auth/users', artist.token, body)).status, 403);
  assert.equal((await api('POST', '/auth/users', admin.token, body)).status, 201);
});

await check('the user list is still available to a signed-in user', async () => {
  const r = await api('GET', '/auth/users', salesHead.token);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

console.log(`\n${pass} passed, ${failures.length} failed`);
await mongoose.disconnect();
server.close();
process.exit(failures.length ? 1 : 0);
