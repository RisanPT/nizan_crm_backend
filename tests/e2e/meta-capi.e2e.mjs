// End-to-end check of sending lead results back to Meta (/api/meta/capi): nothing until set up AND switched on (by a manager); every
// stage each Lead Ads lead's CRM lead has reached is sent once, in order, with Meta's rules (system_generated, crm source, the lead id
// exact and unhashed, phone and e-mail hashed, never older than 7 days); a client who booked before the form counts only as a Lead; a
// refused request is retried event by event so one bad event does not hold the rest back; a refused token stops the run and says so;
// an Events Manager token goes without our app's proof; the test code; one run at a time; who may do what; no secret leaves the server.
// META IS FAKED — no request leaves this machine.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/meta-capi.e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_PAGE_IDS', 'META_WEBHOOK_VERIFY_TOKEN', 'META_AD_ACCOUNTS', 'META_APP_SECRET', 'META_ACCESS_TOKEN', 'META_CAPI_DATASET_ID', 'META_CAPI_TOKEN', 'META_CAPI_TEST_CODE']) {
  process.env[k] = '';
}
const SECRET = 'e2e-app-secret';
const TOKEN = 'e2e-system-user-token';
const CAPI_TOKEN = 'e2e-events-manager-token';
const DATASET = '888777666';
const configure = () => Object.assign(process.env, { META_APP_SECRET: SECRET, META_ACCESS_TOKEN: TOKEN, META_CAPI_DATASET_ID: DATASET, META_GRAPH_VERSION: 'v25.0' });

