// End-to-end check of the Campaigns hub — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run
// against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-campaign-hub.e2e.mjs
//
// The document's method: bring the paid-ads figures in ONCE (a Meta Ads Manager export, or a day typed by hand), keep leads / bookings in the
// CRM, log work against a campaign — then every screen follows: Overview, All Campaigns (+ a campaign's own page), Performance, Creatives &
// Ads, Budget & Spend, Leads & Conversions, Reports. There is no live Meta sync, so the Meta card must say "Not connected".
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first — no booking e-mail, SMS, WhatsApp, maps or AI call reaches anybody.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_campaign_hub_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Campaign = await imp('models/Campaign.js');
const Metric = await imp('models/CampaignDailyMetric.js');
const Ad = await imp('models/CampaignAd.js');
const AdDay = await imp('models/CampaignAdDailyMetric.js');
const Breakdown = await imp('models/CampaignBreakdownMetric.js');
const ImportLog = await imp('models/MetaImportLog.js');
const Lead = await imp('models/Lead.js');
const Booking = await imp('models/Booking.js');
const Activity = await imp('models/MarketingActivity.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
const { invalidateSalesRules } = await import(new URL('utils/salesRules.js', root));
const Hub = await import(new URL('controllers/marketingCampaignHubController.js', root));
const Stats = await import(new URL('utils/marketingCampaignStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

// mounted as server.js mounts them: the old Campaigns routes first, then the hub
const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing', await imp('routes/marketingRoutes.js'));
app.use('/api/marketing/campaign-hub', await imp('routes/marketingCampaignHubRoutes.js'));
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api/marketing`;

const call = async (method, path, who, body) => {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const hub = (m, p, w, b) => call(m, `/campaign-hub${p}`, w, b);

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
const today = istDay(new Date());
const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
await E.MarketingCalendarSetting.create({ weeklyOff: (dow + 3) % 7, standardHours: 8, editWindowDays: 2 });
const month = today.slice(0, 7);
let n = 0;
const login = async (key, role, extra = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, ...extra });
  return { id: String(user._id), emp: String(emp._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('boss', 'marketing_admin');
const outsider = await login('outsider', 'crm');
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const preethi = await login('Preethi', 'marketing_staff');
const ashique = await login('Ashique', 'marketing_staff');
const noSales = await login('nosales', 'crm', { countInSalesTotals: false }); // bookings this user enters add no revenue to sales totals
invalidateSalesRules();
const rEditor = await E.MarketingRole.create({ name: 'Content Producer' });
const member = async (u) => {
  const mm = await E.MarketingTeamMember.create({ userId: u.id, name: u.name, shortName: u.name, activeFrom: new Date(`${month}-01T00:00:00Z`) });
  await E.MarketingMemberRole.create({ memberId: mm._id, roleId: rEditor._id, fromMonth: '2026-01' });
  return { ...u, mid: String(mm._id) };
};
await member(preethi);
await member(ashique);

// the days of the scenario
const d0 = today;
const d1 = addDays(today, -1);
const d2 = addDays(today, -2);
const dp = addDays(today, -9); // inside the period before (the 7 days before the last 7)
const from = addDays(today, -6);
const to = today;
const rq = (extra = '') => `from=${from}&to=${to}${extra}`;
const BRIDAL = 'Bridal Campaign – Nov';

// ── the campaigns ─────────────────────────────────────────────────────────────
console.log('\n— campaigns —');
let bridal, festive, courses, old, trial, legacyId;
await check('a campaign needs a name; brand, objective, budget and dates are checked; the Meta ID is unique; only the team may add', async () => {
  const ok = { title: BRIDAL, brand: 'kerala', platform: 'meta', objective: 'lead_generation', budget: 10000, metaCampaignId: '1203001', status: 'active', startDate: addDays(today, -30) };
  assert.equal((await hub('POST', '/campaigns', preethi, { brand: 'kerala' })).status, 400, 'no name');
  for (const bad of [{ brand: 'mars' }, { objective: 'fame' }, { platform: 'tiktokk' }, { budget: -5 }, { budget: 'lots' }, { startDate: '2026-02-31' }, { startDate: today, endDate: addDays(today, -1) }, { metaCampaignId: 'has space' }, { status: 'done' }]) {
    const r = await hub('POST', '/campaigns', preethi, { ...ok, metaCampaignId: '999', ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.body.message && r.body.field, 'a refusal names its field');
  }
  assert.equal((await hub('POST', '/campaigns', outsider, ok)).status, 403);
  assert.equal((await hub('POST', '/campaigns', null, ok)).status, 401);
  const r = await hub('POST', '/campaigns', preethi, ok);
  assert.equal(r.status, 201, r.text);
  bridal = r.body;
  assert.deepEqual([bridal.brand, bridal.platform, bridal.objective, bridal.budget, bridal.status, bridal.metaCampaignId, bridal.startDate], ['kerala', 'meta', 'lead_generation', 10000, 'active', '1203001', addDays(today, -30)]);
  const dup = await hub('POST', '/campaigns', ashique, { title: 'Another', metaCampaignId: '1203001' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.field, 'metaCampaignId');
  festive = (await hub('POST', '/campaigns', preethi, { title: 'Festive Offers', brand: 'kerala', platform: 'instagram', objective: 'messages', status: 'paused' })).body;
  courses = (await hub('POST', '/campaigns', preethi, { title: 'Makeup Courses', brand: 'main', platform: 'google', objective: 'reach', budget: 5000 })).body;
  const noBrand = (await hub('POST', '/campaigns', preethi, { title: 'Brand not chosen' })).body;
  assert.equal(noBrand.brand, 'kerala', 'a new campaign defaults to Kerala');
  await Campaign.deleteOne({ _id: noBrand.id });
  old = (await hub('POST', '/campaigns', preethi, { title: 'Old Campaign', brand: 'kerala', status: 'completed', budget: 3000 })).body;
  assert.ok(bridal.id && festive.id && courses.id && old.id);
  // a campaign made on the old screen (no brand, platform or budget), with a lifetime ad spend typed on it
  legacyId = String((await Campaign.collection.insertOne({ title: 'Legacy Meta Ads', channel: 'Instagram Ads', status: 'active', adSpend: 99999, productionCost: 0, revenue: 0, leads: 0, conversions: 0, notes: '', createdAt: new Date(), updatedAt: new Date() })).insertedId);
});
await check('the Meta ID is unique in the database too, not only in the controller', async () => {
  await assert.rejects(() => Campaign.create({ title: 'Raw duplicate', metaCampaignId: '1203001' }), /E11000/);
  await Campaign.create({ title: 'Two without an ID', metaCampaignId: '' });
  await Campaign.create({ title: 'Another without an ID' });
  await Campaign.deleteMany({ title: { $in: ['Two without an ID', 'Another without an ID'] } });
});
await check('a campaign can be changed (only what was sent); an older campaign reads as Main with no platform set from its channel', async () => {
  const r = await hub('PUT', `/campaigns/${festive.id}`, ashique, { audienceNote: 'Brides 22–35' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.audienceNote, 'Brides 22–35');
  assert.equal(r.body.objective, 'messages', 'what was not sent stays');
  assert.equal((await hub('PUT', `/campaigns/${festive.id}`, ashique, { brand: 'mars' })).status, 400);
  assert.equal((await hub('PUT', `/campaigns/${festive.id}`, ashique, { metaCampaignId: '1203001' })).status, 409, 'cannot take another campaign\'s Meta ID');
  assert.equal((await hub('PUT', `/campaigns/${bridal.id}`, ashique, { metaCampaignId: '1203001' })).status, 200, 'its own ID is fine');
  assert.equal((await hub('PUT', '/campaigns/64b7f0c2a1b2c3d4e5f60718', ashique, { title: 'x y' })).status, 404);
  assert.equal((await hub('PUT', '/campaigns/not-an-id', ashique, { title: 'x y' })).status, 404);
  assert.equal((await hub('PUT', `/campaigns/${festive.id}`, outsider, { title: 'Hijack' })).status, 403);
  const list = (await hub('GET', `/campaigns?${rq()}&q=legacy`, preethi)).body;
  const l = list.items[0];
  assert.deepEqual([l.title, l.brand, l.platform, l.objective, l.budget, l.status], ['Legacy Meta Ads', 'main', 'instagram', '', 0, 'active']);
});

// ── paid-ads figures: a day typed by hand, then an import ─────────────────────
console.log('\n— a day typed by hand —');
await check('a day\'s figures: a real day that has happened; reach and clicks cannot exceed impressions; an unknown campaign is refused', async () => {
  const ok = { campaignId: bridal.id, day: d1, spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10 };
  for (const bad of [{ day: addDays(today, 1) }, { day: '2026-02-31' }, { spend: -1 }, { reach: 9000 }, { clicks: 9000 }, { campaignId: 'nope' }, { campaignId: '64b7f0c2a1b2c3d4e5f60718' }]) assert.equal((await hub('POST', '/metrics', preethi, { ...ok, ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await hub('POST', '/metrics', outsider, ok)).status, 403);
  const r = await hub('POST', '/metrics', preethi, ok);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.day, r.body.spend, r.body.source], [d1, 1000, 'manual']);
});
await check('typing the same day again REPLACES it (one record per campaign per day); the history says "manual"', async () => {
  const again = await hub('POST', '/metrics', preethi, { campaignId: bridal.id, day: d1, spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10 });
  assert.equal(again.status, 201);
  assert.equal(await Metric.countDocuments({ campaignId: bridal.id, day: d1 }), 1);
  const imports = (await hub('GET', '/imports', preethi)).body;
  assert.equal(imports.items[0].source, 'manual');
  assert.equal(imports.meta.connected, false);
});

console.log('\n— import from Meta Ads Manager —');
const file = [
  { campaign: BRIDAL, day: d2, spend: 600, reach: 3000, impressions: 5000, clicks: 100, results: 6 },
  { campaign: 'bridal campaign – nov', day: d2, spend: 400, reach: 2000, impressions: 3000, clicks: 100, results: 4 }, // a breakdown row of the same day: added
  { campaign: 'Festive Offers', day: d1, spend: 300, reach: 2000, impressions: 4000, clicks: 80, results: 3 },
  { campaign: 'Makeup Courses', day: d0, spend: 200, reach: 1000, impressions: 2500, clicks: 25, results: 0 },
  { campaign: 'Makeup Courses', day: d1, spend: 150, reach: 900, impressions: 2000, clicks: 20, results: 0 },
  { campaign: 'Trial Makeup', day: d1, spend: 100, reach: 500, impressions: 1000, clicks: 10, results: 1 }, // no such campaign yet
  { campaign: BRIDAL, day: dp, spend: 800, reach: 3000, impressions: 4000, clicks: 80, results: 5 }, // the period before
  { campaign: BRIDAL, day: addDays(today, 1), spend: 5 }, // tomorrow: not real
  { campaign: 'Festive Offers', day: d1, spend: 'abc' }, // not a number
  { campaign: 'Festive Offers', day: d1, reach: 900, impressions: 100 }, // reach above impressions
];
const metricCount = () => Metric.countDocuments({});
await check('a dry run reports what matches and what does not, and writes NOTHING', async () => {
  const before = await metricCount();
  const logs = await ImportLog.countDocuments({ source: 'csv' });
  const r = await hub('POST', '/import', preethi, { rows: file, dryRun: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.rows, 7);
  assert.equal(r.body.skipped, 3);
  assert.deepEqual(r.body.skippedRows.map((s) => s.index), [7, 8, 9]);
  assert.deepEqual(r.body.matched.map((m) => m.title).sort(), ['Bridal Campaign – Nov', 'Festive Offers', 'Makeup Courses']);
  assert.deepEqual(r.body.unmatched.map((u) => [u.name, u.reason]), [['Trial Makeup', 'no_match']]);
  assert.equal(await metricCount(), before);
  assert.equal(await ImportLog.countDocuments({ source: 'csv' }), logs, 'a dry run leaves no history');
});
await check('importing without "create these campaigns" writes the matched days and reports the unmatched name; it creates nothing', async () => {
  const campaignsBefore = await Campaign.countDocuments({});
  const r = await hub('POST', '/import', preethi, { rows: file, fileName: 'meta-export.csv' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.created, 0);
  assert.equal(r.body.written, 5, 'bridal d2 (merged), festive, courses ×2, bridal previous');
  assert.deepEqual(r.body.unmatched.map((u) => u.name), ['Trial Makeup']);
  assert.equal(await Campaign.countDocuments({}), campaignsBefore, 'nothing was created behind the importer\'s back');
  assert.equal(r.body.from, dp);
  assert.equal(r.body.to, d0);
  const log = await ImportLog.findOne({ source: 'csv' }).lean();
  assert.deepEqual([log.fileName, log.rows, log.matched, log.unmatched, log.written, log.skipped, log.byName], ['meta-export.csv', 7, 6, 1, 5, 3, 'Preethi']);
  assert.deepEqual(log.unmatchedNames, ['Trial Makeup']);
  const merged = await Metric.findOne({ campaignId: bridal.id, day: d2 }).lean();
  assert.deepEqual([merged.spend, merged.reach, merged.impressions, merged.clicks, merged.results, merged.source], [1000, 5000, 8000, 200, 10, 'csv'], 'the two breakdown rows were added');
});
await check('importing the SAME file again changes nothing in the figures (a day is replaced, never added to)', async () => {
  const count = await metricCount();
  const sums = async () => (await Metric.aggregate([{ $group: { _id: null, spend: { $sum: '$spend' }, impressions: { $sum: '$impressions' } } }]))[0];
  const before = await sums();
  const r = await hub('POST', '/import', preethi, { rows: file });
  assert.equal(r.status, 200);
  assert.equal(await metricCount(), count);
  assert.deepEqual(await sums(), before);
});
await check('"create these campaigns" is an explicit option: it creates the unmatched one in the chosen brand, and the figures land on it', async () => {
  const r = await hub('POST', '/import', preethi, { rows: file, createMissing: true, brand: 'kerala' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.created, 1);
  assert.deepEqual(r.body.unmatched, []);
  trial = await Campaign.findOne({ title: 'Trial Makeup' }).lean();
  assert.deepEqual([trial.brand, trial.platform, trial.status, trial.metaCampaignId], ['kerala', 'meta', 'active', '']);
  const m = await Metric.findOne({ campaignId: trial._id }).lean();
  assert.deepEqual([m.day, m.spend], [d1, 100]);
  // and the next import finds it by name
  assert.equal((await hub('POST', '/import', preethi, { rows: file, dryRun: true })).body.unmatched.length, 0);
});
await check('a campaign is also matched by its Meta ID, whatever Meta calls it now; a title shared by two campaigns is never guessed', async () => {
  const r = await hub('POST', '/import', preethi, { rows: [{ campaign: 'Renamed in Meta', campaignId: '1203001', day: d2, spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10 }] });
  assert.equal(r.body.matched[0].title, BRIDAL);
  assert.equal(r.body.written, 1);
  await Campaign.create({ title: 'Twin', status: 'active' });
  await Campaign.create({ title: 'twin', status: 'active' });
  const amb = await hub('POST', '/import', preethi, { rows: [{ campaign: 'TWIN', day: d1, spend: 5, impressions: 10 }], createMissing: true });
  assert.equal(amb.body.written, 0);
  assert.equal(amb.body.created, 0, 'ambiguous is not "no match": nothing is created');
  assert.equal(amb.body.unmatched[0].reason, 'ambiguous');
  await Campaign.deleteMany({ title: { $in: ['Twin', 'twin'] } });
});
await check('a big file goes in several requests that share one history entry; bad requests are refused', async () => {
  const log = await ImportLog.findOne({ source: 'csv', fileName: 'meta-export.csv' }).lean();
  const second = await hub('POST', '/import', preethi, { rows: [{ campaign: 'Makeup Courses', day: d2, spend: 50, reach: 100, impressions: 500, clicks: 5, results: 0 }], importId: String(log._id) });
  assert.equal(second.body.importId, String(log._id));
  const after = await ImportLog.findById(log._id).lean();
  assert.equal(after.written, log.written + 1);
  assert.equal(after.rows, log.rows + 1);
  assert.equal((await hub('POST', '/import', ashique, { rows: [{ campaign: 'Makeup Courses', day: d2, spend: 1 }], importId: String(log._id) })).body.importId !== String(log._id), true, 'someone else\'s import is not extended');
  await Metric.deleteOne({ campaignId: courses.id, day: d2 });
  assert.equal((await hub('POST', '/import', preethi, { rows: Array.from({ length: 501 }, () => file[0]) })).status, 400, 'more than 500 rows at once');
  for (const body of [{}, { rows: [] }, { rows: 'a,b' }, { rows: [file[0]], brand: 'mars' }]) assert.equal((await hub('POST', '/import', preethi, body)).status, 400, JSON.stringify(body));
  assert.equal((await hub('POST', '/import', outsider, { rows: [file[0]] })).status, 403);
  assert.equal((await hub('POST', '/import', null, { rows: [file[0]] })).status, 401);
  // a file with nothing usable writes nothing and logs nothing
  const logs = await ImportLog.countDocuments({});
  const none = await hub('POST', '/import', preethi, { rows: [{ campaign: 'Nobody Knows', day: d1, spend: 1 }] });
  assert.equal(none.status, 200);
  assert.equal(none.body.written, 0);
  assert.equal(await ImportLog.countDocuments({}), logs);
});

// ── the CRM's side: leads and bookings ────────────────────────────────────────
console.log('\n— CRM leads, bookings and logged work —');
let ph = 9000000;
const mkLead = (campaign, day, extra = {}) => Lead.create({ name: `Lead ${ph}`, phone: String(++ph), source: 'Paid Ads', campaignId: campaign?.id ?? campaign?._id ?? null, leadDate: new Date(`${day}T05:00:00Z`), ...extra });
let bk = 0;
const mkBooking = (lead, extra = {}) => Booking.create({ bookingNumber: `HUB-${++bk}`, customerName: 'Bride', service: 'Bridal', bookingDate: new Date(`${d1}T00:00:00+05:30`), serviceStart: new Date(`${d1}T10:00:00+05:30`), serviceEnd: new Date(`${d1}T14:00:00+05:30`), totalPrice: 40000, status: 'confirmed', address: 'Venue', leadId: lead._id, createdBy: boss.id, ...extra });
let l1, l2, l3;
await check('the scenario: leads tagged to campaigns, a converted lead with a booking, a cancelled booking, one more booking from a user excluded from sales totals', async () => {
  l1 = await mkLead(bridal, d1, { status: 'Converted', priority: 'Hot' });
  const b1 = await mkBooking(l1);
  await Lead.updateOne({ _id: l1._id }, { bookingId: b1._id });
  l2 = await mkLead(bridal, d1, { status: 'Qualified', priority: 'Warm' });
  l3 = await mkLead(bridal, d2, { status: 'New', priority: 'Cold' });
  await mkBooking(l3, { status: 'cancelled', totalPrice: 99999 }); // a dead booking: not a booking
  await mkLead(festive, d2, { status: 'Contacted' });
  await mkLead(courses, d0, { status: 'Lost' });
  await mkLead(bridal, dp, { status: 'New' }); // the period before
  await mkLead(null, d1, { source: 'Paid Ads', region: 'Calicut' }); // from Meta Ads but tagged to no campaign
  await mkLead(null, d1, { source: 'WhatsApp (Organic)' });
  assert.equal(await Lead.countDocuments({}), 8);
});
await check('work members LOG against a campaign (Log Activity → Campaign) is stored on the campaign', async () => {
  const log = (who, body) => call('POST', '/team/activities', who, { kind: 'campaign', timeSpentMinutes: 60, ...body });
  assert.equal((await log(preethi, { campaignId: bridal.id, workedOn: 'Wrote ad copy', timeSpentMinutes: 90 })).status, 201);
  assert.equal((await log(preethi, { campaignId: bridal.id, workedOn: 'Set up targeting', timeSpentMinutes: 30 })).status, 201);
  assert.equal((await log(ashique, { campaignId: bridal.id, workedOn: 'Edited the reel', timeSpentMinutes: 60 })).status, 201);
  assert.equal((await log(ashique, { campaignId: festive.id, workedOn: 'Festive plan', timeSpentMinutes: 45 })).status, 201);
  assert.equal(await Activity.countDocuments({ campaignId: bridal.id }), 3);
});

// ── the screens ───────────────────────────────────────────────────────────────
console.log('\n— Overview —');
// spend in the last 7 days: bridal 1000 (typed) + 1000 (imported) · festive 300 · courses 350 · trial 100 = 2750; the 7 days before: bridal 800
// leads: bridal 3, festive 1, courses 1 = 5 · impressions 25,500 · clicks 535
await check('the KPIs: spend, reach, impressions, leads (CRM), cost per lead, CTR — each with its change on the period before', async () => {
  const r = await hub('GET', `/overview?${rq()}`, preethi);
  assert.equal(r.status, 200, r.text);
  const { now, before, change } = r.body.kpis;
  assert.deepEqual([now.spend, now.reach, now.impressions, now.clicks, now.leads, now.cpl, now.ctr], [2750, 14400, 25500, 535, 5, 550, 2.1]);
  assert.equal(now.results, 24, 'the platform\'s own results (24) are kept apart from the CRM leads (5)');
  assert.deepEqual([before.spend, before.leads, before.cpl], [800, 1, 800]);
  assert.equal(change.spend, 244);
  assert.equal(change.leads, 400);
  assert.equal(change.cpl, -31);
  assert.equal(now.bookings, 1);
  assert.equal(now.revenue, 40000);
  assert.deepEqual([r.body.from, r.body.to, r.body.brand], [from, to, 'all']);
});
await check('the lifetime adSpend typed on the old screen (₹99,999 on a legacy campaign) is NOT added to the paid-ads figures', async () => {
  const r = (await hub('GET', `/overview?${rq()}`, preethi)).body;
  assert.equal(r.kpis.now.spend, 2750);
  const all = (await hub('GET', `/budget?${rq()}`, preethi)).body;
  const l = all.rows.find((x) => x.title === 'Legacy Meta Ads');
  assert.deepEqual([l.hasBudget, l.spentToDate, l.spendInPeriod], [false, 0, 0], 'it is running, so it is listed — with no budget and no spend, not ₹99,999');
});
await check('Meta card: honest — "not connected", with when the figures were last brought in and how', async () => {
  const r = (await hub('GET', `/overview?${rq()}`, preethi)).body;
  assert.equal(r.meta.connected, false);
  assert.equal(r.meta.status, 'not_connected');
  assert.equal(r.meta.lastImport.source, 'csv');
  assert.ok(Date.now() - new Date(r.meta.lastImport.at).getTime() < 120000);
  assert.equal(r.meta.lastImport.byName, 'Ashique', 'the most recent import, and who made it');
  assert.equal(r.meta.lastImport.written, 1);
});
await check('the trend adds up to the KPIs, day by day; leads by campaign type; the status chips and the active campaigns table', async () => {
  const r = (await hub('GET', `/overview?${rq()}`, preethi)).body;
  assert.equal(r.trend.length, 7);
  assert.equal(r.trend.reduce((s, p) => s + p.spend, 0), 2750);
  assert.equal(r.trend.reduce((s, p) => s + p.leads, 0), 5);
  assert.equal(r.trend.find((p) => p.day === d1).spend, 1000 + 300 + 150 + 100);
  assert.deepEqual(r.leadsByType.map((t) => [t.key, t.leads]), [['lead_gen', 3], ['whatsapp', 1], ['others', 1]], 'Lead Generation → lead gen · Messages → WhatsApp · Reach → others');
  assert.deepEqual(r.counts, { total: 6, planned: 0, active: 4, paused: 1, completed: 1 });
  assert.deepEqual(r.campaigns.active.map((c) => c.title), [BRIDAL, 'Makeup Courses', 'Trial Makeup', 'Legacy Meta Ads'], 'biggest spend first');
  assert.deepEqual(r.campaigns.paused.map((c) => c.title), ['Festive Offers']);
  assert.deepEqual(r.campaigns.completed.map((c) => c.title), ['Old Campaign']);
  const b = r.campaigns.active[0];
  assert.deepEqual([b.spend, b.leads, b.cpl, b.platform, b.objective], [2000, 3, 666.67, 'meta', 'lead_generation']);
});
await check('the brand filter follows the campaign\'s brand: Kerala and Main add up to All', async () => {
  const k = (await hub('GET', `/overview?${rq('&brand=kerala')}`, preethi)).body.kpis.now;
  const m = (await hub('GET', `/overview?${rq('&brand=main')}`, preethi)).body.kpis.now;
  assert.deepEqual([k.spend, k.leads, k.cpl], [2400, 4, 600]);
  assert.deepEqual([m.spend, m.leads, m.cpl], [350, 1, 350]);
  assert.equal(k.spend + m.spend, 2750);
  assert.equal(k.leads + m.leads, 5);
  assert.equal((await hub('GET', `/overview?${rq('&brand=mars')}`, preethi)).status, 400);
});
await check('insights: only lines the data supports (cost per lead, the top campaign, untagged Meta Ads leads, nothing invented)', async () => {
  const r = (await hub('GET', `/overview?${rq()}`, preethi)).body;
  const texts = r.insights.map((i) => i.text);
  assert.ok(texts.includes('Cost per lead is ₹550, 31% lower than the period before (₹800).'), texts.join(' | '));
  assert.ok(texts.includes(`${BRIDAL} brought the most leads: 3 of 5 (60%).`));
  assert.ok(texts.includes('1 lead from Meta Ads is not tagged to a campaign, so its cost cannot be counted.'));
  assert.ok(r.insights.length <= 6);
  // a quiet window: nothing is invented
  const quiet = (await hub('GET', `/overview?from=2020-01-01&to=2020-01-07`, preethi)).body;
  assert.equal(quiet.kpis.now.spend, 0);
  assert.equal(quiet.kpis.now.cpl, null);
  assert.equal(quiet.leadsByType.length, 0);
  assert.deepEqual(quiet.insights.map((i) => i.text), ['No ad spend is recorded for this period.']);
});
await check('bad ranges are refused', async () => {
  for (const q of ['from=bad&to=2026-11-01', `from=${to}&to=${from}`, 'from=2024-01-01&to=2026-11-01']) assert.equal((await hub('GET', `/overview?${q}`, preethi)).status, 400, q);
});

console.log('\n— All Campaigns —');
await check('the KPI strip counts by status; the table is searchable and filterable and pages', async () => {
  const r = (await hub('GET', `/campaigns?${rq()}`, preethi)).body;
  assert.deepEqual(r.counts, { total: 6, planned: 0, active: 4, paused: 1, completed: 1 });
  assert.equal(r.total, 6);
  assert.deepEqual(r.items.map((c) => c.title), [BRIDAL, 'Makeup Courses', 'Trial Makeup', 'Legacy Meta Ads', 'Festive Offers', 'Old Campaign'], 'active first, then paused, then completed');
  const b = r.items[0];
  assert.deepEqual([b.spend, b.reach, b.impressions, b.clicks, b.ctr, b.results, b.leads, b.bookings, b.revenue, b.cpl, b.budget, b.workMinutes, b.workEntries], [2000, 10000, 16000, 400, 2.5, 20, 3, 1, 40000, 666.67, 10000, 180, 3]);
  const q = async (s) => (await hub('GET', `/campaigns?${rq(s)}`, preethi)).body;
  assert.deepEqual((await q('&q=festive')).items.map((c) => c.title), ['Festive Offers']);
  assert.deepEqual((await q('&q=1203001')).items.map((c) => c.title), [BRIDAL], 'search reaches the Meta ID');
  assert.deepEqual((await q('&q=reach')).items.map((c) => c.title), ['Makeup Courses'], 'and the objective');
  assert.equal((await q('&q=' + encodeURIComponent('.*'))).total, 0, 'a regex typed in the box is text');
  assert.deepEqual((await q('&status=paused')).items.map((c) => c.title), ['Festive Offers']);
  assert.deepEqual((await q('&platform=google')).items.map((c) => c.title), ['Makeup Courses']);
  assert.deepEqual((await q('&objective=lead_generation')).items.map((c) => c.title), [BRIDAL]);
  const page2 = await q('&limit=4&page=2');
  assert.equal(page2.items.length, 2);
  assert.equal(page2.total, 6);
  assert.equal((await q('&status=paused')).counts.total, 6, 'the strip does not narrow with the filter');
  assert.deepEqual((await q('&brand=main')).items.map((c) => c.title).sort(), ['Legacy Meta Ads', 'Makeup Courses']);
});
await check('a campaign\'s own page: its figures, the daily records, ads, budget and the work members logged against it', async () => {
  const r = await hub('GET', `/campaigns/${bridal.id}?${rq()}`, preethi);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.campaign.title, BRIDAL);
  assert.deepEqual([r.body.kpis.now.spend, r.body.kpis.now.leads, r.body.kpis.now.bookings], [2000, 3, 1]);
  assert.deepEqual(r.body.days.map((d) => [d.day, d.spend, d.source]), [[d1, 1000, 'manual'], [d2, 1000, 'csv']]);
  assert.equal(r.body.budget.budget, 10000);
  assert.equal(r.body.budget.spentToDate, 2800);
  assert.equal(r.body.work.minutes, 180);
  assert.equal(r.body.work.entries, 3);
  assert.deepEqual(r.body.work.members.map((m) => [m.name, m.minutes, m.entries]), [['Preethi', 120, 2], ['Ashique', 60, 1]]);
  assert.equal(r.body.work.recent.length, 3);
  assert.ok(r.body.work.recent.some((x) => x.workedOn === 'Edited the reel' && x.member === 'Ashique'));
  // the brand filter does not hide the campaign being looked at
  assert.equal((await hub('GET', `/campaigns/${bridal.id}?${rq('&brand=main')}`, preethi)).body.kpis.now.spend, 2000);
  assert.equal((await hub('GET', `/campaigns/not-an-id?${rq()}`, preethi)).status, 404);
  assert.equal((await hub('GET', `/campaigns/64b7f0c2a1b2c3d4e5f60718?${rq()}`, preethi)).status, 404);
  const idle = (await hub('GET', `/campaigns/${old.id}?${rq()}`, preethi)).body;
  assert.deepEqual([idle.kpis.now.spend, idle.days.length, idle.work.entries, idle.ads.length], [0, 0, 0, 0]);
});

console.log('\n— Performance —');
await check('reach, impressions, clicks, leads and cost per lead with their change; the trend; objective-wise results', async () => {
  const r = (await hub('GET', `/performance?${rq()}`, preethi)).body;
  const { now, change } = r.kpis;
  assert.deepEqual([now.reach, now.impressions, now.clicks, now.leads, now.cpl], [14400, 25500, 535, 5, 550]);
  assert.equal(change.impressions, 538);
  assert.equal(r.trend.reduce((s, p) => s + p.impressions, 0), 25500);
  assert.equal(r.trend.reduce((s, p) => s + p.clicks, 0), 535);
  assert.deepEqual(r.objectives.map((o) => [o.key, o.campaigns, o.spend, o.leads, o.cpl]), [['lead_generation', 1, 2000, 3, 666.67], ['reach', 1, 350, 1, 350], ['messages', 1, 300, 1, 300], ['not_set', 1, 100, 0, null]], 'only campaigns that ran in the period');
});

console.log('\n— Creatives & Ads —');
let adReel, adStatic, adFestive, adCourses;
await check('an ad needs a campaign and a name; links must be https; clicks cannot exceed impressions; unknown campaigns are refused', async () => {
  const ok = { campaignId: bridal.id, name: 'Bridal Reel 1', adSetName: 'Brides 22–35', format: 'reel', creativeUrl: 'https://drive.test/reel1', thumbUrl: 'https://drive.test/reel1.jpg', impressions: 10000, clicks: 400, spend: 1000, results: 10 };
  for (const bad of [{ name: '' }, { campaignId: 'x' }, { format: 'hologram' }, { creativeUrl: 'javascript:alert(1)' }, { thumbUrl: 'file:///etc/passwd' }, { clicks: 20000 }, { spend: -1 }, { campaignId: '64b7f0c2a1b2c3d4e5f60718' }, { status: 'gone' }]) assert.equal((await hub('POST', '/ads', preethi, { ...ok, ...bad })).status, 400, JSON.stringify(bad));
  assert.equal((await hub('POST', '/ads', outsider, ok)).status, 403);
  const r = await hub('POST', '/ads', preethi, ok);
  assert.equal(r.status, 201, r.text);
  adReel = r.body;
  assert.equal(adReel.campaign, BRIDAL);
  assert.equal(adReel.ctr, 4);
  adStatic = (await hub('POST', '/ads', preethi, { campaignId: bridal.id, name: 'Bridal Static', format: 'image', impressions: 10000, clicks: 100, spend: 1100, results: 8 })).body;
  adFestive = (await hub('POST', '/ads', ashique, { campaignId: festive.id, name: 'Festive Carousel', format: 'carousel', impressions: 5000, clicks: 100, spend: 600, results: 0 })).body;
  adCourses = (await hub('POST', '/ads', ashique, { campaignId: courses.id, name: 'Courses Story', format: 'story', impressions: 500, clicks: 5, spend: 50, results: 1 })).body;
});
await check('the verdicts against the brand\'s average: top / underperforming / needs attention / too early; the chips and KPI strip', async () => {
  const r = (await hub('GET', '/ads', preethi)).body;
  assert.equal(r.total, 4);
  assert.deepEqual(r.counts, { all: 4, top: 1, under: 1, needs_attention: 1 });
  const by = Object.fromEntries(r.items.map((a) => [a.name, a]));
  assert.deepEqual([by['Bridal Reel 1'].verdict, by['Bridal Static'].verdict, by['Festive Carousel'].verdict, by['Courses Story'].verdict], ['top', 'under', 'needs_attention', 'early']);
  assert.deepEqual([r.kpis.total, r.kpis.top, r.kpis.ctr, r.kpis.costPerResult], [4, 1, 2.37, 144.74]);
  assert.equal(by['Bridal Reel 1'].cpm, 100);
  assert.equal(by['Festive Carousel'].costPerResult, null);
  assert.equal((await hub('GET', '/ads?filter=top', preethi)).body.items.length, 1);
  assert.equal((await hub('GET', '/ads?filter=needs_attention', preethi)).body.items[0].name, 'Festive Carousel');
  assert.equal((await hub('GET', `/ads?campaignId=${bridal.id}`, preethi)).body.items.length, 2);
  assert.equal((await hub('GET', '/ads?q=carousel', preethi)).body.items.length, 1);
  assert.equal((await hub('GET', '/ads?q=brides', preethi)).body.items.length, 1, 'search reaches the ad set');
  assert.equal((await hub('GET', '/ads?q=' + encodeURIComponent('(('), preethi)).status, 200, 'a bracket typed in the box is text');
  const filtered = (await hub('GET', `/ads?campaignId=${bridal.id}`, preethi)).body;
  assert.equal(filtered.items.find((a) => a.name === 'Bridal Static').verdict, 'under', 'a filter never changes an ad\'s verdict');
  assert.equal(filtered.counts.all, 4, 'the chips count the brand\'s ads, not just the filtered ones');
  assert.equal((await hub('GET', '/ads?limit=2&page=2', preethi)).body.items.length, 2);
  // brand: Main sees only the Main campaign's ad
  const main = (await hub('GET', '/ads?brand=main', preethi)).body;
  assert.deepEqual(main.items.map((a) => a.name), ['Courses Story']);
  assert.equal((await hub('GET', '/ads?brand=mars', preethi)).status, 400);
});
await check('Overview\'s top creatives; ads can be changed and deleted; an ad moves to another campaign', async () => {
  const top = (await hub('GET', `/overview?${rq()}`, preethi)).body.topAds;
  assert.equal(top[0].name, 'Bridal Reel 1');
  assert.equal(top[0].thumbUrl, 'https://drive.test/reel1.jpg');
  const up = await hub('PUT', `/ads/${adStatic.id}`, ashique, { results: 12 });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.body.results, 12);
  assert.equal((await hub('PUT', `/ads/${adStatic.id}`, ashique, { clicks: 99999 })).status, 400, 'checked against the stored impressions');
  assert.equal((await hub('PUT', `/ads/${adStatic.id}`, ashique, { campaignId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  assert.equal((await hub('PUT', '/ads/64b7f0c2a1b2c3d4e5f60718', ashique, { name: 'x y' })).status, 404);
  assert.equal((await hub('PUT', `/ads/${adStatic.id}`, ashique, { results: 8 })).status, 200);
  const extra = (await hub('POST', '/ads', preethi, { campaignId: bridal.id, name: 'Throwaway ad' })).body;
  assert.equal((await hub('DELETE', `/ads/${extra.id}`, preethi)).status, 200);
  assert.equal((await hub('DELETE', `/ads/${extra.id}`, preethi)).status, 404);
  assert.equal((await hub('DELETE', '/ads/not-an-id', preethi)).status, 404);
});

console.log('\n— Budget & Spend —');
// bridal ₹10,000: spent to date 800 (the period before) + 2000 = 2800; courses ₹5,000: 350; festive and trial have no budget; "Old Campaign" (completed, no spend) is not in the period
await check('total budget, spent to date, remaining and utilisation add up the BUDGETED campaigns; no budget is shown as no budget', async () => {
  const r = (await hub('GET', `/budget?${rq()}`, preethi)).body;
  const s = r.summary;
  assert.deepEqual([s.totalBudget, s.spentToDate, s.remaining, s.utilisationPct, s.remainingPct, s.budgetedCampaigns, s.unbudgetedCampaigns], [15000, 3150, 11850, 21, 79, 2, 3]);
  assert.equal(s.utilisationChangePts, 15.7, '21% now, 5.3% at the end of the period before');
  assert.equal(s.spendInPeriod, 2750);
  assert.equal(s.unbudgetedSpendInPeriod, 400);
  const by = Object.fromEntries(r.rows.map((x) => [x.title, x]));
  assert.deepEqual([by[BRIDAL].spentToDate, by[BRIDAL].remaining, by[BRIDAL].utilisationPct, by[BRIDAL].spendInPeriod], [2800, 7200, 28, 2000]);
  assert.equal(by['Festive Offers'].hasBudget, false);
  assert.equal(by['Festive Offers'].remaining, null);
  assert.equal(by['Festive Offers'].utilisationPct, null);
  assert.ok(!by['Old Campaign'], 'a completed campaign with no spend in the period is not part of it');
  assert.equal(r.hasSpend, true);
});
await check('daily spend bars cover every day and add up; the donut splits spend by campaign and adds to 100', async () => {
  const r = (await hub('GET', `/budget?${rq()}`, preethi)).body;
  assert.equal(r.daily.length, 7);
  assert.equal(r.daily.reduce((t, d) => t + d.spend, 0), 2750);
  assert.equal(r.daily.find((d) => d.day === d1).spend, 1550);
  assert.equal(r.split.total, 2750);
  assert.deepEqual(r.split.slices.map((x) => x.label), [BRIDAL, 'Makeup Courses', 'Festive Offers', 'Trial Makeup']);
  assert.ok(Math.abs(r.split.slices.reduce((t, x) => t + x.pct, 0) - 100) < 0.2);
  const kerala = (await hub('GET', `/budget?${rq('&brand=kerala')}`, preethi)).body;
  assert.equal(kerala.summary.totalBudget, 10000);
  assert.equal(kerala.summary.spendInPeriod, 2400);
});
await check('a campaign over its budget says so, and the Overview warns', async () => {
  await hub('PUT', `/campaigns/${festive.id}`, preethi, { budget: 200 });
  const r = (await hub('GET', `/budget?${rq()}`, preethi)).body;
  const f = r.rows.find((x) => x.title === 'Festive Offers');
  assert.deepEqual([f.hasBudget, f.remaining, f.overBy, f.utilisationPct], [true, 0, 100, 150]);
  assert.equal(r.summary.budgetedCampaigns, 3);
  assert.equal(r.summary.totalBudget, 15200);
  const texts = (await hub('GET', `/overview?${rq()}`, preethi)).body.insights.map((i) => i.text);
  assert.ok(texts.includes('Festive Offers is over its budget by ₹100.'), texts.join(' | '));
  await hub('PUT', `/campaigns/${festive.id}`, preethi, { budget: 0 });
  assert.equal((await hub('GET', `/budget?${rq()}`, preethi)).body.summary.budgetedCampaigns, 2, 'back to no budget');
});

console.log('\n— Leads & Conversions —');
await check('total leads, qualified, bookings, conversion rate and booking value (dead bookings and excluded creators handled)', async () => {
  // a second booking, entered by a user excluded from sales totals: it counts as a booking, its money does not count
  await mkBooking(l2, { createdBy: noSales.id, totalPrice: 25000 });
  invalidateSalesRules();
  const r = (await hub('GET', `/leads?${rq()}`, preethi)).body;
  const { now, before, change } = r.kpis;
  assert.deepEqual([now.leads, now.qualified, now.bookedLeads, now.bookings, now.conversionRate, now.revenue], [5, 2, 2, 2, 40, 40000]);
  assert.deepEqual([before.leads, before.bookings], [1, 0]);
  assert.equal(change.leads, 400);
  assert.equal(change.conversionRate, 40, '0% before, 40% now: +40 points');
  assert.equal(now.roas, 14.55);
  assert.deepEqual(r.funnel.map((s) => [s.key, s.count, s.pct]), [['leads', 5, 100], ['qualified', 2, 40], ['booked', 2, 40]]);
  assert.deepEqual(r.quality, { Hot: 1, Warm: 3, Nurture: 0, Cold: 1 });
  assert.equal(r.trend.reduce((t, p) => t + p.leads, 0), 5);
  assert.equal(r.trend.reduce((t, p) => t + p.bookings, 0), 2);
  assert.equal(r.trend.find((p) => p.day === d1).bookings, 2, 'bookings sit on the day their lead arrived');
  const b = r.rows.find((x) => x.title === BRIDAL);
  assert.deepEqual([b.leads, b.qualified, b.bookedLeads, b.bookings, b.conversionRate, b.revenue, b.spend, b.roas], [3, 2, 2, 2, 66.7, 40000, 2000, 20]);
  assert.ok(r.rows.every((x) => x.leads > 0 || x.spend > 0));
  const kerala = (await hub('GET', `/leads?${rq('&brand=kerala')}`, preethi)).body.kpis.now;
  assert.equal(kerala.leads, 4);
  assert.equal((await hub('GET', `/leads?${rq('&brand=main')}`, preethi)).body.kpis.now.leads, 1);
});
await check('the Weekly Report\'s functions agree with the screens: the same inputs give the same totals', async () => {
  const i = await Hub.loadPaidAdsInputs({ from, to });
  const totals = Stats.paidAdsTotals({ ...i, from, to });
  const screen = (await hub('GET', `/overview?${rq()}`, preethi)).body.kpis;
  assert.deepEqual([totals.now.spend, totals.now.leads, totals.now.bookings, totals.now.revenue, totals.now.cpl], [screen.now.spend, screen.now.leads, screen.now.bookings, screen.now.revenue, screen.now.cpl]);
  assert.deepEqual(Stats.adSpendForRange({ ...i, from, to }), { spend: 2750, previousSpend: 800, change: 244 });
  assert.equal(Stats.adSpendForRange({ ...i, from, to, brand: 'kerala' }).spend, 2400);
  assert.equal(Stats.spendByDay({ ...i, from, to }).reduce((t, d) => t + d.spend, 0), 2750);
  const table = Stats.campaignsTable({ ...i, from, to });
  assert.deepEqual(table.map((r) => [r.title, r.spend, r.leads, r.bookings, r.revenue]), [[BRIDAL, 2000, 3, 2, 40000], ['Makeup Courses', 350, 1, 0, 0], ['Trial Makeup', 100, 0, 0, 0], ['Festive Offers', 300, 1, 0, 0]], 'only campaigns with spend or leads, active first');
});

console.log('\n— Reports & Insights —');
await check('five report cards, each a table of the same numbers (CSV-ready); scheduled reports are not built', async () => {
  const r = (await hub('GET', `/reports?${rq()}`, preethi)).body;
  assert.deepEqual(r.cards.map((c) => c.type), ['campaign', 'creative', 'lead', 'conversion', 'spend', 'audience', 'overview', 'performance'], 'every tab has a report its Export downloads');
  assert.equal(r.scheduledReports, false);
  assert.equal(r.meta.connected, false);
  assert.ok(r.imports.length >= 2 && r.imports[0].at);
  assert.ok(r.imports.some((i) => i.fileName === 'meta-export.csv' && i.unmatchedNames.includes('Trial Makeup')), 'the history keeps what could not be matched');
  assert.ok(r.insights.length > 0);
  for (const c of r.cards) {
    const t = (await hub('GET', `/reports/${c.type}?${rq()}`, preethi)).body;
    assert.equal(t.rows.length, c.rows, c.type);
    assert.ok(t.rows.every((row) => row.length === t.columns.length), c.type);
    assert.equal(t.title, c.title);
    assert.match(t.filename, new RegExp(`^campaign-${c.type}-report-${from}_${to}\\.csv$`));
  }
  const camp = (await hub('GET', `/reports/campaign?${rq()}`, preethi)).body;
  const bRow = camp.rows.find((x) => x[0] === BRIDAL);
  assert.deepEqual([bRow[5], bRow[6], bRow[12], bRow[13]], [10000, 2000, 3, 666.67]);
  assert.equal(camp.rows.find((x) => x[0] === 'Makeup Courses')[5], 5000);
  assert.equal(camp.rows.find((x) => x[0] === 'Trial Makeup')[5], 'No budget set');
  const conv = (await hub('GET', `/reports/conversion?${rq()}`, preethi)).body;
  assert.deepEqual(conv.rows.find((x) => x[0] === BRIDAL), [BRIDAL, 3, 2, 2, 66.7, 40000, 2000, 1000, 20]);
  const ov = (await hub('GET', `/reports/overview?${rq()}`, preethi)).body;
  assert.deepEqual(ov.rows.find((x) => x[0] === 'Spend (INR)'), ['Spend (INR)', 2750, 800, 244]);
  const perf = (await hub('GET', `/reports/performance?${rq()}`, preethi)).body;
  assert.equal(perf.rows.filter((x) => x[0] === 'Day').reduce((t, x) => t + x[3], 0), 2750, 'the trend rows add up to the spend');
  const spend = (await hub('GET', `/reports/spend?${rq('&brand=kerala')}`, preethi)).body;
  assert.ok(!spend.rows.some((x) => x[0] === 'Makeup Courses'), 'the Kerala spend report has no Main campaign');
  assert.match(spend.filename, /-kerala\.csv$/);
  const cre = (await hub('GET', `/reports/creative?${rq()}`, preethi)).body;
  assert.equal(cre.rows.length, 4);
  assert.equal((await hub('GET', `/reports/nonsense?${rq()}`, preethi)).status, 404);
  assert.equal((await hub('GET', '/reports/campaign?from=bad&to=x', preethi)).status, 400);
});

console.log('\n— changing and deleting —');
await check('a day\'s record can be removed; only a Marketing Manager deletes a campaign; one with leads or logged work is kept; an empty one goes with its figures and ads', async () => {
  const day = await Metric.findOne({ campaignId: bridal.id, day: d1 }).lean();
  assert.equal((await hub('DELETE', `/metrics/${day._id}`, outsider)).status, 403);
  assert.equal((await hub('DELETE', `/metrics/${day._id}`, preethi)).status, 200);
  assert.equal((await hub('DELETE', `/metrics/${day._id}`, preethi)).status, 404);
  assert.equal((await hub('GET', `/overview?${rq()}`, preethi)).body.kpis.now.spend, 2750 - 1000, 'the overview follows at once');
  await hub('POST', '/metrics', preethi, { campaignId: bridal.id, day: d1, spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10 }); // put it back
  assert.equal((await hub('DELETE', `/campaigns/${bridal.id}`, preethi)).status, 403, 'a team member cannot delete');
  const kept = await hub('DELETE', `/campaigns/${bridal.id}`, boss);
  assert.equal(kept.status, 409);
  assert.match(kept.body.message, /4 leads and 3 logged entries attached\. Mark it Completed instead/, 'every lead ever tagged to it, not just the period\'s');
  // "Old Campaign": add a day and an ad, then delete it — nothing else points at it
  await hub('POST', '/metrics', preethi, { campaignId: old.id, day: d2, spend: 10, impressions: 100 });
  await hub('POST', '/ads', preethi, { campaignId: old.id, name: 'Old ad' });
  assert.equal((await hub('DELETE', `/campaigns/${old.id}`, boss)).status, 200);
  assert.equal(await Metric.countDocuments({ campaignId: old.id }), 0, 'its daily figures go with it');
  assert.equal(await Ad.countDocuments({ campaignId: old.id }), 0, 'and its ads');
  assert.equal((await hub('DELETE', `/campaigns/${old.id}`, boss)).status, 404);
  assert.equal((await hub('DELETE', '/campaigns/not-an-id', boss)).status, 404);
});
await check('the old Campaigns screen\'s endpoints still work with hub campaigns, and a change there does not wipe the hub fields', async () => {
  const legacy = await call('GET', '/campaigns', boss);
  assert.equal(legacy.status, 200, legacy.text);
  assert.ok(legacy.body.campaigns.some((c) => c.title === BRIDAL));
  const put = await call('PUT', `/campaigns/${bridal.id}`, boss, { title: BRIDAL, channel: 'Meta', status: 'active', adSpend: 123 });
  assert.equal(put.status, 200, put.text);
  const after = (await hub('GET', `/campaigns/${bridal.id}?${rq()}`, preethi)).body.campaign;
  assert.deepEqual([after.budget, after.brand, after.objective, after.metaCampaignId], [10000, 'kerala', 'lead_generation', '1203001']);
  assert.equal((await hub('GET', `/overview?${rq()}`, preethi)).body.kpis.now.spend, 2750, 'and the lifetime adSpend of the old screen still adds nothing');
  // a campaign made on the old screen (which knows nothing of the hub's fields) is valid and reads sensibly in the hub
  const made = await call('POST', '/campaigns', boss, { title: 'Made on the old screen', channel: 'Google Search', status: 'active', adSpend: 500 });
  assert.equal(made.status, 201, made.text);
  const seen = (await hub('GET', `/campaigns?${rq('&q=old screen')}`, preethi)).body.items[0];
  assert.deepEqual([seen.brand, seen.platform, seen.objective, seen.budget, seen.spend], ['kerala', 'google', '', 0, 0], 'a NEW campaign is Kerala (the ads run only on the Kerala account)');
  const options = await call('GET', '/campaigns/options', boss);
  assert.equal(options.status, 200);
  assert.equal(legacyId.length, 24);
});

console.log('\n— ad-level import (Ads Manager, one row per ad per day) —');
const adFile = [
  { campaign: BRIDAL, campaignId: '1203001', ad: 'Reel #17', adId: '9001', adSet: 'Brides 22–35', adSetId: '8001', day: d1, spend: 700, reach: 4000, impressions: 6000, clicks: 150, results: 7 },
  { campaign: BRIDAL, campaignId: '1203001', ad: 'Static B', adId: '9002', adSet: 'Brides 22–35', adSetId: '8001', day: d1, spend: 300, reach: 1000, impressions: 2000, clicks: 50, results: 3 },
  { campaign: BRIDAL, campaignId: '1203001', ad: 'Reel #17', adId: '9001', adSet: 'Brides 22–35', adSetId: '8001', day: dp, spend: 400, reach: 2000, impressions: 3000, clicks: 60, results: 2 },
  { campaign: BRIDAL, campaignId: '1203001', ad: '', adId: '', day: d1, spend: 1 }, // no ad: skipped
];
await check('an ad-level file: the ads are found or added (never typed twice), their days stored, and the campaign\'s day becomes the sum of its ads', async () => {
  const dry = await hub('POST', '/import', preethi, { level: 'ad', rows: adFile, dryRun: true });
  assert.equal(dry.status, 200, dry.text);
  assert.deepEqual([dry.body.level, dry.body.skipped, dry.body.matched[0].ads, dry.body.matched[0].title], ['ad', 1, 2, BRIDAL]);
  assert.equal(await AdDay.countDocuments({}), 0, 'a dry run writes nothing');
  const r = await hub('POST', '/import', preethi, { level: 'ad', rows: adFile, fileName: 'ads.csv' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.written, r.body.adsCreated], [3, 2], 'three ad-days; Reel #17 and Static B were not in the hub yet');
  const reel = await Ad.findOne({ metaAdId: '9001' }).lean();
  assert.deepEqual([reel.name, reel.adSetName, reel.metaAdSetId, reel.dailyFigures, reel.spend, reel.impressions], ['Reel #17', 'Brides 22–35', '8001', true, 1100, 9000], 'its own figures are the sum of all its days');
  const day = await Metric.findOne({ campaignId: bridal.id, day: d1 }).lean();
  assert.deepEqual([day.spend, day.impressions, day.clicks, day.results, day.source], [1000, 8000, 200, 10, 'csv_ads'], 'the campaign day = its ads');
  const log = await ImportLog.findOne({ fileName: 'ads.csv' }).lean();
  assert.deepEqual([log.level, log.written, log.adsCreated], ['ad', 3, 2]);
  // the same file again changes nothing; the ad is found by its Meta ad ID even when renamed in Meta
  await hub('POST', '/import', preethi, { level: 'ad', rows: adFile.map((x) => (x.adId === '9001' ? { ...x, ad: 'Reel #17 (v2)' } : x)) });
  assert.equal(await Ad.countDocuments({ campaignId: bridal.id, metaAdId: { $in: ['9001', '9002'] } }), 2);
  assert.equal((await Ad.findOne({ metaAdId: '9001' }).lean()).name, 'Reel #17', 'the name the team knows it by is kept');
  assert.equal(await AdDay.countDocuments({}), 3);
  assert.equal((await Metric.findOne({ campaignId: bridal.id, day: d1 }).lean()).spend, 1000);
  // sent in two requests, the campaign's day still adds up
  await hub('POST', '/import', preethi, { level: 'ad', rows: [adFile[0]] });
  await hub('POST', '/import', preethi, { level: 'ad', rows: [adFile[1]] });
  assert.equal((await Metric.findOne({ campaignId: bridal.id, day: d1 }).lean()).spend, 1000);
  assert.equal((await hub('GET', `/overview?${rq()}`, preethi)).body.kpis.now.spend, 2750, 'the overview is unchanged: the same money, now with its ads');
});
await check('Creatives & Ads follow the dates: an imported ad shows the days in the range; a typed ad its lifetime figures; CRM leads and cost per lead per ad', async () => {
  await mkLead(bridal, d1, { creative: 'reel 17' });
  await mkLead(null, d1, { creative: 'REEL #17' }); // no campaign, one ad has the name
  await mkLead(bridal, dp, { creative: 'Reel #17' }); // the period before
  const r = (await hub('GET', `/ads?${rq()}&limit=50`, preethi)).body;
  const by = Object.fromEntries(r.items.map((a) => [a.name, a]));
  assert.deepEqual([by['Reel #17'].figures, by['Reel #17'].spend, by['Reel #17'].impressions, by['Reel #17'].leads, by['Reel #17'].cpl], ['range', 700, 6000, 2, 350], 'only this week\'s day; "reel 17" and "REEL #17" both name it');
  assert.deepEqual([by['Static B'].leads, by['Static B'].cpl], [0, null]);
  assert.deepEqual([by['Bridal Reel 1'].figures, by['Bridal Reel 1'].cpl], ['lifetime', null], 'a typed ad keeps its lifetime figures, and no cost per lead');
  const before = (await hub('GET', `/ads?from=${addDays(dp, -3)}&to=${addDays(dp, 3)}&limit=50`, preethi)).body;
  const reelBefore = before.items.find((a) => a.name === 'Reel #17');
  assert.deepEqual([reelBefore.spend, reelBefore.leads, reelBefore.cpl], [400, 1, 400]);
  assert.ok(!before.items.some((a) => a.name === 'Static B'), 'an imported ad that did not run in the range is not listed');
  assert.equal((await hub('GET', '/ads?from=bad', preethi)).status, 400);
  const cre = (await hub('GET', `/reports/creative?${rq()}`, preethi)).body;
  assert.deepEqual(cre.rows.find((x) => x[0] === 'Reel #17').slice(13, 15), [2, 350]);
});

console.log('\n— audience & placement breakdowns —');
await check('a breakdown file (age, gender, placement) is stored by segment; the Audiences view and the Overview show the top segments; a day with figures is not overwritten', async () => {
  const rows = [
    { campaign: BRIDAL, campaignId: '1203001', day: d1, age: '25-34', gender: 'female', spend: 600, impressions: 5000, clicks: 120, results: 6 },
    { campaign: BRIDAL, campaignId: '1203001', day: d1, age: '18-24', gender: 'female', spend: 300, impressions: 2000, clicks: 60, results: 3 },
    { campaign: BRIDAL, campaignId: '1203001', day: d1, age: '25-34', gender: 'male', spend: 100, impressions: 1000, clicks: 20, results: 1 },
    { campaign: 'Festive Offers', day: d2, age: '25-34', gender: 'female', spend: 80, impressions: 900, clicks: 9, results: 1 }, // a day with no figure yet
  ];
  const r = await hub('POST', '/import', preethi, { level: 'breakdown', rows, fileName: 'by-age-gender.csv' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.written, 4);
  assert.equal(await Breakdown.countDocuments({}), 4);
  assert.equal((await Metric.findOne({ campaignId: bridal.id, day: d1 }).lean()).spend, 1000, 'the ad-level figure stands');
  const filled = await Metric.findOne({ campaignId: festive.id, day: d2 }).lean();
  assert.deepEqual([filled.spend, filled.source], [80, 'csv_breakdown'], 'an empty day takes the segments\' total');
  await hub('POST', '/import', preethi, { level: 'breakdown', rows: [{ campaign: BRIDAL, campaignId: '1203001', day: d1, platform: 'Instagram', position: 'Reels', spend: 700, impressions: 6000, clicks: 140, results: 8 }, { campaign: BRIDAL, campaignId: '1203001', day: d1, platform: 'Facebook', position: 'Feed', spend: 300, impressions: 2000, clicks: 40, results: 2 }] });
  const a = (await hub('GET', `/audiences?${rq()}`, preethi)).body;
  assert.equal(a.hasData, true);
  assert.deepEqual(a.age.rows.map((x) => [x.segment, x.spend, x.results]), [['25-34', 780, 8], ['18-24', 300, 3]]);
  assert.deepEqual(a.gender.rows.map((x) => [x.segment, x.spend]), [['female', 980], ['male', 100]]);
  assert.deepEqual(a.placement.rows.map((x) => [x.segment, x.spend, x.costPerResult]), [['Instagram · Reels', 700, 87.5], ['Facebook · Feed', 300, 150]]);
  assert.deepEqual((await hub('GET', `/audiences?${rq('&brand=main')}`, preethi)).body.age.rows, [], 'Main has no breakdown');
  const ov = (await hub('GET', `/overview?${rq()}`, preethi)).body.audiences;
  assert.equal(ov.age.rows[0].segment, '25-34');
  const rep = (await hub('GET', `/reports/audience?${rq()}`, preethi)).body;
  assert.ok(rep.rows.some((x) => x[0] === 'Placement' && x[1] === 'Instagram · Reels'));
  // re-importing the same breakdown changes nothing
  await hub('POST', '/import', preethi, { level: 'breakdown', rows });
  assert.equal(await Breakdown.countDocuments({}), 6);
  for (const bad of [{ level: 'breakdown', rows: [{ campaign: BRIDAL, day: d1, spend: 1 }] }]) assert.equal((await hub('POST', '/import', preethi, bad)).body.written, 0);
  // put Festive's d2 back as it was for what follows
  await Metric.deleteOne({ campaignId: festive.id, day: d2 });
});

console.log('\n— access —');
await check('someone outside Marketing is refused everywhere; no login is refused', async () => {
  const reads = ['/setup', `/overview?${rq()}`, `/campaigns?${rq()}`, `/campaigns/${bridal.id}?${rq()}`, `/performance?${rq()}`, '/ads', `/budget?${rq()}`, `/audiences?${rq()}`, `/leads?${rq()}`, `/reports?${rq()}`, `/reports/campaign?${rq()}`, '/imports'];
  for (const p of reads) {
    assert.equal((await hub('GET', p, outsider)).status, 403, p);
    assert.equal((await hub('GET', p, null)).status, 401, p);
    assert.equal((await hub('GET', p, preethi)).status, 200, p);
  }
  const s = (await hub('GET', '/setup', preethi)).body;
  assert.ok(s.campaigns.some((c) => c.title === BRIDAL && c.brand === 'kerala'));
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
