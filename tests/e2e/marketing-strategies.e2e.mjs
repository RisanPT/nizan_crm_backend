// End-to-end check of Strategies & Developments — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run
// against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-strategies.e2e.mjs
//
// The document's method: tie tasks and logs to an initiative / development project ONCE, and every screen follows — its progress (the mean of
// its tasks), owner and due day (from the tasks when not typed), status (due date against progress), hours; the Overview's KPIs, focus
// areas, roadmap, performance bars and recent updates; plans, the roadmap members tick off, research findings members add, and reviews whose
// score is counted from their outcomes. Plus access (outsider 403, no login 401, member vs manager) and bad input.
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
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_strategies_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Activity = await imp('models/MarketingActivity.js');
const Task = await imp('models/MarketingTask.js');
const Initiative = await imp('models/StrategicInitiative.js');
const Project = await imp('models/DevProject.js');
const Plan = await imp('models/StrategicPlan.js');
const Roadmap = await imp('models/RoadmapItem.js');
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
app.use('/api/marketing/strategies', await imp('routes/marketingStrategiesRoutes.js'));
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
const st = (m, p, w, b) => call(m, `/strategies${p}`, w, b);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
const today = istDay(new Date());
const thisYear = Number(today.slice(0, 4));
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
const ghost = await login('Ghost', 'marketing_staff'); // has the Marketing permission but is not on the team list
const rEditor = await E.MarketingRole.create({ name: 'Video Editor' });
const member = async (u) => {
  const mm = await E.MarketingTeamMember.create({ userId: u.id, name: u.name, shortName: u.name, activeFrom: new Date(`${month}-01T00:00:00Z`) });
  await E.MarketingMemberRole.create({ memberId: mm._id, roleId: rEditor._id, fromMonth: '2026-01' });
  return { ...u, mid: String(mm._id) };
};
const P = await member(preethi);
const A = await member(ashique);
const rng = `from=${addDays(today, -90)}&to=${addDays(today, 90)}`;
const y = `year=${thisYear}`;

console.log('\n— access —');
await check('someone outside Marketing is refused everywhere; no login is refused', async () => {
  for (const path of ['/setup', '/overview', '/plans', '/projects', '/initiatives', '/roadmap', '/research', '/reviews']) assert.equal((await st('GET', path, outsider)).status, 403, path);
  assert.equal((await st('POST', '/plans', outsider, { title: 'x y', focusArea: 'a', year: thisYear })).status, 403);
  assert.equal((await call('GET', '/strategies/overview')).status, 401);
});
await check('the form setup: who can manage, who I am, the team, and what exists so far (nothing yet)', async () => {
  const b = (await st('GET', '/setup', boss)).body;
  assert.equal(b.canManage, true);
  assert.equal(b.me, null, 'the boss is not on the team list');
  assert.deepEqual(b.members.map((m) => m.name).sort(), ['Ashique', 'Preethi']);
  assert.deepEqual([b.plans, b.initiatives, b.focusAreas, b.categories], [[], [], [], []]);
  const m = (await st('GET', '/setup', preethi)).body;
  assert.equal(m.canManage, false);
  assert.deepEqual(m.me, { id: P.mid, name: 'Preethi' });
});