await mongoose.connect('mongodb://127.0.0.1:27099/meta_capi_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Lead = await imp('models/Lead.js');
const MetaLeadEvent = await imp('models/MetaLeadEvent.js');
const MetaCapiEvent = await imp('models/MetaCapiEvent.js');
const MetaCapiState = await imp('models/MetaCapiState.js');
const { _setMetaFetch } = await import(new URL('services/metaGraph.js', root));
const { runCapi } = await import(new URL('services/metaCapi.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

// ── a fake Meta (Conversions API) ───────────────────────────────────────────
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
const requests = [];
let refuseToken = false;
let refuseRight = false;
_setMetaFetch(async (url, opts) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const token = u.searchParams.get('access_token');
  const proof = u.searchParams.get('appsecret_proof');
  const raw = opts.body;
  requests.push({ path: u.pathname, method: opts.method, token, proof, raw, body: JSON.parse(raw) });
  if (u.hostname !== 'graph.facebook.com' || opts.method !== 'POST' || u.pathname !== `/v25.0/${DATASET}/events`) return json(400, { error: { code: 803, message: 'Unknown path' } });
  if (refuseToken) return json(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
  if (refuseRight) return json(400, { error: { code: 200, message: 'Permissions error' } });
  if (token === TOKEN && proof !== crypto.createHmac('sha256', SECRET).update(TOKEN).digest('hex')) return json(400, { error: { code: 100, message: 'Invalid appsecret_proof' } });
  if (token === CAPI_TOKEN && proof) return json(400, { error: { code: 100, message: 'Invalid appsecret_proof' } });
  if (![TOKEN, CAPI_TOKEN].includes(token)) return json(400, { error: { code: 190, message: 'Invalid token' } });
  const body = JSON.parse(raw);
  for (const e of body.data) {
    // Meta drops the whole request when one event is bad
    if (e.action_source !== 'system_generated' || e.custom_data?.event_source !== 'crm' || !e.custom_data?.lead_event_source) return json(400, { error: { code: 100, message: 'Invalid parameter' } });
    if (typeof e.user_data?.lead_id !== 'number' || String(e.user_data.lead_id) === '999') return json(400, { error: { code: 100, message: 'Invalid lead_id' } });
    if (e.event_time * 1000 < Date.now() - 7 * 864e5) return json(400, { error: { code: 100, message: 'event_time too old' } });
  }
  return json(200, { events_received: body.data.length, messages: [], fbtrace_id: `trace-${requests.length}` });
});
const events = () => requests.flatMap((r) => r.body.data ?? []);

// ── the app ─────────────────────────────────────────────────────────────────
const app = express();
app.use(sanitizeErrorResponses);
app.use(express.json());
app.use('/api/meta', await imp('routes/metaLeadRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {
    j = null;
  }
  return { status: res.status, body: j, text };
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
const person = async (name, role) => {
  n += 1;
  const user = await User.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '')}${n}@e2e.test`, password: 'secret123', role });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const head = await person('Meera Head', 'marketing_admin');
const member = await person('Saeeda', 'marketing_staff');
const artist = await person('Arti', 'artist');

const ago = (ms) => new Date(Date.now() - ms);
const H = 3600 * 1000;
const D = 24 * H;
/** A Lead Ads lead: its CRM lead (status, times set exactly) and its Meta event. */
const metaLead = async (leadgenId, { status = 'New', submitted = ago(2 * H), updated = null, booked = null, metaStatus = 'created', phone, email, noticed = submitted } = {}) => {
  const lead = await Lead.create({ name: `Bride ${leadgenId.slice(-3)}`, phone: phone ?? `+9198470${leadgenId.slice(-5)}`, email, status: 'New' });
  await Lead.updateOne({ _id: lead._id }, { $set: { status, updatedAt: updated ?? submitted, ...(booked ? { bookedDate: booked, bookingId: new mongoose.Types.ObjectId() } : {}) } }, { timestamps: false });
  const ev = await MetaLeadEvent.create({ leadgenId, status: metaStatus, leadId: metaStatus === 'failed' ? null : lead._id, submittedAt: submitted, leadName: lead.name });
  await MetaLeadEvent.collection.updateOne({ _id: ev._id }, { $set: { createdAt: noticed } }); // createdAt is immutable to Mongoose: a raw write
  return lead;
};
const A = await metaLead('120000000000001', { status: 'New' });
const B = await metaLead('12345678901234567', { status: 'Converted', submitted: ago(3 * D), updated: ago(H), booked: ago(2 * H), phone: '98470 12345', email: ' Asha@Example.com ' });
await metaLead('120000000000003', { status: 'Lost', updated: ago(H) });
await metaLead('120000000000004', { status: 'Contacted', submitted: ago(10 * D), updated: ago(H) });
await metaLead('120000000000005', { status: 'Converted', submitted: ago(D), booked: ago(20 * D), metaStatus: 'existing' }); // a client who booked before the form
await metaLead('120000000000006', { metaStatus: 'failed' });
await metaLead('120000000000007', { status: 'Qualified', submitted: ago(40 * D), noticed: ago(40 * D), updated: ago(H) }); // older than the 35 days followed
await metaLead('120000000000008', { status: 'Pending Lost Approval', updated: ago(H) });
const stagesOf = async (leadgenId) => (await MetaCapiEvent.find({ leadgenId }).sort({ eventTime: 1 }).lean()).map((e) => `${e.stage}:${e.status}`);

console.log('Lead results back to Meta');

await check('not set up: the screen says so, Send now explains, nothing is sent', async () => {
  const s = await call('/meta/capi/status', { token: member.token });
  assert.equal(s.status, 200);
  assert.equal(s.body.config.ready, false);
  assert.equal(s.body.config.dataset, false);
  assert.equal((await call('/meta/capi/send', { token: member.token, method: 'POST' })).status, 409);
  assert.equal(requests.length, 0);
});

configure();

await check('set up but switched off: still nothing — only a manager switches it on', async () => {
  const r = await call('/meta/capi/send', { token: member.token, method: 'POST' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'off');
  assert.deepEqual(await runCapi(), { off: true });
  assert.equal(requests.length, 0);
  assert.equal(await MetaCapiEvent.countDocuments(), 0, 'not even planned');
  assert.equal((await call('/meta/capi/settings', { token: member.token, method: 'PUT', body: { enabled: true } })).status, 403);
  assert.equal((await call('/meta/capi/settings', { token: head.token, method: 'PUT', body: { enabled: 'yes' } })).status, 400);
  const on = await call('/meta/capi/settings', { token: head.token, method: 'PUT', body: { enabled: true } });
  assert.equal(on.status, 200);
  assert.equal(on.body.settings.enabled, true);
  assert.ok(on.body.settings.enabledAt);
});

await check('Send now: every stage reached, once, in order, as Meta asks', async () => {
  const r = await call('/meta/capi/send', { token: member.token, method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.run.ok, true, r.body.run.problem);
  assert.equal(requests.length, 1, 'one request of up to 50');
  const req = requests[0];
  assert.equal(req.token, TOKEN);
  assert.ok(req.proof, 'our token goes with our app\'s proof');
  assert.equal(req.body.test_event_code, undefined);
  // (JSON.parse reads a 17-digit id into a number that loses its last digit — compare the same way; the raw body is checked below)
  const byLead = (id) => req.body.data.filter((e) => e.user_data.lead_id === Number(id)).map((e) => e.event_name);
  assert.deepEqual(byLead('12345678901234567'), ['Lead', 'Contacted', 'Qualified', 'Converted'], 'a booking: every earlier stage first');
  assert.deepEqual(byLead('120000000000001'), ['Lead']);
  assert.deepEqual(byLead('120000000000003'), ['Lead', 'Lost']);
  assert.deepEqual(byLead('120000000000008'), ['Lead'], 'a lost request not decided yet sends nothing more');
  assert.deepEqual(byLead('120000000000005'), ['Lead'], 'booked before the form: not this form\'s result');
  assert.deepEqual(byLead('120000000000006'), []);
  assert.deepEqual(byLead('120000000000007'), [], 'older than the 35 days followed');
  assert.deepEqual(byLead('120000000000004'), ['Contacted'], 'its Lead was already too old to send');
  assert.match(req.raw, /"lead_id":12345678901234567[,}]/, 'all 17 digits, as a number');
  for (const e of req.body.data) {
    assert.equal(e.action_source, 'system_generated');
    assert.deepEqual(e.custom_data, { event_source: 'crm', lead_event_source: 'Team N CRM' });
  }
  const conv = req.body.data.find((e) => e.event_name === 'Converted');
  assert.deepEqual(conv.user_data.ph, [sha('919847012345')]);
  assert.deepEqual(conv.user_data.em, [sha('asha@example.com')]);
  assert.equal(req.raw.includes('98470') || req.raw.includes('Asha'), false, 'no phone or e-mail in the clear');
  assert.equal(Math.abs(conv.event_time - Math.floor((Date.now() - 2 * H) / 1000)) < 5, true, 'Converted at the booking');
  assert.deepEqual(await stagesOf('120000000000004'), ['Lead:skipped', 'Contacted:sent']);
  assert.equal((await MetaCapiEvent.findOne({ leadgenId: '120000000000004', stage: 'Lead' }).lean()).problemCode, 'too_old');
  assert.equal(r.body.run.sent, 10);
  assert.equal(r.body.run.skipped, 1);
});

await check('the next run sends nothing twice; a lead moving on sends only its new stages', async () => {
  await runCapi({ trigger: 'manual' });
  assert.equal(requests.length, 1, 'nothing new: no request');
  await Lead.updateOne({ _id: A._id }, { $set: { status: 'Qualified', updatedAt: ago(10 * 60 * 1000) } }, { timestamps: false });
  const r = await runCapi({ trigger: 'manual' });
  assert.equal(r.sent, 2);
  assert.deepEqual(requests.at(-1).body.data.map((e) => e.event_name), ['Contacted', 'Qualified']);
  assert.deepEqual(await stagesOf('120000000000001'), ['Lead:sent', 'Contacted:sent', 'Qualified:sent']);
});

await check('one bad event drops its request: each is then tried alone, so the good ones go and the bad one keeps failing until it stops', async () => {
  await metaLead('999', { status: 'New' });
  await metaLead('120000000000010', { status: 'Contacted', updated: ago(H) });
  const first = await runCapi({ trigger: 'manual' });
  assert.equal(first.ok, false);
  assert.equal(first.failed, 3);
  assert.equal(first.problemCode, 'refused');
  for (const e of await MetaCapiEvent.find({ status: 'failed' }).lean()) {
    assert.equal(e.retry, true);
    assert.ok(e.nextTryAt > new Date(Date.now() + 9 * 60000), 'about 10 minutes later');
  }
  await MetaCapiEvent.updateMany({ status: 'failed' }, { $set: { nextTryAt: ago(1000) } });
  const before = requests.length;
  await runCapi({ trigger: 'manual' });
  assert.equal(requests.length - before, 3, 'one request each');
  assert.deepEqual(await stagesOf('120000000000010'), ['Lead:sent', 'Contacted:sent']);
  const bad = await MetaCapiEvent.findOne({ leadgenId: '999' }).lean();
  assert.deepEqual([bad.status, bad.attempts, bad.retry], ['failed', 2, false], 'alone and refused for a reason trying again cannot fix');
});

await check('a refused token stops the run at once and says so', async () => {
  refuseToken = true;
  await metaLead('120000000000011', { status: 'New' });
  await metaLead('120000000000012', { status: 'New' });
  await MetaCapiEvent.updateOne({ leadgenId: '999' }, { $set: { retry: true, nextTryAt: ago(1000) } });
  const before = requests.length;
  const r = await runCapi({ trigger: 'manual' });
  assert.equal(r.ok, false);
  assert.equal(r.problemCode, 'token');
  assert.equal(requests.length - before, 1, 'no point asking again with the same token');
  const s = await call('/meta/capi/status', { token: member.token });
  assert.equal(s.body.lastRun.problemCode, 'token');
  assert.match(s.body.lastRun.problem, /META_ACCESS_TOKEN/);
  refuseToken = false;
  await MetaCapiEvent.updateMany({ status: 'failed', leadgenId: { $ne: '999' } }, { $set: { nextTryAt: ago(1000) } });
  await runCapi({ trigger: 'manual' });
  assert.deepEqual(await stagesOf('120000000000011'), ['Lead:sent']);
});

await check('an Events Manager token goes without our app\'s proof; the test code sends to Test events and marks them', async () => {
  Object.assign(process.env, { META_CAPI_TOKEN: CAPI_TOKEN, META_CAPI_TEST_CODE: 'TEST4242' });
  await metaLead('120000000000013', { status: 'New' });
  await MetaCapiEvent.updateOne({ leadgenId: '999' }, { $set: { retry: false } });
  const r = await runCapi({ trigger: 'manual' });
  assert.equal(r.ok, true, r.problem);
  const req = requests.at(-1);
  assert.equal(req.token, CAPI_TOKEN);
  assert.equal(req.proof, null);
  assert.equal(req.body.test_event_code, 'TEST4242');
  assert.equal((await MetaCapiEvent.findOne({ leadgenId: '120000000000013' }).lean()).test, true);
  const s = await call('/meta/capi/status', { token: member.token });
  assert.equal(s.body.config.ownToken, true);
  assert.equal(s.body.config.testMode, true);
  // its refusal names ITS setting, and a missing right names the dataset (not Lead Ads' wording)
  refuseToken = true;
  await metaLead('120000000000016', { status: 'New' });
  const t = await runCapi({ trigger: 'manual' });
  assert.match(t.problem, /META_CAPI_TOKEN/);
  refuseToken = false;
  refuseRight = true;
  await metaLead('120000000000017', { status: 'New' });
  const p = await runCapi({ trigger: 'manual' });
  assert.equal(p.problemCode, 'permission');
  assert.match(p.problem, /dataset/);
  assert.doesNotMatch(p.problem, /lead/i);
  refuseRight = false;
  process.env.META_CAPI_TOKEN = '';
  process.env.META_CAPI_TEST_CODE = '';
});

await check('a waiting event that grew older than 7 days expires instead of being sent', async () => {
  const lead = await metaLead('120000000000014', { status: 'New' });
  await MetaCapiEvent.create({ leadgenId: '120000000000014', leadId: lead._id, stage: 'Lead', eventTime: Math.floor((Date.now() - 8 * D) / 1000), status: 'pending' });
  const before = requests.length;
  const r = await runCapi({ trigger: 'manual' });
  assert.equal(r.expired, 1);
  assert.equal(requests.length, before, 'nothing to send');
  assert.equal((await MetaCapiEvent.findOne({ leadgenId: '120000000000014' }).lean()).status, 'expired');
});

await check('one run at a time; switched off, the timer does nothing', async () => {
  await MetaCapiState.updateOne({ key: 'capi' }, { $set: { running: true, runningSince: new Date() } });
  assert.equal((await call('/meta/capi/send', { token: member.token, method: 'POST' })).status, 409);
  await MetaCapiState.updateOne({ key: 'capi' }, { $set: { runningSince: ago(21 * 60000) } });
  assert.equal((await call('/meta/capi/send', { token: member.token, method: 'POST' })).status, 200, 'a dead run does not block');
  await call('/meta/capi/settings', { token: head.token, method: 'PUT', body: { enabled: false } });
  await metaLead('120000000000015', { status: 'New' });
  const before = requests.length;
  assert.deepEqual(await runCapi({ trigger: 'auto' }), { off: true });
  assert.equal(requests.length, before);
});

await check('status: counts by stage and state, the latest events, how many leads are followed — never a secret; Marketing only', async () => {
  const s = await call('/meta/capi/status', { token: member.token });
  assert.equal(s.status, 200);
  assert.equal(s.body.canManage, false);
  assert.equal(s.body.settings.enabled, false);
  assert.ok(s.body.sentByStage30.Converted >= 1);
  assert.ok(s.body.counts30.sent >= 15);
  assert.equal(s.body.counts30.skipped, 1);
  assert.ok(s.body.followed >= 10);
  assert.ok(s.body.recent.length > 0);
  const list = await call('/meta/capi/events?status=failed', { token: member.token });
  assert.deepEqual(list.body.items.map((e) => e.leadgenId).sort(), ['120000000000016', '120000000000017', '999']);
  assert.ok(list.body.items.every((e) => e.status === 'failed'));
  assert.equal((await call('/meta/capi/events?status=nope', { token: member.token })).status, 400);
  for (const secret of [SECRET, TOKEN, CAPI_TOKEN]) assert.equal(s.text.includes(secret), false);
  assert.equal((await call('/meta/capi/status', { token: artist.token })).status, 403);
  assert.equal((await call('/meta/capi/send', { method: 'POST' })).status, 401);
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
