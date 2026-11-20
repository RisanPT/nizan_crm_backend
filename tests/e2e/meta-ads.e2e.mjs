// End-to-end check of the live Meta ad spend sync (/api/meta/ads): figures read from the Insights API (paged, in 15-day pieces, both ad
// accounts) land in the Campaigns hub exactly as an import would put them — campaign days (Meta's own reach), ads, audience segments —
// replacing what was there for those days only; a campaign found by its title takes Meta's id; Meta campaigns no CRM campaign matches are
// listed, not counted, until linked (their Meta leads then take the campaign), added (with the account's brand) or ignored; a run that
// fails writes nothing and says why; one run at a time; the automatic run; who may do what; no secret leaves the server.
// META IS FAKED — no request leaves this machine.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/meta-ads.e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_PAGE_IDS', 'META_WEBHOOK_VERIFY_TOKEN', 'META_AD_ACCOUNTS', 'META_APP_SECRET', 'META_ACCESS_TOKEN']) {
  process.env[k] = '';
}
const SECRET = 'e2e-app-secret';
const TOKEN = 'e2e-system-user-token';
const configure = () => Object.assign(process.env, { META_APP_SECRET: SECRET, META_ACCESS_TOKEN: TOKEN, META_AD_ACCOUNTS: 'act_111:kerala, act_222:main', META_GRAPH_VERSION: 'v25.0' });