console.log('\n— strategic plans —');
let plan1;
let plan2;
let plan3;
await check('only a manager makes a plan; it needs a title, a focus area and a year; goals are a short list', async () => {
  assert.equal((await st('POST', '/plans', preethi, { title: 'Brand plan', focusArea: 'Brand', year: thisYear })).status, 403);
  for (const body of [{ focusArea: 'Brand' }, { title: 'Brand plan' }, { title: 'Brand plan', focusArea: 'Brand', year: 1800 }, { title: 'Brand plan', focusArea: 'Brand', status: 'cancelled' }, { title: 'Brand plan', focusArea: 'Brand', brand: 'mars' }, { title: 'Brand plan', focusArea: 'Brand', goals: 'x' }, { title: 'Brand plan', focusArea: 'Brand', ownerId: 'nope' }, { title: 'Brand plan', focusArea: 'Brand', ownerId: '64b7f0c2a1b2c3d4e5f60718' }]) {
    assert.equal((await st('POST', '/plans', boss, body)).status, 400, JSON.stringify(body));
  }
  const r = await st('POST', '/plans', boss, { title: 'Brand & Market Positioning', focusArea: 'Brand & Market Positioning', year: thisYear, goals: ['Increase qualified leads by 40%', 'Improve brand engagement by 50%'], ownerId: A.mid });
  assert.equal(r.status, 201, r.text);
  plan1 = r.body;
  assert.equal(plan1.status, 'active');
  assert.equal(plan1.owner.name, 'Ashique');
  assert.deepEqual(plan1.goals.length, 2);
  plan2 = (await st('POST', '/plans', boss, { title: 'Revenue & Lead Growth', focusArea: 'Revenue & Lead Growth', status: 'in_progress', goals: ['Launch 2 new service verticals'] })).body;
  plan3 = (await st('POST', '/plans', boss, { title: 'Team build', focusArea: 'Team & Capability', status: 'on_hold', goals: ['Hidden: on hold'] })).body;
  await st('POST', '/plans', boss, { title: 'Ops automation', focusArea: 'Operations', status: 'completed', goals: ['Hidden: done'] });
  await st('POST', '/plans', boss, { title: 'An old plan', focusArea: 'Brand & Market Positioning', year: thisYear - 3 });
  await st('POST', '/plans', boss, { title: 'Kerala brand plan', focusArea: 'Brand & Market Positioning', brand: 'kerala' });
});
await check('Strategic Plans: KPI counts, the live plans per focus area, the status donut, the key goals; the year decides what is in range; brand filters', async () => {
  const r = (await st('GET', `/plans?${rng}`, preethi)).body;
  assert.deepEqual(r.counts, { total: 5, active: 3, inProgress: 1, onHold: 1, completed: 1 }, 'the old plan (3 years back) is out of range; the Kerala plan is in');
  assert.deepEqual(r.focusAreas.rows, [{ focusArea: 'Brand & Market Positioning', count: 2 }, { focusArea: 'Revenue & Lead Growth', count: 1 }]);
  assert.equal(r.focusAreas.total, 3, 'equals Active Strategies');
  assert.deepEqual(r.progress.slices.map((s) => [s.key, s.count]), [['active', 2], ['in_progress', 1], ['on_hold', 1], ['completed', 1]]);
  assert.equal(r.progress.total, 5);
  assert.deepEqual(r.goals.map((g) => g.text), ['Launch 2 new service verticals', 'Increase qualified leads by 40%', 'Improve brand engagement by 50%'], 'the live plans\' goals, newest plan first');
  assert.equal(r.items.length, 5);
  const main = (await st('GET', `/plans?${rng}&brand=main`, preethi)).body;
  assert.equal(main.counts.total, 4);
  assert.equal((await st('GET', `/plans?${rng}&brand=kerala`, preethi)).body.counts.total, 1);
  const old = (await st('GET', `/plans?from=${thisYear - 3}-01-01&to=${thisYear - 3}-12-31`, preethi)).body;
  assert.deepEqual(old.items.map((p) => p.title), ['An old plan']);
  assert.equal((await st('GET', '/plans?from=bad', preethi)).status, 400);
  assert.equal((await st('GET', '/plans?brand=mars', preethi)).status, 400);
});
await check('a manager changes a plan\'s status; a member cannot; an unknown plan is 404', async () => {
  assert.equal((await st('PUT', `/plans/${plan3.id}`, preethi, { status: 'active' })).status, 403);
  const r = await st('PUT', `/plans/${plan3.id}`, boss, { status: 'active', title: 'Team & Capability Build' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'active');
  assert.equal((await st('GET', `/plans?${rng}`, preethi)).body.counts.active, 4);
  await st('PUT', `/plans/${plan3.id}`, boss, { status: 'on_hold' });
  assert.equal((await st('PUT', '/plans/64b7f0c2a1b2c3d4e5f60718', boss, { status: 'active' })).status, 404);
  assert.equal((await st('PUT', '/plans/not-an-id', boss, { status: 'active' })).status, 404);
  assert.equal((await st('PUT', `/plans/${plan3.id}`, boss, { status: 'finished' })).status, 400);
});

console.log('\n— initiatives: progress, owner, due day and status come from the work —');
const iso = (d) => addDays(today, d);
let init1;
let init2;
await check('a member makes an initiative (they own it); with no tasks and nothing typed there is NO progress, only "in progress"', async () => {
  assert.equal((await st('POST', '/initiatives', ghost, { title: 'Ghost initiative' })).status, 403, 'not on the team');
  assert.equal((await st('POST', '/initiatives', preethi, { title: 'x' })).status, 400);
  assert.equal((await st('POST', '/initiatives', preethi, { title: 'Needs a manager', status: 'on_hold' })).status, 403);
  assert.equal((await st('POST', '/initiatives', preethi, { title: 'Not mine to give', ownerId: A.mid })).status, 403);
  assert.equal((await st('POST', '/initiatives', preethi, { title: 'Bad dates', startDate: iso(5), dueDate: iso(1) })).status, 400);
  assert.equal((await st('POST', '/initiatives', preethi, { title: 'Ghost plan', planId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  const r = await st('POST', '/initiatives', preethi, { title: 'Launch Bridal Campaign v2', focusArea: 'Revenue & Lead Growth', impact: 'high', startDate: iso(-10), dueDate: iso(10), planId: plan2.id });
  assert.equal(r.status, 201, r.text);
  init1 = r.body;
  assert.equal(init1.owner.name, 'Preethi');
  assert.equal(init1.owner.source, 'set');
  assert.equal(init1.progressSource, 'none');
  assert.equal(init1.status, 'in_progress');
  assert.equal(init1.plan.title, 'Revenue & Lead Growth');
  assert.equal(init1.storedStatus, 'active');
});
await check('a progress typed by the owner counts only while no task is tied; it is labelled and judged against the clock', async () => {
  const r = await st('PUT', `/initiatives/${init1.id}`, preethi, { progress: 30 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.progress, 30);
  assert.equal(r.body.progressSource, 'owner');
  assert.equal(r.body.status, 'at_risk', '10 of 20 days gone (50%) with 30% done: 20 points behind');
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { progress: 60 })).body.status, 'on_track');
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { progress: 101 })).status, 400);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { progress: 35 })).body.status, 'on_track', 'exactly 15 behind is within the margin');
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { progress: 34 })).body.status, 'at_risk', '16 behind');
  await st('PUT', `/initiatives/${init1.id}`, preethi, { progress: 30 });
});
const task = (who, body) => call('POST', '/team/tasks', who, { priority: 'medium', ...body });
await check('tasks tied to the initiative decide: the typed figure is ignored, the mean of the tasks shows, and the status follows', async () => {
  const t1 = await task(boss, { title: 'Brief the creatives', assigneeId: P.mid, initiativeId: init1.id, status: 'in_progress', progress: 100 });
  assert.equal(t1.status, 201, t1.text);
  assert.equal(t1.body.status, 'completed', '100% completes a task');
  const t2 = await task(boss, { title: 'Shoot hero reel', assigneeId: P.mid, initiativeId: init1.id, status: 'in_progress', progress: 50, dueDate: iso(8) });
  assert.equal(t2.status, 201);
  const d = (await st('GET', `/initiatives/${init1.id}`, preethi)).body;
  assert.equal(d.progress, 75, '(100 + 50) / 2');
  assert.equal(d.progressSource, 'tasks');
  assert.equal(d.taskCount, 2);
  assert.equal(d.doneCount, 1);
  assert.equal(d.status, 'on_track');
  assert.equal(d.typedProgress, 30, 'the typed figure is kept, but unused');
  assert.deepEqual(d.tasks.map((t) => [t.title, t.progress, t.status]), [['Shoot hero reel', 50, 'in_progress'], ['Brief the creatives', 100, 'completed']], 'open tasks first');
  assert.equal(d.tasks[0].assignee, 'Preethi');
  // every status counts: a blocked task at 0 drags the mean
  const t3 = await task(boss, { title: 'Approve budget', assigneeId: P.mid, initiativeId: init1.id, status: 'blocked', progress: 0 });
  assert.equal((await st('GET', `/initiatives/${init1.id}`, preethi)).body.progress, 50, '(100 + 50 + 0) / 3');
  assert.equal((await call('DELETE', `/team/tasks/${t3.body.id}`, boss)).status, 200);
  assert.equal((await st('GET', `/initiatives/${init1.id}`, preethi)).body.progress, 75, 'deleting the task follows');
});
await check('a log tied to the initiative (Log Activity) adds its hours; a log tied to nothing does not', async () => {
  const log = (who, body) => call('POST', '/team/activities', who, { workedOn: 'Campaign planning', kind: 'strategy', timeSpentMinutes: 90, status: 'completed', ...body });
  assert.equal((await log(preethi, { initiativeId: init1.id })).status, 201);
  assert.equal((await log(ashique, { initiativeId: init1.id, timeSpentMinutes: 30, workedOn: 'Creative review' })).status, 201);
  assert.equal((await log(preethi, { timeSpentMinutes: 200 })).status, 201, 'not tied to anything');
  const d = (await st('GET', `/initiatives/${init1.id}`, preethi)).body;
  assert.equal(d.minutes, 120);
  assert.deepEqual(d.logs.map((l) => [l.member, l.minutes]).sort(), [['Ashique', 30], ['Preethi', 90]]);
  assert.equal((await log(preethi, { initiativeId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400, 'an initiative that does not exist');
});
await check('a manager\'s initiative with no owner and no due day takes both from its tasks (the person holding most, the latest due day)', async () => {
  const r = await st('POST', '/initiatives', boss, { title: 'CRM & Lead Automation', focusArea: 'Operations & Automation', brand: 'main', ownerId: null, startDate: iso(-5) });
  assert.equal(r.status, 201, r.text);
  init2 = r.body;
  assert.equal(init2.owner, null, 'the boss is not on the team, so nobody owns it yet');
  await task(boss, { title: 'Map the funnel', assigneeId: A.mid, initiativeId: init2.id, progress: 10, status: 'in_progress', dueDate: iso(12) });
  await task(boss, { title: 'Pick the tool', assigneeId: A.mid, initiativeId: init2.id, progress: 10, status: 'in_progress', dueDate: iso(25) });
  await task(boss, { title: 'Brief the vendor', assigneeId: P.mid, initiativeId: init2.id, progress: 10, status: 'in_progress', dueDate: iso(3) });
  const d = (await st('GET', `/initiatives/${init2.id}`, boss)).body;
  assert.deepEqual([d.owner.name, d.owner.source], ['Ashique', 'tasks']);
  assert.deepEqual([d.due, d.dueSource], [iso(25), 'tasks']);
  assert.equal(d.progress, 10);
  assert.equal(d.status, 'on_track', '5 of 30 days gone (17%), 10% done: 7 points behind');
});
await check('overdue is at risk; completing every task completes the initiative; on hold and completed are the manager\'s words', async () => {
  const late = (await st('POST', '/initiatives', boss, { title: 'Kerala Expansion', focusArea: 'Revenue & Lead Growth', brand: 'kerala', startDate: iso(-30), dueDate: iso(-3), progress: 90 })).body;
  assert.equal(late.status, 'at_risk', 'overdue, whatever the progress');
  const hold = (await st('POST', '/initiatives', boss, { title: 'Paused idea', status: 'on_hold', startDate: iso(-30), dueDate: iso(-1) })).body;
  assert.equal(hold.status, 'on_hold', 'on hold beats overdue');
  const done = (await st('POST', '/initiatives', boss, { title: 'Finished by hand', status: 'completed' })).body;
  assert.equal(done.status, 'completed');
  assert.ok(done.closedDay, 'closed today');
  const all = (await st('POST', '/initiatives', boss, { title: 'All tasks done', startDate: iso(-30), dueDate: iso(-1) })).body;
  const t = (await task(boss, { title: 'Only task', assigneeId: A.mid, initiativeId: all.id, status: 'in_progress', progress: 20 })).body;
  assert.equal((await st('GET', `/initiatives/${all.id}`, boss)).body.status, 'at_risk');
  await call('PUT', `/team/tasks/${t.id}`, boss, { status: 'completed' });
  const after = (await st('GET', `/initiatives/${all.id}`, boss)).body;
  assert.equal(after.status, 'completed', 'every linked task is done');
  assert.equal(after.progress, 100);
  assert.equal(after.closedDay, today);
  await call('PUT', `/team/tasks/${t.id}`, boss, { status: 'in_progress', progress: 40 });
  assert.equal((await st('GET', `/initiatives/${all.id}`, boss)).body.status, 'at_risk', 'reopening the task reopens the initiative');
});

console.log('\n— who may change an initiative —');
await check('the owner updates their own initiative; a member cannot touch another\'s, set a status or hand it over; a manager can do all', async () => {
  assert.equal((await st('PUT', `/initiatives/${init2.id}`, preethi, { notes: 'mine?' })).status, 403, 'init2 has no owner and was not made by Preethi');
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, ashique, { notes: 'not mine' })).status, 403);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { notes: 'on it', impact: 'low' })).status, 200);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { status: 'completed' })).status, 403);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { status: 'active' })).status, 200, 'the status it already has is not a change');
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { ownerId: A.mid })).status, 403);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, ghost, { notes: 'x' })).status, 403, 'not on the team');
  const m = await st('PUT', `/initiatives/${init1.id}`, boss, { ownerId: A.mid, status: 'on_hold' });
  assert.equal(m.status, 200);
  assert.deepEqual([m.body.owner.name, m.body.status], ['Ashique', 'on_hold']);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, preethi, { notes: 'lost it' })).status, 403, 'no longer hers');
  const back = await st('PUT', `/initiatives/${init1.id}`, boss, { ownerId: P.mid, status: 'active' });
  assert.equal(back.body.status, 'on_track');
  assert.equal((await st('PUT', '/initiatives/64b7f0c2a1b2c3d4e5f60718', boss, { notes: 'x' })).status, 404);
});

