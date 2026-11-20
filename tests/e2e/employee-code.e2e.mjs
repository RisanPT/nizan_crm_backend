// End-to-end check that every employee gets their OWN code (NZ-1001, NZ-1002, …) even when many are saved at the same moment — an HR
// create, an associate quick-add and a Timebox import together — and that the Timebox sync never saves the same person twice. Against a
// THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else and drops its own database first):
//
//   mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/employee-code.e2e.mjs
//
// The Timebox side runs on the bundled demo fixtures (fixtures/timebox/employees.json): the live URL and key are blanked below.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first — no e-mail, SMS, AI or Timebox call reaches anybody.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_URL', 'TIMEBOX_API_KEY', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/employee_code_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'employee_code_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Counter = await imp('models/Counter.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const timebox = await import(new URL('controllers/timeboxController.js', root));
const { timeboxMode } = await import(new URL('services/timeboxClient.js', root));
const syncIdle = timebox.timeboxSyncIdle ?? (async () => {});
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
assert.equal(timeboxMode(), 'demo', 'SAFETY: Timebox must run on the demo fixtures here');
const FIXTURE = (await import(new URL('fixtures/timebox/employees.json', root), { with: { type: 'json' } })).default.data;

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
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

/** Codes held by more than one employee, e.g. [['NZ-1022', 2]] — must always be empty. */
const sharedCodes = async () => (await Employee.aggregate([
  { $match: { employeeCode: { $type: 'string' } } },
  { $group: { _id: '$employeeCode', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
])).map((g) => [g._id, g.n]);
/** Timebox people saved more than once, e.g. [[3, 2]] — must always be empty. */
const twiceImported = async () => (await Employee.aggregate([
  { $match: { timeboxEmployeeId: { $type: 'number' } } },
  { $group: { _id: '$timeboxEmployeeId', n: { $sum: 1 } } },
  { $match: { n: { $gt: 1 } } },
])).map((g) => [g._id, g.n]);
const codeNumber = (c) => Number(String(c).replace(/^NZ-/, ''));

// ── people ────────────────────────────────────────────────────────────────────
let n = 0;
const login = async (key, role) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Operations' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await login('admin', 'admin');
const crm = await login('crm', 'crm');

console.log('— employee codes —');
await check('25 employees saved at the same moment get 25 different codes', async () => {
  const made = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => Employee.create({ name: `Burst ${i}` })));
  const refused = made.filter((r) => r.status === 'rejected').map((r) => r.reason?.message);
  assert.deepEqual(refused, [], 'every save goes through');
  const codes = made.map((r) => r.value.employeeCode);
  assert.ok(codes.every((c) => /^NZ-\d+$/.test(c)), codes.join(' '));
  assert.equal(new Set(codes).size, 25, `codes handed out twice: ${codes.join(' ')}`);
  assert.deepEqual(await sharedCodes(), []);
});

await check('HR creates, associate quick-adds and Timebox imports all at once: every request succeeds, no code is handed out twice', async () => {
  const hr = Array.from({ length: 6 }, (_, i) => call('POST', '/employees', admin, { name: `HR New ${i}`, phone: `91000000${10 + i}`, artistRole: 'assistant' }));
  const quick = Array.from({ length: 6 }, (_, i) => call('POST', '/employees/associates', crm, { name: `Quick Add ${i}`, phone: `92000000${10 + i}` }));
  const syncs = [timebox.performTimeboxEmployeeSync(), timebox.performTimeboxEmployeeSync()];
  const answers = await Promise.all([...hr, ...quick]);
  assert.deepEqual(answers.map((r) => r.status), Array(12).fill(201), answers.find((r) => r.status !== 201)?.text);
  const summaries = await Promise.all(syncs);
  assert.ok(summaries.every((s) => s.ok === true));
  await syncIdle();
  assert.deepEqual(await sharedCodes(), []);
  assert.equal(await Employee.countDocuments({ $or: [{ employeeCode: null }, { employeeCode: '' }] }), 0, 'everyone has a code');
});

