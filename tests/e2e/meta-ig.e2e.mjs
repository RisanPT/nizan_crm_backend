// End-to-end check of the Instagram insights sync (/api/meta/ig): finding the Pages' Instagram accounts; followers into the Socials
// accounts (with the day's history); the last 30 days' posts (paged, stories left out) with their insights matched to Socials posts by
// Instagram id, link, or the one planned post of that day (nothing ambiguous guessed); figures replaced, impressions kept; an old post's
// insights falling back without stopping the run; posts no Socials post matches listed until added, linked or hidden; a refused
// token or right stops the run and writes nothing; one run at a time; the automatic run; who may do what; no secret leaves the server.
// META IS FAKED — no request leaves this machine.
// Against a THROWAWAY local MongoDB (127.0.0.1:27099; refuses anything else, drops its database first):
//   node tests/e2e/meta-ig.e2e.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_PAGE_IDS', 'META_WEBHOOK_VERIFY_TOKEN', 'META_AD_ACCOUNTS', 'META_APP_SECRET', 'META_ACCESS_TOKEN', 'META_CAPI_DATASET_ID', 'META_CAPI_TOKEN', 'META_CAPI_TEST_CODE', 'META_IG_ACCOUNTS']) {
  process.env[k] = '';
}
const SECRET = 'e2e-app-secret';
const TOKEN = 'e2e-system-user-token';
const MAIN = '17841400000000001';
const KERALA = '17841400000000002';