console.log('\n— development projects —');
let proj1;
await check('only a manager makes a project; progress, owner, due day and status come from its tasks like an initiative\'s', async () => {
  assert.equal((await st('POST', '/projects', preethi, { name: 'Website v2' })).status, 403);
  assert.equal((await st('POST', '/projects', boss, { name: 'x' })).status, 400);
  assert.equal((await st('POST', '/projects', boss, { name: 'Website v2', startDate: iso(5), endDate: iso(1) })).status, 400);
  assert.equal((await st('POST', '/projects', boss, { name: 'Website v2', status: 'active' })).status, 400, 'active is an initiative status');
  const r = await st('POST', '/projects', boss, { name: 'Website v2', category: 'Technology', startDate: iso(-20), endDate: iso(20), ownerId: A.mid, description: 'Brand site & portfolio upgrade' });
  assert.equal(r.status, 201, r.text);
  proj1 = r.body;
  assert.equal(proj1.progressSource, 'none');
  assert.equal(proj1.status, 'in_progress');
  await task(boss, { title: 'Design', assigneeId: A.mid, devProjectId: proj1.id, status: 'completed' });
  await task(boss, { title: 'Build', assigneeId: P.mid, devProjectId: proj1.id, status: 'in_progress', progress: 60 });
  await task(boss, { title: 'Launch', assigneeId: P.mid, devProjectId: proj1.id, status: 'not_started' });
  const d = (await st('GET', `/projects/${proj1.id}`, preethi)).body;
  assert.equal(d.progress, 53, '(100 + 60 + 0) / 3');
  assert.equal(d.status, 'on_track', '50% of the time gone, 53% done');
  assert.deepEqual(d.tasks.map((t) => t.title).sort(), ['Build', 'Design', 'Launch']);
  assert.equal(d.owner.name, 'Ashique');
  assert.equal(d.due, iso(20));
  assert.equal(d.dueSource, 'set');
  assert.equal(d.category, 'Technology');
  assert.equal(d.description, 'Brand site & portfolio upgrade');
});
await check('a project has its owner update it, not other members; delete is the manager\'s and refused while tasks are tied to it', async () => {
  assert.equal((await st('PUT', `/projects/${proj1.id}`, ashique, { notes: 'v2 notes' })).status, 200, 'the owner');
  assert.equal((await st('PUT', `/projects/${proj1.id}`, preethi, { notes: 'x' })).status, 403);
  assert.equal((await st('PUT', `/projects/${proj1.id}`, ashique, { status: 'on_hold' })).status, 403);
  assert.equal((await st('DELETE', `/projects/${proj1.id}`, preethi)).status, 403);
  const del = await st('DELETE', `/projects/${proj1.id}`, boss);
  assert.equal(del.status, 409);
  assert.match(del.body.message, /3 tasks/);
  const spare = (await st('POST', '/projects', boss, { name: 'Spare project' })).body;
  assert.equal((await st('DELETE', `/projects/${spare.id}`, boss)).status, 200);
  assert.equal((await st('GET', `/projects/${spare.id}`, boss)).status, 404);
  assert.equal((await st('GET', '/projects/not-an-id', boss)).status, 404);
});

console.log('\n— the lists: Initiatives and Development Projects —');
await check('Initiatives: KPIs count the range; the table filters by status, focus area and search, pages, and sorts open work by due day', async () => {
  const r = (await st('GET', `/initiatives?${rng}`, preethi)).body;
  // init1 on_track (75%), init2 on_track, Kerala Expansion at_risk, Paused idea on_hold, Finished by hand completed, All tasks done at_risk (reopened)
  assert.deepEqual(r.counts, { total: 6, open: 4, completed: 1, onHold: 1, onTrack: 2, atRisk: 2, inProgress: 0 });
  assert.equal(r.total, 6);
  assert.equal(r.items[0].title, 'Kerala Expansion', 'open work first, the earliest due day (overdue) first');
  assert.equal(r.items[r.items.length - 1].title, 'Finished by hand', 'completed last');
  assert.equal((await st('GET', `/initiatives?${rng}&status=at_risk`, preethi)).body.total, 2);
  assert.equal((await st('GET', `/initiatives?${rng}&status=open`, preethi)).body.total, 4);
  assert.equal((await st('GET', `/initiatives?${rng}&status=completed`, preethi)).body.items[0].title, 'Finished by hand');
  assert.equal((await st('GET', `/initiatives?${rng}&focusArea=${encodeURIComponent('Revenue & Lead Growth')}`, preethi)).body.total, 2);
  assert.equal((await st('GET', `/initiatives?${rng}&q=crm`, preethi)).body.total, 1);
  assert.equal((await st('GET', `/initiatives?${rng}&q=${encodeURIComponent('.*')}`, preethi)).body.total, 0, 'a regex in the search box is text');
  const p2 = (await st('GET', `/initiatives?${rng}&limit=4&page=2`, preethi)).body;
  assert.equal(p2.items.length, 2);
  assert.equal(p2.total, 6);
  assert.deepEqual((await st('GET', `/initiatives?${rng}`, preethi)).body.focusAreas, ['Operations & Automation', 'Revenue & Lead Growth']);
  assert.equal((await st('GET', `/initiatives?${rng}&brand=kerala`, preethi)).body.counts.total, 1);
  assert.equal((await st('GET', `/initiatives?${rng}&brand=main`, preethi)).body.counts.total, 5);
});
await check('the range matters: an initiative that ended before it, or starts after it, is not in it; cancelled counts nowhere (but can be found)', async () => {
  const before = (await st('POST', '/initiatives', boss, { title: 'Last year thing', startDate: iso(-400), dueDate: iso(-300) })).body;
  const after = (await st('POST', '/initiatives', boss, { title: 'Next year thing', startDate: iso(300), dueDate: iso(350) })).body;
  const gone = (await st('POST', '/initiatives', boss, { title: 'Dropped', status: 'cancelled' })).body;
  const r = (await st('GET', `/initiatives?${rng}`, preethi)).body;
  assert.equal(r.counts.total, 6);
  assert.ok(!r.items.some((i) => [before.id, after.id, gone.id].includes(i.id)));
  assert.deepEqual((await st('GET', `/initiatives?${rng}&status=cancelled`, preethi)).body.items.map((i) => i.title), ['Dropped']);
  const wide = (await st('GET', `/initiatives?from=${iso(-420)}&to=${iso(-250)}`, preethi)).body;
  assert.ok(wide.items.some((i) => i.id === before.id));
  await Initiative.deleteMany({ _id: { $in: [before.id, after.id, gone.id] } });
});
await check('Development Projects: KPIs, the table and its filters', async () => {
  await st('POST', '/projects', boss, { name: 'CRM Migration', category: 'Operations', status: 'completed', startDate: iso(-40), endDate: iso(-10) });
  await st('POST', '/projects', boss, { name: 'Kerala Plan', category: 'Growth', status: 'on_hold', brand: 'kerala', startDate: iso(-10), endDate: iso(40) });
  const r = (await st('GET', `/projects?${rng}`, preethi)).body;
  assert.deepEqual(r.counts, { total: 3, open: 1, completed: 1, onHold: 1, onTrack: 1, atRisk: 0, inProgress: 0 });
  assert.equal(r.items[0].title, 'Website v2');
  assert.equal(r.items[0].category, 'Technology');
  assert.equal((await st('GET', `/projects?${rng}&status=on_hold`, preethi)).body.items[0].title, 'Kerala Plan');
  assert.equal((await st('GET', `/projects?${rng}&q=growth`, preethi)).body.total, 1, 'search reaches the category');
  assert.equal((await st('GET', `/projects?${rng}&brand=kerala`, preethi)).body.counts.total, 1);
});

