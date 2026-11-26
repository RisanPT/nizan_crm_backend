// End-to-end check of the Creative Director ("Also Creative Director" on a login) — against a THROWAWAY local MongoDB (needs a mongod
// on 127.0.0.1:27099; refuses to run against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/creative-director.e2e.mjs
//
// Who may set the flag (management only), who opens the dashboard, what its numbers are, and what the flag unlocks: the creative work
// (shoots, posts, gallery approvals, creative tasks) — never campaigns, Meta, reports, team logs or social accounts.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: every outbound service's key is blanked before the code under test loads the real .env
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET', 'META_APP_SECRET', 'META_ACCESS_TOKEN', 'META_WEBHOOK_VERIFY_TOKEN', 'META_AD_ACCOUNTS', 'META_IG_ACCOUNTS', 'META_CAPI_DATASET_ID', 'META_CAPI_TOKEN', 'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN', 'DROPBOX_ACCESS_TOKEN']) {
  process.env[k] = '';
}
process.env.MARKETING_REPORT_SCHEDULER = 'off';
await mongoose.connect('mongodb://127.0.0.1:27099/creative_director_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Content = await imp('models/ContentItem.js');
const Asset = await imp('models/MarketingAsset.js');
const Shoot = await imp('models/MarketingShoot.js');
const Task = await imp('models/MarketingTask.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
assert.equal(process.env.ORS_API_KEY, '', 'SAFETY: an import reloaded the real .env over the blanked keys');

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
for (const [path, file] of [
  ['/api/auth', 'routes/authRoutes.js'],
  ['/api/creative', 'routes/creativeRoutes.js'],
  ['/api/marketing/socials', 'routes/marketingSocialsRoutes.js'],
  ['/api/marketing/portfolio', 'routes/marketingPortfolioRoutes.js'],
  ['/api/marketing/team', 'routes/marketingTeamRoutes.js'],
  ['/api/marketing/campaign-hub', 'routes/marketingCampaignHubRoutes.js'],
  ['/api/marketing/reports', 'routes/marketingReportsRoutes.js'],
  ['/api/meta', 'routes/metaLeadRoutes.js'],
  ['/api/content', 'routes/contentRoutes.js'],
]) app.use(path, await imp(file));
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
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); }
};

let n = 0;
const mk = async (key, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), email: user.email, name: key, role, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const memberRole = 'marketing_staff';
await Role.updateOne({ key: memberRole }, { $setOnInsert: { key: memberRole, label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });

const admin = await mk('admin', 'admin');
const manager = await mk('mgr', 'manager');
const boss = await mk('boss', 'marketing_admin'); // the Marketing Manager
const staff = await mk('staff', memberRole); // a plain Marketing member
const nihala = await mk('Nihala', 'artist'); // will be made the Creative Director
const artist = await mk('artist', 'artist');
const fleet = await mk('fleet', 'fleet_manager'); // a department head by role
const ceo = await mk('ceo', 'ceo');
const sales = await mk('sales', 'sales');
const fidha = await E.MarketingTeamMember.create({ name: 'Fidha', shortName: 'Fidha', userId: staff.id });
const jibya = await E.MarketingTeamMember.create({ name: 'Jibya', shortName: 'Jibya' });

const today = istDay();
const fullUser = (u, over = {}) => ({
  name: u.name, email: u.email, role: u.role, active: true, inventoryAccess: false, inventoryManage: false, isDepartmentHead: false, artistHead: false,
  countInSalesTotals: true, employeeId: null, zoneId: null, stateId: null, regionId: null, districtId: null, pincodeId: null, ...over,
});

// ── the flag ──────────────────────────────────────────────────────────────────
console.log('\nWho may make someone the Creative Director');
await check('an admin turns it on for an artist; the artist keeps the artist role and sees the flag on /auth/me', async () => {
  const r = await call('PUT', `/auth/users/${nihala.id}`, admin, fullUser(nihala, { creativeDirector: true }));
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.creativeDirector, true);
  const me = await call('GET', '/auth/me', nihala);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.role, 'artist');
  assert.equal(me.body.user.creativeDirector, true);
  const list = await call('GET', '/auth/users', admin);
  assert.equal(list.body.find((u) => u.id === nihala.id || u._id === nihala.id)?.creativeDirector, true, 'the users list carries it for the Settings screen');
});

