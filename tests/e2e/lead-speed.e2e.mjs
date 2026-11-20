// End-to-end check of speed to lead — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/lead-speed.e2e.mjs
//
// Leads that came in on their own (an ad form, the website) are timed to their first contact: the first activity logged on them, or
// their first move out of New, stamped once by the server. One left waiting past the alert time tells its salesperson and the sales
// managers — once. The Lead Report's Speed to lead tab shows the figures; a Marketing Manager sets the target, alert and hours.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound service's key is blanked first (the code loads the real .env, which never overrides).
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN', 'META_CAPI_DATASET_ID']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/lead_speed_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Lead = await imp('models/Lead.js');
const LeadActivity = await imp('models/LeadActivity.js');
const Notification = await imp('models/Notification.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
const { businessMinutes } = await import(new URL('utils/leadResponse.js', root));
const { checkWaitingLeads } = await import(new URL('services/leadResponse.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/leads', await imp('routes/leadRoutes.js'));
app.use('/api/marketing/lead-report', await imp('routes/marketingLeadReportRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api`;
const call = async (method, path, who, body) => {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`); }
};

let n = 0;
const login = async (name, role) => {
  n += 1;
  const emp = await Employee.create({ name, department: 'Sales' });
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), _id: user._id, name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('Marketing Boss', 'marketing_admin');
const sm = await login('Sales Head', 'sales_manager');
const arjun = await login('Arjun', 'sales');
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const staff = await login('Marketing Staff', 'marketing_staff');

const MIN = 60 * 1000;
const ago = (m) => new Date(Date.now() - m * MIN);
let phone = 9800000000;
const lead = async (fields, minutesAgo) => {
  phone += 1;
  const l = await Lead.create({ name: fields.name, phone: String(phone), source: fields.source ?? 'Paid Ads Leads', status: 'New', assignedTo: arjun._id, ...fields });
  // the lead arrived [minutesAgo] (createdAt is immutable to Mongoose: written directly)
  await Lead.collection.updateOne({ _id: l._id }, { $set: { createdAt: ago(minutesAgo), leadDate: ago(minutesAgo) } });
  return l;
};
const range = `from=${addDays(istDay(new Date()), -1)}&to=${istDay(new Date())}`;

console.log('\n— settings —');
await check('only a Marketing Manager changes them; nonsense is refused with the reason', async () => {
  assert.equal((await call('PUT', '/marketing/lead-report/speed/settings', staff, { targetMinutes: 5 })).status, 403);
  const bad = await call('PUT', '/marketing/lead-report/speed/settings', boss, { dayStart: '21:00', dayEnd: '09:00' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /end after they start/);
  // every hour a working hour, so the test reads the same at any time of day
  const ok = await call('PUT', '/marketing/lead-report/speed/settings', boss, { targetMinutes: 15, alertAfterMinutes: 30, dayStart: '00:00', dayEnd: '23:59' });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.body.targetMinutes, ok.body.dayStart, ok.body.updatedByName], [15, '00:00', 'Marketing Boss']);
  assert.equal((await call('GET', '/marketing/lead-report/speed/settings', staff)).body.canEdit, false);
});

console.log('\n— the first contact is stamped once —');
let A, B, C, D, E;
await check('a call logged on a lead from an ad form is its first contact; a second call does not move it', async () => {
  A = await lead({ name: 'Anjali (ad form)', origin: 'meta_lead_ads' }, 50);
  const r = await call('POST', `/leads/${A._id}/activities`, arjun, { type: 'call', scheduledDate: new Date().toISOString(), remark: 'Called', channel: 'call' });
  assert.equal(r.status, 201, r.text);
  const a1 = await Lead.findById(A._id).lean();
  assert.ok(a1.firstContactAt);
  assert.deepEqual([a1.firstContactByName, a1.firstContactVia], ['Arjun', 'call']);
  await call('POST', `/leads/${A._id}/activities`, arjun, { type: 'call', scheduledDate: new Date().toISOString(), remark: 'Again', channel: 'whatsapp' });
  const a2 = await Lead.findById(A._id).lean();
  assert.equal(+a2.firstContactAt, +a1.firstContactAt);
  assert.equal(a2.firstContactVia, 'call');
});
await check('moving a lead out of New is a first contact too; the app cannot write the stamp itself', async () => {
  B = await lead({ name: 'Bina (website)', origin: 'website', source: 'Website' }, 20);
  const r = await call('PUT', `/leads/${B._id}`, arjun, { status: 'Contacted', firstContactAt: '2020-01-01T00:00:00Z', origin: 'meta_lead_ads' });
  assert.equal(r.status, 200, r.text);
  const b = await Lead.findById(B._id).lean();
  assert.equal(b.firstContactVia, 'status');
  assert.ok(Date.now() - b.firstContactAt < 60 * 1000, 'stamped now, not the date the app sent');
  assert.equal(b.origin, 'website', 'origin is the server\'s');
});

console.log('\n— the waiting alert —');
await check('a lead from a form left waiting past the alert time tells its salesperson and the sales head — once', async () => {
  C = await lead({ name: 'Chitra (ad form)', origin: 'meta_lead_ads' }, 45);
  D = await lead({ name: 'Devi (typed in)', origin: '', source: 'WhatsApp (Organic)' }, 45);
  E = await lead({ name: 'Elsa (ad form, called before the stamp)', origin: 'meta_lead_ads' }, 45);
  await LeadActivity.create({ leadId: E._id, createdBy: arjun._id, type: 'call', scheduledDate: ago(40), channel: 'call' });
  await Lead.collection.updateOne({ _id: E._id }, { $set: { firstContactAt: null } });
  const sent = await checkWaitingLeads();
  assert.equal(sent, 1, 'only Chitra');
  const notes = await Notification.find({ type: 'lead_waiting' }).lean();
  assert.deepEqual(notes.map((x) => String(x.recipient)).sort(), [arjun.id, sm.id].sort());
  assert.match(notes[0].body, /Chitra \(ad form\) .* has not been contacted yet/);
  assert.equal(await checkWaitingLeads(), 0, 'not twice');
  assert.equal(await Notification.countDocuments({ type: 'lead_waiting' }), 2);
  const e = await Lead.findById(E._id).lean();
  assert.equal(e.firstContactVia, 'call', 'the older call is stamped while checking');
});

console.log('\n— the Lead Report\'s Speed to lead —');
await check('the figures: leads that came in on their own, contacted, the median in working minutes, inside the target, waiting now', async () => {
  const r = await call('GET', `/marketing/lead-report/speed?${range}&brand=all`, staff);
  assert.equal(r.status, 200, r.text);
  const s = r.body;
  assert.equal(s.scope, 'auto');
  assert.equal(s.kpis.leads, 4, 'Anjali, Bina, Chitra, Elsa — not the lead typed in');
  assert.equal(s.kpis.contacted, 3);
  assert.equal(s.kpis.waiting, 1);
  assert.equal(s.kpis.late, 1);
  // Anjali ~50, Bina ~20, Elsa ~45 working minutes (every hour is a working hour here) → the median is Elsa's
  const e = await Lead.findById(E._id).lean();
  const elsa = businessMinutes(e.createdAt, e.firstContactAt, s.settings);
  assert.equal(s.kpis.medianMinutes, elsa);
  assert.ok(elsa >= 44 && elsa <= 46, `${elsa}`);
  assert.equal(s.kpis.withinPct, 0, 'none inside 15 minutes');
  assert.equal(s.waiting.length, 1);
  assert.deepEqual([s.waiting[0].name, s.waiting[0].assignee, s.waiting[0].late, s.waiting[0].alerted], ['Chitra (ad form)', 'Arjun', true, true]);
  assert.ok(s.waiting[0].waitingMinutes >= 44, `${s.waiting[0].waitingMinutes}`);
  assert.ok(!('phone' in s.waiting[0]), 'no numbers on this tab');
  assert.equal(s.byPerson[0].name, 'Arjun');
  assert.ok(s.bySource.some((g) => g.name === 'Website'));
  assert.equal(s.canEdit, false);
});
await check('?scope=all takes in the leads typed by staff too', async () => {
  const s = (await call('GET', `/marketing/lead-report/speed?${range}&brand=all&scope=all`, boss)).body;
  assert.equal(s.kpis.leads, 5);
  assert.equal(s.kpis.waiting, 2, 'Devi waits too');
  assert.equal(s.canEdit, true);
});
await check('the lead\'s own page shows its first contact', async () => {
  const d = (await call('GET', `/marketing/lead-report/leads/${A._id}`, boss)).body;
  assert.equal(d.firstContact.state, 'contacted');
  assert.equal(d.firstContact.by, 'Arjun');
  assert.equal(d.firstContact.cameOnItsOwn, true);
  const w = (await call('GET', `/marketing/lead-report/leads/${C._id}`, boss)).body;
  assert.equal(w.firstContact.state, 'waiting');
  assert.ok(w.firstContact.waitingMinutes >= 44);
});
await check('alerts switched off: nothing goes out', async () => {
  await call('PUT', '/marketing/lead-report/speed/settings', boss, { alertsOn: false });
  await lead({ name: 'Farah (ad form)', origin: 'meta_lead_ads' }, 90);
  assert.equal(await checkWaitingLeads(), 0);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