console.log('\n— the roadmap members tick off —');
let q1a;
await check('a manager lays out the quarters; the name of a quarter is the theme typed on its lines; members cannot add lines', async () => {
  assert.equal((await st('POST', '/roadmap', preethi, { title: 'Brand consolidation', year: thisYear, quarter: 1 })).status, 403);
  for (const body of [{ year: thisYear, quarter: 1 }, { title: 'Brand consolidation', year: thisYear, quarter: 5 }, { title: 'Brand consolidation', quarter: 1 }, { title: 'Brand consolidation', year: thisYear, quarter: 1, initiativeId: '64b7f0c2a1b2c3d4e5f60718' }]) assert.equal((await st('POST', '/roadmap', boss, body)).status, 400, JSON.stringify(body));
  const mk = async (title, quarter, theme, extra = {}) => (await st('POST', '/roadmap', boss, { title, year: thisYear, quarter, theme, ...extra })).body;
  q1a = await mk('Brand consolidation', 1, 'Foundation');
  await mk('Content engine setup', 1, 'Foundation', { initiativeId: init2.id });
  await mk('Process & tools', 1, 'Base');
  await mk('Campaign scale-up', 2, 'Growth', { planId: plan2.id });
  await mk('Regional growth', 3, 'Expansion');
  await mk('Performance review', 4, 'Optimization');
  await st('POST', '/roadmap', boss, { title: 'Last year line', year: thisYear - 1, quarter: 1, theme: 'Old' });
  await st('POST', '/roadmap', boss, { title: 'Kerala only line', year: thisYear, quarter: 2, theme: 'Growth', brand: 'kerala' });
  const r = (await st('GET', `/roadmap?${y}&${rng}`, preethi)).body;
  assert.deepEqual(r.quarters.map((q) => [q.label, q.theme, q.total, q.done]), [['Q1', 'Foundation', 3, 0], ['Q2', 'Growth', 2, 0], ['Q3', 'Expansion', 1, 0], ['Q4', 'Optimization', 1, 0]]);
  assert.deepEqual(r.counts, { items: 7, done: 0, pct: 0 });
  assert.equal(r.quarters[0].items[1].link, 'CRM & Lead Automation', 'a line shows the initiative it belongs to');
  assert.equal(r.quarters[1].items[0].link, 'Revenue & Lead Growth', 'or the plan');
  assert.equal((await st('GET', `/roadmap?${y}&${rng}&brand=main`, preethi)).body.counts.items, 6);
  assert.equal((await st('GET', `/roadmap?year=${thisYear - 1}&${rng}`, preethi)).body.counts.items, 1);
});
await check('a member ticks a line off (who and when are kept) and can take the tick back; someone off the team cannot tick', async () => {
  assert.equal((await st('POST', `/roadmap/${q1a.id}/tick`, ghost, { done: true })).status, 403);
  assert.equal((await st('POST', `/roadmap/${q1a.id}/tick`, preethi, {})).status, 400);
  assert.equal((await st('POST', `/roadmap/${q1a.id}/tick`, preethi, { done: 'yes' })).status, 400);
  assert.equal((await st('POST', '/roadmap/64b7f0c2a1b2c3d4e5f60718/tick', preethi, { done: true })).status, 404);
  const r = await st('POST', `/roadmap/${q1a.id}/tick`, preethi, { done: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.done, r.body.doneBy], [true, 'Preethi']);
  assert.ok(r.body.doneAt);
  const again = await st('POST', `/roadmap/${q1a.id}/tick`, ashique, { done: true });
  assert.equal(again.body.doneBy, 'Preethi', 'ticking an already ticked line changes nothing');
  const q = (await st('GET', `/roadmap?${y}&${rng}`, preethi)).body;
  assert.deepEqual([q.quarters[0].done, q.quarters[0].pct, q.counts.done, q.counts.pct], [1, 33, 1, 14]);
  const un = await st('POST', `/roadmap/${q1a.id}/tick`, ashique, { done: false });
  assert.deepEqual([un.body.done, un.body.doneBy, un.body.doneAt], [false, '', null]);
  await st('POST', `/roadmap/${q1a.id}/tick`, preethi, { done: true });
});
await check('the timeline draws each project and initiative from its start to its end day over the year; work with no end day is listed apart', async () => {
  const r = (await st('GET', `/roadmap?${y}&${rng}`, preethi)).body;
  const bar = (title) => r.timeline.bars.find((b) => b.title === title);
  const web = bar('Website v2');
  assert.ok(web, 'a project is on the timeline');
  assert.equal(web.kind, 'project');
  assert.equal(web.progress, 53);
  assert.equal(web.owner, 'Ashique');
  assert.equal(web.status, 'on_track');
  assert.equal(web.start, iso(-20));
  assert.equal(web.end, iso(20));
  assert.ok(web.from >= 0 && web.to <= 1 && web.to > web.from);
  assert.equal(bar('Launch Bridal Campaign v2').kind, 'initiative');
  assert.ok(r.timeline.undated.some((u) => u.title === 'CRM & Lead Automation') === false, 'it has a due day from its tasks, so it is drawn');
  assert.ok(bar('CRM & Lead Automation'));
  const noEnd = (await st('POST', '/initiatives', boss, { title: 'Hyderabad Studio Setup', startDate: iso(-2) })).body;
  const r2 = (await st('GET', `/roadmap?${y}&${rng}`, preethi)).body;
  assert.ok(r2.timeline.undated.some((u) => u.id === noEnd.id), 'no end day → not drawn');
  assert.ok(!r2.timeline.bars.some((b) => b.id === noEnd.id));
  assert.deepEqual(r2.timeline.bars.map((b) => b.from), [...r2.timeline.bars.map((b) => b.from)].sort((a, b) => a - b), 'ordered by start');
  assert.equal((await st('GET', `/roadmap?year=1800&${rng}`, preethi)).status, 400);
  assert.equal((await st('GET', `/roadmap?year=${thisYear + 5}&${rng}`, preethi)).body.timeline.bars.length, 0, 'nothing is planned five years out');
});
await check('a manager edits and deletes a line; members cannot', async () => {
  const x = (await st('POST', '/roadmap', boss, { title: 'Temp line', year: thisYear, quarter: 4, theme: 'Optimization' })).body;
  assert.equal((await st('PUT', `/roadmap/${x.id}`, preethi, { title: 'Hijack' })).status, 403);
  assert.equal((await st('DELETE', `/roadmap/${x.id}`, preethi)).status, 403);
  const r = await st('PUT', `/roadmap/${x.id}`, boss, { title: 'Temp line renamed', quarter: 3 });
  assert.deepEqual([r.body.title, r.body.quarter], ['Temp line renamed', 3]);
  assert.equal((await st('DELETE', `/roadmap/${x.id}`, boss)).status, 200);
  assert.equal((await st('PUT', `/roadmap/${x.id}`, boss, { title: 'gone' })).status, 404);
});

