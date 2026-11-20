// End-to-end check of the Creative Portfolio gallery's search, filters and keywords — against a THROWAWAY local MongoDB (needs a mongod
// on 127.0.0.1:27099; refuses to run against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-gallery-search.e2e.mjs
//
// The library is filled through the API the way the team fills it (keywords typed every which way), then searched and filtered the
// way the gallery asks: several values per filter, keywords all/any/left out, words that reach the shoot and the person who added it,
// "Best match", pages that never repeat or skip an asset, and the keyword tools (suggest, rename/merge, remove, bulk add/remove).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_SYSTEM_TOKEN']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_gallery_search_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Asset = await imp('models/MarketingAsset.js');
const Shoot = await imp('models/MarketingShoot.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/socials', await imp('routes/marketingSocialsRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api/marketing/socials`;

const call = async (method, path, who, body) => {
  const res = await fetch(`${origin}${path}`, { method, headers: { 'content-type': 'application/json', ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};
/** GET /assets with the query as the app sends it: a list = the same name repeated. */
const list = async (who, params = {}) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of Array.isArray(v) ? v : [v]) u.append(k, String(x));
  const r = await call('GET', `/assets?${u}`, who);
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const titles = (l) => l.items.map((a) => a.title);

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.stack ?? e.message).split('\n').slice(0, 8).join('\n      ')}`); }
};

let n = 0;
const login = async (name, role) => {
  n += 1;
  const emp = await Employee.create({ name, department: 'Marketing' });
  const user = await User.create({ name, email: `u${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('Boss', 'marketing_admin');
const memberRole = 'marketing_staff';
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: memberRole }, { $setOnInsert: { key: memberRole, label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const anu = await login('Anu Varghese', memberRole);

// a shoot whose location and crew are not written on its assets — the search still reaches them
const shoot = await Shoot.create({ title: 'Anjali wedding day', brand: 'kerala', category: 'Bridal Makeup', shootDate: '2026-11-02', location: 'Kumarakom Lake Resort', crew: [{ name: 'Faies (MUA)', role: 'Makeup Artist' }] });

const add = async (who, body) => {
  const r = await call('POST', '/assets', who, { url: `https://www.dropbox.com/s/${Math.random().toString(36).slice(2)}/x.mp4`, ...body });
  assert.equal(r.status, 201, r.text);
  return r.body;
};

console.log('\n— keywords are kept one way, however they are typed —');
let a1, a2, a3, a4, a5, a6;
await check('typed or pasted every which way: one spelling each, duplicates dropped, order kept', async () => {
  a1 = await add(boss, { title: 'Bridal reel — Anjali', kind: 'reel', tags: '#Bridal, bridal ; Kerala  Bride\n#Hero', stage: 'approved' });
  assert.deepEqual(a1.tags, ['bridal', 'kerala bride', 'hero']);
  a2 = await add(anu, { title: 'Studio clip', kind: 'bts', tags: ['Bridal', 'REEL', 'reel, studio'] });
  assert.deepEqual(a2.tags, ['bridal', 'reel', 'studio']);
  a3 = await add(boss, { title: 'Party makeup look', kind: 'still', media: 'image', tags: ['party', 'glam'], page: 'Party Makeup', isFinal: true });
  a4 = await add(anu, { title: 'Christian bride portrait', kind: 'still', media: 'image', tags: ['bride', 'christian bride'], page: 'Bridal Makeup', brand: 'kerala' });
  a5 = await add(boss, { title: 'Untitled export 0042', kind: 'film', tags: [], shootId: String(shoot._id) });
  a6 = await add(anu, { title: 'Logo sheet', kind: 'design', tags: '' });
  assert.deepEqual(a5.tags, ['bridal makeup'], 'from the shoot: its category as a keyword');
});
await check('too many or too long: refused with the reason, nothing saved', async () => {
  const many = await call('POST', '/assets', boss, { title: 'Too many', url: 'https://d.test/m', tags: Array.from({ length: 51 }, (_, i) => `k${i}`) });
  assert.equal(many.status, 400);
  assert.match(many.body.message, /up to 50 keywords — this has 51/);
  const long = await call('PUT', `/assets/${a1.id}`, boss, { tags: ['ok', 'x'.repeat(41)] });
  assert.equal(long.status, 400);
  assert.match(long.body.message, /40 characters/);
  assert.deepEqual((await Asset.findById(a1.id).lean()).tags, ['bridal', 'kerala bride', 'hero'], 'unchanged');
  assert.equal(await Asset.countDocuments({ title: 'Too many' }), 0);
});

console.log('\n— filters: several values each; they add up; the counts stay readable —');
await check('media Videos OR Photos; with a stage it narrows; older single values and "all" still work', async () => {
  assert.equal((await list(boss, { media: ['video', 'image'] })).total, 5);
  assert.deepEqual(titles(await list(boss, { media: ['video', 'image'], stage: 'approved' })), ['Bridal reel — Anjali']);
  assert.equal((await list(boss, { media: 'video' })).total, 3);
  assert.equal((await list(boss, { stage: 'all', kind: 'all' })).total, 6);
  assert.equal((await list(boss, { tag: 'party' })).total, 1, 'the older ?tag=');
});
await check('each facet is counted with every filter but its own: picking Videos still shows how many Photos there are', async () => {
  const l = await list(boss, { media: 'video' });
  assert.deepEqual(l.facets.media, { video: 3, image: 2, design: 1 });
  assert.deepEqual(l.facets.kinds, { reel: 1, bts: 1, film: 1 }, 'the other facets follow the media picked');
  assert.equal(l.counts.total, 6, 'the KPI strip is the whole library (brand and dates only)');
  assert.equal(l.total, 3);
});
await check('keywords: all of these (default), any of these, and some left out', async () => {
  assert.deepEqual(titles(await list(boss, { kw: ['bridal', 'reel'] })), ['Studio clip']);
  assert.deepEqual(titles(await list(boss, { kw: ['bridal', 'reel'], kwMode: 'any' })).sort(), ['Bridal reel — Anjali', 'Studio clip']);
  assert.deepEqual(titles(await list(boss, { kw: 'bridal', notKw: 'studio' })), ['Bridal reel — Anjali']);
  const all = await list(boss, { kw: 'bridal' });
  assert.deepEqual(all.facets.tags.reel, 1, '"all": the keyword list counts within the results');
  assert.ok(all.facets.keywords.some((k) => k.keyword === 'bridal' && k.count === 2));
  const any = await list(boss, { kw: 'bridal', kwMode: 'any' });
  assert.equal(any.facets.tags.party, 1, '"any": the other keywords stay offered with their counts');
});
await check('no keyword yet: counted and listable, so they can be found and fixed', async () => {
  const l = await list(boss, {});
  assert.equal(l.facets.untagged, 1);
  assert.deepEqual(titles(await list(boss, { untagged: 1 })), ['Logo sheet']);
});
await check('owner: several at once — the named owner, or who added it', async () => {
  assert.deepEqual(titles(await list(boss, { owner: ['Anu Varghese'] })).sort(), ['Christian bride portrait', 'Logo sheet', 'Studio clip']);
  assert.equal((await list(boss, { owner: ['Anu Varghese', 'Boss'] })).total, 6);
  assert.equal((await list(boss, {})).facets.owners['Anu Varghese'], 3);
});
await check('final outputs only; ready to post (approved or final)', async () => {
  assert.deepEqual(titles(await list(boss, { final: 1 })), ['Party makeup look']);
  assert.deepEqual(titles(await list(boss, { usable: 1, sort: 'title' })), ['Bridal reel — Anjali', 'Party makeup look']);
});

console.log('\n— the search box —');
await check('every word must be found; a word reaches the title, keywords, page and portfolio', async () => {
  assert.deepEqual(titles(await list(boss, { q: 'bridal studio' })), ['Studio clip']);
  assert.equal((await list(boss, { q: 'bridal' })).total, 4, 'title, keyword, page (Christian bride portrait) and its shoot (film)');
  assert.deepEqual((await list(boss, { q: 'bridal studio' })).search.terms, ['bridal', 'studio'], 'what was read is said');
});
await check('a word reaches the shoot (location, crew, title) and the person who added it', async () => {
  assert.deepEqual(titles(await list(boss, { q: 'kumarakom' })), ['Untitled export 0042']);
  assert.deepEqual(titles(await list(boss, { q: 'faies' })), ['Untitled export 0042']);
  assert.deepEqual(titles(await list(boss, { q: 'varghese logo' })), ['Logo sheet']);
});
await check('"phrase", -left out, #keyword, -#keyword, plurals, and type words', async () => {
  assert.deepEqual(titles(await list(boss, { q: '"christian bride"' })), ['Christian bride portrait']);
  assert.deepEqual(titles(await list(boss, { q: '"bride christian"' })), [], 'a phrase is the words in that order');
  assert.ok(!titles(await list(boss, { q: 'bridal -studio' })).includes('Studio clip'));
  assert.deepEqual(titles(await list(boss, { q: '#hero' })), ['Bridal reel — Anjali']);
  assert.ok(!titles(await list(boss, { q: 'bridal -#reel' })).includes('Studio clip'));
  assert.deepEqual(titles(await list(boss, { q: 'brides portraits' })), ['Christian bride portrait'], 'plurals find the singular');
  assert.deepEqual(titles(await list(boss, { q: 'designs' })), ['Logo sheet'], 'a type word finds that type');
  assert.equal((await list(boss, { q: 'videos' })).total, 3);
  assert.equal((await list(boss, { q: '.*' })).total, 0, 'a pattern typed is text');
});
await check('Best match: the keyword itself first, then the title; the newest wins a tie', async () => {
  const l = await list(boss, { q: 'bridal reel', sort: 'relevance' });
  // "Bridal reel — Anjali": "bridal" a keyword and in the title, "reel" in the title, both in order (17) · "Studio clip": both keywords
  // but nothing in the title (12)
  assert.deepEqual(titles(l), ['Bridal reel — Anjali', 'Studio clip']);
  assert.equal(l.sort, 'relevance');
  assert.equal((await list(boss, { sort: 'relevance' })).sort, 'newest', 'nothing typed: newest first');
});

console.log('\n— pages —');
await check('pages of a big library: the right total, no asset twice, none skipped, in every sort', async () => {
  const docs = Array.from({ length: 53 }, (_, i) => ({ title: `Bulk still ${String(i).padStart(2, '0')}`, url: `https://d.test/b${i}`, kind: 'still', media: 'image', tags: ['bulk', i % 2 ? 'odd' : 'even'], createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)) }));
  await Asset.insertMany(docs);
  for (const sort of ['newest', 'oldest', 'title', 'relevance']) {
    const seen = [];
    let pages = 0;
    for (let p = 1; p <= 4; p += 1) {
      const l = await list(boss, { kw: 'bulk', q: sort === 'relevance' ? 'bulk' : '', limit: 20, pageNo: p, sort });
      assert.equal(l.total, 53, sort);
      pages = l.pages;
      seen.push(...l.items.map((a) => a.id));
    }
    assert.equal(pages, 3, sort);
    assert.equal(seen.length, 53, `${sort}: every asset once`);
    assert.equal(new Set(seen).size, 53, `${sort}: none twice`);
  }
  const t = await list(boss, { kw: 'bulk', sort: 'title', limit: 3 });
  assert.deepEqual(titles(t), ['Bulk still 00', 'Bulk still 01', 'Bulk still 02']);
  assert.equal((await list(boss, {})).limit, 120, 'older builds get the 120 they always got');
});

console.log('\n— the keyword tools —');
await check('suggestions while typing: the exact keyword first, then those starting with it, then those containing it; counts', async () => {
  const r = await call('GET', '/assets/keywords?q=Bride', anu);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.items.map((k) => k.keyword), ['bride', 'christian bride', 'kerala bride']);
  assert.equal(r.body.canManage, false, 'a member may not rename or remove');
  const top = (await call('GET', '/assets/keywords?limit=2', boss)).body;
  assert.deepEqual(top.items.map((k) => [k.keyword, k.count]), [['bulk', 53], ['even', 27]], 'nothing typed: the most used');
  assert.equal(top.canManage, true);
});
await check('rename and merge (manager only): "bride" into "bridal" — an asset never carries it twice', async () => {
  assert.equal((await call('POST', '/assets/keywords/rename', anu, { from: 'bride', to: 'bridal' })).status, 403);
  await call('PUT', `/assets/${a4.id}`, boss, { tags: ['bride', 'bridal', 'christian bride'] });
  const r = await call('POST', '/assets/keywords/rename', boss, { from: 'bride', to: '#Bridal' });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body, { from: 'bride', to: 'bridal', updated: 1, merged: true });
  assert.deepEqual((await Asset.findById(a4.id).lean()).tags, ['bridal', 'christian bride']);
  assert.equal((await call('POST', '/assets/keywords/rename', boss, { from: 'bride', to: 'x' })).status, 404, 'no asset carries it any more');
  assert.equal((await call('POST', '/assets/keywords/rename', boss, { from: 'glam', to: 'a, b' })).status, 400, 'one new keyword');
  assert.equal((await call('POST', '/assets/keywords/rename', boss, { from: 'glam', to: 'GLAM' })).status, 400, 'the same keyword');
  const plain = await call('POST', '/assets/keywords/rename', boss, { from: 'glam', to: 'Glamour Look' });
  assert.deepEqual([plain.body.to, plain.body.merged], ['glamour look', false]);
});
await check('remove a keyword from the library (manager only)', async () => {
  assert.equal((await call('POST', '/assets/keywords/remove', anu, { keyword: 'odd' })).status, 403);
  const r = await call('POST', '/assets/keywords/remove', boss, { keyword: 'odd' });
  assert.deepEqual(r.body, { keyword: 'odd', updated: 26 });
  assert.equal(await Asset.countDocuments({ tags: 'odd' }), 0);
  assert.equal((await call('POST', '/assets/keywords/remove', boss, { keyword: 'odd' })).status, 404);
});
await check('bulk add/remove on chosen assets (any member): one that would pass the most is left as it was, and said', async () => {
  const full = await Asset.create({ title: 'Full of keywords', url: 'https://d.test/f', tags: Array.from({ length: 50 }, (_, i) => `f${i}`) });
  const ids = [a2.id, a3.id, a6.id, String(full._id), String(new mongoose.Types.ObjectId())];
  const r = await call('POST', '/assets/bulk-keywords', anu, { ids, add: ['#Portfolio 2026', 'studio'], remove: ['party'] });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.updated, 3);
  assert.equal(r.body.missing, 1);
  assert.deepEqual(r.body.skipped.map((s) => s.title), ['Full of keywords']);
  assert.match(r.body.skipped[0].reason, /52 keywords; the most is 50/);
  assert.deepEqual((await Asset.findById(a2.id).lean()).tags, ['bridal', 'reel', 'studio', 'portfolio 2026']);
  assert.deepEqual((await Asset.findById(a3.id).lean()).tags, ['glamour look', 'portfolio 2026', 'studio']);
  const again = (await call('POST', '/assets/bulk-keywords', anu, { ids: [a2.id], add: ['studio'] })).body;
  assert.deepEqual([again.updated, again.unchanged], [0, 1], 'nothing to change is said, not rewritten');
  assert.equal((await call('POST', '/assets/bulk-keywords', anu, { ids: [a2.id] })).status, 400);
  assert.equal((await call('POST', '/assets/bulk-keywords', anu, { ids: [], add: ['x'] })).status, 400);
});
await check('the keyword routes are not mistaken for an asset id', async () => {
  assert.equal((await call('GET', '/assets/keywords', boss)).status, 200);
  assert.equal((await call('GET', `/assets/${a1.id}`, boss)).body.title, 'Bridal reel — Anjali');
});

