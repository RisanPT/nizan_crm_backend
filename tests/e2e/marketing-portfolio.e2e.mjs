// End-to-end check of the Creative Portfolio — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run
// against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-portfolio.e2e.mjs
//
// The document's method: plan a shoot ONCE, then every screen follows — the planner, the production calendar (today's productions,
// load, crew availability), the shoot reports (planned against delivered, turnaround, footage), and the progress that moves when
// members LOG pre-production, production and post-production work against the shoot.
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
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_portfolio_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Shoot = await imp('models/MarketingShoot.js');
const Asset = await imp('models/MarketingAsset.js');
const Activity = await imp('models/MarketingActivity.js');
const Leave = await imp('models/LeaveRequest.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/portfolio', await imp('routes/marketingPortfolioRoutes.js'));
app.use('/api/marketing/socials', await imp('routes/marketingSocialsRoutes.js'));
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js'));
app.use('/api/content', await imp('routes/contentRoutes.js'));
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
const pf = (m, p, w, b) => call(m, `/portfolio${p}`, w, b);

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 10).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
const today = istDay(new Date());
// The lists and the calendar show the current MONTH unless told otherwise — a shoot a few days ahead falls in the next month near the
// end of one, so the counts here are read over a window around today instead (the default month has its own check below).
const WIN = `from=${addDays(today, -5)}&to=${addDays(today, 12)}`;
const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
await E.MarketingCalendarSetting.create({ weeklyOff: (dow + 3) % 7, standardHours: 8, editWindowDays: 2 });
const month = today.slice(0, 7);
let n = 0;
const login = async (key, role) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), emp: String(emp._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('boss', 'marketing_admin');
const outsider = await login('outsider', 'crm');
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const preethi = await login('Preethi', 'marketing_staff');
const ashique = await login('Ashique', 'marketing_staff');
const faris = await login('Faris', 'marketing_staff');

const rVideo = await E.MarketingRole.create({ name: 'Videographer' });
const rEditor = await E.MarketingRole.create({ name: 'Video Editor' });
const member = async (u, role) => {
  const mm = await E.MarketingTeamMember.create({ userId: u.id, name: u.name, shortName: u.name, activeFrom: new Date(`${month}-01T00:00:00Z`) });
  await E.MarketingMemberRole.create({ memberId: mm._id, roleId: role._id, fromMonth: '2026-01' });
  return { ...u, mid: String(mm._id) };
};
const P = await member(preethi, rEditor);
const A = await member(ashique, rVideo);
const F = await member(faris, rVideo);

console.log('\n— plan once —');
let bridal;
await check('a shoot needs a title and a real date; a good plan is stored with its crew, outputs and default milestone dates', async () => {
  assert.equal((await pf('POST', '/shoots', preethi, { shootDate: today })).status, 400, 'no title');
  assert.equal((await pf('POST', '/shoots', preethi, { title: 'Bridal Transformation', shootDate: '2026-02-31' })).status, 400);
  assert.equal((await pf('POST', '/shoots', outsider, { title: 'x y', shootDate: today })).status, 403);
  const r = await pf('POST', '/shoots', preethi, { title: 'Bridal Transformation – Nov', brand: 'main', category: 'Bridal Makeup', pillar: 'Bridal · Transformation', shootDate: today, startTime: '09:00', endTime: '17:00', location: 'Studio 1, Kozhikode', planned: { reels: 2, stills: 3 }, crew: [{ memberId: A.mid }, { memberId: P.mid, role: 'Lead editor' }, { name: 'Freelance makeup artist', role: 'Makeup' }] });
  assert.equal(r.status, 201, r.text);
  bridal = r.body;
  assert.equal(bridal.status, 'planned');
  assert.equal(bridal.plannedTotal, 5);
  assert.equal(bridal.progress, 20, 'the brief is done the moment the plan exists');
  assert.equal(bridal.crewCount, 3);
  const d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.deepEqual(d.milestones.map((m) => [m.key, m.date, !!m.doneAt]), [['brief', addDays(today, -3), true], ['pre_production', addDays(today, -2), false], ['production', today, false], ['post_production', addDays(today, 2), false], ['distribution', addDays(today, 4), false]]);
  assert.deepEqual(d.crew.map((c) => [c.name, c.role]), [['Ashique', 'Videographer'], ['Preethi', 'Lead editor'], ['Freelance makeup artist', 'Makeup']], 'a member keeps their own name and role; a role typed on the plan wins');
  assert.equal(d.currentMilestone, 'pre_production');
});
await check('bad input is refused: end before start, a negative planned output, a script link, an unknown status', async () => {
  const ok = { title: 'Another shoot', shootDate: today };
  for (const body of [{ ...ok, startTime: '10:00', endTime: '09:00' }, { ...ok, planned: { reels: -2 } }, { ...ok, coverUrl: 'javascript:x' }, { ...ok, status: 'done' }, { ...ok, brand: 'mars' }]) assert.equal((await pf('POST', '/shoots', boss, body)).status, 400, JSON.stringify(body));
});

console.log('\n— the planner reads the plan —');
await pf('POST', '/shoots', boss, { title: 'Party Makeup Series', category: 'Party Makeup', shootDate: addDays(today, 2), planned: { reels: 1 } });
await pf('POST', '/shoots', boss, { title: 'Kerala Mehendi', brand: 'kerala', category: 'Bridal Makeup', shootDate: addDays(today, 1), planned: { stills: 4 } });
const cancelled = (await pf('POST', '/shoots', boss, { title: 'Cancelled shoot', shootDate: today })).body;
await pf('PUT', `/shoots/${cancelled.id}`, boss, { status: 'cancelled' });
await check('the KPI strip counts by where each shoot is, cancelled ones nowhere; brand and search narrow the list', async () => {
  const r = (await pf('GET', `/shoots?${WIN}`, preethi)).body;
  assert.equal(r.counts.total, 3);
  assert.equal(r.counts.planned, 3);
  assert.equal(r.counts.inProduction, 0);
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map((s) => s.title), ['Bridal Transformation – Nov', 'Kerala Mehendi', 'Party Makeup Series'], 'soonest first');
  assert.equal((await pf('GET', `/shoots?${WIN}&brand=kerala`, preethi)).body.items.length, 1);
  assert.equal((await pf('GET', `/shoots?${WIN}&q=party`, preethi)).body.items.length, 1);
  assert.equal((await pf('GET', `/shoots?${WIN}&q=bridal`, preethi)).body.items.length, 2, 'search reaches the category');
  assert.equal((await pf('GET', `/shoots?${WIN}&q=` + encodeURIComponent('.*'), preethi)).body.items.length, 0, 'a regex in the search box is text');
  const page = (await pf('GET', `/shoots?${WIN}&limit=2&page=2`, preethi)).body;
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 3);
});