await check('a save that leaves the flag out keeps it (an older app build)', async () => {
  const r = await call('PUT', `/auth/users/${nihala.id}`, admin, fullUser(nihala));
  assert.equal(r.status, 200, r.text);
  assert.equal((await User.findById(nihala.id)).creativeDirector, true);
});

await check('a department head creating a login cannot give it, and the Marketing Manager cannot either', async () => {
  const r = await call('POST', '/auth/users', fleet, { name: 'drv', email: 'drv@e2e.test', password: 'secret123', role: 'driver', creativeDirector: true });
  assert.equal(r.status, 201, r.text);
  assert.equal((await User.findOne({ email: 'drv@e2e.test' })).creativeDirector, false);
  const m = await call('PUT', `/auth/users/${artist.id}`, boss, fullUser(artist, { creativeDirector: true }));
  assert.ok([200, 403].includes(m.status), m.text);
  assert.equal((await User.findById(artist.id)).creativeDirector, false);
});

await check('a manager can turn it on and off', async () => {
  assert.equal((await call('PUT', `/auth/users/${artist.id}`, manager, fullUser(artist, { creativeDirector: true }))).status, 200);
  assert.equal((await User.findById(artist.id)).creativeDirector, true);
  assert.equal((await call('PUT', `/auth/users/${artist.id}`, manager, fullUser(artist, { creativeDirector: false }))).status, 200);
  assert.equal((await User.findById(artist.id)).creativeDirector, false);
});

// ── seed the creative work ──────────────────────────────────────────────────
const at = (day, hhmm = '00:00') => new Date(Date.parse(`${day}T${hhmm}:00Z`) - 5.5 * 3600 * 1000);
const shootA = await Shoot.create({ title: 'Bridal Campaign 2026', brand: 'main', status: 'pre_production', shootDate: addDays(today, 3), milestones: [{ key: 'brief', doneAt: new Date() }, { key: 'pre_production', date: addDays(today, 1) }, { key: 'production', date: addDays(today, 3) }, { key: 'post_production', date: addDays(today, 5) }, { key: 'distribution', date: addDays(today, 7) }] });
const shootB = await Shoot.create({ title: 'Summer Reel', brand: 'kerala', status: 'in_production', shootDate: today, coverUrl: 'https://img.e2e/cover.jpg' });
await Shoot.create({ title: 'Old film', brand: 'main', status: 'cancelled', shootDate: today });
const reviewAsset = await Asset.create({ title: 'Teaser cut', url: 'https://drive.e2e/teaser', brand: 'main', stage: 'in_review', kind: 'reel', media: 'video', shootId: shootA._id });
await Asset.create({ title: 'Still 1', url: 'https://drive.e2e/still1', brand: 'main', stage: 'approved', kind: 'still', media: 'image', approvedAt: new Date() });
const reviewPost = await Content.create({ title: 'Makeover reel', platform: 'instagram', contentType: 'reel', status: 'in-review', brand: 'main', scheduledDate: at(today, '18:00') });
await Content.create({ title: 'Bride tips', platform: 'instagram', contentType: 'post', status: 'published', brand: 'main', scheduledDate: at(today), publishedDate: at(today, '10:00'), metrics: { reach: 2000, likes: 100, saves: 50, views: 3000 } });
await Content.create({ title: 'New idea', platform: 'youtube', contentType: 'video', status: 'idea', brand: 'main', scheduledDate: at(today, '11:30') });
await Task.create({ title: 'Moodboard for the bridal shoot', assigneeId: jibya._id, status: 'pending', priority: 'high', dueDate: addDays(today, -1), brand: 'main' });