await mongoose.connect('mongodb://127.0.0.1:27099/meta_ads_e2e');
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
const CampaignDailyMetric = await imp('models/CampaignDailyMetric.js');
const CampaignAd = await imp('models/CampaignAd.js');
const CampaignAdDailyMetric = await imp('models/CampaignAdDailyMetric.js');
const CampaignBreakdownMetric = await imp('models/CampaignBreakdownMetric.js');
const MetaImportLog = await imp('models/MetaImportLog.js');
const MetaAdsSync = await imp('models/MetaAdsSync.js');
const MetaLeadEvent = await imp('models/MetaLeadEvent.js');
const { _setMetaFetch } = await import(new URL('services/metaGraph.js', root));
const { autoSyncTick } = await import(new URL('services/metaAdsSync.js', root));
const { istToday, addDays } = await import(new URL('utils/metaAds.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const TODAY = istToday();
const day = (n) => addDays(TODAY, -n); // n days ago

// ── a fake Meta (Insights API) ───────────────────────────────────────────────
const CAMPAIGNS = [
  { id: '3001', name: 'Kerala Nov', account: 'act_111', objective: 'OUTCOME_LEADS', base: 100 },
  { id: '3002', name: 'Bridal Reels', account: 'act_111', objective: 'OUTCOME_ENGAGEMENT', base: 200 },
  { id: '3005', name: 'Party Season', account: 'act_111', objective: 'OUTCOME_LEADS', base: 50 },
  { id: '3003', name: 'Main Diwali', account: 'act_222', objective: 'OUTCOME_LEADS', base: 300 },
  { id: '3004', name: 'Test campaign', account: 'act_222', objective: 'OUTCOME_TRAFFIC', base: 1 },
];
let bump = 0; // added to every spend: Meta "changing its mind" between runs
const spendOf = (c, d) => c.base + Number(d.slice(8)) + bump;
const daysIn = (since, until) => {
  const out = [];
  for (let d = since; d <= until; d = addDays(d, 1)) out.push(d);
  return out;
};
const rowsFor = (account, level, breakdowns, since, until) => {
  const rows = [];
  for (const c of CAMPAIGNS.filter((x) => x.account === account)) {
    for (const d of daysIn(since, until)) {
      const base = { campaign_id: c.id, campaign_name: c.name, date_start: d, date_stop: d };
      const spend = spendOf(c, d);
      if (level === 'campaign' && !breakdowns) {
        rows.push({ ...base, objective: c.objective, spend: spend.toFixed(2), reach: '600', impressions: '1000', inline_link_clicks: '50', actions: [{ action_type: 'link_click', value: '50' }, { action_type: 'lead', value: '2' }, { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '4' }] });
      } else if (level === 'ad' && c.id === '3001') {
        for (const [adId, name] of [['501', 'Reel 17'], ['502', 'Carousel 3']]) {
          rows.push({ ...base, adset_id: '401', adset_name: 'Women 22-30', ad_id: adId, ad_name: name, spend: (spend / 2).toFixed(2), reach: '420', impressions: '500', inline_link_clicks: '25', actions: [{ action_type: 'lead', value: '1' }] });
        }
      } else if (breakdowns === 'age,gender' && c.id === '3001') {
        rows.push({ ...base, age: '25-34', gender: 'female', spend: (spend * 0.7).toFixed(2), reach: '400', impressions: '700', inline_link_clicks: '35', actions: [] });
        rows.push({ ...base, age: '18-24', gender: 'female', spend: (spend * 0.3).toFixed(2), reach: '200', impressions: '300', inline_link_clicks: '15', actions: [] });
      } else if (breakdowns === 'publisher_platform,platform_position' && c.id === '3001') {
        rows.push({ ...base, publisher_platform: 'instagram', platform_position: 'instagram_reels', spend: (spend * 0.6).toFixed(2), reach: '350', impressions: '600', inline_link_clicks: '30', actions: [] });
        rows.push({ ...base, publisher_platform: 'facebook', platform_position: 'feed', spend: (spend * 0.4).toFixed(2), reach: '250', impressions: '400', inline_link_clicks: '20', actions: [] });
      }
    }
  }
  return rows;
};
const PAGE = 7; // small pages, so paging is used
let failOn = null; // { breakdowns?: string, level?: string, code: 'token' | 'down' }
const calls = [];
_setMetaFetch(async (url) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const token = u.searchParams.get('access_token');
  if (u.hostname !== 'graph.facebook.com') return json(500, { error: { message: 'off graph' } });
  if (u.searchParams.get('appsecret_proof') !== crypto.createHmac('sha256', SECRET).update(token ?? '').digest('hex')) return json(400, { error: { code: 100, message: 'Invalid appsecret_proof' } });
  if (token !== TOKEN) return json(400, { error: { code: 190, message: 'Invalid OAuth access token' } });
  const [ver, account, edge] = u.pathname.split('/').filter(Boolean);
  if (ver !== 'v25.0' || edge !== 'insights' || !['act_111', 'act_222'].includes(account)) return json(400, { error: { code: 803, message: 'Unknown path' } });
  const level = u.searchParams.get('level');
  const breakdowns = u.searchParams.get('breakdowns') ?? '';
  const { since, until } = JSON.parse(u.searchParams.get('time_range'));
  calls.push({ account, level, breakdowns, since, until, after: u.searchParams.get('after') ?? '' });
  if (u.searchParams.get('time_increment') !== '1') return json(400, { error: { code: 100, message: 'daily rows expected' } });
  if (failOn && (failOn.breakdowns ?? breakdowns) === breakdowns && (failOn.level ?? level) === level) {
    if (failOn.code === 'permission') return json(400, { error: { code: 200, message: 'Requires ads_read' } });
    return failOn.code === 'token' ? json(400, { error: { code: 190, error_subcode: 463, message: 'Session has expired' } }) : json(503, {});
  }
  const fields = u.searchParams.get('fields').split(',');
  for (const need of ['campaign_id', 'spend', 'reach', 'impressions', 'inline_link_clicks', 'actions', 'date_start']) if (!fields.includes(need)) return json(400, { error: { code: 100, message: `missing ${need}` } });
  const all = rowsFor(account, level, breakdowns, since, until);
  const at = Number(u.searchParams.get('after') || 0);
  const next = new URL(url);
  next.searchParams.set('after', String(at + PAGE));
  next.searchParams.delete('access_token');
  next.searchParams.delete('appsecret_proof');
  return json(200, { data: all.slice(at, at + PAGE), paging: at + PAGE < all.length ? { next: next.toString() } : {} });
});

// ── the app, as server.js mounts it ─────────────────────────────────────────
const app = express();
app.use(sanitizeErrorResponses);
app.use(express.json());
app.use('/api/meta', await imp('routes/metaLeadRoutes.js'));
app.use('/api/marketing/campaign-hub', await imp('routes/marketingCampaignHubRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;
const call = async (p, { token, method = 'GET', body } = {}) => {
  const res = await fetch(`${base}${p}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, body: json, text };
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
const keralaNov = await Campaign.create({ title: 'Kerala Nov', metaCampaignId: '3001', brand: 'kerala' });
const bridal = await Campaign.create({ title: 'Bridal Reels', brand: 'kerala' }); // no Meta id yet: found by its title
const party = await Campaign.create({ title: 'Party season promo', brand: 'kerala' }); // Meta calls it "Party Season": linked by hand
const other = await Campaign.create({ title: 'Already linked', metaCampaignId: '9999', brand: 'main' });
// what was there before the sync: a file-imported day and a typed day inside the synced days, and a day before them
await CampaignDailyMetric.create({ campaignId: keralaNov._id, day: day(5), spend: 1, reach: 1, impressions: 1, clicks: 1, results: 1, source: 'csv' });
await CampaignDailyMetric.create({ campaignId: keralaNov._id, day: day(6), spend: 2, reach: 1, impressions: 1, clicks: 0, results: 0, source: 'manual' });
await CampaignDailyMetric.create({ campaignId: keralaNov._id, day: day(40), spend: 77, reach: 10, impressions: 20, clicks: 2, results: 1, source: 'csv' });
// a Meta lead that came through "Party Season" before it was linked
const partyLead = await Lead.create({ name: 'Nila', phone: '+919800000001', source: 'Paid Ads Leads' });
await MetaLeadEvent.create({ leadgenId: '7001', status: 'created', leadId: partyLead._id, metaCampaignId: '3005' });

const metric = (c, d) => CampaignDailyMetric.findOne({ campaignId: c._id ?? c, day: d }).lean();
console.log('Meta ad spend sync');

await check('not set up: the screen says what is missing; Sync now explains instead of failing', async () => {
  const s = await call('/meta/ads/status', { token: member.token });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.config, { appSecret: false, token: false, accounts: [], ready: false, version: 'v25.0' });
  const r = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 3 } });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /META_AD_ACCOUNTS/);
  assert.equal(await autoSyncTick(), null, 'no automatic run either');
  assert.equal(calls.length, 0);
});

configure();

await check('Sync now: both accounts, 15-day pieces, every level and breakdown, every page', async () => {
  const r = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 20 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.run.ok, true, r.body.run.problem);
  assert.deepEqual([r.body.run.from, r.body.run.to], [day(19), TODAY]);
  const pieces = [...new Set(calls.map((c) => `${c.since}|${c.until}`))].sort();
  assert.deepEqual(pieces, [`${day(19)}|${day(5)}`, `${day(4)}|${TODAY}`]);
  for (const account of ['act_111', 'act_222']) {
    for (const [level, b] of [['campaign', ''], ['ad', ''], ['campaign', 'age,gender'], ['campaign', 'publisher_platform,platform_position']]) {
      assert.ok(calls.some((c) => c.account === account && c.level === level && c.breakdowns === b), `${account} ${level} ${b}`);
    }
  }
  assert.ok(calls.some((c) => c.after), 'next pages were read');
});

await check('campaign days are Meta\'s own figures (reach not the ads\' sum); results by the objective', async () => {
  const d = day(2);
  const m = await metric(keralaNov, d);
  assert.equal(m.source, 'api');
  assert.equal(m.spend, 100 + Number(d.slice(8)));
  assert.deepEqual([m.reach, m.impressions, m.clicks, m.results], [600, 1000, 50, 2], 'reach 600, not 420 + 420 from the ads');
  const b = await metric(bridal, d);
  assert.equal(b.results, 4, 'an engagement campaign counts conversations');
  assert.equal(await CampaignDailyMetric.countDocuments({ campaignId: keralaNov._id, day: { $gte: day(19), $lte: TODAY } }), 20);
});

await check('the days synced replace what was there (file and typed); a day outside them is left alone', async () => {
  assert.equal((await metric(keralaNov, day(5))).source, 'api');
  assert.equal((await metric(keralaNov, day(6))).source, 'api');
  const before = await metric(keralaNov, day(40));
  assert.deepEqual([before.source, before.spend], ['csv', 77]);
});

await check('a CRM campaign found by its title takes Meta\'s id (so the next sync and Lead Ads find it by id)', async () => {
  assert.equal((await Campaign.findById(bridal._id).lean()).metaCampaignId, '3002');
  assert.equal(await CampaignDailyMetric.countDocuments({ campaignId: bridal._id }), 20);
});

await check('ads are added with their days; their figures add up; audience segments are stored by dimension', async () => {
  const ads = await CampaignAd.find({ campaignId: keralaNov._id }).lean();
  assert.deepEqual(ads.map((a) => a.metaAdId).sort(), ['501', '502']);
  assert.equal(ads[0].adSetName, 'Women 22-30');
  assert.equal(await CampaignAdDailyMetric.countDocuments({ campaignId: keralaNov._id }), 40);
  const reel = ads.find((a) => a.metaAdId === '501');
  const days = await CampaignAdDailyMetric.find({ adId: reel._id }).lean();
  assert.equal(Math.round(reel.spend * 100), Math.round(days.reduce((t, x) => t + x.spend, 0) * 100));
  const segs = await CampaignBreakdownMetric.find({ campaignId: keralaNov._id, day: day(1) }).lean();
  assert.deepEqual(segs.map((s) => s.dimension).sort(), ['age+gender', 'age+gender', 'placement', 'placement']);
  assert.ok(segs.some((s) => s.placement === 'Instagram · Instagram Reels'));
  assert.ok(segs.some((s) => s.age === '25-34' && s.gender === 'female'));
});

await check('Meta campaigns no CRM campaign matches are listed with their account\'s brand — not counted', async () => {
  const s = await call('/meta/ads/status', { token: member.token });
  const ids = s.body.unlinked.map((u) => u.metaId).sort();
  assert.deepEqual(ids, ['3003', '3004', '3005']);
  const diwali = s.body.unlinked.find((u) => u.metaId === '3003');
  assert.deepEqual([diwali.name, diwali.brand, diwali.accountId, diwali.firstDay, diwali.lastDay], ['Main Diwali', 'main', 'act_222', day(19), TODAY]);
  assert.ok(diwali.spend > 0);
  assert.ok(s.body.lastRun.unlinkedSpend > 0);
  assert.equal(await Campaign.countDocuments(), 4, 'nothing created unasked');
  assert.deepEqual(s.body.campaignChoices.map((c) => c.title).sort(), ['Party season promo'], 'only campaigns without a Meta id can be linked');
});

await check('the same days again change nothing (no second day, ad or segment); a changed figure from Meta replaces the old', async () => {
  const counts = async () => [await CampaignDailyMetric.countDocuments(), await CampaignAd.countDocuments(), await CampaignAdDailyMetric.countDocuments(), await CampaignBreakdownMetric.countDocuments()];
  const before = await counts();
  bump = 10;
  const r = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 20 } });
  assert.equal(r.body.run.ok, true);
  assert.deepEqual(await counts(), before);
  assert.equal((await metric(keralaNov, day(2))).spend, 110 + Number(day(2).slice(8)));
  assert.equal(await MetaImportLog.countDocuments({ source: 'api' }), 2, 'one history entry per run');
});

await check('link: "Party Season" is that CRM campaign — its days come in from the first day seen, and its Meta lead takes it', async () => {
  const r = await call('/meta/ads/unlinked/3005/link', { token: member.token, method: 'POST', body: { campaignId: String(party._id) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.leadsTagged, 1);
  assert.equal(r.body.run.ok, true);
  assert.equal((await Campaign.findById(party._id).lean()).metaCampaignId, '3005');
  assert.equal(String((await Lead.findById(partyLead._id).lean()).campaignId), String(party._id));
  assert.equal(await CampaignDailyMetric.countDocuments({ campaignId: party._id }), 20);
  const s = await call('/meta/ads/status', { token: member.token });
  assert.equal(s.body.unlinked.some((u) => u.metaId === '3005'), false);
});

await check('link refusals: a campaign linked to another Meta campaign; a Meta campaign already linked elsewhere', async () => {
  assert.equal((await call('/meta/ads/unlinked/3003/link', { token: member.token, method: 'POST', body: { campaignId: String(other._id) } })).status, 409);
  assert.equal((await call('/meta/ads/unlinked/3001/link', { token: member.token, method: 'POST', body: { campaignId: String(party._id) } })).status, 409);
  assert.equal((await call('/meta/ads/unlinked/3003/link', { token: member.token, method: 'POST', body: { campaignId: 'nope' } })).status, 400);
  assert.equal((await call('/meta/ads/unlinked/x-1/link', { token: member.token, method: 'POST', body: { campaignId: String(party._id) } })).status, 404);
});

await check('ignore a test campaign: off the list and out of the next runs; restore lists it again', async () => {
  let s = await call('/meta/ads/unlinked/3004/ignore', { token: member.token, method: 'POST' });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.ignored, ['3004']);
  assert.equal(s.body.unlinked.some((u) => u.metaId === '3004'), false);
  await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 3 } });
  s = await call('/meta/ads/status', { token: member.token });
  assert.equal(s.body.unlinked.some((u) => u.metaId === '3004'), false);
  s = await call('/meta/ads/ignored/3004/restore', { token: member.token, method: 'POST' });
  assert.deepEqual(s.body.ignored, []);
  await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 3 } });
  s = await call('/meta/ads/status', { token: member.token });
  assert.equal(s.body.unlinked.some((u) => u.metaId === '3004'), true);
});

await check('add: "Main Diwali" becomes a campaign of the Main brand, with its days', async () => {
  const r = await call('/meta/ads/unlinked/3003/add', { token: member.token, method: 'POST' });
  assert.equal(r.status, 200, r.text);
  const c = await Campaign.findOne({ metaCampaignId: '3003' }).lean();
  assert.deepEqual([c.title, c.brand, c.platform], ['Main Diwali', 'main', 'meta']);
  assert.equal(await CampaignDailyMetric.countDocuments({ campaignId: c._id }), 20, 'from the first day it was seen');
  assert.equal((await call('/meta/ads/unlinked/3003/add', { token: member.token, method: 'POST' })).status, 404, 'not twice');
});

await check('a run Meta refuses part-way writes nothing and says why; the next run works', async () => {
  bump = 50;
  failOn = { breakdowns: 'publisher_platform,platform_position', code: 'token' };
  const logs = await MetaImportLog.countDocuments();
  const r = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 3 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.ok, false);
  assert.equal(r.body.run.problemCode, 'token');
  assert.match(r.body.run.problem, /META_ACCESS_TOKEN/);
  assert.equal((await metric(keralaNov, TODAY)).spend, 110 + Number(TODAY.slice(8)), 'the old figure stays: nothing was half-written');
  assert.equal(await MetaImportLog.countDocuments(), logs, 'no empty history entry');
  const card = await call('/marketing/campaign-hub/imports', { token: member.token });
  assert.equal(card.body.meta.status, 'error');
  assert.match(card.body.meta.sync.problem, /access token/);
  failOn = { level: 'ad', code: 'permission' };
  const right = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 3 } });
  assert.equal(right.body.run.problemCode, 'permission');
  assert.match(right.body.run.problem, /ads_read/, 'the sync names the ad accounts\' right, not a lead\'s');
  failOn = null;
  const again = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 3 } });
  assert.equal(again.body.run.ok, true);
  assert.equal((await metric(keralaNov, TODAY)).spend, 150 + Number(TODAY.slice(8)));
});

await check('one run at a time: a running sync refuses another; one dead for 30 minutes does not block', async () => {
  await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { running: true, runningSince: new Date() } });
  assert.equal((await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 1 } })).status, 409);
  await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { runningSince: new Date(Date.now() - 31 * 60000) } });
  const r = await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.body.run.ok, true);
  assert.equal((await MetaAdsSync.findOne({ key: 'ads' }).lean()).running, false);
});

await check('the automatic run: due 6 hours after the last, the last 3 days; off when switched off — which only a manager can do', async () => {
  assert.equal(await autoSyncTick(), null, 'just ran: not due');
  await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { 'lastRun.at': new Date(Date.now() - 7 * 3600000) } });
  const run = await autoSyncTick();
  assert.equal(run.ok, true);
  assert.deepEqual([run.trigger, run.byName, run.from, run.to], ['auto', 'Automatic sync', day(2), TODAY]);
  assert.equal((await call('/meta/ads/settings', { token: member.token, method: 'PUT', body: { autoSync: false } })).status, 403);
  assert.equal((await call('/meta/ads/settings', { token: head.token, method: 'PUT', body: { autoSync: 'no' } })).status, 400);
  const s = await call('/meta/ads/settings', { token: head.token, method: 'PUT', body: { autoSync: false } });
  assert.equal(s.body.settings.autoSync, false);
  assert.equal(s.body.nextAutoAt, null);
  await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { 'lastRun.at': new Date(Date.now() - 7 * 3600000) } });
  assert.equal(await autoSyncTick(), null);
});

await check('the hub\'s Meta card: connected, when it last synced, how many Meta campaigns wait to be linked', async () => {
  const card = await call('/marketing/campaign-hub/imports', { token: member.token });
  assert.equal(card.status, 200);
  assert.equal(card.body.meta.connected, true);
  assert.equal(card.body.meta.status, 'connected');
  assert.equal(card.body.meta.sync.unlinked, 1);
  assert.equal(card.body.meta.lastImport.source, 'api');
});

await check('add all; status shows the history and never a secret; only the Marketing team may open it', async () => {
  const r = await call('/meta/ads/unlinked/add-all', { token: member.token, method: 'POST' });
  assert.equal(r.status, 200);
  assert.ok(await Campaign.exists({ metaCampaignId: '3004' }));
  assert.equal((await call('/meta/ads/unlinked/add-all', { token: member.token, method: 'POST' })).status, 409);
  const s = await call('/meta/ads/status', { token: member.token });
  assert.deepEqual(s.body.config.accounts, [{ id: 'act_111', brand: 'kerala' }, { id: 'act_222', brand: 'main' }]);
  assert.ok(s.body.history.length >= 5);
  assert.equal(s.body.canManage, false);
  for (const secret of [SECRET, TOKEN]) assert.equal(s.text.includes(secret), false);
  assert.equal((await call('/meta/ads/status', { token: artist.token })).status, 403);
  assert.equal((await call('/meta/ads/sync', { method: 'POST', body: { days: 1 } })).status, 401);
  assert.equal((await call('/meta/ads/sync', { token: member.token, method: 'POST', body: { days: 93 } })).status, 400);
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
