// End-to-end check of Meta Lead Ads → CRM leads (/api/meta/webhook + /api/meta): Meta's set-up check, the signature, a form becoming a
// lead with its answers in the right fields and its campaign, Meta re-sending the same lead, a number that is already a lead, Sales
// taking turns, failures kept with a plain reason and tried again, "Check for missed leads" (with Graph's paging, never off Graph), who
// may see and change what, and the token never leaving the server. META IS FAKED — no request leaves this machine.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/meta-leads.e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_PAGE_IDS']) {
  process.env[k] = '';
}
const SECRET = 'e2e-app-secret';
const TOKEN = 'e2e-system-user-token';
const PAGE_TOKEN = 'e2e-page-token';
const VERIFY = 'e2e-verify-me';
const configure = () => Object.assign(process.env, { META_APP_SECRET: SECRET, META_ACCESS_TOKEN: TOKEN, META_WEBHOOK_VERIFY_TOKEN: VERIFY, META_GRAPH_VERSION: 'v25.0' });
configure();

await mongoose.connect('mongodb://127.0.0.1:27099/meta_leads_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Lead = await imp('models/Lead.js');
const Campaign = await imp('models/Campaign.js');
const Region = await imp('models/Region.js');
const District = await imp('models/District.js');
const Pincode = await imp('models/Pincode.js');
const Notification = await imp('models/Notification.js');
const MetaLeadEvent = await imp('models/MetaLeadEvent.js');
const { _setMetaFetch, _resetMetaCaches, drainMetaLeads } = await import(new URL('services/metaLeads.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

// ── a fake Meta ─────────────────────────────────────────────────────────────
const PAGE = '111';
const ago = (days) => new Date(Date.now() - days * 864e5).toISOString().replace(/\.\d{3}Z$/, '+0000');
const ans = (o) => Object.entries(o).map(([name, v]) => ({ name, values: Array.isArray(v) ? v : [v] }));
const LEADS = {
  9001: { form_id: '77', ad_id: '501', ad_name: 'Reel 17', adset_id: '401', campaign_id: '3001', campaign_name: 'Kerala Nov', platform: 'ig', is_organic: false, created_time: ago(0.1),
    field_data: ans({ full_name: 'Asha Nair', phone_number: '+91 98470 12345', email: 'asha@example.com', zip_code: '673001', city: 'Kozhikode', event_type: 'Wedding', 'when_is_your_wedding?': '15/12/2027', budget_range: '50k-1L' }) },
  9002: { form_id: '77', ad_name: 'Reel 17', campaign_id: '3001', created_time: ago(0.05), field_data: ans({ full_name: 'Bindu', phone_number: '+919847022222' }) },
  9003: { form_id: '77', ad_name: 'Reel 18', campaign_id: '9999', created_time: ago(0.05), field_data: ans({ full_name: 'Chitra', phone_number: '+919847033333' }) },
  9004: { form_id: '77', ad_name: 'Reel 17', campaign_id: '3001', created_time: ago(0.04), field_data: ans({ full_name: 'Deepa again', phone_number: '98470 55555' }) },
  9100: { form_id: '77', created_time: ago(0.03), field_data: ans({ full_name: 'Esha', phone_number: '+919847066666' }) },
  9300: { form_id: '78', created_time: ago(0.02), field_data: ans({ full_name: 'Fida', email: 'fida@example.com' }) },
  9400: { form_id: '77', created_time: ago(0.02), field_data: ans({ full_name: 'Gita', phone_number: '+919847077777' }) },
  9401: { form_id: '77', created_time: ago(0.02), field_data: ans({ full_name: 'Gita twin', phone_number: '+919847077777' }) },
  9500: { form_id: '77', created_time: ago(2), field_data: ans({ full_name: 'Hema', phone_number: '+919847088881' }) },
  9501: { form_id: '79', created_time: ago(3), field_data: ans({ full_name: 'Indu', phone_number: '+919847088882' }) },
  9502: { form_id: '79', created_time: ago(4), field_data: ans({ full_name: 'Jaya', phone_number: '+919847088883' }) },
};
const FORMS = { 77: 'Bridal Nov form', 78: 'Callback form', 79: 'Old form' };
const fail = { 9100: 'token' }; // leadgen id → how Meta refuses it (changed by the checks)
let pageTokenDown = false; // Meta will not hand out the Page's token
const calls = [];
_setMetaFetch(async (url) => {
  const u = new URL(url);
  const token = u.searchParams.get('access_token');
  calls.push({ host: u.hostname, path: u.pathname, params: Object.fromEntries(u.searchParams), token });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (u.hostname !== 'graph.facebook.com') return json(500, { error: { message: 'off graph' } });
  // every call carries the proof made from ITS token with the app secret
  if (u.searchParams.get('appsecret_proof') !== crypto.createHmac('sha256', SECRET).update(token ?? '').digest('hex')) {
    return json(400, { error: { code: 100, message: 'Invalid appsecret_proof provided in the API argument' } });
  }
  const parts = u.pathname.split('/').filter(Boolean); // ['v25.0', id, edge?]
  if (parts[0] !== 'v25.0') return json(400, { error: { code: 2635, message: 'no version' } });
  const [, id, edge] = parts;
  if (id === 'me') return json(200, { id: '5', name: 'Nizan Leads Bot' });
  if (id === PAGE && !edge && u.searchParams.get('fields') === 'access_token') return pageTokenDown ? json(503, {}) : json(200, { id: PAGE, access_token: PAGE_TOKEN });
  if (id === PAGE && !edge) return json(200, { id: PAGE, name: 'Team N Makeovers' });
  if (id === PAGE && edge === 'leadgen_forms') {
    if (u.searchParams.get('after') === 'p2') return json(200, { data: [{ id: '79', name: FORMS[79] }], paging: { next: 'https://evil.example.com/v25.0/111/leadgen_forms?after=p3' } });
    return json(200, { data: [{ id: '77', name: FORMS[77] }, { id: '78', name: FORMS[78] }], paging: { next: `https://graph.facebook.com/v25.0/${PAGE}/leadgen_forms?after=p2&access_token=${PAGE_TOKEN}` } });
  }
  if (FORMS[id] && !edge) return json(200, { id, name: FORMS[id] });
  if (FORMS[id] && edge === 'leads') {
    const since = JSON.parse(u.searchParams.get('filtering'))[0].value;
    const rows = Object.entries(LEADS)
      .filter(([, l]) => l.form_id === id && Date.parse(l.created_time.replace('+0000', 'Z')) / 1000 > since)
      .map(([lid, l]) => ({ id: lid, ...l }));
    return json(200, { data: rows });
  }
  if (LEADS[id]) {
    if (token !== PAGE_TOKEN) return json(400, { error: { code: 200, message: 'Requires leads_retrieval on the Page' } });
    if (fail[id] === 'token') return json(400, { error: { code: 190, error_subcode: 463, message: 'Session has expired' } });
    if (fail[id] === 'down') return json(503, {});
    return json(200, { id, ...LEADS[id] });
  }
  if (id === '9200') return json(400, { error: { code: 100, error_subcode: 33, message: 'Unsupported get request. Object with ID does not exist' } });
  return json(404, { error: { code: 803, message: 'Unknown object' } });
});

// ── the app, as server.js mounts it ─────────────────────────────────────────
const app = express();
app.use(sanitizeErrorResponses);
app.use('/api/meta/webhook', express.raw({ type: () => true, limit: '1mb' }), await imp('routes/metaWebhookRoutes.js'));
app.use(express.json());
app.use('/api/meta', await imp('routes/metaLeadRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, { token, method = 'GET', body, raw, headers = {} } = {}) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
};
const hook = (ids, { secret = SECRET, page = PAGE } = {}) => {
  const raw = JSON.stringify({
    object: 'page',
    entry: [{ id: page, time: 1, changes: ids.map((id) => ({ field: 'leadgen', value: { leadgen_id: id, page_id: page, form_id: LEADS[id]?.form_id ?? '77', created_time: 1794990000 } })) }],
  });
  return call('/meta/webhook', { method: 'POST', raw, headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` } });
};
const settle = async () => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
    await drainMetaLeads();
    if (!(await MetaLeadEvent.exists({ status: { $in: ['received', 'working'] } }))) return;
  }
};
const ev = (leadgenId) => MetaLeadEvent.findOne({ leadgenId }).lean();

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

// ── people and data ──────────────────────────────────────────────────────────
let n = 0;
const person = async (name, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name, email: `${name.toLowerCase().replace(/\s+/g, '')}${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const head = await person('Meera Head', 'marketing_admin');
const member = await person('Saeeda', 'marketing_staff');
const manager = await person('Mani Manager', 'manager');
const sales1 = await person('Sam One', 'sales');
const sales2 = await person('Sara Two', 'sales_executive');
const salesOff = await person('Sid Gone', 'sales', { active: false });
const artist = await person('Arti', 'artist');
const region = await Region.create({ name: 'Kerala' });
const district = await District.create({ name: 'Kozhikode', region: region._id });
await Pincode.create({ code: '673001', district: district._id });
const campaign = await Campaign.create({ title: 'Kerala November', metaCampaignId: '3001', brand: 'kerala' });
const deepa = await Lead.create({ name: 'Deepa', phone: '+919847055555', assignedTo: sales1.user._id, source: 'WhatsApp (Organic)' });

console.log('Meta Lead Ads');

await check("Meta's set-up check: the verify token echoes the challenge; anything else is refused", async () => {
  const ok = await call(`/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
  assert.equal(ok.status, 200);
  assert.equal(ok.text, '1158201444');
  assert.equal((await call(`/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);
  assert.equal((await call(`/meta/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=%3Cscript%3E`)).status, 403, 'never echoes markup');
});

await check('a body without Meta\'s signature (or signed with another secret) is refused and nothing is stored', async () => {
  const raw = JSON.stringify({ object: 'page', entry: [{ id: PAGE, changes: [{ field: 'leadgen', value: { leadgen_id: '9001' } }] }] });
  assert.equal((await call('/meta/webhook', { method: 'POST', raw, headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await hook(['9001'], { secret: 'not-the-secret' })).status, 401);
  assert.equal(await MetaLeadEvent.countDocuments(), 0);
  assert.equal(calls.length, 0, 'Meta was not even asked');
});

await check('a form becomes a CRM lead: answers in their fields, its campaign, the rest in the remarks, managers told', async () => {
  const r = await hook(['9001']);
  assert.equal(r.status, 200);
  await settle();
  const e = await ev('9001');
  assert.equal(e.status, 'created', e.problemText);
  const lead = await Lead.findById(e.leadId).lean();
  assert.equal(lead.name, 'Asha Nair');
  assert.equal(lead.phone, '+919847012345');
  assert.equal(lead.email, 'asha@example.com');
  assert.equal(lead.source, 'Paid Ads Leads');
  assert.equal(String(lead.campaignId), String(campaign._id));
  assert.equal(lead.creative, 'Reel 17');
  assert.equal(lead.location, 'Kozhikode');
  assert.equal(lead.eventType, 'Wedding');
  assert.equal(lead.pincode, '673001');
  assert.equal(lead.district, 'Kozhikode', 'the pincode list gives the district');
  assert.equal(new Date(lead.probableDate.getTime() + 330 * 60000).toISOString().slice(0, 10), '2027-12-15');
  assert.equal(lead.createdByName, 'Meta Lead Ads');
  assert.equal(lead.assignedTo, null, 'nobody chosen yet: it waits for a manager');
  assert.equal(lead.status, 'New');
  assert.match(lead.remarks, /^Meta Lead Ads on Instagram · form "Bridal Nov form" · ad "Reel 17" · campaign "Kerala Nov"/);
  assert.match(lead.remarks, /Budget range: 50k-1L/);
  assert.equal(Math.abs(new Date(lead.leadDate) - Date.parse(LEADS[9001].created_time.replace('+0000', 'Z'))) < 1000, true, 'dated when she sent it');
  const told = await Notification.find({ leadId: lead._id }).lean();
  assert.ok(told.some((x) => String(x.recipient) === String(manager.user._id) && x.title === 'New Meta lead'));
  // and Marketing's manager (the ads are theirs) — not every Marketing member
  assert.ok(told.some((x) => String(x.recipient) === String(head.user._id) && x.title === 'New Meta lead'), 'the Marketing Manager hears of it');
  assert.equal(told.some((x) => String(x.recipient) === String(member.user._id)), false);
  assert.equal(told.filter((x) => String(x.recipient) === String(head.user._id)).length, 1, 'once');
  const leadCall = calls.find((c) => c.path === '/v25.0/9001');
  assert.equal(leadCall.token, PAGE_TOKEN, 'the lead is read as the Page');
  assert.equal(e.formName, 'Bridal Nov form');
  assert.equal(String(e.campaignId), String(campaign._id));
});

await check('Meta sending the same lead again changes nothing', async () => {
  const before = await Lead.countDocuments();
  assert.equal((await hook(['9001'])).status, 200);
  await settle();
  assert.equal(await Lead.countDocuments(), before);
  assert.equal(await MetaLeadEvent.countDocuments({ leadgenId: '9001' }), 1);
});

await check('who gets new leads: only the Marketing Manager / admin may choose, and only active Sales logins', async () => {
  const ids = [String(sales1.user._id), String(sales2.user._id)];
  assert.equal((await call('/meta/settings', { token: member.token, method: 'PUT', body: { assignMode: 'rotate', rotateUserIds: ids } })).status, 403);
  assert.equal((await call('/meta/settings', { token: head.token, method: 'PUT', body: { assignMode: 'rotate', rotateUserIds: [String(artist.user._id)] } })).status, 400);
  assert.equal((await call('/meta/settings', { token: head.token, method: 'PUT', body: { assignMode: 'rotate', rotateUserIds: [String(salesOff.user._id)] } })).status, 400);
  assert.equal((await call('/meta/settings', { token: head.token, method: 'PUT', body: { assignMode: 'rotate', rotateUserIds: [] } })).status, 400);
  const ok = await call('/meta/settings', { token: head.token, method: 'PUT', body: { assignMode: 'rotate', rotateUserIds: ids } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.settings.rotateUsers.map((u) => u.name), ['Sam One', 'Sara Two']);
});

await check('Sales take turns; each is told; a campaign Meta knows but we do not is left untagged', async () => {
  assert.equal((await hook(['9002', '9003'])).status, 200);
  await settle();
  const [b, c] = await Promise.all([ev('9002'), ev('9003')]);
  assert.equal(b.status, 'created');
  assert.equal(c.status, 'created');
  const leads = await Lead.find({ _id: { $in: [b.leadId, c.leadId] } }).lean();
  assert.deepEqual(leads.map((l) => String(l.assignedTo)).sort(), [String(sales1.user._id), String(sales2.user._id)].sort());
  assert.equal(leads.find((l) => l.name === 'Chitra').campaignId, null);
  for (const l of leads) assert.ok(await Notification.exists({ recipient: l.assignedTo, leadId: l._id, title: 'New Meta lead for you' }));
});

await check('a number that is already a lead: no second lead; noted on hers; her owner told', async () => {
  const before = await Lead.countDocuments();
  await hook(['9004']);
  await settle();
  const e = await ev('9004');
  assert.equal(e.status, 'existing');
  assert.equal(String(e.leadId), String(deepa._id));
  assert.equal(await Lead.countDocuments(), before);
  const after = await Lead.findById(deepa._id).lean();
  assert.equal(after.auditLog.at(-1).action, 'meta_form_again');
  assert.match(after.auditLog.at(-1).note, /Bridal Nov form/);
  assert.equal(after.name, 'Deepa', 'nothing else on her lead changes');
  assert.ok(await Notification.exists({ recipient: sales1.user._id, leadId: deepa._id, title: 'Meta lead came again' }));
});

await check('two forms with one number in the same webhook make one lead, not two', async () => {
  await hook(['9400', '9401']);
  await settle();
  assert.equal(await Lead.countDocuments({ phone: '+919847077777' }), 1);
  assert.deepEqual([(await ev('9400')).status, (await ev('9401')).status].sort(), ['created', 'existing']);
});

await check('a refused token: kept with a plain reason and a next try; Retry takes it in once Meta answers', async () => {
  // the Page's token has expired and no fresh one can be had: the configured token is tried and refused for ANOTHER reason (it may
  // not read leads itself) — the team must still be told the real cause, the expired token
  pageTokenDown = true;
  await hook(['9100']);
  await settle();
  pageTokenDown = false;
  _resetMetaCaches();
  let e = await ev('9100');
  assert.equal(e.status, 'failed');
  assert.equal(e.problemCode, 'token');
  assert.match(e.problemText, /META_ACCESS_TOKEN/);
  assert.equal(e.retry, true);
  assert.ok(e.nextTryAt > new Date(Date.now() + 4 * 60000), 'about 5 minutes later');
  delete fail[9100];
  const r = await call(`/meta/events/${e._id}/retry`, { token: member.token, method: 'POST' });
  assert.equal(r.status, 200);
  e = await ev('9100');
  assert.equal(e.status, 'created');
  assert.equal(e.problemText, '');
  assert.equal((await call(`/meta/events/${e._id}/retry`, { token: member.token, method: 'POST' })).status, 409, 'only a failed lead');
});

await check('a lead Meta no longer has is not tried again; a form without a phone is shown with its e-mail', async () => {
  await hook(['9200', '9300']);
  await settle();
  const gone = await ev('9200');
  assert.equal(gone.problemCode, 'missing');
  assert.equal(gone.retry, false);
  assert.equal(gone.nextTryAt, null);
  const noPhone = await ev('9300');
  assert.equal(noPhone.problemCode, 'no_phone');
  assert.equal(await Lead.exists({ name: 'Fida' }), null);
  const list = await call('/meta/events?status=failed', { token: member.token });
  assert.equal(list.status, 200);
  const shown = list.body.items.find((i) => i.leadgenId === '9300');
  assert.equal(shown.email, 'fida@example.com');
  assert.equal(shown.leadName, 'Fida');
  assert.equal(list.body.items.find((i) => i.leadgenId === '9200').email, '');
});

await check('Meta down: tried again on its own once due', async () => {
  LEADS[9600] = { form_id: '77', created_time: ago(0.01), field_data: ans({ full_name: 'Kavya', phone_number: '+919847099991' }) };
  fail[9600] = 'down';
  await hook(['9600']);
  await settle();
  assert.equal((await ev('9600')).problemCode, 'meta_down');
  delete fail[9600];
  await MetaLeadEvent.updateOne({ leadgenId: '9600' }, { $set: { nextTryAt: new Date(Date.now() - 1000) } }); // its time has come
  await drainMetaLeads();
  assert.equal((await ev('9600')).status, 'created');
});

await check('Check for missed leads: every form (Graph\'s paging, never off Graph), only the days asked, nothing twice', async () => {
  const before = calls.length;
  const r = await call('/meta/check', { token: member.token, method: 'POST', body: { days: 7 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.forms, 3);
  assert.equal(r.body.found, Object.keys(LEADS).length, 'every lead of the three forms in the last 7 days');
  const since = Number(JSON.parse(calls.slice(before).find((c) => c.path.endsWith('/77/leads')).params.filtering)[0].value);
  assert.ok(Math.abs(since - (Date.now() / 1000 - 7 * 86400)) < 60, 'from 7 days ago');
  assert.equal(calls.slice(before).some((c) => c.host !== 'graph.facebook.com'), false, 'the off-Graph next link was not followed');
  const formPages = calls.slice(before).filter((c) => c.path.endsWith('/leadgen_forms'));
  assert.equal(formPages.length, 2, 'two pages of forms');
  for (const id of ['9500', '9501', '9502']) {
    const e = await ev(id);
    assert.equal(e.via, 'check');
    assert.equal(e.status, 'created');
  }
  assert.equal(r.body.added, 3);
  assert.equal(r.body.already, r.body.found - 3);
  const again = await call('/meta/check', { token: member.token, method: 'POST', body: { days: 7 } });
  assert.equal(again.body.added, 0);
  assert.equal(again.body.already, again.body.found);
  assert.equal((await call('/meta/check', { token: member.token, method: 'POST', body: { days: 120 } })).status, 400);
});

await check('the status screen: what is set (never the values), counts, Pages learnt from the leads, the last check', async () => {
  const s = await call('/meta/status', { token: member.token });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.config, { appSecret: true, token: true, verifyToken: true, ready: true, version: 'v25.0', webhookPath: '/api/meta/webhook' });
  assert.equal(s.body.canManage, false);
  assert.deepEqual(s.body.pageIds, [PAGE]);
  assert.ok(s.body.counts30.created >= 8);
  assert.equal(s.body.counts30.failed, 2);
  assert.equal(s.body.lastCheck.added, 0);
  assert.deepEqual(s.body.assignees.map((a) => a.name).sort(), ['Sam One', 'Sara Two'], 'active Sales logins only');
  const t = await call('/meta/test', { token: member.token, method: 'POST' });
  assert.equal(t.body.ok, true);
  assert.equal(t.body.name, 'Nizan Leads Bot');
  assert.deepEqual(t.body.pages, [{ id: PAGE, name: 'Team N Makeovers', ok: true, problem: '' }]);
  for (const text of [s.text, t.text, (await call('/meta/events', { token: member.token })).text]) {
    for (const secret of [SECRET, TOKEN, PAGE_TOKEN, VERIFY]) assert.equal(text.includes(secret), false, 'a secret left the server');
  }
  assert.equal((await call('/meta/status', { token: head.token })).body.canManage, true);
});

await check('only the Marketing team (and admin / manager) may open it', async () => {
  assert.equal((await call('/meta/status', { token: artist.token })).status, 403);
  assert.equal((await call('/meta/status', { token: sales1.token })).status, 403);
  assert.equal((await call('/meta/status')).status, 401);
  assert.equal((await call('/meta/status', { token: manager.token })).status, 200);
});

await check('not set up on the server: the webhook says so (Meta tries again later) and nothing is fetched', async () => {
  process.env.META_APP_SECRET = '';
  _resetMetaCaches();
  assert.equal((await hook(['9700'])).status, 503);
  assert.equal((await call('/meta/check', { token: member.token, method: 'POST', body: { days: 7 } })).status, 409);
  const s = await call('/meta/status', { token: member.token });
  assert.equal(s.body.config.ready, false);
  assert.equal(s.body.config.appSecret, false);
  configure();
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