console.log('\n— research & insights —');
let f1;
await check('a member adds a finding (their name on it); a link must be http(s); kind and title are required', async () => {
  assert.equal((await st('POST', '/research', ghost, { title: 'A finding', kind: 'report' })).status, 403);
  for (const body of [{ kind: 'report' }, { title: 'A finding' }, { title: 'A finding', kind: 'rumour' }, { title: 'A finding', kind: 'report', link: 'javascript:alert(1)' }, { title: 'A finding', kind: 'report', date: '2026-02-31' }]) assert.equal((await st('POST', '/research', preethi, body)).status, 400, JSON.stringify(body));
  const r = await st('POST', '/research', preethi, { title: 'Instagram Growth Trends – Nov', kind: 'market_insight', summary: 'Reels reach 74% of social reach', link: 'https://drive.google.com/x', tags: ['Instagram', 'trends'] });
  assert.equal(r.status, 201, r.text);
  f1 = r.body;
  assert.equal(f1.author, 'Preethi');
  assert.equal(f1.date, today, 'the day defaults to today');
  assert.deepEqual(f1.tags, ['instagram', 'trends']);
  assert.equal(f1.kindLabel, 'Market insight');
  const mk = (title, kind, extra = {}) => st('POST', '/research', ashique, { title, kind, ...extra });
  await mk('Bridal Market Insights – India', 'report', { link: 'https://d.test/bridal' });
  await mk('Competitor pricing sweep', 'competitor');
  await mk('Expand bridal trials campaign', 'opportunity');
  await mk('Increase NRI-focused ads', 'opportunity');
  await mk('Meta lead CPL benchmark', 'market_insight', { date: iso(-5), brand: 'kerala' });
  await mk('An old report', 'report', { date: iso(-200) });
});
await check('the KPI strip counts kinds in the range; Key Insights and Opportunity Areas are lists of the findings; brand, kind, search and paging work', async () => {
  const r = (await st('GET', `/research?${rng}`, preethi)).body;
  assert.deepEqual(r.counts, { total: 6, report: 1, marketInsight: 2, competitor: 1, opportunity: 2 }, 'the old report is out of range');
  assert.deepEqual(r.keyInsights.map((f) => f.title).sort(), ['Instagram Growth Trends – Nov', 'Meta lead CPL benchmark']);
  assert.deepEqual(r.opportunities.map((f) => f.title).sort(), ['Expand bridal trials campaign', 'Increase NRI-focused ads']);
  assert.equal(r.total, 6);
  assert.equal((await st('GET', `/research?${rng}&brand=kerala`, preethi)).body.counts.total, 1);
  assert.equal((await st('GET', `/research?${rng}&kind=opportunity`, preethi)).body.total, 2);
  assert.equal((await st('GET', `/research?${rng}&kind=weird`, preethi)).body.total, 6, 'an unknown kind is no filter');
  assert.equal((await st('GET', `/research?${rng}&q=bridal`, preethi)).body.total, 2, 'search reaches the title and the summary');
  assert.equal((await st('GET', `/research?${rng}&q=instagram`, preethi)).body.total, 1, 'and the tags');
  assert.equal((await st('GET', `/research?${rng}&q=${encodeURIComponent('(')}`, preethi)).status, 200, 'a bracket is text, not a broken pattern');
  const p = (await st('GET', `/research?${rng}&limit=4&page=2`, preethi)).body;
  assert.equal(p.items.length, 2);
  assert.equal((await st('GET', `/research?from=${iso(-300)}&to=${iso(-150)}`, preethi)).body.counts.report, 1);
  assert.equal((await st('GET', '/research?to=bad', preethi)).status, 400);
});
await check('a member edits and deletes only their own findings; a manager any', async () => {
  assert.equal((await st('PUT', `/research/${f1.id}`, ashique, { title: 'Not yours' })).status, 403);
  assert.equal((await st('DELETE', `/research/${f1.id}`, ashique)).status, 403);
  const r = await st('PUT', `/research/${f1.id}`, preethi, { summary: 'Updated summary', link: 'https://d.test/new' });
  assert.deepEqual([r.status, r.body.summary, r.body.link], [200, 'Updated summary', 'https://d.test/new']);
  assert.equal((await st('PUT', `/research/${f1.id}`, preethi, { link: 'ftp://bad' })).status, 400);
  assert.equal((await st('PUT', `/research/${f1.id}`, boss, { kind: 'report' })).body.kind, 'report');
  await st('PUT', `/research/${f1.id}`, boss, { kind: 'market_insight' });
  const temp = (await st('POST', '/research', preethi, { title: 'Temp finding', kind: 'report' })).body;
  assert.equal((await st('DELETE', `/research/${temp.id}`, preethi)).status, 200);
  assert.equal((await st('DELETE', `/research/${temp.id}`, boss)).status, 404);
});