await mongoose.connect('mongodb://127.0.0.1:27099/meta_ig_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const ContentItem = await imp('models/ContentItem.js');
const SocialAccount = await imp('models/SocialAccount.js');
const MetaIgSync = await imp('models/MetaIgSync.js');
const { _setMetaFetch } = await import(new URL('services/metaGraph.js', root));
const { igAutoSyncTick } = await import(new URL('services/metaIgSync.js', root));
const { istDayOf } = await import(new URL('utils/metaIg.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));

const H = 3600 * 1000;
const D = 24 * H;
// times count back from a fixed IST midday (today's once it is past 1 pm, else yesterday's), so "two reels on one day" never falls
// either side of midnight however late the test runs
const IST = 5.5 * H;
const middayIst = (() => {
  const dayStart = Math.floor((Date.now() + IST) / D) * D - IST;
  const noon = dayStart + 12 * H;
  return Date.now() >= noon + H ? noon : noon - D;
})();
const at = (ms) => new Date(middayIst - ms);
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+0000');

// ── a fake Instagram (Graph API) ─────────────────────────────────────────────
const t1 = at(2 * H);
const MEDIA = {
  [MAIN]: [
    { id: '9001', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Our Kozhikode bride ✨\n#bride #kerala', permalink: 'https://www.instagram.com/reel/CODE1/', timestamp: iso(t1), like_count: 120, comments_count: 9 },
    { id: '9010', media_product_type: 'STORY', media_type: 'IMAGE', permalink: 'https://www.instagram.com/stories/x/9010/', timestamp: iso(at(3 * H)) },
    { id: '9002', media_product_type: 'FEED', media_type: 'IMAGE', caption: 'Engagement look', permalink: 'https://www.instagram.com/p/CODE2/', timestamp: iso(at(2 * D)), like_count: 80, comments_count: 4 },
    { id: '9003', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Reel A #party', permalink: 'https://www.instagram.com/reel/CODE3/', timestamp: iso(at(3 * D)), like_count: 50, comments_count: 2 },
    { id: '9004', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Reel B', permalink: 'https://www.instagram.com/reel/CODE4/', timestamp: iso(at(3 * D - H)), like_count: 60, comments_count: 3 },
    { id: '9005', media_product_type: 'FEED', media_type: 'CAROUSEL_ALBUM', caption: 'Old carousel', permalink: 'https://www.instagram.com/p/CODE5/', timestamp: iso(at(5 * D)), like_count: 33, comments_count: 1 },
    { id: '9008', media_product_type: 'FEED', media_type: 'IMAGE', caption: '', permalink: 'https://www.instagram.com/p/CODE8/', timestamp: iso(at(6 * D)), like_count: 7, comments_count: 0 },
    { id: '9007', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Too old', permalink: 'https://www.instagram.com/reel/CODE7/', timestamp: iso(at(40 * D)), like_count: 1, comments_count: 0 },
    { id: '9009', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Even older', permalink: 'https://www.instagram.com/reel/CODE9/', timestamp: iso(at(60 * D)) },
    // a whole further page of old posts: the reading must stop before it
    { id: '9011', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Old 1', permalink: 'https://www.instagram.com/reel/OLD1/', timestamp: iso(at(70 * D)) },
    { id: '9012', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Old 2', permalink: 'https://www.instagram.com/reel/OLD2/', timestamp: iso(at(80 * D)) },
    { id: '9013', media_product_type: 'REELS', media_type: 'VIDEO', caption: 'Old 3', permalink: 'https://www.instagram.com/reel/OLD3/', timestamp: iso(at(90 * D)) },
  ],
  [KERALA]: [{ id: '9101', media_product_type: 'FEED', media_type: 'VIDEO', caption: 'Kerala bride', permalink: 'https://www.instagram.com/p/KCODE1/', timestamp: iso(at(D)), like_count: 20, comments_count: 1 }],
};
const PROFILES = { [MAIN]: { id: MAIN, username: 'teamn.makeovers', followers_count: 15230, media_count: 400 }, [KERALA]: { id: KERALA, username: 'teamn.kerala', followers_count: 4100, media_count: 120 } };
let bump = 0;
let refuse = null; // 'token' | 'right' — on the next insights / profile calls
const calls = [];
_setMetaFetch(async (url) => {
  const u = new URL(url);
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const token = u.searchParams.get('access_token');
  calls.push({ path: u.pathname, params: Object.fromEntries(u.searchParams) });
  if (u.hostname !== 'graph.facebook.com') return json(500, { error: { message: 'off graph' } });
  if (u.searchParams.get('appsecret_proof') !== crypto.createHmac('sha256', SECRET).update(token ?? '').digest('hex')) return json(400, { error: { code: 100, message: 'Invalid appsecret_proof' } });
  if (token !== TOKEN) return json(400, { error: { code: 190, message: 'Invalid token' } });
  const [ver, id, edge] = u.pathname.split('/').filter(Boolean);
  if (ver !== 'v25.0') return json(400, { error: { code: 2635, message: 'version' } });
  if (refuse === 'right' && PROFILES[id] && !edge) return json(400, { error: { code: 10, message: 'Application does not have permission for this action' } });
  if (id === '111' && !edge) return json(200, { id: '111', name: 'Team N Makeovers', instagram_business_account: { id: MAIN, username: 'teamn.makeovers', followers_count: 15230 } });
  if (id === '222' && !edge) return json(200, { id: '222', name: 'Team N Academy' });
  if (PROFILES[id] && !edge) return json(200, PROFILES[id]);
  if (PROFILES[id] && edge === 'media') {
    const all = MEDIA[id];
    const from = Number(u.searchParams.get('after') || 0);
    const next = new URL(url);
    next.searchParams.set('after', String(from + 3));
    next.searchParams.delete('access_token');
    next.searchParams.delete('appsecret_proof');
    return json(200, { data: all.slice(from, from + 3), paging: from + 3 < all.length ? { next: next.toString() } : {} });
  }
  if (edge === 'insights') {
    if (refuse === 'token') return json(400, { error: { code: 190, error_subcode: 463, message: 'Session has expired' } });
    const metric = u.searchParams.get('metric');
    if (id === '9008') return json(400, { error: { code: 100, message: 'Unsupported request' } });
    if (id === '9005' && metric !== 'reach,saved') return json(400, { error: { code: 100, message: '(#100) metric[1] must be one of the following values: reach, saved' } });
    const n = Number(id.slice(-2)) * 100 + bump;
    const all = { reach: n, views: n * 3, likes: n / 10, comments: n / 100, shares: 5, saved: 7 };
    return json(200, { data: metric.split(',').map((name) => ({ name, period: 'lifetime', values: [{ value: all[name] }] })) });
  }
  return json(404, { error: { code: 803, message: 'Unknown object' } });
});

// ── the app ─────────────────────────────────────────────────────────────────
const app = express();
app.use(sanitizeErrorResponses);
app.use(express.json());
app.use('/api/meta', await imp('routes/metaLeadRoutes.js'));
app.use('/api/marketing/socials', await imp('routes/marketingSocialsRoutes.js'));
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

const yesterday = istDayOf(at(D));
await SocialAccount.create({ brand: 'main', platform: 'instagram', handle: '@teamn.makeovers', followers: 15000, history: [{ day: yesterday, followers: 15000 }] });
const plan = (o) => ContentItem.create({ platform: 'instagram', brand: 'main', status: 'scheduled', contentType: 'reel', ...o });
const P1 = await plan({ title: 'Bride reel (planned)', scheduledDate: t1 }); // the one planned reel of the day → linked by the day
const P2 = await plan({ title: 'Engagement post', contentType: 'post', status: 'published', scheduledDate: at(2 * D), permalink: 'https://instagram.com/p/CODE2?igsh=abc', metrics: { impressions: 300, reach: 1, likes: 1 } });
const P3 = await plan({ title: 'Party reel', scheduledDate: at(3 * D) }); // two reels that day: not guessed
const PK = await plan({ title: 'Kerala video', brand: 'kerala', contentType: 'video', scheduledDate: at(D) });
const YT = await ContentItem.create({ title: 'YouTube vlog', platform: 'youtube', brand: 'main', status: 'published', contentType: 'video', scheduledDate: at(5 * D) });
const post = (p) => ContentItem.findById(p._id).lean();

console.log('Instagram insights');

await check('not set up: the screen says so; Sync now and Find explain', async () => {
  const s = await call('/meta/ig/status', { token: member.token });
  assert.equal(s.status, 200);
  assert.deepEqual([s.body.config.ready, s.body.config.canFind], [false, false]);
  assert.equal((await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } })).status, 409);
  assert.equal((await call('/meta/ig/find', { token: member.token, method: 'POST' })).status, 409);
  assert.equal(calls.length, 0);
});

Object.assign(process.env, { META_APP_SECRET: SECRET, META_ACCESS_TOKEN: TOKEN, META_PAGE_IDS: '111,222', META_GRAPH_VERSION: 'v25.0' });

await check('Find my Instagram accounts: each Page\'s account, or why it has none', async () => {
  const r = await call('/meta/ig/find', { token: member.token, method: 'POST' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.accounts.map((a) => [a.pageId, a.igId, a.username]), [['111', MAIN, 'teamn.makeovers'], ['222', '', '']]);
  assert.match(r.body.accounts[1].problem, /No Instagram business account/);
});

process.env.META_IG_ACCOUNTS = `${MAIN}:main, ${KERALA}:kerala`;

await check('Sync now: the last 30 days\' posts of both accounts (paged; stories and older posts left out), with their insights', async () => {
  const r = await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } });
  assert.equal(r.status, 200, r.text);
  const run = r.body.run;
  assert.equal(run.ok, true, run.problem);
  assert.deepEqual([run.accounts, run.media, run.updated, run.linked, run.unmatched, run.gaps], [2, 7, 3, 3, 4, 2]);
  assert.ok(calls.some((c) => c.path.endsWith('/media') && c.params.after === '3'), 'the second page was read');
  assert.equal(calls.some((c) => c.path.endsWith('/media') && c.params.after === '9'), false, 'not past the first post older than 30 days');
  assert.equal(calls.some((c) => c.path === '/v25.0/9010/insights'), false, 'a story is not read');
  assert.equal(calls.some((c) => c.path === '/v25.0/9007/insights'), false, 'a post older than 30 days is not read');
});

await check('the planned post of the day becomes the reel: published, its link, its figures from Instagram', async () => {
  const p = await post(P1);
  assert.equal(p.igMediaId, '9001');
  assert.equal(p.status, 'published');
  assert.equal(p.publishedDate.toISOString(), t1.toISOString().replace(/\.\d{3}Z$/, '.000Z'));
  assert.equal(p.permalink, 'https://www.instagram.com/reel/CODE1/');
  assert.deepEqual([p.metrics.reach, p.metrics.views, p.metrics.likes, p.metrics.comments, p.metrics.shares, p.metrics.saves], [100, 300, 10, 1, 5, 7]);
  assert.equal(p.metricsSource, 'instagram');
  assert.ok(p.metricsSyncedAt);
});

await check('a post found by its link keeps the link and the impressions typed by hand; the rest is Instagram\'s', async () => {
  const p = await post(P2);
  assert.equal(p.igMediaId, '9002');
  assert.equal(p.permalink, 'https://instagram.com/p/CODE2?igsh=abc');
  assert.equal(p.metrics.impressions, 300, 'Instagram no longer reports impressions: what was typed stays');
  assert.equal(p.metrics.reach, 200);
  const k = await post(PK);
  assert.equal(k.igMediaId, '9101', 'the Kerala account\'s post matches the Kerala plan');
});

await check('two reels on one day and one planned reel: neither is guessed; both are listed', async () => {
  assert.equal((await post(P3)).igMediaId, '');
  const s = await call('/meta/ig/status', { token: member.token });
  assert.deepEqual(s.body.unmatched.map((u) => u.mediaId).sort(), ['9003', '9004', '9005', '9008']);
  const old = s.body.unmatched.find((u) => u.mediaId === '9005');
  assert.deepEqual([old.metrics.reach, old.metrics.saves, old.metrics.likes, old.metrics.views], [500, 7, 33, 0], 'its insights fell back to reach and saved; the likes are the post\'s own count');
  assert.equal(s.body.unmatched.find((u) => u.mediaId === '9008').metrics.likes, 7, 'no insights at all: the counts still come');
});

await check('followers: the account\'s figure and today\'s history; a missing account is added under its brand', async () => {
  const main = await SocialAccount.findOne({ igUserId: MAIN }).lean();
  assert.deepEqual([main.handle, main.followers, main.status], ['@teamn.makeovers', 15230, 'connected']);
  assert.deepEqual(main.history.map((h) => h.followers), [15000, 15230]);
  const kerala = await SocialAccount.findOne({ igUserId: KERALA }).lean();
  assert.deepEqual([kerala.brand, kerala.handle, kerala.followers], ['kerala', 'teamn.kerala', 4100]);
});

await check('syncing again changes the figures, never adds anything twice', async () => {
  bump = 50;
  const count = await ContentItem.countDocuments();
  const r = await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } });
  assert.equal(r.body.run.ok, true);
  assert.equal(r.body.run.linked, 0, 'all linked already');
  assert.equal(await ContentItem.countDocuments(), count);
  assert.equal((await post(P1)).metrics.reach, 150);
  assert.equal((await SocialAccount.findOne({ igUserId: MAIN }).lean()).history.length, 2, 'one figure per day');
  const s = await call('/meta/ig/status', { token: member.token });
  assert.equal(s.body.unmatched.length, 4);
});

await check('link: reel A is the planned party reel — its figures come with it; reel B stays listed', async () => {
  const r = await call('/meta/ig/unmatched/9003/link', { token: member.token, method: 'POST', body: { contentId: String(P3._id) } });
  assert.equal(r.status, 200, r.text);
  const p = await post(P3);
  assert.deepEqual([p.igMediaId, p.status, p.metrics.reach, p.metricsSource], ['9003', 'published', 350, 'instagram']);
  const s = await call('/meta/ig/status', { token: member.token });
  assert.equal(s.body.unmatched.some((u) => u.mediaId === '9003'), false);
  assert.equal(s.body.postChoices.some((c) => c.id === String(P3._id)), false, 'a linked post is no longer offered');
});

await check('link refusals: not an Instagram post; a post already linked to another', async () => {
  assert.equal((await call('/meta/ig/unmatched/9005/link', { token: member.token, method: 'POST', body: { contentId: String(YT._id) } })).status, 409);
  assert.equal((await call('/meta/ig/unmatched/9005/link', { token: member.token, method: 'POST', body: { contentId: String(P1._id) } })).status, 409);
  assert.equal((await call('/meta/ig/unmatched/9005/link', { token: member.token, method: 'POST', body: { contentId: 'x' } })).status, 400);
  assert.equal((await call('/meta/ig/unmatched/abc/link', { token: member.token, method: 'POST', body: { contentId: String(P1._id) } })).status, 404);
});

await check('add: reel B becomes a published Socials post — title from the caption, its hashtags, its figures', async () => {
  const r = await call('/meta/ig/unmatched/9004/add', { token: member.token, method: 'POST' });
  assert.equal(r.status, 200, r.text);
  const p = await ContentItem.findOne({ igMediaId: '9004' }).lean();
  assert.deepEqual([p.title, p.contentType, p.status, p.brand, p.platform, p.metricsSource], ['Reel B', 'reel', 'published', 'main', 'instagram', 'instagram']);
  assert.equal(p.metrics.reach, 450);
  assert.equal((await call('/meta/ig/unmatched/9004/add', { token: member.token, method: 'POST' })).status, 404, 'not twice');
  // the Socials calendar shows where the figures came from
  const cal = await call(`/marketing/socials/calendar?from=${istDayOf(at(4 * D))}&to=${istDayOf(new Date())}&brand=all`, { token: member.token });
  assert.equal(cal.status, 200, cal.text);
  assert.equal(cal.body.items.find((i) => i.title === 'Reel B').metricsSource, 'instagram');
});

await check('hide a post: off the list and out of the next runs; show again lists it at the next sync', async () => {
  let s = await call('/meta/ig/unmatched/9008/ignore', { token: member.token, method: 'POST' });
  assert.deepEqual(s.body.ignored, ['9008']);
  await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } });
  s = await call('/meta/ig/status', { token: member.token });
  assert.equal(s.body.unmatched.some((u) => u.mediaId === '9008'), false);
  await call('/meta/ig/ignored/9008/restore', { token: member.token, method: 'POST' });
  await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } });
  s = await call('/meta/ig/status', { token: member.token });
  assert.equal(s.body.unmatched.some((u) => u.mediaId === '9008'), true);
});