// ── the dashboard ──────────────────────────────────────────────────────────
console.log('\nThe dashboard');
await check('the Creative Director, the Marketing Manager, an admin and the CEO open it; an artist, sales and a plain member do not', async () => {
  for (const who of [nihala, boss, admin, ceo]) assert.equal((await call('GET', '/creative/overview', who)).status, 200, who.name);
  for (const who of [artist, sales, staff]) assert.equal((await call('GET', '/creative/overview', who)).status, 403, who.name);
  assert.equal((await call('GET', '/creative/overview', null)).status, 401);
  assert.equal((await call('GET', '/creative/overview?from=2026-13-01&to=2026-11-01', nihala)).status, 400);
});

await check('its numbers come from the records: projects, approvals, the week\'s calendar, top content, tasks and the workflow', async () => {
  const r = await call('GET', '/creative/overview', nihala);
  const d = r.body;
  assert.equal(d.canManage, true, 'the Creative Director may act');
  assert.equal(d.kpis.activeProjects.value, 2, 'two open shoots (the cancelled one is not counted)');
  assert.equal(d.kpis.published.value, 1);
  assert.equal(d.kpis.reach.value, 2000);
  assert.equal(d.kpis.engagementRate.value, 7.5, '(100+50) ÷ 2000');
  assert.equal(d.kpis.approved.value, 1);
  assert.deepEqual(d.projects.map((p) => p.title).sort(), ['Bridal Campaign 2026', 'Summer Reel']);
  const bridal = d.projects.find((p) => p.title === 'Bridal Campaign 2026');
  assert.equal(bridal.stage, 'Pre-production');
  assert.equal(bridal.progress, 20);
  assert.equal(d.approvals.total, 2);
  assert.deepEqual(d.approvals.items.map((i) => i.type).sort(), ['asset', 'post']);
  assert.equal(d.approvals.items.find((i) => i.type === 'asset').sub, 'Bridal Campaign 2026', 'an asset names its shoot');
  const day = d.calendar.days.find((x) => x.day === today);
  assert.deepEqual(day.items.map((i) => `${i.time} ${i.title}`), ['10:00 Bride tips', '11:30 New idea', '18:00 Makeover reel']);
  assert.equal(d.top[0].title, 'Bride tips');
  assert.equal(d.tasks.total, 1);
  assert.equal(d.tasks.overdue, 1);
  assert.equal(d.tasks.items[0].assignee, 'Jibya');
  const wf = Object.fromEntries(d.workflow.map((s) => [s.key, s.count]));
  assert.equal(d.workflow.length, 11);
  assert.equal(wf.pre_production, 1);
  assert.equal(wf.review, 2);
  assert.equal(wf.concept, 1);
  assert.equal(d.month.contentPublished.value >= 1, true);
});

await check('the brand filter and the CEO\'s read-only view', async () => {
  const k = await call('GET', '/creative/overview?brand=kerala', nihala);
  assert.equal(k.body.kpis.activeProjects.value, 1);
  assert.deepEqual(k.body.projects.map((p) => p.title), ['Summer Reel']);
  assert.equal(k.body.approvals.total, 0);
  const c = await call('GET', '/creative/overview', ceo);
  assert.equal(c.body.canManage, false, 'leadership reads only');
});

// ── what the flag unlocks ────────────────────────────────────────────────────
console.log('\nWhat the Creative Director may do');
await check('opens Socials, the Creative Portfolio and posts — an artist without the flag does not', async () => {
  for (const path of ['/marketing/socials/assets', '/marketing/portfolio/shoots', '/content']) {
    assert.equal((await call('GET', path, nihala)).status, 200, path);
    assert.equal((await call('GET', path, artist)).status, 403, path);
  }
  assert.equal((await call('GET', '/marketing/socials/assets', nihala)).body.canManage, true, 'the gallery shows her the approve buttons');
  assert.equal((await call('GET', '/marketing/socials/assets', staff)).body.canManage, false);
});