console.log('\n— reviews —');
let rev1;
await check('a manager adds a review; the score is COUNTED from its outcomes; members cannot add; bad input is refused', async () => {
  const body = { type: 'quarterly', periodLabel: 'Q3 2026', reviewDate: iso(-3), summary: 'How the quarter went', outcomes: [{ text: 'Lead target achieved (102%)', state: 'achieved' }, { text: 'Brand engagement up 48%', state: 'achieved' }, { text: 'Kerala expansion in progress (60%)', state: 'partial' }, { text: 'New service launch delayed', state: 'missed' }], actionItems: [{ text: 'Complete bridal vertical go-to-market', ownerId: A.mid, priority: 'high', targetDate: iso(15), status: 'in_progress' }, { text: 'Finalise Kerala expansion locations', ownerId: P.mid, priority: 'high', targetDate: iso(-2) }, { text: 'Review Q4 budget' }] };
  assert.equal((await st('POST', '/reviews', preethi, body)).status, 403);
  for (const bad of [{ ...body, type: 'weekly' }, { ...body, periodLabel: '' }, { ...body, outcomes: [] }, { ...body, outcomes: [{ text: 'x y', state: 'meh' }] }, { ...body, actionItems: [{ text: 'x y', priority: 'urgent' }] }, { ...body, actionItems: [{ text: 'x y', ownerId: '64b7f0c2a1b2c3d4e5f60718' }] }, { ...body, reviewDate: '2026-02-31' }]) assert.equal((await st('POST', '/reviews', boss, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  const r = await st('POST', '/reviews', boss, body);
  assert.equal(r.status, 201, r.text);
  rev1 = r.body;
  assert.deepEqual(rev1.scores, { total: 4, achieved: 2, partial: 1, missed: 1, achievedPct: 50, partialPct: 25, missedPct: 25, overall: 50 });
  assert.equal(rev1.actionItems.length, 3);
  assert.equal(rev1.actionItems[0].owner.name, 'Ashique');
  assert.equal(rev1.actionItems[1].overdue, true, 'target day passed and not done');
  assert.equal(rev1.actionItems[0].overdue, false);
  assert.equal(rev1.actionItems[2].status, 'open');
  assert.equal(rev1.actionItems[2].priority, 'medium');
});
await check('the list: type tabs with counts, the range by the review day, and the brand', async () => {
  await st('POST', '/reviews', boss, { type: 'strategy', periodLabel: 'Brand strategy', reviewDate: iso(-20), outcomes: [{ text: 'Positioning agreed', state: 'achieved' }] });
  await st('POST', '/reviews', boss, { type: 'campaign', periodLabel: 'Diwali campaign', reviewDate: iso(-1), brand: 'kerala', outcomes: [{ text: 'Leads target', state: 'missed' }] });
  await st('POST', '/reviews', boss, { type: 'quarterly', periodLabel: 'Q2 2025', reviewDate: iso(-400), outcomes: [{ text: 'Old', state: 'achieved' }] });
  const all = (await st('GET', `/reviews?${rng}`, preethi)).body;
  assert.deepEqual(all.counts, { strategy: 1, project: 0, campaign: 1, quarterly: 1 }, 'the review from 400 days back is out of range');
  assert.equal(all.items.length, 3);
  assert.equal(all.items[0].periodLabel, 'Diwali campaign', 'newest first');
  const q = (await st('GET', `/reviews?${rng}&type=quarterly`, preethi)).body;
  assert.deepEqual(q.items.map((r) => r.periodLabel), ['Q3 2026']);
  assert.equal(q.counts.campaign, 1, 'tab counts do not depend on the open tab');
  assert.equal((await st('GET', `/reviews?${rng}&type=project`, preethi)).body.items.length, 0);
  assert.equal((await st('GET', `/reviews?${rng}&brand=kerala`, preethi)).body.items.length, 1);
  assert.equal((await st('GET', `/reviews?from=${iso(-420)}&to=${iso(-380)}`, preethi)).body.items[0].periodLabel, 'Q2 2025');
});
await check('the owner of an action item ticks it; another member cannot; a manager can; the id survives an edit', async () => {
  const [a1, a2] = rev1.actionItems;
  assert.equal((await st('PATCH', `/reviews/${rev1.id}/actions/${a1.id}`, preethi, { status: 'done' })).status, 403, 'it is Ashique\'s');
  const done = await st('PATCH', `/reviews/${rev1.id}/actions/${a1.id}`, ashique, { status: 'done' });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.actionItems[0].status, 'done');
  assert.equal(done.body.actionItems[0].overdue, false);
  assert.equal((await st('PATCH', `/reviews/${rev1.id}/actions/${a1.id}`, ashique, { status: 'finished' })).status, 400);
  assert.equal((await st('PATCH', `/reviews/${rev1.id}/actions/64b7f0c2a1b2c3d4e5f60718`, boss, { status: 'done' })).status, 404);
  assert.equal((await st('PATCH', `/reviews/${rev1.id}/actions/${a2.id}`, ghost, { status: 'done' })).status, 403);
  assert.equal((await st('PATCH', `/reviews/${rev1.id}/actions/${a2.id}`, boss, { status: 'in_progress' })).body.actionItems[1].status, 'in_progress');
  // a manager edits the review: the action item keeps its id (and so its tick)
  const edit = await st('PUT', `/reviews/${rev1.id}`, boss, { summary: 'Edited', outcomes: [{ text: 'Lead target achieved (102%)', state: 'achieved' }, { text: 'Kerala expansion', state: 'achieved' }], actionItems: done.body.actionItems.map((a) => ({ id: a.id, text: a.text, ownerId: a.owner?.id ?? null, priority: a.priority, targetDate: a.targetDate, status: a.status })).concat([{ text: 'A new step', priority: 'low' }]) });
  assert.equal(edit.status, 200, edit.text);
  assert.equal(edit.body.actionItems[0].id, a1.id);
  assert.equal(edit.body.actionItems[0].status, 'done');
  assert.equal(edit.body.actionItems.length, 4);
  assert.deepEqual(edit.body.scores, { total: 2, achieved: 2, partial: 0, missed: 0, achievedPct: 100, partialPct: 0, missedPct: 0, overall: 100 }, 'the score follows the outcomes');
  assert.equal((await st('PUT', `/reviews/${rev1.id}`, preethi, { summary: 'x' })).status, 403);
  assert.equal((await st('PUT', `/reviews/${rev1.id}`, boss, { outcomes: [] })).status, 400);
  assert.equal((await st('PUT', '/reviews/64b7f0c2a1b2c3d4e5f60718', boss, { summary: 'x' })).status, 404);
  // put the four outcomes back for the Overview
  await st('PUT', `/reviews/${rev1.id}`, boss, { outcomes: [{ text: 'Lead target achieved (102%)', state: 'achieved' }, { text: 'Brand engagement up 48%', state: 'achieved' }, { text: 'Kerala expansion in progress (60%)', state: 'partial' }, { text: 'New service launch delayed', state: 'missed' }] });
});
await check('only a manager deletes a review', async () => {
  const x = (await st('POST', '/reviews', boss, { type: 'project', periodLabel: 'Temp', outcomes: [{ text: 'a b', state: 'achieved' }] })).body;
  assert.equal((await st('DELETE', `/reviews/${x.id}`, preethi)).status, 403);
  assert.equal((await st('DELETE', `/reviews/${x.id}`, boss)).status, 200);
  assert.equal((await st('DELETE', `/reviews/${x.id}`, boss)).status, 404);
});

console.log('\n— the Overview reads everything once —');
await check('KPIs: active strategies, development projects, total initiatives, on track, at risk, new this week', async () => {
  const o = (await st('GET', `/overview?${rng}&${y}`, preethi)).body;
  // plans in range: 4 live (Brand, Revenue, Kerala brand plan = active/in_progress...) — see the plans check: active 3 (+ the Team plan on hold)
  assert.equal(o.kpis.activeStrategies, 3);
  assert.equal(o.kpis.developmentProjects, 3, 'Website v2, CRM Migration, Kerala Plan');
  // initiatives: Launch (on track), CRM (on track), Kerala Expansion (at risk), Paused idea (hold), Finished by hand, All tasks done (at risk), Hyderabad (in progress)
  assert.equal(o.kpis.totalInitiatives, 7);
  assert.equal(o.kpis.onTrack, 2);
  assert.equal(o.kpis.atRisk, 2);
  // everything above was made today, so it was all made this week: 6 plans (the old one included: "new" is about when it was made, not its year)
  // + 7 initiatives + 3 projects (the cancelled, deleted and spare ones are not counted)
  assert.equal(o.kpis.newThisWeek, 6 + 7 + 3);
  assert.equal((await st('GET', `/overview?${rng}&${y}&brand=kerala`, preethi)).body.kpis.newThisWeek, 1 + 1 + 1, 'the brand narrows it too');
});
await check('Strategic Focus Areas, the roadmap quarters, the key initiatives and projects, strategy performance', async () => {
  const o = (await st('GET', `/overview?${rng}&${y}`, preethi)).body;
  assert.deepEqual(o.focusAreas, { total: 3, rows: [{ focusArea: 'Brand & Market Positioning', count: 2 }, { focusArea: 'Revenue & Lead Growth', count: 1 }] });
  assert.deepEqual(o.roadmap.quarters.map((q) => [q.label, q.theme, q.total, q.done]), [['Q1', 'Foundation', 3, 1], ['Q2', 'Growth', 2, 0], ['Q3', 'Expansion', 1, 0], ['Q4', 'Optimization', 1, 0]]);
  assert.equal(o.roadmap.year, thisYear);
  assert.equal(o.roadmap.quarters[0].items.find((i) => i.title === 'Brand consolidation').done, true);
  assert.equal(o.initiatives.length, 5, 'the table shows five');
  assert.equal(o.initiatives[0].title, 'Kerala Expansion');
  assert.deepEqual(o.initiatives.map((i) => i.title), ['Kerala Expansion', 'All tasks done', 'Launch Bridal Campaign v2', 'CRM & Lead Automation', 'Hyderabad Studio Setup'], 'open work by due day (no due day last); the paused and the finished one do not make the five');
  assert.deepEqual(o.projects.map((p) => p.title), ['Website v2', 'Kerala Plan', 'CRM Migration'], 'open, then on hold, then completed');
  assert.equal(o.projects[0].progress, 53);
  const perf = Object.fromEntries(o.performance.map((p) => [p.focusArea, p]));
  // Revenue & Lead Growth: Launch (75) and Kerala Expansion (typed 90) → 83 (82.5 rounds up); Operations: CRM (10) + All tasks done (40, reopened task 40%) → 25; Others: Finished by hand (none), Paused (none), Hyderabad (none)
  assert.equal(perf['Revenue & Lead Growth'].progress, 83);
  assert.equal(perf['Revenue & Lead Growth'].initiatives, 2);
  assert.equal(perf['Operations & Automation'].progress, 10);
  assert.equal(perf.Others.progress, 40, 'All tasks done sits in Others at 40; the unmeasured ones do not count');
  assert.equal(perf.Others.measured, 1);
  assert.equal(perf.Others.initiatives, 4);
});
await check('Research cards, Key Outcomes of the latest review, and Recent Updates built from real changes (newest first)', async () => {
  // the last things done, in this order
  await sleep(20);
  const t = (await task(boss, { title: 'Final cut', assigneeId: A.mid, initiativeId: init2.id, status: 'in_progress', progress: 10 })).body;
  await sleep(20);
  await call('PUT', `/team/tasks/${t.id}`, boss, { status: 'completed' });
  await sleep(20);
  const line = (await st('GET', `/roadmap?${y}&${rng}`, preethi)).body.quarters[1].items[0];
  await st('POST', `/roadmap/${line.id}/tick`, ashique, { done: true });
  await sleep(20);
  await st('POST', '/research', preethi, { title: 'Studio Expansion Feasibility – South', kind: 'report' });
  await sleep(20);
  await st('POST', '/reviews', boss, { type: 'project', periodLabel: 'Website v2 launch', reviewDate: iso(-1), outcomes: [{ text: 'Website v2 design completed', state: 'achieved' }, { text: 'Content output increased by 32%', state: 'achieved' }] });
  const o = (await st('GET', `/overview?${rng}&${y}`, preethi)).body;
  assert.deepEqual(o.recentUpdates.slice(0, 4).map((e) => e.kind), ['review', 'finding', 'roadmap_done', 'task_done']);
  assert.equal(o.recentUpdates[0].text, 'Website v2 launch review added');
  assert.equal(o.recentUpdates[1].text, 'Studio Expansion Feasibility – South');
  assert.equal(o.recentUpdates[1].by, 'Preethi');
  assert.equal(o.recentUpdates[2].by, 'Ashique');
  assert.deepEqual([o.recentUpdates[3].text, o.recentUpdates[3].subtitle, o.recentUpdates[3].by], ['Final cut completed', 'CRM & Lead Automation', 'Ashique']);
  assert.ok(o.recentUpdates.length <= 12);
  assert.ok(o.recentUpdates.every((e, i, a) => i === 0 || new Date(a[i - 1].at) >= new Date(e.at)), 'newest first');
  assert.equal(o.research.length, 3);
  assert.equal(o.research[0].title, 'Studio Expansion Feasibility – South', 'newest findings first');
  assert.equal(o.keyOutcomes.review.periodLabel, 'Website v2 launch', 'the latest review');
  assert.deepEqual(o.keyOutcomes.outcomes.map((x) => x.text), ['Website v2 design completed', 'Content output increased by 32%']);
  assert.equal(o.keyOutcomes.scores.overall, 100);
});
await check('an empty period shows honest empties: no updates, no key outcomes from a review that has not happened yet', async () => {
  const o = (await st('GET', `/overview?from=${thisYear - 3}-03-01&to=${thisYear - 3}-03-31&year=${thisYear - 3}`, preethi)).body;
  assert.equal(o.kpis.activeStrategies, 1, 'the old plan');
  assert.equal(o.kpis.totalInitiatives, 0);
  assert.equal(o.kpis.newThisWeek >= 0, true);
  assert.deepEqual(o.recentUpdates, []);
  assert.equal(o.keyOutcomes, null);
  assert.deepEqual(o.research, []);
  assert.deepEqual(o.roadmap.quarters.map((q) => q.total), [0, 0, 0, 0]);
  assert.deepEqual(o.initiatives, []);
});
await check('the Overview follows the brand: Kerala only', async () => {
  const o = (await st('GET', `/overview?${rng}&${y}&brand=kerala`, preethi)).body;
  assert.equal(o.kpis.totalInitiatives, 1);
  assert.equal(o.kpis.atRisk, 1);
  assert.equal(o.kpis.developmentProjects, 1);
  assert.equal(o.kpis.activeStrategies, 1, 'the Kerala brand plan');
  assert.equal(o.initiatives[0].title, 'Kerala Expansion');
  assert.equal(o.research.length, 1);
});
await check('with no range at all the Overview opens on this month and the year of today', async () => {
  const o = (await st('GET', '/overview', preethi)).body;
  assert.equal(o.from, `${today.slice(0, 7)}-01`);
  assert.equal(o.year, thisYear);
  assert.equal(o.brand, 'all');
  assert.equal((await st('GET', '/overview?year=abc', preethi)).status, 400);
});

console.log('\n— deleting —');
await check('an initiative with tasks or logs is cancelled instead; an empty one can go (its roadmap lines stay, unlinked)', async () => {
  const del = await st('DELETE', `/initiatives/${init1.id}`, boss);
  assert.equal(del.status, 409);
  assert.match(del.body.message, /Cancel it instead/);
  assert.equal((await st('DELETE', `/initiatives/${init1.id}`, preethi)).status, 403);
  const empty = (await st('POST', '/initiatives', boss, { title: 'Empty one' })).body;
  const l = (await st('POST', '/roadmap', boss, { title: 'Linked line', year: thisYear, quarter: 2, initiativeId: empty.id })).body;
  assert.equal((await st('DELETE', `/initiatives/${empty.id}`, boss)).status, 200);
  assert.equal((await st('GET', `/initiatives/${empty.id}`, boss)).status, 404);
  assert.equal((await Roadmap.findById(l.id).lean()).initiativeId, null);
  assert.equal((await st('PUT', `/initiatives/${init1.id}`, boss, { status: 'cancelled' })).body.status, 'cancelled');
  assert.equal((await st('GET', `/overview?${rng}&${y}`, preethi)).body.kpis.totalInitiatives, 6, 'cancelled counts nowhere');
  assert.ok(!(await st('GET', '/setup', preethi)).body.initiatives.some((i) => i.id === init1.id), 'and is not offered in a form');
  assert.ok(!(await st('GET', `/roadmap?${y}&${rng}`, preethi)).body.timeline.bars.some((b) => b.id === init1.id), 'nor drawn on the timeline');
  await st('PUT', `/initiatives/${init1.id}`, boss, { status: 'active' });
});
await check('deleting a plan leaves its initiatives and roadmap lines, unlinked', async () => {
  assert.equal((await st('DELETE', `/plans/${plan2.id}`, preethi)).status, 403);
  assert.equal((await Initiative.findById(init1.id).lean()).planId.toString(), plan2.id);
  assert.equal((await st('DELETE', `/plans/${plan2.id}`, boss)).status, 200);
  assert.equal((await Initiative.findById(init1.id).lean()).planId, null);
  assert.equal(await Roadmap.countDocuments({ planId: plan2.id }), 0);
  assert.equal((await Plan.countDocuments({ _id: plan2.id })), 0);
  assert.equal((await st('DELETE', `/plans/${plan2.id}`, boss)).status, 404);
});
await check('the Log Activity form\'s initiative and project pickers still list the open ones (the pre-wired link)', async () => {
  const setup = (await call('GET', `/team/log-setup?date=${today}`, preethi)).body;
  assert.ok(setup.initiatives.some((i) => i.id === init1.id));
  assert.ok(setup.devProjects.some((p) => p.id === proj1.id));
  assert.ok(!setup.initiatives.some((i) => i.title === 'Dropped'), 'a cancelled initiative is not offered');
  const s = (await st('GET', '/setup', preethi)).body;
  assert.ok(s.initiatives.some((i) => i.id === init1.id) && s.plans.length >= 4 && s.focusAreas.includes('Operations & Automation') && s.categories.includes('Technology'), 'what the forms offer is what exists');
  assert.ok(s.focusAreas.includes('Brand & Market Positioning'), 'focus areas from plans as well as initiatives');
  assert.deepEqual(s.members.map((m) => m.name).sort(), ['Ashique', 'Preethi']);
});
await check('the roadmap and the Overview default to the year of the end of the range', async () => {
  const r = (await st('GET', `/roadmap?from=${thisYear - 1}-12-01&to=${thisYear}-01-15`, preethi)).body;
  assert.equal(r.year, thisYear);
  const o = (await st('GET', `/overview?from=${thisYear - 1}-12-01&to=${thisYear}-01-15`, preethi)).body;
  assert.equal(o.year, thisYear);
  assert.equal((await st('GET', `/roadmap?year=${thisYear - 1}&from=${thisYear - 1}-12-01&to=${thisYear}-01-15`, preethi)).body.year, thisYear - 1, 'an explicit year wins');
});
await check('nobody outside Marketing can write anything, and no login is refused everywhere', async () => {
  const r0 = (await st('GET', `/roadmap?${y}&${rng}`, preethi)).body.quarters[0].items[0].id;
  const rev = rev1.id;
  const calls = [
    ['POST', '/plans', { title: 'x y', focusArea: 'a' }], ['PUT', `/plans/${plan1.id}`, { title: 'x y' }], ['DELETE', `/plans/${plan1.id}`],
    ['POST', '/initiatives', { title: 'x y' }], ['PUT', `/initiatives/${init1.id}`, { notes: 'x' }], ['DELETE', `/initiatives/${init1.id}`],
    ['POST', '/projects', { name: 'x y' }], ['PUT', `/projects/${proj1.id}`, { notes: 'x' }], ['DELETE', `/projects/${proj1.id}`],
    ['POST', '/roadmap', { title: 'x y', year: thisYear, quarter: 1 }], ['PUT', `/roadmap/${r0}`, { title: 'x y' }], ['DELETE', `/roadmap/${r0}`], ['POST', `/roadmap/${r0}/tick`, { done: true }],
    ['POST', '/research', { title: 'x y', kind: 'report' }], ['PUT', `/research/${f1.id}`, { title: 'x y' }], ['DELETE', `/research/${f1.id}`],
    ['POST', '/reviews', { type: 'strategy', periodLabel: 'x', outcomes: [{ text: 'x y', state: 'achieved' }] }], ['PUT', `/reviews/${rev}`, { summary: 'x' }], ['DELETE', `/reviews/${rev}`], ['PATCH', `/reviews/${rev}/actions/${rev1.actionItems[0].id}`, { status: 'done' }],
  ];
  for (const [m, p, b] of calls) {
    assert.equal((await st(m, p, outsider, b)).status, 403, `outsider ${m} ${p}`);
    assert.equal((await call(m, `/strategies${p}`, undefined, b)).status, 401, `no login ${m} ${p}`);
  }
  assert.ok(await Plan.exists({ _id: plan1.id }), 'nothing was deleted');
});


// ── the audit's fixes (S1, S2, S4) ──────────────────────────────────────────
const Lead = await imp('models/Lead.js');
const { seedStrategyMetrics, STRATEGY_METRICS } = await import(new URL('utils/seedMarketingMaster.js', root));

console.log('\n— S1: the Strategies log types, counted per initiative and project —');
let stratIds;
await check('seeding makes the Strategies group and its five log types once (safe on every start; a used code is never taken)', async () => {
  await E.MarketingMetric.create({ groupId: (await E.MarketingGroup.create({ name: 'Ads', sortOrder: 3 }))._id, code: 22, name: 'Someone else\'s activity' });
  await E.MarketingRole.create({ name: 'Marketing Manager' });
  const first = await seedStrategyMetrics();
  const again = await seedStrategyMetrics();
  assert.deepEqual(again.metricIds.map(String), first.metricIds.map(String), 'the second run finds the same five');
  const group = await E.MarketingGroup.findOne({ name: 'Strategies' }).lean();
  const metrics = await E.MarketingMetric.find({ groupId: group._id }).sort({ sortOrder: 1 }).lean();
  assert.deepEqual(metrics.map((m) => m.name), STRATEGY_METRICS.map((m) => m.name));
  assert.notEqual(metrics[0].code, 22, 'code 22 was taken, so the next free one is used');
  assert.equal(new Set((await E.MarketingMetric.find().lean()).map((m) => m.code)).size, await E.MarketingMetric.countDocuments(), 'codes stay unique');
  assert.ok(metrics.every((m) => m.inTotalOutput === false));
  const mgr = await E.MarketingRole.findOne({ name: 'Marketing Manager' }).lean();
  assert.equal(await E.MarketingRoleMetric.countDocuments({ roleId: mgr._id, metricId: { $in: first.metricIds } }), 5, 'the Marketing Manager can log them');
  stratIds = metrics.map((m) => String(m._id));
});
await check('a log with first drafts and a meeting, tied to an initiative and a project, is counted on both (and on the Overview in the range)', async () => {
  for (const id of stratIds) await E.MarketingMemberMetric.create({ memberId: P.mid, metricId: id, fromMonth: '2026-01', toMonth: null });
  const init = await Initiative.create({ title: 'Wedding season push', brand: 'main', status: 'active' });
  const proj = await Project.create({ name: 'Booking funnel v2', brand: 'main', status: 'in_progress' });
  const r = await call('POST', '/team/activities', preethi, { workedOn: 'Drafted the season plan', initiativeId: String(init._id), devProjectId: String(proj._id), timeSpentMinutes: 60, values: [{ metricId: stratIds[1], value: 2 }, { metricId: stratIds[2], value: 1 }] });
  assert.equal(r.status, 201, r.text);
  assert.equal(String(r.body.activity.devProjectId), String(proj._id));
  const i = (await st('GET', `/initiatives/${init._id}`, P)).body;
  assert.deepEqual([i.strategyWork.total, i.strategyWork.logs, i.strategyWork.counts.map((c) => [c.metric, c.total])], [3, 1, [['First drafts prepared', 2], ['Strategy meetings held', 1]]]);
  const p = (await st('GET', `/projects/${proj._id}`, P)).body;
  assert.equal(p.strategyWork.total, 3);
  assert.equal(p.minutes, 60, 'a project\'s logged hours come from its logs too');
  assert.deepEqual(p.logs.map((l) => l.workedOn), ['Drafted the season plan']);
  const list = (await st('GET', `/initiatives?${rng}&q=Wedding season`, P)).body.items.find((x) => x.id === String(init._id));
  assert.equal(list.strategyWork.total, 3);
  const o = (await st('GET', `/overview?${rng}`, P)).body;
  assert.equal(o.strategyWork.tracked, true);
  assert.ok(o.strategyWork.counts.some((c) => c.metric === 'First drafts prepared' && c.total >= 2));
  assert.deepEqual(o.strategyWork.types, STRATEGY_METRICS.map((m) => m.name));
  assert.equal((await call('POST', '/team/activities', preethi, { workedOn: 'Ghost project', devProjectId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  assert.equal((await st('DELETE', `/projects/${proj._id}`, boss)).status, 409, 'a project with logs tied to it is cancelled, not deleted');
});

console.log('\n— S2: a review names what it reviews and shows how that stands now —');
await check('a review linked to a project shows the project\'s CURRENT progress and status; a link to nothing is refused; it can be taken away', async () => {
  const proj = await Project.create({ name: 'Website v3', brand: 'main', status: 'in_progress', startDate: addDays(today, -10), endDate: addDays(today, 20) });
  await Task.create({ title: 'Design', assigneeId: P.mid, devProjectId: proj._id, status: 'completed', progress: 100, completedAt: new Date() });
  await Task.create({ title: 'Build', assigneeId: P.mid, devProjectId: proj._id, status: 'in_progress', progress: 40 });
  const body = { type: 'project', periodLabel: 'Website v3 mid-point', reviewDate: today, outcomes: [{ text: 'Design signed off', state: 'achieved' }], linkKind: 'project', linkId: String(proj._id) };
  const r = await st('POST', '/reviews', boss, body);
  assert.equal(r.status, 201, r.text);
  assert.deepEqual([r.body.linked.kind, r.body.linked.title, r.body.linked.progress, r.body.linked.progressSource], ['project', 'Website v3', 70, 'tasks']);
  assert.ok(r.body.linked.statusLabel);
  // the project moves on → the review shows where it is NOW
  await Task.updateOne({ devProjectId: proj._id, title: 'Build' }, { $set: { status: 'completed', progress: 100, completedAt: new Date() } });
  const listed = (await st('GET', `/reviews?${rng}&type=project`, P)).body.items.find((x) => x.id === r.body.id);
  assert.deepEqual([listed.linked.progress, listed.linked.status], [100, 'completed']);
  assert.equal((await st('POST', '/reviews', boss, { ...body, linkId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  assert.equal((await st('POST', '/reviews', boss, { ...body, linkKind: 'campaign' })).status, 400);
  const plan = await Plan.create({ title: 'FY27 brand plan', focusArea: 'Brand', year: thisYear, brand: 'main', status: 'active' });
  const toPlan = await st('PUT', `/reviews/${r.body.id}`, boss, { linkKind: 'plan', linkId: String(plan._id) });
  assert.deepEqual([toPlan.body.linked.kind, toPlan.body.linked.title, toPlan.body.linked.statusLabel], ['plan', 'FY27 brand plan', 'Active']);
  const off = await st('PUT', `/reviews/${r.body.id}`, boss, { linkKind: null, linkId: null });
  assert.equal(off.body.linked, null);
  assert.equal((await st('PUT', `/reviews/${r.body.id}`, P, { linkKind: null, linkId: null })).status, 403, 'members do not change reviews');
});

console.log('\n— S4: the enquiry trend (our own leads, this quarter against the last, over the same days) —');
await check('Research shows the enquiry trend vs last quarter from the CRM leads, by arrival day and brand — honestly labelled, "—" with nothing to compare', async () => {
  const S = await import(new URL('utils/marketingStrategyStats.js', root));
  const q = S.quarterOf(today);
  const elapsed = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86400000);
  const prevFrom = S.quarterOf(addDays(q.from, -1)).from;
  let r = (await st('GET', `/research?${rng}`, P)).body.enquiryTrend;
  assert.equal(r.label, 'Enquiry trend vs last quarter');
  assert.deepEqual([r.now.leads, r.before.leads, r.change], [0, 0, null], 'no leads → no change, never 0%');
  const at = (day, extra = {}) => ({ name: 'Lead', phone: '9000000000', status: 'New', source: 'WhatsApp', region: 'Bangalore', leadDate: new Date(`${day}T06:00:00Z`), createdAt: new Date(`${day}T06:00:00Z`), ...extra });
  await Lead.collection.insertMany([at(q.from), at(today), at(today, { region: 'Calicut' }), at(prevFrom), at(addDays(prevFrom, elapsed + 1))]);
  r = (await st('GET', `/research?${rng}`, P)).body.enquiryTrend;
  assert.deepEqual([r.now.leads, r.before.leads, r.change, r.elapsedDays], [3, 1, 200, elapsed + 1], 'the lead after the same number of days of last quarter is not compared');
  const kerala = (await st('GET', `/research?${rng}&brand=kerala`, P)).body.enquiryTrend;
  assert.deepEqual([kerala.now.leads, kerala.before.leads, kerala.change], [1, 0, null]);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