await check('a refused token part-way writes nothing and says why; a missing right on the account names Instagram\'s rights', async () => {
  bump = 900;
  refuse = 'token';
  const before = (await post(P1)).metrics.reach;
  const followers = (await SocialAccount.findOne({ igUserId: MAIN }).lean()).followers;
  PROFILES[MAIN].followers_count = 99999;
  const r = await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } });
  assert.equal(r.body.run.ok, false);
  assert.equal(r.body.run.problemCode, 'token');
  assert.equal((await post(P1)).metrics.reach, before, 'no post changed');
  assert.equal((await SocialAccount.findOne({ igUserId: MAIN }).lean()).followers, followers, 'no account changed');
  refuse = 'right';
  const right = await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 30 } });
  assert.equal(right.body.run.problemCode, 'permission');
  assert.match(right.body.run.problem, /instagram_manage_insights/);
  refuse = null;
  PROFILES[MAIN].followers_count = 15230;
});

await check('one run at a time; the automatic run when due — switched only by a manager', async () => {
  await MetaIgSync.updateOne({ key: 'ig' }, { $set: { running: true, runningSince: new Date() } });
  assert.equal((await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 7 } })).status, 409);
  await MetaIgSync.updateOne({ key: 'ig' }, { $set: { running: false, runningSince: null } });
  assert.equal(await igAutoSyncTick(), null, 'just ran: not due');
  await MetaIgSync.updateOne({ key: 'ig' }, { $set: { 'lastRun.at': new Date(Date.now() - 7 * H) } });
  const run = await igAutoSyncTick();
  assert.deepEqual([run.ok, run.trigger, run.days], [true, 'auto', 30]);
  assert.equal((await call('/meta/ig/settings', { token: member.token, method: 'PUT', body: { autoSync: false } })).status, 403);
  const s = await call('/meta/ig/settings', { token: head.token, method: 'PUT', body: { autoSync: false } });
  assert.equal(s.body.settings.autoSync, false);
  await MetaIgSync.updateOne({ key: 'ig' }, { $set: { 'lastRun.at': new Date(Date.now() - 7 * H) } });
  assert.equal(await igAutoSyncTick(), null);
  assert.equal((await call('/meta/ig/sync', { token: member.token, method: 'POST', body: { days: 91 } })).status, 400);
});

await check('add all; the status: accounts with names and followers, synced posts — never a secret; Marketing only', async () => {
  const r = await call('/meta/ig/unmatched/add-all', { token: member.token, method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 2);
  const s = await call('/meta/ig/status', { token: member.token });
  assert.deepEqual(s.body.config.accounts.map((a) => [a.id, a.brand, a.username, a.followers]), [[MAIN, 'main', '@teamn.makeovers', 15230], [KERALA, 'kerala', 'teamn.kerala', 4100]]);
  assert.equal(s.body.syncedPosts, 7, '4 linked, 1 added, 2 added with add all');
  assert.equal(s.body.unmatched.length, 0);
  for (const secret of [SECRET, TOKEN]) assert.equal(s.text.includes(secret), false);
  assert.equal((await call('/meta/ig/status', { token: artist.token })).status, 403);
  assert.equal((await call('/meta/ig/sync', { method: 'POST', body: { days: 7 } })).status, 401);
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