await check('approves a gallery asset, which a plain member may not', async () => {
  const no = await call('PUT', `/marketing/socials/assets/${reviewAsset._id}`, staff, { stage: 'approved' });
  assert.equal(no.status, 403);
  const r = await call('PUT', `/marketing/socials/assets/${reviewAsset._id}`, nihala, { stage: 'approved' });
  assert.equal(r.status, 200, r.text);
  const a = await Asset.findById(reviewAsset._id);
  assert.equal(a.stage, 'approved');
  assert.ok(a.approvedAt, 'the approval day is recorded');
  assert.equal(a.title, 'Teaser cut', 'a partial save keeps the rest');
});

await check('approves a post (In review → Scheduled) and sends one back', async () => {
  const r = await call('PUT', `/content/${reviewPost._id}`, nihala, { status: 'scheduled' });
  assert.equal(r.status, 200, r.text);
  assert.equal((await Content.findById(reviewPost._id)).status, 'scheduled');
  assert.equal((await call('PUT', `/content/${reviewPost._id}`, nihala, { status: 'in-progress' })).status, 200);
  assert.equal((await Content.findById(reviewPost._id)).status, 'in-progress');
});

await check('edits and deletes a shoot (delete is a manager\'s call — a plain member may not)', async () => {
  const s = await Shoot.create({ title: 'Throwaway', brand: 'main', status: 'planned', shootDate: today });
  assert.equal((await call('DELETE', `/marketing/portfolio/shoots/${s._id}`, staff)).status, 403);
  assert.equal((await call('DELETE', `/marketing/portfolio/shoots/${s._id}`, nihala)).status, 200);
  assert.equal(await Shoot.countDocuments({ _id: s._id }), 0);
});

await check('assigns, re-assigns and comments on marketing tasks; a plain member may only give tasks to themself', async () => {
  const list = await call('GET', '/marketing/team/tasks', nihala);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.canAssign, true);
  assert.deepEqual(list.body.assignees.map((a) => a.name).sort(), ['Fidha', 'Jibya']);
  const made = await call('POST', '/marketing/team/tasks', nihala, { title: 'Colour grade the teaser', assigneeId: String(fidha._id), dueDate: addDays(today, 2), priority: 'high' });
  assert.equal(made.status, 201, made.text);
  const moved = await call('PUT', `/marketing/team/tasks/${made.body.id}`, nihala, { assigneeId: String(jibya._id) });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await call('POST', `/marketing/team/tasks/${made.body.id}/comments`, nihala, { text: 'Warmer tones please' })).status, 201);
  const own = await call('GET', '/marketing/team/tasks', staff);
  assert.equal(own.body.canAssign, false);
  assert.deepEqual(own.body.assignees, []);
  assert.equal((await call('POST', '/marketing/team/tasks', staff, { title: 'Not mine to give', assigneeId: String(jibya._id) })).status, 403);
});

await check('never campaigns, Meta, reports, team logs, attendance or social accounts', async () => {
  assert.equal((await call('GET', '/marketing/campaign-hub/overview', nihala)).status, 403, 'campaigns hub');
  assert.equal((await call('GET', '/meta/status', nihala)).status, 403, 'Meta');
  assert.equal((await call('GET', '/marketing/reports/schedules', nihala)).status, 403, 'report schedules');
  assert.equal((await call('GET', '/marketing/team/overview', nihala)).status, 403, 'team dashboard');
  assert.equal((await call('GET', '/marketing/team/attendance', nihala)).status, 403, 'attendance');
  assert.equal((await call('POST', '/marketing/socials/accounts', nihala, { platform: 'instagram', handle: 'x' })).status, 403, 'social accounts');
  assert.equal((await call('PUT', '/marketing/socials/targets', nihala, {})).status, 403, 'targets');
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
