// End-to-end check of the Socials module — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run
// against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-socials.e2e.mjs
//
// The method is the document's: post once, then every screen that should reflect it does — the Overview's KPI strip, pipeline,
// platform split, engagement, recent posts, calendar strip, activity tracker (what members LOGGED against targets), team activities
// and organic Instagram leads, and the Performance and Reports numbers that read the same posts.
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
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_socials_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Lead = await imp('models/Lead.js');
const Content = await imp('models/ContentItem.js');
const Asset = await imp('models/MarketingAsset.js');
const Activity = await imp('models/MarketingActivity.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
// the drop above also dropped the indexes: build them again before anything relies on them
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/socials', await imp('routes/marketingSocialsRoutes.js'));
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js'));
app.use('/api/content', await imp('routes/contentRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api`;

const call = async (method, path, token, body) => {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
const sx = (method, path, who, body) => call(method, `/marketing/socials${path}`, who.token, body);

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 10).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
let n = 0;
const login = async (key, role) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('boss', 'marketing_admin');
const preethi = await login('Preethi', 'marketing_admin'); // marketing access; a plain member is checked below with their own login
const outsider = await login('outsider', 'crm');

// a plain team member: marketing permission through a role that is not a manager role
const memberRole = 'marketing_staff';
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: memberRole }, { $setOnInsert: { key: memberRole, label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const staff = await login('staff', memberRole);

const today = istDay(new Date());
const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
const monday = addDays(today, -((dow + 6) % 7));
const nextMonday = addDays(monday, 7);
const lastMonday = addDays(monday, -7);
const at = (day, hh = 10) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+05:30`).toISOString();
const q = `from=${monday}&to=${addDays(monday, 6)}`;

// ── the Socials activity set up by the team ───────────────────────────────────
const gSocials = await E.MarketingGroup.create({ name: 'Socials', sortOrder: 1 });
const gOther = await E.MarketingGroup.create({ name: 'Campaigns', sortOrder: 2 });
const mReels = await E.MarketingMetric.create({ groupId: gSocials._id, code: 1, name: 'Reels posted', maxPerDay: 20 });
const mStories = await E.MarketingMetric.create({ groupId: gSocials._id, code: 2, name: 'Stories posted' });
const mAds = await E.MarketingMetric.create({ groupId: gOther._id, code: 3, name: 'Ad sets updated' });
const mm = await E.MarketingTeamMember.create({ userId: preethi.id, name: 'Preethi', shortName: 'Preethi', activeFrom: new Date(`${monday}T00:00:00Z`) });
const post = (body) => Content.create({ platform: 'instagram', contentType: 'reel', brand: 'main', metrics: {}, ...body, scheduledDate: body.scheduledDate ?? at(addDays(monday, 1)) });

console.log('\n— content: brand, the new stage and the numbers typed on a post —');
await check('a post is created with its brand, stage, links and metrics; junk metrics are dropped', async () => {
  const r = await call('POST', '/content', boss.token, { title: 'Bridal reel', contentType: 'reel', brand: 'kerala', status: 'in-review', scheduledDate: at(addDays(monday, 2)), permalink: 'https://instagram.com/p/x', metrics: { reach: 100, likes: 'abc', nope: 5, saves: -3, views: '40' } });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.brand, 'kerala');
  assert.equal(r.body.status, 'in-review');
  assert.equal(r.body.metrics.reach, 100);
  assert.equal(r.body.metrics.views, 40);
  assert.equal(r.body.metrics.likes, 0, 'not a number → left alone');
  assert.equal(r.body.metrics.saves, 0, 'negative → left alone');
  assert.equal(r.body.metrics.nope, undefined);
  await Content.deleteMany({});
});
await check('an unknown brand falls back to Main; the list can be filtered by brand', async () => {
  await post({ title: 'A', brand: 'main' });
  await post({ title: 'B', brand: 'kerala' });
  const r = await call('POST', '/content', boss.token, { title: 'C', brand: 'mars', scheduledDate: at(monday) });
  assert.equal(r.body.brand, 'main');
  assert.equal((await call('GET', `/content?${q}&brand=kerala`, boss.token)).body.length, 1);
  assert.equal((await call('GET', `/content?${q}`, boss.token)).body.length, 3);
  await Content.deleteMany({});
});

console.log('\n— post once, every Socials screen follows —');
// this week: 3 posted (reel main, trial reel kerala, story main), 1 scheduled, 1 in review, 1 producing, 1 idea, 1 cancelled; last week: 1 reel posted
await post({ title: 'Reel A', status: 'published', publishedDate: at(addDays(monday, 1)), metrics: { reach: 1000, impressions: 1800, views: 1500, likes: 80, comments: 10, reposts: 5, shares: 3, saves: 2 }, thumbUrl: 'https://img.test/a.jpg' });
await post({ title: 'Trial reel', contentType: 'trial_reel', brand: 'kerala', status: 'published', publishedDate: at(addDays(monday, 2)), metrics: { reach: 500, views: 700, likes: 20 } });
await post({ title: 'Story', contentType: 'story', status: 'published', publishedDate: at(addDays(monday, 3)), metrics: { reach: 300, likes: 5 } });
await post({ title: 'Carousel', contentType: 'carousel', status: 'scheduled', scheduledDate: at(addDays(monday, 4)) });
await post({ title: 'In review reel', status: 'in-review', scheduledDate: at(addDays(monday, 4)) });
await post({ title: 'Producing', contentType: 'post', status: 'in-progress', scheduledDate: at(addDays(monday, 5)) });
await post({ title: 'Idea', status: 'idea', scheduledDate: at(addDays(monday, 6)) });
await post({ title: 'Cancelled', status: 'cancelled', scheduledDate: at(addDays(monday, 2)) });
await post({ title: 'Last week reel', status: 'published', publishedDate: at(addDays(lastMonday, 2)), scheduledDate: at(addDays(lastMonday, 2)), metrics: { reach: 400, likes: 10 } });
// organic Instagram leads this week
const lead = (extra) => Lead.create({ name: 'L', phone: String(9000000000 + Math.floor(Math.random() * 99999999)), ...extra });
await lead({ source: 'IG Leads — Kerala Page', leadDate: at(addDays(monday, 1)) });
await lead({ source: 'IG Leads — Main Page', leadDate: at(addDays(monday, 2)) });
await lead({ source: 'IG Leads — Main Page', region: 'Calicut', leadDate: at(addDays(monday, 3)) }); // a Main page lead stays Main whatever its region
// a lead tagged to a Kerala campaign counts under the campaign's brand, whatever page it came from (as on the Lead Report and the hub)
const keralaCampaign = await (await imp('models/Campaign.js')).create({ title: 'Kerala bridal push', brand: 'kerala' });
await lead({ source: 'IG Leads — Main Page', campaignId: keralaCampaign._id, leadDate: at(addDays(monday, 4)) });
await lead({ source: 'Paid Ads Leads', leadDate: at(addDays(monday, 3)) });
await lead({ source: 'WhatsApp (Organic)', leadDate: at(addDays(monday, 3)) });
// what members logged under Socials
const todayLog = (extra) => Activity.create({ memberId: mm._id, entryDate: today >= monday && today <= addDays(monday, 6) ? today : monday, kind: 'post', brand: 'main', workedOn: 'Posted reels', status: 'completed', groupId: gSocials._id, ...extra });
await todayLog({ values: [{ metricId: mReels._id, value: 2 }, { metricId: mStories._id, value: 3 }] });
await todayLog({ brand: 'kerala', workedOn: 'Kerala reel', values: [{ metricId: mReels._id, value: 1 }] });
await todayLog({ workedOn: 'Ad work', kind: 'campaign', groupId: gOther._id, values: [{ metricId: mAds._id, value: 9 }] });

let ov;
await check('Overview: KPI strip counts posted items by format, with the change on last week', async () => {
  const r = await sx('GET', `/overview?${q}`, boss);
  assert.equal(r.status, 200, r.text);
  ov = r.body;
  assert.equal(ov.kpis.total, 3);
  assert.equal(ov.kpis.reels, 1);
  assert.equal(ov.kpis.trialReels, 1);
  assert.equal(ov.kpis.stories, 1);
  assert.equal(ov.kpis.feed, 0);
  assert.equal(ov.kpis.change.reels, 0, '1 reel this week, 1 last week');
  assert.equal(ov.kpis.change.stories, null, 'no stories last week');
});
await check('Overview: the pipeline counts every non-cancelled item once, by stage', () => {
  assert.equal(ov.pipeline.total, 7);
  const by = Object.fromEntries(ov.pipeline.stages.map((s) => [s.key, s.count]));
  assert.deepEqual(by, { planned: 1, producing: 1, in_review: 1, scheduled: 1, published: 3 });
});
await check('Overview: platform split names Instagram by brand; engagement sums what was typed on posted items', () => {
  const l = ov.platforms.map((p) => `${p.label}:${p.count}`).sort();
  assert.deepEqual(l, ['Instagram (Kerala):1', 'Instagram (Main):2']);
  assert.equal(ov.engagement.reach, 1800);
  assert.equal(ov.engagement.likes, 105);
  assert.equal(ov.engagement.comments, 10);
  assert.equal(ov.engagement.engagements, 125);
});
await check('Overview: recent posts (newest first, with thumbnail and views) and the calendar strip hold the same items', () => {
  assert.equal(ov.recentPosts.length, 3);
  assert.equal(ov.recentPosts[0].title, 'Story', 'the story went out last');
  assert.equal(ov.recentPosts.find((p) => p.title === 'Reel A').views, 1500);
  assert.equal(ov.calendar.length, 7);
  assert.equal(ov.calendar.flatMap((d) => d.items).length, 7, 'the strip shows everything not cancelled');
  assert.equal(ov.calendar[0].day, monday);
});
await check('Overview: organic Instagram leads — not paid, not WhatsApp — split Main / Kerala (a campaign\'s lead under its campaign\'s brand)', () => {
  assert.equal(ov.leads.total, 4);
  assert.equal(ov.leads.kerala, 2);
  assert.equal(ov.leads.main, 2);
});
await check('Overview: the activity tracker lists the Socials metrics with what members LOGGED (both brands), no target yet', () => {
  assert.equal(ov.tracker.hasMetrics, true);
  const by = Object.fromEntries(ov.tracker.rows.map((r) => [r.name, r]));
  assert.equal(by['Reels posted'].completed, 3);
  assert.equal(by['Stories posted'].completed, 3);
  assert.equal(by['Ad sets updated'], undefined, 'metrics of other groups are not Socials');
  assert.equal(by['Reels posted'].target, null);
  assert.equal(by['Reels posted'].progress, null);
});
await check('Overview: team activities list the day\'s logged Socials work by member, with a status', () => {
  const p = ov.teamActivities.find((t) => t.name === 'Preethi');
  assert.ok(p, JSON.stringify(ov.teamActivities));
  assert.deepEqual(p.activities.sort(), ['Kerala reel', 'Posted reels']);
  assert.equal(p.status, 'completed');
  assert.ok(!ov.teamActivities.some((t) => t.activities.includes('Ad work')), 'campaign work is not Socials');
});
await check('Overview: one brand shows only that brand — KPIs, pipeline, tracker and leads', async () => {
  const r = (await sx('GET', `/overview?${q}&brand=kerala`, boss)).body;
  assert.equal(r.kpis.total, 1);
  assert.equal(r.kpis.trialReels, 1);
  assert.equal(r.pipeline.total, 1);
  assert.equal(r.leads.total, 2);
  assert.equal(r.tracker.rows.find((x) => x.name === 'Reels posted').completed, 1);
});

console.log('\n— targets: stored per week, never overwritten, inherited —');
await check('a member cannot set targets; a manager can; the tracker then shows progress against it', async () => {
  const body = { brand: 'all', period: monday, values: [{ metricId: String(mReels._id), target: 26 }, { metricId: String(mStories._id), target: 14 }] };
  assert.equal((await sx('PUT', '/targets', staff, body)).status, 403);
  const r = await sx('PUT', '/targets', boss, body);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.week, monday);
  const o = (await sx('GET', `/overview?${q}`, boss)).body;
  const reels = o.tracker.rows.find((x) => x.name === 'Reels posted');
  assert.equal(reels.target, 26);
  assert.equal(reels.progress, 12, '3 of 26');
});
await check('a day in the middle of the week sets that week; a target for an Ad metric is refused', async () => {
  const r = await sx('PUT', '/targets', boss, { brand: 'all', period: addDays(monday, 3), values: [{ metricId: String(mReels._id), target: 30 }] });
  assert.equal(r.body.week, monday, 'the week is the Monday');
  assert.equal((await sx('GET', `/targets?from=${monday}&to=${addDays(monday, 6)}`, boss)).body.metrics.find((m) => m.name === 'Reels posted').target, 30, 're-saving the same week replaces that week');
  assert.equal((await sx('PUT', '/targets', boss, { period: monday, values: [{ metricId: String(mAds._id), target: 5 }] })).status, 400);
});
await check('next week inherits this week\'s target; setting next week leaves this week alone', async () => {
  const next = (await sx('GET', `/targets?from=${nextMonday}&to=${addDays(nextMonday, 6)}`, boss)).body;
  assert.equal(next.week, nextMonday);
  assert.equal(next.metrics.find((m) => m.name === 'Reels posted').target, 30, 'inherited');
  await sx('PUT', '/targets', boss, { period: nextMonday, values: [{ metricId: String(mReels._id), target: 10 }] });
  assert.equal((await sx('GET', `/targets?from=${nextMonday}&to=${addDays(nextMonday, 6)}`, boss)).body.metrics.find((m) => m.name === 'Reels posted').target, 10);
  assert.equal((await sx('GET', `/targets?from=${monday}&to=${addDays(monday, 6)}`, boss)).body.metrics.find((m) => m.name === 'Reels posted').target, 30, 'this week unchanged');
  const longer = (await sx('GET', `/overview?from=${monday}&to=${addDays(nextMonday, 6)}`, boss)).body;
  assert.equal(longer.tracker.rows.find((x) => x.name === 'Reels posted').target, 40, 'a two-week range adds its two weeks');
});
await check('bad targets are refused: negative, not a number, no week, nothing sent', async () => {
  const m = String(mReels._id);
  for (const body of [{ period: monday, values: [{ metricId: m, target: -1 }] }, { period: monday, values: [{ metricId: m, target: 'x' }] }, { values: [{ metricId: m, target: 1 }] }, { period: monday, values: [] }, { period: '2026-02-31', values: [{ metricId: m, target: 1 }] }, { brand: 'mars', period: monday, values: [{ metricId: m, target: 1 }] }]) {
    assert.equal((await sx('PUT', '/targets', boss, body)).status, 400, JSON.stringify(body));
  }
});

console.log('\n— Calendar —');
await check('the calendar returns the window\'s items (not cancelled), filterable by brand and platform, with the stage counts', async () => {
  const all = (await sx('GET', `/calendar?${q}`, boss)).body;
  assert.equal(all.items.length, 7);
  assert.equal(all.pipeline.total, 7);
  assert.equal((await sx('GET', `/calendar?${q}&brand=kerala`, boss)).body.items.length, 1);
  assert.equal((await sx('GET', `/calendar?${q}&platform=youtube`, boss)).body.items.length, 0);
  assert.equal((await sx('GET', `/calendar?from=bad&to=${monday}`, boss)).status, 400);
  assert.equal((await sx('GET', `/calendar?from=${addDays(monday, 3)}&to=${monday}`, boss)).status, 400);
});

console.log('\n— Content & Assets —');
let asset;
await check('an asset needs a title and an https link; a script link or a missing link is refused', async () => {
  assert.equal((await sx('POST', '/assets', staff, { title: 'x', url: 'https://d.test/a' })).status, 400, 'title too short');
  assert.equal((await sx('POST', '/assets', staff, { title: 'Hero still' })).status, 400, 'no link');
  assert.equal((await sx('POST', '/assets', staff, { title: 'Hero still', url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await sx('POST', '/assets', staff, { title: 'Hero still', url: 'https://d.test/a', kind: 'wat' })).status, 400);
  const r = await sx('POST', '/assets', staff, { title: 'Hero still', url: 'https://d.test/a', kind: 'reel', tags: ['Bridal', ' bridal ', 'Kerala'], brand: 'kerala', portfolio: 'Kerala', page: 'Bridal Makeup' });
  assert.equal(r.status, 201, r.text);
  asset = r.body;
  assert.equal(asset.stage, 'raw');
  assert.equal(asset.media, 'video', 'a reel is video unless said otherwise');
  assert.deepEqual(asset.tags, ['bridal', 'kerala'], 'tags are cleaned and de-duplicated');
});
await check('a member moves an asset through the production stages but cannot approve it; a manager can', async () => {
  assert.equal((await sx('PUT', `/assets/${asset.id}`, staff, { stage: 'in_edit' })).body.stage, 'in_edit');
  assert.equal((await sx('PUT', `/assets/${asset.id}`, staff, { stage: 'approved' })).status, 403);
  const r = await sx('PUT', `/assets/${asset.id}`, boss, { stage: 'approved', isFinal: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.stage, 'approved');
  assert.equal((await sx('PUT', `/assets/${asset.id}`, staff, { stage: 'approved' })).status, 200, 'setting the stage it already has is not an approval');
});
await check('the gallery list: filters, search, counts and facets agree', async () => {
  await sx('POST', '/assets', staff, { title: 'Studio clip', url: 'https://d.test/b', kind: 'bts', portfolio: 'Main (Company)', page: 'Behind the Scenes' });
  await sx('POST', '/assets', staff, { title: 'Look still', url: 'https://d.test/c', kind: 'still', portfolio: 'Main (Company)', page: 'Bridal Makeup' });
  const all = (await sx('GET', '/assets', staff)).body;
  assert.equal(all.counts.total, 3);
  assert.equal(all.counts.videos, 2);
  assert.equal(all.counts.photos, 1);
  assert.equal(all.counts.approved, 1);
  assert.equal(all.counts.approvedPct, 33);
  assert.equal(all.counts.finals, 1);
  assert.deepEqual(all.facets.portfolios, { Kerala: 1, 'Main (Company)': 2 });
  assert.equal(all.facets.pages['Bridal Makeup'], 2);
  assert.equal((await sx('GET', '/assets?stage=approved', staff)).body.items.length, 1);
  assert.equal((await sx('GET', '/assets?media=video', staff)).body.items.length, 2);
  assert.equal((await sx('GET', '/assets?q=studio', staff)).body.items.length, 1);
  assert.equal((await sx('GET', '/assets?q=bridal', staff)).body.items.length, 2, 'search reaches tags and pages');
  assert.equal((await sx('GET', '/assets?brand=kerala', staff)).body.counts.total, 1, 'counts follow the brand');
  assert.equal((await sx('GET', '/assets?q=' + encodeURIComponent('.*'), staff)).body.items.length, 0, 'a regex in the search box is text, not a pattern');
});
await check('an asset a post uses cannot be deleted until it is taken off the post', async () => {
  const item = await post({ title: 'Uses asset', assetId: asset.id, status: 'planned' });
  const r = await sx('DELETE', `/assets/${asset.id}`, boss);
  assert.equal(r.status, 409);
  assert.match(r.body.message, /used by 1 post/);
  await Content.updateOne({ _id: item._id }, { assetId: null });
  assert.equal((await sx('DELETE', `/assets/${asset.id}`, boss)).status, 200);
  assert.equal((await sx('PUT', `/assets/${asset.id}`, boss, { title: 'gone' })).status, 404);
});

console.log('\n— Publishing & Accounts —');
let acc;
await check('only a manager adds or changes an account; the same account twice is refused; followers keep a daily history', async () => {
  assert.equal((await sx('POST', '/accounts', staff, { platform: 'instagram', brand: 'main', handle: '@teamn' })).status, 403);
  const r = await sx('POST', '/accounts', boss, { platform: 'Instagram', brand: 'main', handle: '@teamn', followers: 1200 });
  assert.equal(r.status, 201, r.text);
  acc = r.body;
  assert.equal(acc.platform, 'instagram');
  assert.equal(acc.status, 'manual', 'no platform API is connected, so it says so');
  assert.equal((await sx('POST', '/accounts', boss, { platform: 'instagram', brand: 'main', handle: '@teamn' })).status, 409);
  assert.equal((await sx('POST', '/accounts', boss, { brand: 'main' })).status, 400);
  assert.equal((await sx('PUT', `/accounts/${acc.id}`, boss, { followers: 1300 })).body.followers, 1300);
  const stored = await mongoose.model('SocialAccount').findById(acc.id).lean();
  assert.equal(stored.history.length, 1, 'today\'s figure replaces today\'s');
  assert.equal(stored.history[0].followers, 1300);
  assert.equal((await sx('PUT', `/accounts/${acc.id}`, boss, { followers: -5 })).status, 400);
  assert.equal((await sx('PUT', `/accounts/${acc.id}`, staff, { followers: 5 })).status, 403);
});
await check('the publishing queue is what is scheduled or in review, soonest first', async () => {
  const r = (await sx('GET', '/publishing', staff)).body;
  assert.equal(r.accounts.length, 1);
  const titles = r.queue.map((x) => x.title);
  assert.ok(titles.includes('Carousel') && titles.includes('In review reel'));
  assert.ok(!titles.includes('Reel A'), 'published is not in the queue');
  assert.ok(r.queue.every((x, i, a) => i === 0 || new Date(a[i - 1].scheduledDate) <= new Date(x.scheduledDate)));
  assert.ok(r.recent.some((x) => x.title === 'Story'));
});
await check('an account can be removed by a manager', async () => {
  assert.equal((await sx('DELETE', `/accounts/${acc.id}`, staff)).status, 403);
  assert.equal((await sx('DELETE', `/accounts/${acc.id}`, boss)).status, 200);
  assert.equal((await sx('GET', '/accounts', boss)).body.length, 0);
});

console.log('\n— Performance and Reports read the same posts —');
await check('Performance: totals, platform rows, top content and the daily trend agree with the Overview', async () => {
  const p = (await sx('GET', `/performance?${q}`, boss)).body;
  assert.equal(p.totals.reach, ov.engagement.reach);
  assert.equal(p.totals.engagements, ov.engagement.engagements);
  assert.equal(p.totals.engagementRate, 6.9, '125 / 1800');
  assert.equal(p.totals.videoViews, 2200);
  assert.equal(p.platforms.length, 1);
  assert.equal(p.platforms[0].posts, 3);
  assert.equal(p.top[0].title, 'Reel A');
  assert.equal(p.trend.reduce((s, d) => s + d.reach, 0), 1800);
  assert.equal(p.contentStatus.total, 8, 'the seven of this week, and the planned post made in the asset test');
  assert.equal((await sx('GET', `/performance?${q}&platform=youtube`, boss)).body.totals.reach, 0);
});
await check('Reports: the summary, six-month trend and insights; growth is against the period before', async () => {
  const r = (await sx('GET', `/reports?${q}`, boss)).body;
  assert.equal(r.summary.reach.value, 1800);
  assert.equal(r.summary.reach.change, 350, '1800 vs 400 last week');
  assert.equal(r.growthTrend.length, 6);
  assert.equal(r.growthTrend.reduce((s, m) => s + m.posts, 0), 4, 'this week\'s 3 and last week\'s 1 (the month they fall in)');
  assert.ok(Array.isArray(r.insights));
  assert.equal(r.kpis.total, 3);
});

console.log('\n— the audit fixes —');
const Shoot = mongoose.model('MarketingShoot');
await check('S1: every platform the app offers is saved as itself through the API; an unknown one is refused, never turned into Instagram', async () => {
  for (const platform of ['pinterest', 'snapchat', 'linkedin', 'youtube']) {
    const r = await call('POST', '/content', boss.token, { title: `On ${platform}`, platform, scheduledDate: at(nextMonday) });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.body.platform, platform);
  }
  const p = (await call('POST', '/content', boss.token, { title: 'Moves platform', platform: 'pinterest', scheduledDate: at(nextMonday) })).body;
  assert.equal((await call('PUT', `/content/${p._id}`, boss.token, { platform: 'snapchat' })).body.platform, 'snapchat', 'an update changes it (it used to be ignored)');
  assert.equal((await call('PUT', `/content/${p._id}`, boss.token, { platform: 'myspace' })).status, 400);
  assert.equal((await Content.findById(p._id).lean()).platform, 'snapchat', 'a refused change leaves it as it was');
  assert.equal((await call('POST', '/content', boss.token, { title: 'Unknown', platform: 'myspace', scheduledDate: at(nextMonday) })).status, 400);
  assert.equal((await call('POST', '/content', boss.token, { title: 'No platform', scheduledDate: at(nextMonday) })).body.platform, 'instagram', 'none sent → the Instagram default');
  assert.equal((await sx('GET', `/calendar?from=${nextMonday}&to=${addDays(nextMonday, 6)}&platform=pinterest`, boss)).body.items.length, 1, 'the calendar filters by it');
  await Content.deleteMany({ title: { $in: ['On pinterest', 'On snapchat', 'On linkedin', 'On youtube', 'Moves platform', 'No platform'] } });
});

await check('S2: a post can be made only from an approved or final asset; it then belongs to the asset\'s shoot (the server decides)', async () => {
  const shoot = await Shoot.create({ title: 'Asset shoot', shootDate: today, brand: 'main' });
  const other = await Shoot.create({ title: 'Other shoot', shootDate: today, brand: 'main' });
  const raw = (await sx('POST', '/assets', staff, { title: 'Raw clip', url: 'https://d.test/raw', kind: 'reel', shootId: String(shoot._id) })).body;
  const fin = (await sx('POST', '/assets', staff, { title: 'Final reel', url: 'https://d.test/final', kind: 'reel', shootId: String(shoot._id) })).body;
  assert.equal(fin.approvedAt, null, 'not approved yet');
  const approved = (await sx('PUT', `/assets/${fin.id}`, boss, { stage: 'approved' })).body;
  assert.ok(approved.approvedAt, 'the moment it was approved is kept');
  const refused = await call('POST', '/content', boss.token, { title: 'From raw', assetId: raw.id, scheduledDate: at(nextMonday) });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /approved or final/);
  const r = await call('POST', '/content', boss.token, { title: 'From final', assetId: fin.id, shootId: String(other._id), scheduledDate: at(nextMonday) });
  assert.equal(r.status, 201, r.text);
  assert.equal(String(r.body.shootId), String(shoot._id), 'the asset\'s shoot, not the one the app sent');
  const usable = (await sx('GET', '/assets?usable=1', staff)).body.items.map((a) => a.title);
  assert.ok(usable.includes('Final reel') && !usable.includes('Raw clip'), 'the picker lists only what can be posted');
  assert.equal((await sx('GET', `/assets/${fin.id}`, staff)).body.title, 'Final reel', 'one asset can be read (the post form shows the linked one)');
  assert.equal((await call('PUT', `/content/${r.body._id}`, boss.token, { assetId: raw.id })).status, 400, 'switching to a raw asset is refused');
  await sx('PUT', `/assets/${fin.id}`, boss, { stage: 'rejected' });
  assert.equal((await Asset.findById(fin.id).lean()).approvedAt, null, 'rejected: no longer delivered');
  assert.equal((await call('PUT', `/content/${r.body._id}`, boss.token, { assetId: fin.id, title: 'Renamed post' })).status, 200, 'a post\'s own asset never blocks an edit');
  await sx('PUT', `/assets/${fin.id}`, staff, { shootId: String(other._id) });
  assert.equal(String((await Content.findById(r.body._id).lean()).shootId), String(other._id), 'the asset moved shoot: the post follows it');
  const off = (await call('PUT', `/content/${r.body._id}`, boss.token, { assetId: null, shootId: String(shoot._id) })).body;
  assert.deepEqual([off.assetId, String(off.shootId)], [null, String(shoot._id)], 'with no asset a post names the shoot it is for');
  assert.equal((await call('PUT', `/content/${r.body._id}`, boss.token, { shootId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400, 'a shoot that does not exist');
  const shaped = (await sx('GET', `/calendar?from=${nextMonday}&to=${addDays(nextMonday, 6)}`, boss)).body.items.find((x) => x.title === 'Renamed post');
  assert.deepEqual([shaped.assetId, shaped.shootId], [null, String(shoot._id)], 'the calendar\'s posts carry their links');
  await Content.deleteMany({ title: 'Renamed post' });
  await Asset.deleteMany({ _id: { $in: [raw.id, fin.id] } });
  await Shoot.deleteMany({ _id: { $in: [shoot._id, other._id] } });
});

await check('S3: the tracker target is pro-rated by days — one day is a seventh of the week\'s target, not the whole week', async () => {
  const day = (await sx('GET', `/overview?from=${monday}&to=${monday}`, boss)).body;
  assert.equal(day.tracker.rows.find((x) => x.name === 'Reels posted').target, 4.3, '30 a week → 4.3 for a day');
  const week = (await sx('GET', `/overview?${q}`, boss)).body;
  assert.equal(week.tracker.rows.find((x) => x.name === 'Reels posted').target, 30);
});

await check('S4: the asset library filters by owner (named, else who added it) and by the days assets were added, server-side', async () => {
  const named = (await sx('POST', '/assets', boss, { title: 'Named owner', url: 'https://d.test/n', kind: 'still', ownerName: 'Preethi' })).body;
  assert.equal(named.owner, 'Preethi');
  const legacy = await Asset.create({ title: 'Legacy still', url: 'https://d.test/legacy', kind: 'still', createdBy: boss.id, ownerName: '' });
  const lib = (await sx('GET', '/assets', staff)).body;
  assert.equal(lib.facets.owners.staff, 2, 'what staff added names them as owner');
  assert.equal(lib.facets.owners.Preethi, 1);
  assert.equal(lib.facets.owners.boss, 1, 'an older asset with no owner → who added it');
  assert.equal((await sx('GET', '/assets?owner=staff', staff)).body.items.length, 2);
  assert.equal((await sx('GET', '/assets?owner=preethi', staff)).body.items.length, 1, 'any letter case');
  assert.deepEqual((await sx('GET', '/assets?owner=boss', staff)).body.items.map((a) => a.title), ['Legacy still']);
  assert.ok(lib.facets.tags, 'the tags facet is there');
  // the dates: one asset was added 40 days ago
  await Asset.collection.updateOne({ _id: legacy._id }, { $set: { createdAt: new Date(at(addDays(today, -40))) } });
  const old = (await sx('GET', `/assets?from=${addDays(today, -45)}&to=${addDays(today, -35)}`, staff)).body;
  assert.deepEqual(old.items.map((a) => a.title), ['Legacy still']);
  assert.equal(old.counts.total, 1, 'the counts follow the dates too');
  assert.equal((await sx('GET', `/assets?from=${today}&to=${today}`, staff)).body.items.some((a) => a.title === 'Legacy still'), false);
  assert.equal((await sx('GET', `/assets?from=${today}`, staff)).status, 400, 'both dates or neither');
  await Asset.deleteMany({ _id: { $in: [named.id, legacy._id] } });
});

await check('S4: Publishing follows the date range — the queue is what is scheduled in it, the published list what went out in it', async () => {
  const wk = (await sx('GET', `/publishing?${q}`, boss)).body;
  assert.ok(wk.queue.some((x) => x.title === 'Carousel'));
  assert.ok(wk.recent.some((x) => x.title === 'Story'));
  assert.ok(!wk.recent.some((x) => x.title === 'Last week reel'), 'last week\'s post is outside this week');
  const next = (await sx('GET', `/publishing?from=${nextMonday}&to=${addDays(nextMonday, 6)}`, boss)).body;
  assert.equal(next.queue.length, 0);
  assert.equal(next.recent.length, 0);
  assert.equal((await sx('GET', '/publishing?from=bad&to=bad', boss)).status, 400);
});

await check('S5: Reports find the period before however long the period is; each platform has its growth; next actions follow the figures', async () => {
  // a post that went out 400 days ago is in the "before" of a 300-day period (it used to be missed: only 200 days were read)
  await post({ title: 'Long ago', status: 'published', publishedDate: at(addDays(today, -400)), scheduledDate: at(addDays(today, -400)), metrics: { reach: 1000 } });
  const r = (await sx('GET', `/reports?from=${addDays(today, -299)}&to=${today}`, boss)).body;
  assert.ok(r.summary.reach.value > 0);
  assert.equal(r.summary.reach.change, Math.round(((r.summary.reach.value - 1000) / 1000) * 100));
  const ig = r.platforms.find((p) => p.platform === 'instagram');
  assert.equal(ig.change.reach, r.summary.reach.change, 'all posts are Instagram here, so its growth is the total');
  // something past its day and not out → the first next action
  const late = await post({ title: 'Late one', status: 'scheduled', scheduledDate: at(addDays(today, -2)) });
  const w = (await sx('GET', `/reports?${q}`, boss)).body;
  assert.ok(Array.isArray(w.nextActions));
  assert.ok(w.nextActions.some((a) => /^Publish or reschedule the \d+ posts? past/.test(a)), JSON.stringify(w.nextActions));
  const perf = (await sx('GET', `/performance?${q}`, boss)).body;
  assert.ok('change' in perf.platforms[0], 'Performance rows carry the growth too');
  await Content.deleteMany({ _id: { $in: [late._id] } });
  await Content.deleteMany({ title: 'Long ago' });
});

await check('S6: Team Activities — a member sees only their own logged work; a manager sees everyone\'s', async () => {
  const sm = await E.MarketingTeamMember.create({ userId: staff.id, name: 'staff', shortName: 'staff', activeFrom: new Date(`${monday}T00:00:00Z`) });
  const logDay = today >= monday && today <= addDays(monday, 6) ? today : monday;
  await Activity.create({ memberId: sm._id, entryDate: logDay, kind: 'post', brand: 'main', workedOn: 'Staff story', status: 'in_progress', groupId: gSocials._id });
  const mine = (await sx('GET', `/overview?${q}`, staff)).body;
  assert.equal(mine.teamScope, 'own');
  assert.deepEqual(mine.teamActivities.map((t) => t.name), ['staff'], 'Preethi\'s work is not shown to staff');
  const all = (await sx('GET', `/overview?${q}`, boss)).body;
  assert.equal(all.teamScope, 'team');
  assert.deepEqual(all.teamActivities.map((t) => t.name).sort(), ['Preethi', 'staff']);
  const loner = await login('loner', memberRole); // marketing access, but not on the team
  assert.deepEqual((await sx('GET', `/overview?${q}`, loner)).body.teamActivities, [], 'no team record → nobody\'s work');
});

console.log('\n— access —');
await check('someone outside Marketing is refused everywhere; no login is refused', async () => {
  for (const path of ['/overview', '/calendar', '/assets', '/accounts', '/publishing', '/targets', '/performance', '/reports']) {
    assert.equal((await sx('GET', path, outsider)).status, 403, path);
  }
  assert.equal((await sx('POST', '/assets', outsider, { title: 'xx', url: 'https://d.test/a' })).status, 403);
  assert.equal((await call('GET', '/marketing/socials/overview')).status, 401);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