await check('a code already taken (typed in by hand) is skipped, never handed out again', async () => {
  const next = (await Counter.findById('employeeCode').lean())?.seq + 1;
  assert.ok(Number.isFinite(next), 'the counter exists');
  await Employee.create({ name: 'Hand Typed', employeeCode: `NZ-${next}` });
  await Employee.collection.insertOne({ name: 'Raw Insert', employeeCode: `NZ-${next + 1}`, createdAt: new Date() }); // never went through the model
  const after = await Employee.create({ name: 'After The Typed Ones' });
  assert.equal(after.employeeCode, `NZ-${next + 2}`);
  assert.deepEqual(await sharedCodes(), []);
});

await check('a brand-new counter (or a lost one) starts after the employees already there, even with many saves at once', async () => {
  await Counter.deleteOne({ _id: 'employeeCode' });
  const before = new Set((await Employee.find({}, 'employeeCode').lean()).map((e) => e.employeeCode));
  const made = await Promise.all(Array.from({ length: 10 }, (_, i) => Employee.create({ name: `After Reset ${i}` })));
  const codes = made.map((e) => e.employeeCode);
  assert.equal(new Set(codes).size, 10, codes.join(' '));
  assert.ok(codes.every((c) => !before.has(c)), 'none of them was already taken');
  assert.ok(codes.every((c) => codeNumber(c) >= 1001), codes.join(' '));
  assert.deepEqual(await sharedCodes(), []);
});

console.log('\n— the Timebox sync —');
await check('several syncs at once (boot, the 30-minute timer, "Sync now", employee creations) never import a person twice', async () => {
  await Employee.deleteMany({ timeboxEmployeeId: { $ne: null } });
  const runs = [1, 2, 3, 4].map(() => timebox.performTimeboxEmployeeSync());
  const hr = [1, 2].map((i) => call('POST', '/employees', admin, { name: `During Sync ${i}`, artistRole: 'assistant' }));
  assert.deepEqual((await Promise.all(hr)).map((r) => r.status), [201, 201]);
  assert.ok((await Promise.all(runs)).every((s) => s.ok === true));
  await syncIdle();
  assert.deepEqual(await twiceImported(), []);
  const ids = new Set((await Employee.find({ timeboxEmployeeId: { $ne: null } }, 'timeboxEmployeeId').lean()).map((e) => e.timeboxEmployeeId));
  assert.deepEqual(FIXTURE.map((t) => t.id).filter((id) => !ids.has(id)), [], 'every Timebox person is in the CRM');
  assert.deepEqual(await sharedCodes(), []);
});

await check('a Timebox person renamed (and given a new e-mail) in the CRM is still recognised by their Timebox id, not imported again', async () => {
  const tb = FIXTURE[0];
  await Employee.updateOne({ timeboxEmployeeId: tb.id }, { $set: { name: 'Renamed In CRM', email: 'renamed@e2e.test' } });
  const before = await Employee.countDocuments();
  const s = await timebox.performTimeboxEmployeeSync();
  assert.equal(s.created, 0, s.message);
  assert.equal(await Employee.countDocuments(), before);
  assert.deepEqual(await twiceImported(), []);
});

await check('a person HR adds while a sync is importing is saved once: linked to Timebox, not imported a second time', async () => {
  await Employee.deleteMany({ timeboxEmployeeId: { $ne: null } });
  const tb = FIXTURE.at(-1); // the sync imports everyone again and reaches this person last
  const running = timebox.performTimeboxEmployeeSync(); // its picture of the CRM is taken before HR adds them
  const r = await call('POST', '/employees', admin, { name: tb.full_name, email: tb.email, artistRole: 'staff' });
  // whoever saves first wins: HR's record (the sync then links it) or the import (HR is then told they already exist)
  assert.ok(r.status === 201 || (r.status === 400 && /already exists/i.test(r.body.message)), r.text);
  await running;
  await syncIdle();
  const people = await Employee.find({ $or: [{ timeboxEmployeeId: tb.id }, { email: String(tb.email).trim().toLowerCase() }] }).lean();
  assert.equal(people.length, 1, people.map((p) => `${p.name} <${p.email}> tb=${p.timeboxEmployeeId}`).join(' | '));
  assert.equal(people[0].timeboxEmployeeId, tb.id, 'linked to Timebox');
  assert.deepEqual(await twiceImported(), []);
});

await syncIdle();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
