// End-to-end check of the Marketing Weekly Report — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to
// run against anything else and drops its own database first):
//
//   mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-weekly.e2e.mjs
//
// The document's method: create the records ONCE (CRM leads + bookings, campaigns + their daily spend, members + their logs, shoots,
// posts), then the one-page report reflects all of them — and agrees with the Lead Report and the Campaigns module, which it must not
// contradict. Plus who may see what, brand filter, bad input, empty weeks.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first — no e-mail, SMS, WhatsApp, maps or AI call reaches anybody.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_weekly_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'marketing_weekly_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Lead = await imp('models/Lead.js');
const Booking = await imp('models/Booking.js');
const Campaign = await imp('models/Campaign.js');
const CampaignDailyMetric = await imp('models/CampaignDailyMetric.js');
const CampaignAd = await imp('models/CampaignAd.js');
const ContentItem = await imp('models/ContentItem.js');
const MarketingActivity = await imp('models/MarketingActivity.js');
const MarketingShoot = await imp('models/MarketingShoot.js');
const GstSetting = await imp('models/GstSetting.js');
const Role = await imp('models/Role.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
const R = await import(new URL('utils/marketingLeadReportStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/weekly', await imp('routes/marketingWeeklyRoutes.js'));
app.use('/api/marketing/lead-report', await imp('routes/marketingLeadReportRoutes.js'));
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js')); // the log that publishes a post (T11)
app.use('/api/marketing/campaign-hub', await imp('routes/marketingCampaignHubRoutes.js')); // its campaign figures are the Weekly Report's
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/marketing`;

const call = async (path, who) => {
  const res = await fetch(`${base}${path}`, { headers: who ? { authorization: `Bearer ${who.token}` } : {} });
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

// ── the week ──────────────────────────────────────────────────────────────────
const today = istDay(new Date());
const d = (n) => addDays(today, n);
const at = (day, hh = 10, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
const FROM = d(-6);
const WEEK = `from=${FROM}&to=${today}`;
const PREV_DAY = d(-9); // a day of the week before (FROM-7 … FROM-1 = d(-13) … d(-7))
let n = 0;
const login = async (key, role, extra = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, ...extra });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const boss = await login('boss', 'marketing_admin');
const preethi = await login('Preethi', 'marketing_staff');
const ashique = await login('Ashique', 'marketing_staff');
const outsider = await login('outsider', 'crm');

// members + their logs: the report's "Individual Insights"
const gSocial = await E.MarketingGroup.create({ name: 'Socials', sortOrder: 1 });
const mReels = await E.MarketingMetric.create({ groupId: gSocial._id, code: 1, name: 'Reels posted' });
const mStories = await E.MarketingMetric.create({ groupId: gSocial._id, code: 2, name: 'Stories posted' });
const rManager = await E.MarketingRole.create({ name: 'Brand Manager' });
const monthStart = new Date(`${d(-40)}T00:00:00Z`);
const memberPreethi = await E.MarketingTeamMember.create({ userId: preethi.id, name: 'Preethi', shortName: 'Preethi', activeFrom: monthStart, sortOrder: 1 });
const memberAshique = await E.MarketingTeamMember.create({ userId: ashique.id, name: 'Ashique', shortName: 'Ashique', activeFrom: monthStart, sortOrder: 2 });
const memberQuiet = await E.MarketingTeamMember.create({ name: 'Quiet Member', shortName: 'Quiet', activeFrom: monthStart, sortOrder: 3 });
await E.MarketingMemberRole.create({ memberId: memberPreethi._id, roleId: rManager._id, fromMonth: '2026-01' });
const log = (member, day, minutes, values, extra = {}) => MarketingActivity.create({ memberId: member._id, entryDate: day, workedOn: 'Work', timeSpentMinutes: minutes, status: 'completed', brand: 'main', values: values.map(([m, v]) => ({ metricId: m._id, value: v })), ...extra });
await log(memberPreethi, d(-1), 120, [[mReels, 10], [mStories, 3]]);
await log(memberPreethi, d(-3), 60, [[mReels, 17]]);
await log(memberPreethi, d(-9), 60, [[mReels, 20]]); //  the week before: 20 reels → this week 27 = +35%
await log(memberAshique, d(-2), 180, [], { brand: 'kerala' }); // hours only
await log(memberAshique, d(-8), 90, [], { brand: 'kerala' });

// the CRM's records
await GstSetting.create({ enabled: false, rate: 0, pricesIncludeTax: true });
const C1 = await Campaign.create({ title: 'Bridal Campaign', channel: 'Instagram', platform: 'instagram', objective: 'lead_generation', brand: 'main' });
const C2 = await Campaign.create({ title: 'Kerala Festive', channel: 'Meta', platform: 'meta', objective: 'lead_generation', brand: 'kerala' });
const sale = (extra) => Booking.create({ customerName: 'Client', service: 'Bridal', bookingDate: at(d(-2)), serviceStart: at(d(10)), serviceEnd: at(d(10), 18), status: 'confirmed', ...extra });
const B1 = await sale({ totalPrice: 20000, advanceAmount: 8000, collectedAmount: 2000 });
const B2 = await sale({ totalPrice: 9000, status: 'cancelled' });
const B3 = await sale({ totalPrice: 10000, discountAmount: 2000, advanceAmount: 3000, advanceStatus: 'pending' });
const B0 = await sale({ totalPrice: 6000 }); // last week's booking
let phone = 9876500000;
const mk = async (name, day, source, status, priority, extra = {}) => {
  phone += 1;
  return Lead.create({ name, phone: String(phone), source, status, priority, leadDate: at(day), ...extra });
};
await mk('Rehana', d(-1), 'IG Leads — Main Page', 'Converted', 'Hot', { campaignId: C1._id, bookingId: B1._id });
await mk('Arjun', d(-2), 'IG Leads — Main Page', 'Qualified', 'Warm', { campaignId: C1._id });
await mk('Divya', d(-2), 'WhatsApp (Organic)', 'New', 'Cold');
await mk('Faisal', d(-3), 'IG Leads — Kerala Page', 'Converted', 'Hot', { campaignId: C2._id, bookingId: B3._id });
await mk('Gita', d(-4), 'IG Leads — Kerala Page', 'Lost', 'Cold');
await mk('Cancelled one', d(-5), 'WhatsApp (Organic)', 'Converted', 'Warm', { bookingId: B2._id });
// the period before (d(-13) … d(-7)): 2 leads, 1 booking
await mk('Old A', d(-8), 'WhatsApp (Organic)', 'New', 'Warm');
await mk('Old B', d(-9), 'WhatsApp (Organic)', 'Converted', 'Hot', { bookingId: B0._id });

// ad spend (Campaigns module): 2 days this week, 1 the week before
await CampaignDailyMetric.create([
  { campaignId: C1._id, day: d(-1), spend: 3000, reach: 20000, impressions: 40000, clicks: 800, results: 40 },
  { campaignId: C1._id, day: d(-2), spend: 2000, reach: 10000, impressions: 20000, clicks: 400, results: 20 },
  { campaignId: C2._id, day: d(-3), spend: 1000, reach: 5000, impressions: 9000, clicks: 100, results: 5 },
  { campaignId: C1._id, day: d(-9), spend: 1500, reach: 8000, impressions: 15000, clicks: 300, results: 15 },
]);
await CampaignAd.create({ campaignId: C1._id, name: 'Bridal reel ad', format: 'video', impressions: 60000, clicks: 1200, spend: 5000, results: 60 });

// shoots: planned and done
await MarketingShoot.create([
  { title: 'Bridal A', shootDate: d(-1), category: 'Bridal', status: 'completed', brand: 'main' },
  { title: 'Bridal B', shootDate: d(-2), category: 'Bridal', status: 'planned', brand: 'main' },
  { title: 'Reel day', shootDate: d(-3), category: 'Reels', status: 'completed', brand: 'main' },
  { title: 'Kerala shoot', shootDate: d(-4), category: 'Reels', status: 'completed', brand: 'kerala' },
  { title: 'Called off', shootDate: d(-4), category: 'Reels', status: 'cancelled', brand: 'main' },
  { title: 'Last week', shootDate: d(-10), category: 'Bridal', status: 'completed', brand: 'main' },
]);
await ContentItem.create({ title: 'Trial reel', platform: 'instagram', contentType: 'reel', status: 'published', brand: 'main', scheduledDate: at(d(-1)), publishedDate: at(d(-1), 12) });

// ── the report ────────────────────────────────────────────────────────────────
let W = null;
await check('the report answers for the week with every part present', async () => {
  const r = await call(`/weekly?${WEEK}`, boss);
  assert.equal(r.status, 200, r.text);
  W = r.body;
  for (const k of ['range', 'previous', 'headline', 'sparks', 'trend', 'quality', 'sources', 'members', 'campaigns', 'ads', 'recent', 'production', 'revenueCollection', 'insights', 'status']) assert.ok(k in W, `missing ${k}`);
  assert.equal(W.range.from, FROM);
  assert.equal(W.range.to, today);
  assert.equal(W.previous.to, d(-7));
  assert.equal(W.trend.length, 7);
});

await check('headline: leads, bookings, revenue, conversion match the Lead Report exactly (one source)', async () => {
  const lr = await call(`/lead-report/overview?${WEEK}`, boss);
  assert.equal(lr.status, 200, lr.text);
  assert.equal(W.headline.leads.now, 6);
  assert.equal(W.headline.leads.before, 2);
  assert.equal(W.headline.leads.change, 200);
  assert.equal(W.headline.bookings.now, 2); // 2 booked leads — a Converted lead whose booking was cancelled is no booking (the Lead Report's rule, utils/marketingOutcomes.js)
  assert.equal(W.headline.revenue.now, 28000); // 20000 + 8000 (discounted); the cancelled booking adds nothing
  assert.equal(W.headline.revenue.before, 6000);
  assert.equal(W.headline.conversionRate.now, 33.3);
  assert.equal(W.headline.conversionRate.before, 50);
  // the Lead Report's own Overview says the same, figure for figure
  const k = lr.body.kpis;
  assert.equal(k.total, W.headline.leads.now);
  assert.equal(k.bookings, W.headline.bookings.now);
  assert.equal(k.bookingValue, W.headline.revenue.now);
  assert.equal(k.conversionRate, W.headline.conversionRate.now);
  assert.equal(lr.body.kpis.change.total, W.headline.leads.change);
});

await check('ad spend: this week against the week before, from the Campaigns module\'s daily records', async () => {
  assert.deepEqual(W.headline.adSpend, { now: 6000, before: 1500, change: 300 });
  assert.equal(W.status.adSpendRecorded, true);
  assert.equal(W.status.adSpendNote, null);
});

await check('day trend: 7 days, each against its twin in the period before; days add up to the cards', async () => {
  assert.equal(W.trend.reduce((s, t) => s + t.now.leads, 0), W.headline.leads.now);
  assert.equal(W.trend.reduce((s, t) => s + t.now.bookings, 0), W.headline.bookings.now);
  assert.equal(W.trend.reduce((s, t) => s + t.now.revenue, 0), W.headline.revenue.now);
  assert.equal(W.trend.reduce((s, t) => s + (t.before?.leads ?? 0), 0), W.headline.leads.before);
  assert.equal(W.trend[0].day, FROM);
  assert.equal(W.trend[0].before.day, d(-13));
});

await check('sparklines: seven values per card; spend line equals the daily spend', async () => {
  for (const k of ['leads', 'bookings', 'revenue', 'adSpend', 'conversionRate']) assert.equal(W.sparks[k].length, 7, k);
  assert.equal(W.sparks.adSpend.reduce((a, v) => a + v, 0), 6000);
});

await check('lead quality and sources: the same distributions the Lead Report shows', async () => {
  assert.equal(W.quality.total, 6);
  const q = Object.fromEntries(W.quality.rows.map((r) => [r.key, r.count]));
  assert.deepEqual([q.Hot, q.Warm, q.Cold], [2, 2, 2]);
  assert.ok(Object.entries(q).every(([k, v]) => ['Hot', 'Warm', 'Cold'].includes(k) || v === 0), 'any other bucket the Lead Report adds (Nurture) is there, empty here');
  assert.equal(W.sources.total, 6);
  assert.equal(W.sources.rows.reduce((s, r) => s + r.count, 0), 6);
});

await check('individual insights: each member\'s key result from their logs, with the change; silent members counted', async () => {
  const rows = W.members.rows;
  const p = rows.find((r) => r.name === 'Preethi');
  assert.equal(p.role, 'Brand Manager');
  assert.equal(p.metric, 'Reels posted');
  assert.equal(p.value, 27);
  assert.equal(p.change, 35);
  const a = rows.find((r) => r.name === 'Ashique');
  assert.equal(a.unit, 'hours');
  assert.equal(a.value, 3);
  assert.equal(W.members.silent, 1); // "Quiet Member"
  assert.equal(W.members.viewer, true);
});

await check('campaign & paid performance: the Campaigns module\'s table and ads', async () => {
  const bridal = W.campaigns.rows.find((r) => r.title === 'Bridal Campaign');
  assert.equal(bridal.spend, 5000);
  assert.equal(bridal.leads, 2);
  assert.equal(bridal.bookings, 1);
  assert.equal(bridal.revenue, 20000);
  assert.ok(W.campaigns.total >= 2);
  assert.equal(W.ads[0].name, 'Bridal reel ad');
});

await check('production: shoots done against planned, cancelled ones left out, top categories', async () => {
  assert.equal(W.production.planned, 4);
  assert.equal(W.production.done, 3);
  const reels = W.production.categories.find((c) => c.category === 'Reels');
  assert.deepEqual(reels, { category: 'Reels', planned: 2, done: 2 });
});

await check('revenue & collection: advance that counts, later collections, balance, progress', async () => {
  const r = W.revenueCollection;
  assert.equal(r.bookings, 2);
  assert.equal(r.orderValue, 28000);
  assert.equal(r.advance, 8000); // the pending advance on the second booking does not count yet
  assert.equal(r.collectedLater, 2000);
  assert.equal(r.balanceDue, 18000); // 20000−8000−2000 = 10000, plus 8000 on the other
  assert.equal(r.averageOrder, 14000);
  assert.equal(r.advanceProgress, 28.6);
});

await check('recent activity: newest first, from the leads, bookings, campaigns, shoots and posts of the week', async () => {
  assert.ok(W.recent.length > 0 && W.recent.length <= 8);
  const times = W.recent.map((e) => new Date(e.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  const kinds = new Set(W.recent.map((e) => e.kind));
  assert.ok(kinds.has('lead'));
  assert.ok([...kinds].every((k) => ['lead', 'booking', 'campaign', 'shoot', 'post'].includes(k)));
  assert.ok(!W.recent.some((e) => /\d{10}/.test(e.text)), 'no phone number in an event');
});

await check('insights: plain-language sentences backed by the numbers', async () => {
  assert.ok(W.insights.includes('Leads increased 200% compared with the period before.'));
  assert.ok(W.insights.some((s) => s.includes('Ad spend per booking')));
});

// ── brand, empty weeks, access, bad input ────────────────────────────────────
await check('brand Kerala: only Kerala leads, spend, shoots and members\' Kerala logs', async () => {
  const r = await call(`/weekly?${WEEK}&brand=kerala`, boss);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.headline.leads.now, 2);
  assert.equal(r.body.headline.adSpend.now, 1000);
  assert.equal(r.body.production.planned, 1);
  assert.equal(r.body.members.rows.find((x) => x.name === 'Preethi'), undefined); // her logs are Main
  assert.equal(r.body.members.rows.find((x) => x.name === 'Ashique').value, 3);
});

await check('brand Main: the Main leads, no Kerala spend', async () => {
  const r = await call(`/weekly?${WEEK}&brand=main`, boss);
  assert.equal(r.body.headline.adSpend.now, 5000);
  assert.equal(r.body.headline.leads.now, 4);
});

await check('a week with nothing in it: zeros, no ad-spend card, an honest note, no crash', async () => {
  const r = await call(`/weekly?from=${d(-200)}&to=${d(-194)}`, boss);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.headline.leads.now, 0);
  assert.equal(r.body.headline.adSpend, null);
  assert.equal(r.body.sparks.adSpend, null);
  assert.equal(r.body.status.adSpendRecorded, false);
  assert.match(r.body.status.adSpendNote, /No ad spend/);
  assert.equal(r.body.production.planned, 0);
  assert.equal(r.body.revenueCollection.averageOrder, null);
  assert.deepEqual(r.body.insights, []);
});

await check('defaults to this week, all brands, when no filter is sent', async () => {
  const r = await call('/weekly', boss);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.range.brand, 'all');
  assert.ok(r.body.range.from <= today && today <= r.body.range.to);
});

await check('a member sees only their own key result; the rest of the page is the same', async () => {
  const r = await call(`/weekly?${WEEK}`, preethi);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.members.viewer, false);
  assert.deepEqual(r.body.members.rows.map((x) => x.name), ['Preethi']);
  assert.equal(r.body.headline.leads.now, 6);
});

await check('access: no login 401, outsider 403', async () => {
  assert.equal((await call(`/weekly?${WEEK}`, null)).status, 401);
  assert.equal((await call(`/weekly?${WEEK}`, outsider)).status, 403);
});

await check('bad input: end before start, bad date, bad brand, repeated filter, over a year', async () => {
  for (const q of [`from=${d(-1)}&to=${d(-5)}`, 'from=nope&to=2026-11-01', `${WEEK}&brand=mars`, `from=${FROM}&from=${FROM}&to=${today}`, `from=${d(-400)}&to=${today}`]) {
    const r = await call(`/weekly?${q}`, boss);
    assert.equal(r.status, 400, q);
    assert.ok(r.body.message, q);
  }
});

await check('no phone number or free-text note anywhere in the payload', async () => {
  const text = JSON.stringify(W);
  assert.ok(!/98765\d{5}/.test(text));
  assert.ok(!('phone' in (W.recent[0] ?? {})));
});

await check('the report is read-only: it created and changed nothing', async () => {
  assert.equal(await Lead.countDocuments(), 8);
  assert.equal(await Booking.countDocuments(), 4);
  assert.equal(await MarketingActivity.countDocuments(), 5);
});

await check('one log publishes a post: the Socials post is published and the Weekly Report\'s newest activity shows it (T11)', async () => {
  const post = await ContentItem.create({ title: 'Haldi reel', platform: 'instagram', contentType: 'reel', status: 'scheduled', brand: 'main', scheduledDate: new Date() });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/marketing/team/activities`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${preethi.token}` }, body: JSON.stringify({ workedOn: 'Posted the haldi reel', kind: 'post', contentId: String(post._id), status: 'completed' }) });
  assert.equal(res.status, 201, await res.text());
  assert.equal((await ContentItem.findById(post._id).lean()).status, 'published');
  const w = await call(`/weekly?${WEEK}`, boss);
  assert.ok(w.body.recent.some((e) => e.kind === 'post' && /Haldi reel/.test(e.text)), JSON.stringify(w.body.recent));
});

await check('lead quality: whatever buckets the Lead Report defines are sent, each with a key, a label and a count', async () => {
  const q = (await call(`/weekly?${WEEK}`, boss)).body.quality;
  assert.ok(q.rows.length >= 3);
  assert.ok(q.rows.every((r) => typeof r.key === 'string' && typeof r.label === 'string' && Number.isInteger(r.count)));
  assert.equal(q.rows.reduce((s, r) => s + r.count, 0), q.total, 'the buckets add up to the leads');
});

await check('with GST switched on, the Weekly campaign revenue is the Campaigns hub\'s ex-GST value (one figure across Marketing)', async () => {
  const { setGstConfig } = await import(new URL('services/posting.js', root));
  const on = { enabled: true, rate: 18, pricesIncludeTax: true };
  await GstSetting.updateOne({}, { $set: on });
  setGstConfig(on); // the GST setting is cached for a minute: make this run see the change now
  try {
    const w = (await call(`/weekly?${WEEK}`, boss)).body;
    const hub = await call(`/campaign-hub/campaigns?${WEEK}&limit=50`, boss);
    assert.equal(hub.status, 200, hub.text);
    const weekly = w.campaigns.rows.find((r) => r.title === 'Bridal Campaign');
    const hubRow = hub.body.items.find((r) => r.title === 'Bridal Campaign');
    assert.equal(weekly.revenue, hubRow.revenue, 'the Weekly Report and the Campaigns hub agree');
    assert.equal(weekly.revenue, Math.round((20000 / 1.18) * 100) / 100, 'GST is backed out (₹20,000 GST-inclusive → ₹16,949.15)');
  } finally {
    const off = { enabled: false, rate: 0, pricesIncludeTax: true };
    await GstSetting.updateOne({}, { $set: off });
    setGstConfig(off);
  }
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`FAILED:\n - ${failures.join('\n - ')}`);
  process.exit(1);
}