console.log('\n— approving is a manager\'s call —');
await check('a member cannot create an asset already approved or final, nor flip "final"; a manager can', async () => {
  const appr = await call('POST', '/assets', anu, { title: 'Sneaky approved', url: 'https://d.test/s1', stage: 'approved' });
  assert.equal(appr.status, 403);
  assert.match(appr.body.message, /Only a Marketing Manager/);
  assert.equal((await call('POST', '/assets', anu, { title: 'Sneaky final', url: 'https://d.test/s2', isFinal: true })).status, 403);
  assert.equal((await call('PUT', `/assets/${a2.id}`, anu, { isFinal: true })).status, 403);
  assert.equal((await call('PUT', `/assets/${a2.id}`, anu, { isFinal: false, title: 'Studio clip' })).status, 200, 'sending the value it already has is not a change');
  assert.equal((await call('PUT', `/assets/${a2.id}`, boss, { isFinal: true })).body.isFinal, true);
  assert.equal((await call('GET', '/assets', anu)).body.canManage, false);
  assert.equal((await call('GET', '/assets', boss)).body.canManage, true);
});
await check('a member putting a new file behind an approved asset sends it back for review; a manager\'s change keeps the approval', async () => {
  const r = (await call('PUT', `/assets/${a1.id}`, anu, { url: 'https://www.dropbox.com/s/new/x.mp4' })).body;
  assert.deepEqual([r.stage, r.isFinal, r.approvedAt], ['in_review', false, null]);
  await call('PUT', `/assets/${a1.id}`, boss, { stage: 'approved' });
  const m = (await call('PUT', `/assets/${a1.id}`, boss, { url: 'https://www.dropbox.com/s/newer/x.mp4' })).body;
  assert.equal(m.stage, 'approved');
  const t = (await call('PUT', `/assets/${a1.id}`, anu, { title: 'Bridal reel — Anjali (cut 2)' })).body;
  assert.equal(t.stage, 'approved', 'a new title is not a new file');
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