console.log('\n— log once, the shoot moves —');
const log = (who, body) => call('POST', '/team/activities', who, { workedOn: 'Shoot prep', kind: 'shoot', timeSpentMinutes: 60, ...body });
await check('a log of pre-production tied to the shoot moves it into pre-production; completing the stage marks the milestone', async () => {
  const r = await log(preethi, { shootId: bridal.id, shootStage: 'pre_production', status: 'in_progress' });
  assert.equal(r.status, 201, r.text);
  let d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.equal(d.status, 'pre_production');
  assert.equal(d.progress, 20, 'in progress is not done');
  assert.equal(d.activity[0].stage, 'pre_production');
  const done = await log(preethi, { shootId: bridal.id, shootStage: 'pre_production', status: 'completed', workedOn: 'Moodboard approved' });
  d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.equal(d.progress, 40, 'brief + pre-production');
  assert.equal(d.currentMilestone, 'production');
  assert.equal(done.status, 201);
});
await check('a log of production work moves it on; the planner, calendar load and detail all agree', async () => {
  const prod = await log(ashique, { shootId: bridal.id, shootStage: 'production', status: 'in_progress', workedOn: 'On set' });
  assert.equal(prod.status, 201, prod.text);
  assert.equal((await pf('GET', `/shoots/${bridal.id}`, preethi)).body.status, 'in_production');
  const list = (await pf('GET', `/shoots?${WIN}`, preethi)).body;
  assert.equal(list.counts.inProduction, 1);
  assert.equal(list.counts.planned, 2);
  assert.equal(list.items.find((s) => s.id === bridal.id).status, 'in_production');
  const cal = (await pf('GET', `/calendar?${WIN}`, preethi)).body;
  assert.equal(cal.load.rows.find((r) => r.key === 'in_production').count, 1);
  assert.equal(cal.counts.inProduction, 1);
});
await check('deleting the completing log takes the milestone back; moving a log off the shoot takes it out of the shoot', async () => {
  const mine = await Activity.find({ shootId: bridal.id, shootStage: 'pre_production', status: 'completed' }).lean();
  assert.equal(mine.length, 1);
  assert.equal((await call('DELETE', `/team/activities/${mine[0]._id}`, preethi)).status, 200);
  const d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.equal(d.progress, 20, 'back to the brief only');
  assert.equal(d.status, 'in_production', 'the phase never moves backwards on its own');
  // move the production log to another shoot
  const other = (await pf('GET', `/shoots?${WIN}&q=party`, preethi)).body.items[0];
  const prodLog = await Activity.findOne({ shootId: bridal.id, shootStage: 'production' }).lean();
  const moved = await call('PUT', `/team/activities/${prodLog._id}`, ashique, { workedOn: 'On set', kind: 'shoot', entryDate: prodLog.entryDate, timeSpentMinutes: 60, status: 'in_progress', shootId: other.id, shootStage: 'production' });
  assert.equal(moved.status, 200, moved.text);
  assert.equal((await pf('GET', `/shoots/${other.id}`, preethi)).body.status, 'in_production');
  assert.equal((await pf('GET', `/shoots/${bridal.id}`, preethi)).body.activity.length, 1, 'one log is left on the first shoot');
});
await check('a log tied to a shoot that does not exist is refused; the log form lists the open shoots', async () => {
  const r = await log(preethi, { shootId: '64b7f0c2a1b2c3d4e5f60718', shootStage: 'production' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /shoot no longer exists/);
  const setup = (await call('GET', `/team/log-setup?date=${today}`, preethi)).body;
  assert.ok(setup.shoots.some((s) => s.id === bridal.id));
  assert.ok(!setup.shoots.some((s) => s.title === 'Cancelled shoot'), 'a cancelled shoot is not offered');
  const stageless = await log(preethi, { shootStage: 'production', workedOn: 'No shoot' });
  assert.equal(stageless.body.activity.shootStage, null, 'a stage without a shoot is dropped');
});

console.log('\n— assets attach to the shoot and are what the reports count —');
let asset1;
await check('an asset uploaded under the shoot inherits its brand, portfolio, page and tags', async () => {
  const k = (await pf('POST', '/shoots', boss, { title: 'Inherit shoot', brand: 'kerala', category: 'Bridal Makeup', shootDate: today })).body;
  const r = await call('POST', '/socials/assets', preethi, { title: 'Reel final', url: 'https://d.test/r', kind: 'reel', shootId: k.id, tags: ['hero'] });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.brand, 'kerala');
  assert.equal(r.body.portfolio, 'Kerala');
  assert.equal(r.body.page, 'Bridal Makeup');
  assert.deepEqual(r.body.tags.sort(), ['bridal makeup', 'hero']);
  // the app always sends a brand and a portfolio; for an asset of a shoot the SHOOT decides (a Kerala shoot's work is filed under Kerala)
  const own = await call('POST', '/socials/assets', preethi, { title: 'Own', url: 'https://d.test/o', kind: 'still', shootId: k.id, brand: 'main', portfolio: 'Main (Company)', page: 'Custom' });
  assert.equal(own.body.brand, 'kerala', 'the shoot wins over what the form sent');
  assert.equal(own.body.portfolio, 'Kerala');
  assert.equal(own.body.page, 'Custom', 'a page the sender typed is kept');
  // editing it cannot move it off its shoot's brand; attaching a loose asset to the shoot files it under the shoot
  assert.equal((await call('PUT', `/socials/assets/${own.body.id}`, boss, { brand: 'main', portfolio: 'Main (Company)' })).body.brand, 'kerala');
  const loose = (await call('POST', '/socials/assets', preethi, { title: 'Loose still', url: 'https://d.test/l', kind: 'still', brand: 'main', portfolio: 'Main (Company)' })).body;
  assert.equal(loose.brand, 'main');
  const moved = (await call('PUT', `/socials/assets/${loose.id}`, preethi, { shootId: k.id, brand: 'main', portfolio: 'Main (Company)' })).body;
  assert.deepEqual([moved.brand, moved.portfolio, moved.shootId], ['kerala', 'Kerala', k.id]);
  assert.ok(moved.tags.includes('bridal makeup'), 'and carries its tag');
  assert.equal(moved.owner, 'Preethi', 'the owner is the person who added it');
  assert.equal((await call('POST', '/socials/assets', preethi, { title: 'Ghost', url: 'https://d.test/g', shootId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  await Asset.deleteMany({}); await Shoot.deleteOne({ _id: k.id });
});
await check('delivered outputs are approved or final assets by kind; progress of delivery and footage show on the shoot', async () => {
  const mk = async (body) => (await call('POST', '/socials/assets', preethi, { shootId: bridal.id, url: 'https://d.test/x', ...body })).body;
  asset1 = await mk({ title: 'Reel 1', kind: 'reel' });
  await mk({ title: 'Raw day', kind: 'bts', sizeMb: 0 });
  let d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.equal(d.deliveredTotal, 0, 'nothing approved yet');
  assert.ok(d.takeaways.some((t) => t.includes('0 of 5')));
  await call('PUT', `/socials/assets/${asset1.id}`, boss, { stage: 'approved' });
  d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.equal(d.delivered.reels, 1);
  assert.equal(d.deliveredTotal, 1);
  assert.equal(d.assets.length, 2);
  assert.equal(d.turnaround, null, '1 of 5 delivered → no turnaround yet');
  // deliver the rest: a second reel and three stills
  for (const [title, kind] of [['Reel 2', 'reel'], ['Still 1', 'still'], ['Still 2', 'still'], ['Still 3', 'still']]) {
    const a = await mk({ title, kind });
    await call('PUT', `/socials/assets/${a.id}`, boss, { isFinal: true });
  }
  await Asset.updateMany({ shootId: bridal.id, kind: 'reel' }, { sizeMb: 2048 });
  d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.equal(d.deliveredTotal, 5);
  assert.equal(d.takeaways[0], 'All planned outputs have been delivered.');
  assert.equal(d.turnaround, 0, 'delivered the same day (IST)');
  assert.equal(d.footageMb, 4096);
});

console.log('\n— Production Calendar —');
await check('the calendar lists the month\'s shoots, today\'s productions with their milestones, and what is upcoming', async () => {
  const c = (await pf('GET', '/calendar', preethi)).body;
  // the default view is this month: the three live shoots (today, +1, +2 days) that fall in it — all three except near a month's end
  const inMonth = [today, addDays(today, 1), addDays(today, 2)].filter((d) => d.slice(0, 7) === today.slice(0, 7)).length;
  assert.equal(c.counts.total, inMonth);
  assert.equal(c.today.length, 1);
  assert.equal(c.today[0].title, 'Bridal Transformation – Nov');
  assert.equal(c.today[0].milestones.length, 5);
  assert.equal(c.today[0].milestones[0].doneAt !== null, true);
  assert.deepEqual(c.upcoming.map((s) => s.title), ['Kerala Mehendi', 'Party Makeup Series']);
  assert.equal(c.load.total, inMonth);
  assert.equal((await pf('GET', '/calendar?brand=kerala', preethi)).body.upcoming.length, 1);
});
await check('crew availability: people on the day\'s shoot or on leave are not available', async () => {
  await Leave.collection.insertOne({ employeeId: new mongoose.Types.ObjectId(F.emp), fromDate: new Date(`${today}T00:00:00Z`), toDate: new Date(`${today}T00:00:00Z`), status: 'approved', halfDay: 'none', days: 1 });
  const c = (await pf('GET', '/calendar', preethi)).body;
  const video = c.availability.find((r) => r.role === 'Videographer');
  assert.deepEqual(video, { role: 'Videographer', total: 2, booked: 1, onLeave: 1, absent: 0, onWork: 0, available: 0 }, 'Ashique is on the shoot, Faris on leave');
  const editor = c.availability.find((r) => r.role === 'Video Editor');
  assert.deepEqual(editor, { role: 'Video Editor', total: 1, booked: 1, onLeave: 0, absent: 0, onWork: 0, available: 0 });
  const tomorrow = (await pf('GET', `/calendar?day=${addDays(today, 1)}`, preethi)).body.availability.find((r) => r.role === 'Videographer');
  assert.equal(tomorrow.booked, 0, 'the Kerala shoot has no crew');
  assert.deepEqual([tomorrow.total, tomorrow.booked, tomorrow.onLeave, tomorrow.available], [2, 0, 0, 2], 'the leave was today only, and nobody is on tomorrow\'s shoot');
  assert.equal((await pf('GET', '/calendar?day=nope', preethi)).status, 200, 'a bad day falls back to today');
});

console.log('\n— Shoot Reports —');
await check('KPIs, the month bars, the output split and the rows agree with the shoots and assets', async () => {
  await pf('PUT', `/shoots/${bridal.id}`, boss, { status: 'completed' });
  const r = (await pf('GET', `/reports?${WIN}`, preethi)).body;
  assert.equal(r.kpis.shoots, 3);
  assert.equal(r.kpis.completed, 1);
  assert.equal(r.kpis.outputs, 5);
  assert.equal(r.kpis.footageGb, 4);
  assert.equal(r.kpis.turnaround, 0);
  // this month's bar (the bars run to the window's end, which may be next month): the bridal shoot's 5, the party shoot's reel (in
  // 2 days) and the mehendi's 4 stills (tomorrow) — those of them that are still this month
  const sameMonth = (d) => d.slice(0, 7) === today.slice(0, 7);
  const thisMonth = r.monthly.find((m) => m.month === today.slice(0, 7));
  assert.ok(thisMonth, 'a bar for this month');
  assert.equal(thisMonth.delivered, 5);
  assert.equal(thisMonth.planned, 5 + (sameMonth(addDays(today, 2)) ? 1 : 0) + (sameMonth(addDays(today, 1)) ? 4 : 0));
  assert.deepEqual(r.distribution.rows.map((x) => [x.key, x.count]), [['reels', 2], ['stills', 3]]);
  const row = r.rows.find((x) => x.id === bridal.id);
  assert.equal(row.deliveredTotal, 5);
  assert.equal(row.progress, 40 + 20 >= 0 ? row.progress : 0);
  assert.equal(r.filters.completed, 1);
  assert.equal(r.filters.all, 3);
});
await check('the report list filters (completed / in production / delayed), searches and pages', async () => {
  const done = (await pf('GET', `/reports?${WIN}&filter=completed`, preethi)).body;
  assert.deepEqual(done.rows.map((x) => x.title), ['Bridal Transformation – Nov']);
  const open = (await pf('GET', `/reports?${WIN}&filter=in_production`, preethi)).body;
  assert.ok(open.rows.every((x) => ['in_production', 'post_production', 'pre_production'].includes(x.status)));
  // a shoot whose pre-production date has gone by without the work: delayed
  const late = (await pf('POST', '/shoots', boss, { title: 'Late shoot', shootDate: addDays(today, 3), milestones: [{ key: 'pre_production', date: addDays(today, -1) }] })).body;
  const delayed = (await pf('GET', `/reports?${WIN}&filter=delayed`, preethi)).body;
  const mehendi = (await Shoot.findOne({ title: 'Kerala Mehendi' }).lean())._id.toString();
  // Kerala Mehendi is tomorrow, but its pre-production was planned for yesterday and nothing was logged: that is a delay too
  assert.deepEqual(delayed.rows.map((x) => x.id).sort(), [late.id, mehendi].sort());
  assert.equal(delayed.filters.delayed, 2);
  assert.ok(!delayed.rows.some((x) => x.id === bridal.id), 'a completed shoot is never delayed');
  assert.equal((await pf('GET', `/reports?${WIN}&q=party`, preethi)).body.rows.length, 1);
  assert.equal((await pf('GET', `/reports?${WIN}&limit=1&page=2`, preethi)).body.rows.length, 1);
  assert.equal((await pf('GET', '/reports?from=bad', preethi)).status, 400);
});

console.log('\n— changing the plan —');
await check('moving the date counts as a reschedule; completing a shoot marks distribution; the crew keeps member names', async () => {
  const s = (await pf('POST', '/shoots', boss, { title: 'Reschedule me', shootDate: addDays(today, 5) })).body;
  const u = await pf('PUT', `/shoots/${s.id}`, boss, { shootDate: addDays(today, 6), crew: [{ memberId: P.mid }] });
  assert.equal(u.status, 200, u.text);
  assert.equal(u.body.rescheduleCount, 1);
  assert.equal(u.body.crewCount, 1);
  assert.equal((await pf('PUT', `/shoots/${s.id}`, boss, { title: 'Renamed' })).body.rescheduleCount, 1, 'a rename is not a reschedule');
  const done = await pf('PUT', `/shoots/${s.id}`, boss, { status: 'completed' });
  const d = (await pf('GET', `/shoots/${s.id}`, boss)).body;
  assert.equal(done.status, 200);
  assert.equal(d.milestones.find((m) => m.key === 'distribution').doneAt !== null, true);
  const back = await pf('PUT', `/shoots/${s.id}`, boss, { status: 'planned' });
  assert.equal(back.status, 200);
  assert.equal((await pf('GET', `/shoots/${s.id}`, boss)).body.milestones.find((m) => m.key === 'distribution').doneAt, null, 'taking it back reopens distribution');
  // (asked about the shoot's own day: today + 6 is next month near the end of one)
  assert.equal((await pf('GET', `/calendar?from=${addDays(today, 6)}&to=${addDays(today, 6)}`, preethi)).body.counts.rescheduled, 1);
  assert.equal((await pf('PUT', '/shoots/64b7f0c2a1b2c3d4e5f60718', boss, { title: 'x y' })).status, 404);
  assert.equal((await pf('PUT', `/shoots/${s.id}`, boss, { endTime: '08:00', startTime: '09:00' })).status, 400);
});
await check('only a manager deletes; a shoot with assets or logs is cancelled instead; an empty one can go', async () => {
  const empty = (await pf('POST', '/shoots', boss, { title: 'Empty shoot', shootDate: addDays(today, 8) })).body;
  assert.equal((await pf('DELETE', `/shoots/${empty.id}`, preethi)).status, 403);
  assert.equal((await pf('DELETE', `/shoots/${bridal.id}`, boss)).status, 409, 'it has assets and logs');
  assert.equal((await pf('DELETE', `/shoots/${empty.id}`, boss)).status, 200);
  assert.equal((await pf('GET', `/shoots/${empty.id}`, boss)).status, 404);
  assert.equal((await pf('GET', '/shoots/not-an-id', boss)).status, 404);
});
await check('the form\'s setup lists the team with roles and the categories used so far', async () => {
  const s = (await pf('GET', '/setup', preethi)).body;
  assert.deepEqual(s.members.map((m) => [m.name, m.role]).sort(), [['Ashique', 'Videographer'], ['Faris', 'Videographer'], ['Preethi', 'Video Editor']]);
  assert.ok(s.categories.includes('Bridal Makeup'));
  assert.ok(s.shootTypes.includes('Full Shoot'));
});

console.log('\n— the audit fixes —');
const Booking = await imp('models/Booking.js');
const Content = await imp('models/ContentItem.js');
const Attendance = await imp('models/Attendance.js');
const at = (day, hh = 10) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00+05:30`).toISOString();
const post = (who, body, id) => call(id ? 'PUT' : 'POST', `/../content${id ? `/${id}` : ''}`, who, body);
const oid = (v) => new mongoose.Types.ObjectId(String(v));

await check('P1: the storyboard is saved on the shoot in shooting order and read back; a frame without a description is refused', async () => {
  const frames = [{ description: 'Bride walks in', shotType: 'Wide', durationSec: 8, referenceUrl: 'https://d.test/ref1' }, { shotNo: '2A', description: 'Close-up of the eyes', shotType: 'Close-up', durationSec: 4, notes: 'slow motion' }];
  const u = await pf('PUT', `/shoots/${bridal.id}`, preethi, { storyboard: frames });
  assert.equal(u.status, 200, u.text);
  let d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.deepEqual(d.storyboard.map((f) => [f.shotNo, f.description, f.shotType, f.durationSec, f.referenceUrl, f.notes]), [['1', 'Bride walks in', 'Wide', 8, 'https://d.test/ref1', ''], ['2A', 'Close-up of the eyes', 'Close-up', 4, '', 'slow motion']]);
  await pf('PUT', `/shoots/${bridal.id}`, preethi, { storyboard: [frames[1], frames[0]] });
  d = (await pf('GET', `/shoots/${bridal.id}`, preethi)).body;
  assert.deepEqual(d.storyboard.map((f) => f.shotNo), ['2A', '2'], 'reordered; a blank shot no. is its position');
  const refused = await pf('PUT', `/shoots/${bridal.id}`, preethi, { storyboard: [{ description: '' }] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.message, /Frame 1 needs a description/);
  assert.equal((await pf('GET', `/shoots/${bridal.id}`, preethi)).body.storyboard.length, 2, 'a refused save changes nothing');
});

let work;
await check('P2: a shoot is linked to a work (a CRM booking) picked from the bookings, and shows it; a booking that does not exist is refused', async () => {
  work = await Booking.create({ customerName: 'Anjali', phone: '9000000001', address: 'Somewhere 1', service: 'Bridal Makeup', bookingDate: new Date(at(addDays(today, 3))), serviceStart: new Date(at(addDays(today, 3), 6)), serviceEnd: new Date(at(addDays(today, 3), 12)), totalPrice: 20000, selectedDates: [addDays(today, 3)], status: 'confirmed', contentCreationRequired: true });
  await Booking.create({ customerName: 'Anjali Old', service: 'Party', bookingDate: new Date(at(today)), serviceStart: new Date(at(today)), serviceEnd: new Date(at(today, 12)), totalPrice: 1, status: 'cancelled' });
  const options = (await pf('GET', '/booking-options', preethi)).body.items;
  const o = options.find((b) => b.id === String(work._id));
  assert.ok(o, 'works around today are offered');
  assert.deepEqual([o.customerName, o.service, o.eventDate, o.contentRequired], ['Anjali', 'Bridal Makeup', addDays(today, 3), true]);
  assert.equal(o.phone, undefined, 'never the client\'s phone');
  assert.equal(o.address, undefined, 'or address');
  assert.deepEqual((await pf('GET', '/booking-options?q=anjali', preethi)).body.items.map((b) => b.customerName), ['Anjali'], 'a cancelled work is not offered');
  assert.equal((await pf('GET', `/booking-options?q=${work.bookingNumber}`, preethi)).body.items[0].id, String(work._id), 'found by its number');
  const s = await pf('POST', '/shoots', boss, { title: 'Anjali wedding content', shootDate: addDays(today, 3), bookingId: String(work._id), planned: { reels: 1, stills: 2 } });
  assert.equal(s.status, 201, s.text);
  assert.equal(s.body.bookingId, String(work._id));
  const d = (await pf('GET', `/shoots/${s.body.id}`, boss)).body;
  assert.deepEqual([d.booking.customerName, d.booking.bookingNumber, d.booking.eventDate], ['Anjali', work.bookingNumber, addDays(today, 3)]);
  assert.equal((await pf('POST', '/shoots', boss, { title: 'Ghost work', shootDate: today, bookingId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  assert.equal((await pf('PUT', `/shoots/${s.body.id}`, boss, { bookingId: null })).body.bookingId, null, 'unlinked');
  assert.equal((await pf('PUT', `/shoots/${s.body.id}`, boss, { bookingId: String(work._id) })).body.bookingId, String(work._id));
});

await check('P3: published posts linked to a shoot are delivered outputs (once with the asset they came from); turnaround runs to the last approval or post', async () => {
  const s = (await pf('POST', '/shoots', boss, { title: 'Post shoot', shootDate: addDays(today, -6), planned: { reels: 2, stills: 1 } })).body;
  const reel = (await call('POST', '/socials/assets', preethi, { title: 'Reel A', url: 'https://d.test/ra', kind: 'reel', shootId: s.id })).body;
  await call('PUT', `/socials/assets/${reel.id}`, boss, { stage: 'approved' });
  assert.ok((await Asset.findById(reel.id).lean()).approvedAt, 'approval is recorded');
  await Asset.collection.updateOne({ _id: oid(reel.id) }, { $set: { approvedAt: new Date(at(addDays(today, -4))) } }); // approved 2 days after the shoot
  const p1 = await post(boss, { title: 'Reel A out', assetId: reel.id, contentType: 'reel', status: 'published', scheduledDate: at(addDays(today, -3)), publishedDate: at(addDays(today, -3)) });
  assert.equal(p1.status, 201, p1.text);
  let d = (await pf('GET', `/shoots/${s.id}`, boss)).body;
  assert.equal(d.delivered.reels, 1, 'the asset and the post made from it are one reel');
  assert.equal(d.posts.length, 1);
  await post(boss, { title: 'Reel B', shootId: s.id, contentType: 'reel', status: 'published', scheduledDate: at(addDays(today, -1)), publishedDate: at(addDays(today, -1)) });
  const still = (await post(boss, { title: 'Still post', shootId: s.id, contentType: 'post', status: 'scheduled', scheduledDate: at(addDays(today, 1)) })).body;
  d = (await pf('GET', `/shoots/${s.id}`, boss)).body;
  assert.equal(d.deliveredTotal, 2, 'a scheduled post is not delivered yet');
  assert.equal(d.turnaround, null, '2 of 3: no turnaround yet');
  await post(boss, { status: 'published', publishedDate: at(today) }, still._id);
  d = (await pf('GET', `/shoots/${s.id}`, boss)).body;
  assert.equal(d.deliveredTotal, 3);
  assert.deepEqual([d.deliveredPosts.reels, d.deliveredPosts.stills], [1, 1], 'Reel B and the still came as posts');
  assert.equal(d.turnaround, 6, 'shoot → the still went out today');
  assert.deepEqual(d.checklist.map((r) => [r.key, r.planned, r.delivered, r.posted, r.done]), [['reels', 2, 2, 2, true], ['stills', 1, 1, 1, true]]);
  const r = (await pf('GET', `/reports?from=${addDays(today, -10)}&to=${today}&q=post%20shoot`, boss)).body;
  assert.equal(r.rows[0].deliveredTotal, 3, 'the report row agrees');
  assert.equal(r.rows[0].turnaround, 6);
});

await check('P4: the Shoot Reports export reads every row (?all=1), not one page', async () => {
  const q = `from=${addDays(today, -40)}&to=${addDays(today, 40)}`;
  const page = (await pf('GET', `/reports?${q}&limit=2`, boss)).body;
  const all = (await pf('GET', `/reports?${q}&all=1`, boss)).body;
  assert.equal(page.rows.length, 2);
  assert.ok(all.total > 2, `${all.total}`);
  assert.equal(all.rows.length, all.total);
});

await check('P5: the gallery can be cut by a tag, and lists its tags', async () => {
  const k = (await pf('POST', '/shoots', boss, { title: 'Tag shoot', brand: 'kerala', category: 'Mehendi', shootDate: today })).body;
  await call('POST', '/socials/assets', preethi, { title: 'Mehendi still', url: 'https://d.test/m', kind: 'still', shootId: k.id, brand: 'main', portfolio: 'Main (Company)' });
  const l = (await call('GET', '/socials/assets?tag=mehendi', preethi)).body;
  assert.deepEqual(l.items.map((a) => [a.title, a.brand, a.portfolio]), [['Mehendi still', 'kerala', 'Kerala']]);
  assert.equal(l.facets.tags.mehendi, 1);
});

await check('P6: crew availability reads attendance and counts the makeup artists — on a client work that day, on a shoot, on leave', async () => {
  const day = addDays(today, 10);
  const mua = (name, extra = {}) => Employee.create({ name, department: 'Operations', artistRole: 'artist', ...extra });
  const [anu, bina, chitra] = [await mua('Anu'), await mua('Bina'), await mua('Chitra')];
  await mua('Devi');
  await mua('Asha Assistant', { artistRole: 'assistant' });
  await mua('Outside associate', { isAssociate: true });
  await mua('Gone', { status: 'inactive' });
  await Employee.create({ name: 'A driver', department: 'Operations', artistRole: 'driver' });
  // Anu works a client booking that day (on one of its packages), Bina is on the shoot's crew, Chitra is on leave, Devi is free
  await Booking.create({ customerName: 'Client', service: 'Bridal', bookingDate: new Date(at(day)), serviceStart: new Date(at(day)), serviceEnd: new Date(at(day, 14)), totalPrice: 1, selectedDates: [day], status: 'confirmed', bookingItems: [{ service: 'Bridal', selectedDates: [day], assignedStaff: [{ employeeId: anu._id, artistName: 'Anu', roleType: 'lead' }] }] });
  const sh = await pf('POST', '/shoots', boss, { title: 'Artist day', shootDate: day, crew: [{ employeeId: String(bina._id) }, { memberId: A.mid }] });
  assert.equal(sh.status, 201, sh.text);
  const crew = (await pf('GET', `/shoots/${sh.body.id}`, boss)).body.crew;
  assert.deepEqual(crew.map((c) => [c.name, c.role, c.employeeId]), [['Bina', 'Makeup Artist', String(bina._id)], ['Ashique', 'Videographer', null]], 'an artist on the crew keeps her own name');
  await Leave.collection.insertOne({ employeeId: chitra._id, fromDate: new Date(`${day}T00:00:00Z`), toDate: new Date(`${day}T00:00:00Z`), status: 'approved', halfDay: 'none', days: 1 });
  await Attendance.create({ employeeId: oid(F.emp), date: new Date(`${day}T04:00:00Z`), status: 'Absent' });
  const c = (await pf('GET', `/calendar?day=${day}`, preethi)).body;
  assert.deepEqual(c.availability.find((r) => r.role === 'Makeup Artist'), { role: 'Makeup Artist', total: 4, booked: 1, onLeave: 1, absent: 0, onWork: 1, available: 1 });
  assert.deepEqual(c.availability.find((r) => r.role === 'Makeup Assistant'), { role: 'Makeup Assistant', total: 1, booked: 0, onLeave: 0, absent: 0, onWork: 0, available: 1 });
  assert.deepEqual(c.availability.find((r) => r.role === 'Videographer'), { role: 'Videographer', total: 2, booked: 1, onLeave: 0, absent: 1, onWork: 0, available: 0 }, 'Ashique on the shoot, Faris marked absent');
  assert.deepEqual((await pf('GET', '/setup', preethi)).body.artists.map((a) => a.name), ['Anu', 'Asha Assistant', 'Bina', 'Chitra', 'Devi'], 'the crew picker offers the artists — not associates, leavers, drivers or Marketing staff');
});

await check('P7: a booking\'s content — its shoots with planned outputs against what was delivered and posted', async () => {
  const shoot = await Shoot.findOne({ bookingId: work._id }).lean();
  const reel = (await call('POST', '/socials/assets', preethi, { title: 'Anjali reel', url: 'https://d.test/ar', kind: 'reel', shootId: String(shoot._id) })).body;
  await call('PUT', `/socials/assets/${reel.id}`, boss, { stage: 'approved' });
  await post(boss, { title: 'Anjali reel out', assetId: reel.id, contentType: 'reel', status: 'published', scheduledDate: at(today), publishedDate: at(today) });
  const c = (await pf('GET', `/bookings/${work._id}/content`, preethi)).body;
  assert.equal(c.booking.customerName, 'Anjali');
  assert.equal(c.booking.contentRequired, true);
  assert.equal(c.shoots.length, 1);
  assert.equal(c.shoots[0].title, 'Anjali wedding content');
  assert.deepEqual(c.shoots[0].checklist, [
    { key: 'reels', label: 'Reels', planned: 1, delivered: 1, posted: 1, done: true },
    { key: 'stills', label: 'Stills / Photos', planned: 2, delivered: 0, posted: 0, done: false },
  ]);
  assert.deepEqual(c.shoots[0].posts.map((p) => [p.title, p.status]), [['Anjali reel out', 'published']]);
  const bare = await Booking.create({ customerName: 'No shoot', service: 'Party', bookingDate: new Date(at(today)), serviceStart: new Date(at(today)), serviceEnd: new Date(at(today, 12)), totalPrice: 1 });
  assert.deepEqual((await pf('GET', `/bookings/${bare._id}/content`, preethi)).body.shoots, []);
  assert.equal((await pf('GET', '/bookings/64b7f0c2a1b2c3d4e5f60718/content', preethi)).status, 404);
  assert.equal((await pf('GET', `/bookings/${work._id}/content`, outsider)).status, 403);
});

await check('P8: the work logged against a shoot — a member sees only their own entries, a manager everyone\'s', async () => {
  const s = (await pf('POST', '/shoots', boss, { title: 'Feed shoot', shootDate: today })).body;
  assert.equal((await log(preethi, { shootId: s.id, shootStage: 'pre_production', status: 'in_progress', workedOn: 'Preethi prep' })).status, 201);
  assert.equal((await log(ashique, { shootId: s.id, shootStage: 'production', status: 'in_progress', workedOn: 'Ashique on set' })).status, 201);
  const mine = (await pf('GET', `/shoots/${s.id}`, preethi)).body;
  assert.equal(mine.activityScope, 'own');
  assert.deepEqual(mine.activity.map((l) => l.workedOn), ['Preethi prep']);
  const all = (await pf('GET', `/shoots/${s.id}`, boss)).body;
  assert.equal(all.activityScope, 'team');
  assert.deepEqual(all.activity.map((l) => l.workedOn).sort(), ['Ashique on set', 'Preethi prep']);
  assert.equal(all.status, 'in_production', 'the shoot still moves on everyone\'s logs');
});

console.log('\n— access —');
await check('someone outside Marketing is refused everywhere; no login is refused', async () => {
  for (const path of ['/shoots', '/calendar', '/reports', '/setup', `/shoots/${bridal.id}`]) assert.equal((await pf('GET', path, outsider)).status, 403, path);
  assert.equal((await call('GET', '/portfolio/shoots')).status, 401);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
