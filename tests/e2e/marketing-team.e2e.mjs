// End-to-end check of the Marketing Team Dashboard and Log Activity — against a THROWAWAY local MongoDB (needs a mongod on
// 127.0.0.1:27099; refuses to run against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-team.e2e.mjs
//
// The method is the document's own acceptance test ("the matrix"): log an item ONCE, then check every screen that should reflect it —
// the day's EOD totals, the Team Dashboard overview (KPIs, member row, feed, workload, trend), Team Activity, Logs & Timesheet,
// Performance, Attendance and the reports — and that edit and delete make every number follow.
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
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_team_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Notification = await imp('models/Notification.js');
const Activity = await imp('models/MarketingActivity.js');
const Task = await imp('models/MarketingTask.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js'));
app.use('/api/marketing/eod', await imp('routes/marketingEodRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api/marketing`;

const api = async (method, path, token, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
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
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 10).join('\n      ')}`);
  }
};

// ── the team ────────────────────────────────────────────────────────────────
const today = istDay(new Date());
const yesterday = addDays(today, -1);
const longAgo = addDays(today, -10);
const month = today.slice(0, 7);
const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
await E.MarketingCalendarSetting.create({ weeklyOff: (dow + 3) % 7, standardHours: 8, editWindowDays: 2 }); // never today, never yesterday

let n = 0;
const login = async (key, role, extra = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, ...extra });
  return { id: String(user._id), emp: String(emp._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await login('boss', 'marketing_admin');
const preethi = await login('Preethi', 'crm');
const abhiram = await login('Abhiram', 'crm');
const outsider = await login('outsider', 'crm');
const ceo = await login('ceo', 'ceo');

const gContent = await E.MarketingGroup.create({ name: 'Content', sortOrder: 1 });
const gCampaigns = await E.MarketingGroup.create({ name: 'Campaigns', sortOrder: 2 });
const mReels = await E.MarketingMetric.create({ groupId: gContent._id, code: 1, name: 'Reels edited', maxPerDay: 6 });
const mStories = await E.MarketingMetric.create({ groupId: gContent._id, code: 2, name: 'Stories posted' });
const mAds = await E.MarketingMetric.create({ groupId: gCampaigns._id, code: 3, name: 'Ad sets updated' });
const rExec = await E.MarketingRole.create({ name: 'Content Producer' });
const member = async (u, extra = {}) => {
  const mm = await E.MarketingTeamMember.create({ userId: u.id, name: u.name, shortName: u.name, activeFrom: new Date(`${month}-01T00:00:00Z`), ...extra });
  await E.MarketingMemberRole.create({ memberId: mm._id, roleId: rExec._id, fromMonth: '2026-01' });
  for (const m of [mReels, mStories]) await E.MarketingMemberMetric.create({ memberId: mm._id, metricId: m._id, fromMonth: '2026-01', toMonth: null });
  return { ...u, mid: String(mm._id) };
};
const P = await member(preethi);
const A = await member(abhiram);

const log = (who, body) => api('POST', '/team/activities', who.token, { workedOn: 'Edited the bridal reel', ...body });
const overview = (who, q = '') => api('GET', `/team/overview?from=${today}&to=${today}${q}`, who.token);
const day = async (who, date = today) => (await E.MarketingEodEntry.findOne({ memberId: who.mid, entryDate: date }).lean());
const row = (o, who) => o.body.members.find((m) => m.memberId === who.mid);

console.log('\n— log once —');
let first;
await check('a member logs a piece of work once; it is stored with the member, day, brand, time, counts and links', async () => {
  const r = await log(P, { timeSpentMinutes: 120, projectLabel: 'Bridal Campaign', status: 'completed', values: [{ metricId: String(mReels._id), value: 2, details: 'reel 1 and 2' }], attachments: [{ label: 'Final cut', url: 'https://drive.google.com/final' }] });
  assert.equal(r.status, 201, r.text);
  first = r.body.activity;
  assert.equal(first.memberId, P.mid);
  assert.equal(first.entryDate, today);
  assert.equal(first.brand, 'main');
  assert.equal(first.roleName, 'Content Producer');
  assert.equal(String(first.groupId), String(gContent._id), 'it counts under the group of its biggest count');
  assert.equal(await Activity.countDocuments(), 1);
});

console.log('\n— …and every place the matrix lists reflects it —');
await check('EOD: the day entry is the roll-up of the log — hours from minutes, the counts, source "logs"', async () => {
  const d = await day(P);
  assert.equal(d.source, 'logs');
  assert.equal(d.hoursWorked, 2);
  assert.equal(d.values.length, 1);
  assert.equal(String(d.values[0].metricId), String(mReels._id));
  assert.equal(d.values[0].value, 2);
  assert.equal(d.checkStatus, 'OK');
});

await check('Team Dashboard overview: KPI strip, the member\'s row, today\'s feed, workload, trend, activity rate', async () => {
  const o = await overview(boss);
  assert.equal(o.status, 200, o.text);
  assert.equal(o.body.kpis.members, 2);
  assert.equal(o.body.kpis.tasksCompleted, 1);
  assert.equal(o.body.kpis.activityRate, 50, 'one of two members has logged today');
  const r = row(o, P);
  assert.deepEqual([r.tasks, r.completed, r.progress, r.state, r.role], [1, 1, 100, 'Active', 'Content Producer']);
  assert.equal(row(o, A).state, 'Not in yet');
  assert.equal(o.body.todayFeed.length, 1);
  assert.equal(o.body.todayFeed[0].member, 'Preethi');
  assert.equal(o.body.todayFeed[0].group, 'Content');
  assert.deepEqual(o.body.workload, [{ group: 'Content', count: 1, pct: 100 }]);
  assert.equal(o.body.trend.find((t) => t.day === today).completed, 1);
  assert.ok(o.body.insights.some((s) => /completed 1 task/.test(s)));
});

await check('Team Activity: the log is in the live feed, and Today\'s Summary counts it', async () => {
  const r = await api('GET', `/team/activity?from=${today}&to=${today}`, boss.token);
  assert.equal(r.body.total, 1);
  assert.equal(r.body.items[0].workedOn, 'Edited the bridal reel');
  assert.deepEqual([r.body.summary.logged, r.body.summary.completed, r.body.summary.inProgress, r.body.summary.meetings, r.body.summary.minutes], [1, 1, 0, 0, 120]);
});

await check('Logs & Timesheet: hours per person and the time split by group', async () => {
  const r = await api('GET', `/team/timesheet?from=${today}&to=${today}`, boss.token);
  const p = r.body.rows.find((x) => x.memberId === P.mid);
  assert.deepEqual([p.minutes, p.label, p.logs, p.daysLogged, p.status], [120, '2h', 1, 1, 'Submitted']);
  assert.equal(r.body.rows.find((x) => x.memberId === A.mid).status, 'Not logged');
  assert.deepEqual(r.body.split, [{ group: 'Content', minutes: 120, pct: 100 }]);
  assert.equal(r.body.totalMinutes, 120);
});

await check('Performance: completion, activity rate and the overall score', async () => {
  const r = await api('GET', `/team/performance?from=${today}&to=${today}`, boss.token);
  const p = r.body.rows.find((x) => x.memberId === P.mid);
  assert.deepEqual([p.completion, p.activityRate, p.overall], [100, 100, 100]);
  assert.equal(r.body.rows[0].memberId, P.mid, 'best first');
  assert.equal(r.body.kpis.tasksCompleted, 1);
});

await check('Reports: the daily report lists the log; the weekly report totals it; the project report groups it', async () => {
  const d = await api('GET', `/team/reports/daily?from=${today}`, boss.token);
  assert.equal(d.status, 200);
  assert.equal(d.body.rows.length, 1);
  assert.equal(d.body.rows[0][2], 'Preethi');
  assert.match(d.body.rows[0][8], /Reels edited: 2/);
  const w = await api('GET', `/team/reports/weekly?from=${today}&to=${today}`, boss.token);
  const pr = w.body.rows.find((r) => r[0] === 'Preethi');
  assert.deepEqual([pr[2], pr[3], pr[4]], [1, 2, 1]);
  const p = await api('GET', `/team/reports/project?from=${today}&to=${today}`, boss.token);
  assert.deepEqual(p.body.rows[0].slice(0, 3), ['Bridal Campaign', 1, 2]);
  assert.equal((await api('GET', '/team/reports/nonsense', boss.token)).status, 404);
});

await check('RECONCILE: every screen agrees on the same log (EOD hours = timesheet = the feed\'s minutes; KPI = sum of rows)', async () => {
  const o = await overview(boss);
  const ts = await api('GET', `/team/timesheet?from=${today}&to=${today}`, boss.token);
  const act = await api('GET', `/team/activity?from=${today}&to=${today}`, boss.token);
  const eodHours = (await E.MarketingEodEntry.find({ entryDate: today }).lean()).reduce((s, e) => s + e.hoursWorked, 0);
  assert.equal(ts.body.totalMinutes / 60, eodHours);
  assert.equal(act.body.summary.minutes, ts.body.totalMinutes);
  assert.equal(o.body.kpis.tasksCompleted, o.body.members.reduce((s, m) => s + m.completed, 0));
  assert.equal(o.body.workload.reduce((s, w) => s + w.count, 0), o.body.totalItems);
});

console.log('\n— edit and delete: every number follows —');
await check('editing the log (more time, another count, in progress) changes the roll-up and every screen', async () => {
  const r = await api('PUT', `/team/activities/${first.id}`, P.token, { workedOn: 'Edited the bridal reel', timeSpentMinutes: 180, status: 'in_progress', values: [{ metricId: String(mReels._id), value: 3 }, { metricId: String(mStories._id), value: 4 }] });
  assert.equal(r.status, 200, r.text);
  const d = await day(P);
  assert.equal(d.hoursWorked, 3);
  assert.deepEqual(d.values.map((v) => v.value).sort(), [3, 4]);
  const o = await overview(boss);
  assert.equal(o.body.kpis.tasksCompleted, 0);
  assert.equal(o.body.kpis.inProgress, 1);
  assert.equal(row(o, P).progress, 0);
  assert.equal((await api('GET', `/team/timesheet?from=${today}&to=${today}`, boss.token)).body.totalMinutes, 180);
});

await check('deleting the only log removes the day\'s roll-up and zeroes every screen', async () => {
  const r = await api('DELETE', `/team/activities/${first.id}`, P.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(await day(P), null);
  const o = await overview(boss);
  assert.equal(o.body.kpis.tasksCompleted, 0);
  assert.equal(o.body.kpis.inProgress, 0);
  assert.equal(o.body.kpis.activityRate, 0);
  assert.equal(o.body.todayFeed.length, 0);
  assert.equal((await api('GET', `/team/timesheet?from=${today}&to=${today}`, boss.token)).body.totalMinutes, 0);
});

console.log('\n— a day entered the old way is kept —');
await check('the first log of a day that already has an old whole-day EOD entry keeps that entry as a log; the roll-up adds both', async () => {
  await E.MarketingEodEntry.create({ memberId: P.mid, entryDate: yesterday, hoursWorked: 4, notes: 'Shoot day', values: [{ metricId: mStories._id, value: 5 }] });
  const r = await log(P, { entryDate: yesterday, timeSpentMinutes: 60, values: [{ metricId: String(mStories._id), value: 1 }] });
  assert.equal(r.status, 201, r.text);
  const logs = await Activity.find({ memberId: P.mid, entryDate: yesterday }).lean();
  assert.equal(logs.length, 2);
  assert.ok(logs.some((l) => l.legacy && l.timeSpentMinutes === 240));
  const d = await day(P, yesterday);
  assert.equal(d.hoursWorked, 5);
  assert.equal(d.values[0].value, 6);
  assert.equal(d.source, 'logs');
});

await check('the old EOD form cannot overwrite a day that is built from logs (409)', async () => {
  const r = await api('POST', '/eod/entry', P.token, { memberId: P.mid, entryDate: yesterday, hoursWorked: 1, values: [] });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'DAY_FROM_LOGS');
  assert.equal((await day(P, yesterday)).hoursWorked, 5);
});

console.log('\n— a log linked to a task completes it once —');
let task;
await check('the manager assigns a task; the member is told; it shows in the member\'s tasks', async () => {
  const r = await api('POST', '/team/tasks', boss.token, { title: 'Studio tour reel', assigneeId: P.mid, dueDate: addDays(today, 3), priority: 'high', groupId: String(gContent._id), projectLabel: 'Studio Tour' });
  assert.equal(r.status, 201, r.text);
  task = r.body;
  assert.equal(task.status, 'not_started');
  assert.equal((await Notification.countDocuments({ recipient: P.id, type: 'marketing_task' })), 1);
  assert.equal((await Notification.countDocuments({ recipient: boss.id, type: 'marketing_task' })), 0, 'not to the person who assigned it');
  const mine = await api('GET', '/team/tasks', P.token);
  assert.equal(mine.body.items.length, 1);
});

await check('logging progress on the task moves it; logging it completed completes it — and it counts ONCE on the dashboard', async () => {
  const a = await log(P, { workedOn: 'Shot the studio tour', taskId: task.id, status: 'in_progress', taskProgress: 60, timeSpentMinutes: 60 });
  assert.equal(a.status, 201, a.text);
  let t = (await api('GET', '/team/tasks', P.token)).body.items[0];
  assert.deepEqual([t.status, t.progress], ['in_progress', 60]);
  const b = await log(P, { workedOn: 'Delivered the studio tour', taskId: task.id, status: 'completed', timeSpentMinutes: 30 });
  t = (await api('GET', '/team/tasks', P.token)).body.items[0];
  assert.deepEqual([t.status, t.progress], ['completed', 100]);
  const o = await overview(boss);
  assert.equal(o.body.kpis.tasksCompleted, 1, 'one task, however many logs touched it');
  assert.equal(row(o, P).tasks, 1);
  task.completingLog = b.body.activity.id;
});

await check('deleting the log that completed the task reopens it, and the dashboard follows', async () => {
  await api('DELETE', `/team/activities/${task.completingLog}`, P.token);
  const t = (await api('GET', '/team/tasks', P.token)).body.items[0];
  assert.equal(t.status, 'in_progress');
  assert.ok(t.progress < 100);
  const o = await overview(boss);
  assert.equal(o.body.kpis.tasksCompleted, 0);
  assert.equal(o.body.kpis.inProgress, 1);
});

console.log('\n— permissions: own work, all work, and nobody else\'s —');
await check('a member sees only their own dashboard and logs; asking for someone else is refused', async () => {
  const o = await overview(P);
  assert.equal(o.status, 200);
  assert.equal(o.body.members.length, 1);
  assert.equal(o.body.members[0].memberId, P.mid);
  assert.equal((await overview(P, `&memberId=${A.mid}`)).status, 403);
  assert.equal((await api('GET', `/team/activity?from=${today}&to=${today}&memberId=${A.mid}`, P.token)).status, 403);
  assert.equal((await api('GET', `/team/timesheet?from=${today}&to=${today}&memberId=${A.mid}`, P.token)).status, 403);
  assert.equal((await api('GET', `/team/log-setup?memberId=${A.mid}`, P.token)).status, 403);
});

await check('the manager sees everyone; a person outside the team sees nothing', async () => {
  assert.equal((await overview(boss)).body.members.length, 2);
  assert.equal((await overview(outsider)).status, 403);
  assert.equal((await log(outsider, {})).status, 403);
  assert.equal((await api('GET', '/team/tasks', outsider.token)).status, 403);
});

await check('only a manager logs for someone else — and with a reason', async () => {
  assert.equal((await log(P, { memberId: A.mid })).status, 403);
  const noReason = await log(boss, { memberId: A.mid, timeSpentMinutes: 30 });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.reasonRequired, true);
  const r = await log(boss, { memberId: A.mid, timeSpentMinutes: 30, overrideReason: 'Abhiram was on a shoot' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.activity.memberId, A.mid);
  assert.ok(await E.MarketingAuditLog.findOne({ table: 'mkt_activity', reason: 'Abhiram was on a shoot' }), 'an audit row');
});

await check('a member cannot change or delete someone else\'s log', async () => {
  const theirs = await Activity.findOne({ memberId: A.mid });
  assert.equal((await api('PUT', `/team/activities/${theirs._id}`, P.token, { workedOn: 'Not mine' })).status, 403);
  assert.equal((await api('DELETE', `/team/activities/${theirs._id}`, P.token)).status, 403);
});

await check('a leader can read the dashboard but cannot log or assign (the leadership guard)', async () => {
  const guard = await import(new URL('utils/ceoAccess.js', root));
  assert.equal(guard.ceoVerdict('GET', '/api/marketing/team/overview').ok, true);
  assert.equal(guard.ceoVerdict('POST', '/api/marketing/team/activities').ok, false);
  assert.equal(guard.ceoVerdict('POST', '/api/marketing/team/tasks').ok, false);
  const read = await overview(ceo);
  assert.equal(read.status, 200, read.text);
  assert.equal(read.body.members.length, 2, 'a leader sees the whole team');
  const write = await log(ceo, {});
  assert.equal(write.status, 403);
  assert.equal(write.body.code, 'CEO_READ_ONLY');
  assert.equal((await api('POST', '/team/tasks', ceo.token, { title: 'x task', assigneeId: P.mid })).status, 403);
});

console.log('\n— rules —');
await check('a day cannot be in the future, a log needs words, a day has 24 hours, a link must be a link', async () => {
  assert.equal((await log(P, { entryDate: addDays(today, 1) })).status, 400);
  assert.equal((await api('POST', '/team/activities', P.token, { workedOn: '' })).status, 400);
  const day24 = await log(A, { timeSpentMinutes: 1420, workedOn: 'Long one' });
  assert.equal(day24.status, 400, 'with the 30 minutes already logged for Abhiram, 1420 more is over a day');
  assert.equal((await log(A, { timeSpentMinutes: 1410, workedOn: 'Exactly a day' })).status, 201, 'exactly 24 hours is allowed');
  await Activity.deleteOne({ memberId: A.mid, workedOn: 'Exactly a day' });
  await (await import(new URL('services/marketingRollup.js', root))).rebuildDay(A.mid, today);
  assert.equal((await log(P, { attachments: [{ url: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await log(P, { brand: 'delhi' })).status, 400);
});

await check('a member can only count activities in their own set for the month; a manager may add any', async () => {
  const notMine = await log(P, { values: [{ metricId: String(mAds._id), value: 1 }] });
  assert.equal(notMine.status, 403);
  assert.match(notMine.body.message, /not one of your activities/);
  const mgr = await log(boss, { memberId: P.mid, values: [{ metricId: String(mAds._id), value: 1 }], overrideReason: 'Covered the ad sets' });
  assert.equal(mgr.status, 201, mgr.text);
  await Activity.deleteOne({ _id: mgr.body.activity.id });
  await (await import(new URL('services/marketingRollup.js', root))).rebuildDay(P.mid, today);
});

await check('counts above the usual daily maximum are a warning, not a refusal', async () => {
  const r = await log(P, { timeSpentMinutes: 10, values: [{ metricId: String(mReels._id), value: 9 }] });
  assert.equal(r.status, 201);
  assert.ok(r.body.warnings.some((w) => /above the usual daily maximum/.test(w)));
  await api('DELETE', `/team/activities/${r.body.activity.id}`, P.token);
});

await check('the edit window: a member cannot log or change an old day; a manager can, with a reason', async () => {
  assert.equal((await log(P, { entryDate: longAgo })).status, 403);
  assert.equal((await log(boss, { memberId: P.mid, entryDate: longAgo })).status, 400);
  const r = await log(boss, { memberId: P.mid, entryDate: longAgo, overrideReason: 'Forgot to log', timeSpentMinutes: 45 });
  assert.equal(r.status, 201, r.text);
  assert.equal((await day(P, longAgo)).hoursWorked, 0.75);
});

await check('a closed month is locked for everyone until it is reopened', async () => {
  await E.MarketingDashboardRemark.create({ memberId: A.mid, month, monthStatus: 'closed' });
  assert.equal((await log(A, {})).status, 403);
  assert.equal((await log(boss, { memberId: A.mid, overrideReason: 'x' })).status, 403);
  const mine = await Activity.findOne({ memberId: A.mid });
  assert.equal((await api('DELETE', `/team/activities/${mine._id}?reason=cleanup`, boss.token)).status, 403);
  await E.MarketingDashboardRemark.deleteOne({ memberId: A.mid, month });
});

await check('two logs saved at the same moment: both are kept and the day adds up to both', async () => {
  const before = await Activity.countDocuments({ memberId: P.mid, entryDate: today });
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => log(P, { workedOn: `Parallel ${i}`, timeSpentMinutes: 10 })));
  assert.deepEqual(rs.map((r) => r.status), [201, 201, 201, 201, 201]);
  assert.equal(await Activity.countDocuments({ memberId: P.mid, entryDate: today }), before + 5);
  const logs = await Activity.find({ memberId: P.mid, entryDate: today }).lean();
  const d = await day(P);
  assert.equal(d.hoursWorked, Math.round((logs.reduce((s, l) => s + l.timeSpentMinutes, 0) / 60) * 100) / 100);
});

console.log('\n— brand: Main and Kerala —');
await check('every screen filters by brand: Kerala shows only Kerala work; All shows both', async () => {
  await Activity.deleteMany({});
  await E.MarketingEodEntry.deleteMany({});
  await Task.deleteMany({});
  await log(P, { workedOn: 'Main reel', brand: 'main', timeSpentMinutes: 60 });
  await log(P, { workedOn: 'Kerala reel', brand: 'kerala', timeSpentMinutes: 30 });
  await log(P, { workedOn: 'Kerala story', brand: 'kerala', timeSpentMinutes: 30 });
  const all = await overview(boss, '&brand=all');
  const kerala = await overview(boss, '&brand=kerala');
  const main = await overview(boss, '&brand=main');
  assert.deepEqual([all.body.kpis.tasksCompleted, kerala.body.kpis.tasksCompleted, main.body.kpis.tasksCompleted], [3, 2, 1]);
  assert.equal((await api('GET', `/team/timesheet?from=${today}&to=${today}&brand=kerala`, boss.token)).body.totalMinutes, 60);
  assert.equal((await api('GET', `/team/activity?from=${today}&to=${today}&brand=main`, boss.token)).body.total, 1);
  assert.equal((await overview(boss, '&brand=delhi')).status, 400);
  // the day total (EOD) is the member's whole day, whatever the brand
  assert.equal((await day(P)).hoursWorked, 2);
});

console.log('\n— tasks and deliverables —');
await check('status and priority filters, counts for the kanban tabs, a member updating their own progress', async () => {
  const t1 = (await api('POST', '/team/tasks', boss.token, { title: 'Festive offers ad set', assigneeId: A.mid, dueDate: addDays(today, 1), priority: 'medium' })).body;
  await api('POST', '/team/tasks', boss.token, { title: 'Monthly report', assigneeId: P.mid, dueDate: addDays(today, 5), priority: 'low', brand: 'kerala' });
  const all = await api('GET', '/team/tasks', boss.token);
  assert.equal(all.body.counts.all, 2);
  assert.equal((await api('GET', '/team/tasks?priority=low', boss.token)).body.items.length, 1);
  assert.equal((await api('GET', '/team/tasks?brand=kerala', boss.token)).body.items.length, 1);
  assert.equal((await api('GET', '/team/tasks?q=festive', boss.token)).body.items.length, 1);
  const up = await api('PUT', `/team/tasks/${t1.id}`, A.token, { progress: 100 });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.body.status, 'completed', '100% is completed');
  assert.ok(up.body.completedAt);
  const back = await api('PUT', `/team/tasks/${t1.id}`, A.token, { status: 'in_progress', progress: 50 });
  assert.equal(back.body.completedAt, null);
});

await check('a member cannot assign a task to someone else, reassign one, or touch another person\'s', async () => {
  assert.equal((await api('POST', '/team/tasks', P.token, { title: 'For Abhiram', assigneeId: A.mid })).status, 403);
  const mine = (await api('POST', '/team/tasks', P.token, { title: 'My own task' })).body;
  assert.equal(mine.assigneeId, P.mid, 'a task with no assignee is the member\'s own');
  assert.equal((await api('PUT', `/team/tasks/${mine.id}`, P.token, { assigneeId: A.mid })).status, 403);
  const theirs = (await api('GET', '/team/tasks?assigneeId=' + A.mid, boss.token)).body.items[0];
  assert.equal((await api('PUT', `/team/tasks/${theirs.id}`, P.token, { progress: 10 })).status, 403);
  assert.equal((await api('DELETE', `/team/tasks/${theirs.id}`, P.token)).status, 403);
  assert.equal((await api('POST', `/team/tasks/${theirs.id}/comments`, P.token, { text: 'hi' })).status, 403);
});

await check('comments, deleting a task, and a log that pointed at a deleted task keeps its record', async () => {
  const t = (await api('POST', '/team/tasks', boss.token, { title: 'Brand video', assigneeId: P.mid })).body;
  const c = await api('POST', `/team/tasks/${t.id}/comments`, P.token, { text: 'Started the storyboard' });
  assert.equal(c.status, 201);
  assert.equal(c.body.comments[0].text, 'Started the storyboard');
  assert.equal((await api('POST', `/team/tasks/${t.id}/comments`, P.token, { text: '  ' })).status, 400);
  const l = await log(P, { workedOn: 'Storyboard', taskId: t.id, status: 'in_progress' });
  assert.equal((await api('DELETE', `/team/tasks/${t.id}`, boss.token)).status, 200);
  const kept = await Activity.findById(l.body.activity.id).lean();
  assert.ok(kept, 'the log is still there');
  assert.equal(kept.taskId, null);
});

await check('task rules: a title, a real date, consistent progress; the task is not someone else\'s log', async () => {
  assert.equal((await api('POST', '/team/tasks', boss.token, { title: '', assigneeId: P.mid })).status, 400);
  assert.equal((await api('POST', '/team/tasks', boss.token, { title: 'X task', assigneeId: P.mid, dueDate: '10-11' })).status, 400);
  assert.equal((await api('POST', '/team/tasks', boss.token, { title: 'X task', assigneeId: P.mid, progress: 140 })).status, 400);
  const abhiramsTask = (await api('POST', '/team/tasks', boss.token, { title: 'Abhiram only', assigneeId: A.mid })).body;
  const r = await log(P, { workedOn: 'Trying to log on his task', taskId: abhiramsTask.id });
  assert.equal(r.status, 403);
});

console.log('\n— attendance —');
await check('attendance: present, on shoot, on leave and not in yet, with check-in and out; the month\'s rate', async () => {
  await Activity.deleteMany({});
  await E.MarketingEodEntry.deleteMany({});
  const Attendance = await imp('models/Attendance.js');
  const Leave = await imp('models/LeaveRequest.js');
  await Attendance.create({ employeeId: P.emp, date: new Date(`${today}T00:00:00Z`), status: 'Present', checkInTime: new Date(`${today}T04:00:00Z`), checkOutTime: new Date(`${today}T12:30:00Z`) });
  await Leave.collection.insertOne({ employeeId: new mongoose.Types.ObjectId(A.emp), fromDate: new Date(`${today}T00:00:00Z`), toDate: new Date(`${today}T00:00:00Z`), status: 'approved', halfDay: 'none', days: 1 });
  let r = await api('GET', `/team/attendance?date=${today}`, boss.token);
  assert.equal(r.status, 200, r.text);
  const p = r.body.rows.find((x) => x.memberId === P.mid);
  assert.deepEqual([p.state, p.hours, p.workMode], ['Active', 8.5, 'office']);
  assert.equal(r.body.rows.find((x) => x.memberId === A.mid).state, 'On Leave');
  assert.deepEqual(r.body.summary, { present: 1, onShoot: 0, wfh: 0, onLeave: 1, absent: 0 });
  // a shoot log puts Preethi on shoot
  await log(P, { workedOn: 'Bridal shoot', kind: 'shoot', status: 'in_progress', timeSpentMinutes: 60 });
  r = await api('GET', `/team/attendance?date=${today}`, boss.token);
  assert.equal(r.body.rows.find((x) => x.memberId === P.mid).state, 'On Shoot');
  assert.equal(r.body.summary.onShoot, 1);
  const o = await overview(boss);
  assert.equal(row(o, P).state, 'On Shoot');
  assert.deepEqual([o.body.attendance.onShoot, o.body.attendance.onLeave], [1, 1]);
  assert.equal((await api('GET', '/team/attendance?date=garbage', boss.token)).status, 400);
});

await check('a day on approved leave is not counted against the activity rate', async () => {
  const o = await overview(boss);
  assert.equal(o.body.kpis.activityRate, 100, 'Preethi logged; Abhiram is on leave so was not expected to');
});

console.log('\n— the log form\'s setup —');
await check('the form gets the member\'s own activities grouped, their open tasks, projects, the day\'s logs and whether it may be edited', async () => {
  const r = await api('GET', `/team/log-setup?date=${today}`, P.token);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.groups.map((g) => [g.name, g.metrics.map((m) => m.name)]), [['Content', ['Reels edited', 'Stories posted']]]);
  assert.equal(r.body.canEdit, true);
  assert.equal(r.body.canLogForOthers, false);
  assert.equal(r.body.members.length, 0);
  assert.equal(r.body.logs.length, 1);
  const m = await api('GET', `/team/log-setup?date=${today}&memberId=${A.mid}`, boss.token);
  assert.equal(m.body.canLogForOthers, true);
  assert.equal(m.body.members.length, 2);
  assert.ok(m.body.groups.some((g) => g.name === 'Campaigns'), 'a manager sees every activity');
  const old = await api('GET', `/team/log-setup?date=${longAgo}`, P.token);
  assert.equal(old.body.canEdit, false);
  assert.match(old.body.notice, /ask the Marketing Manager/);
  const future = await api('GET', `/team/log-setup?date=${addDays(today, 2)}`, P.token);
  assert.equal(future.body.canEdit, false);
});

console.log('\n— links to campaigns, initiatives and development projects —');
await check('the log form lists the open campaigns, initiatives and development projects (not finished ones)', async () => {
  const Campaign = await imp('models/Campaign.js');
  const Init = await imp('models/StrategicInitiative.js');
  const Dev = await imp('models/DevProject.js');
  await Campaign.create({ title: 'Festive Offers', status: 'active' });
  await Campaign.create({ title: 'Old campaign', status: 'completed' });
  await Init.create({ title: 'CRM & Lead Automation', status: 'active' });
  await Init.create({ title: 'Done initiative', status: 'completed' });
  await Dev.create({ name: 'Website v2', status: 'in_progress' });
  await Dev.create({ name: 'Shipped project', status: 'completed' });
  const r = (await api('GET', `/team/log-setup?date=${today}`, P.token)).body;
  assert.deepEqual(r.campaigns.map((c) => c.title), ['Festive Offers']);
  assert.deepEqual(r.initiatives.map((c) => c.title), ['CRM & Lead Automation']);
  assert.deepEqual(r.devProjects.map((c) => c.name), ['Website v2']);
});
await check('a log tied to a campaign or initiative is stored with the link; one that does not exist is refused', async () => {
  const Campaign = await imp('models/Campaign.js');
  const Init = await imp('models/StrategicInitiative.js');
  const c = await Campaign.findOne({ title: 'Festive Offers' }).lean();
  const i = await Init.findOne({ title: 'CRM & Lead Automation' }).lean();
  const ok = await log(P, { campaignId: String(c._id), initiativeId: String(i._id), workedOn: 'Linked work' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(String(ok.body.activity.campaignId), String(c._id));
  assert.equal(String(ok.body.activity.initiativeId), String(i._id));
  const ghost = '64b7f0c2a1b2c3d4e5f60718';
  assert.match((await log(P, { campaignId: ghost })).body.message, /campaign no longer exists/);
  assert.match((await log(P, { initiativeId: ghost })).body.message, /initiative no longer exists/);
});
await check('a task can carry an initiative and a development project; unknown ones are refused; null clears them', async () => {
  const Init = await imp('models/StrategicInitiative.js');
  const Dev = await imp('models/DevProject.js');
  const i = await Init.findOne({ title: 'CRM & Lead Automation' }).lean();
  const d = await Dev.findOne({ name: 'Website v2' }).lean();
  const made = await api('POST', '/team/tasks', P.token, { title: 'Wire the form', initiativeId: String(i._id), devProjectId: String(d._id) });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.body.initiativeId, String(i._id));
  assert.equal(made.body.devProjectId, String(d._id));
  assert.equal((await api('POST', '/team/tasks', P.token, { title: 'Ghost link', initiativeId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  assert.equal((await api('PUT', `/team/tasks/${made.body.id}`, P.token, { devProjectId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  const cleared = await api('PUT', `/team/tasks/${made.body.id}`, P.token, { initiativeId: null });
  assert.equal(cleared.body.initiativeId, null);
  assert.equal(cleared.body.devProjectId, String(d._id), 'what was not sent stays');
});


// ── the audit's fixes (T1–T11) ──────────────────────────────────────────────
const CoordRequest = await imp('models/CoordRequest.js');
const ContentItem = await imp('models/ContentItem.js');
const WorkMode = await imp('models/MarketingWorkMode.js');
const Lead = await imp('models/Lead.js');
const Project = await imp('models/Project.js');

console.log('\n— T1 / T8: the daily report is TODAY (or the day asked for), and there is a monthly report —');
await check('the daily report shows today even though the app sends a range starting days ago; ?day= picks another day', async () => {
  await Activity.deleteMany({});
  await E.MarketingEodEntry.deleteMany({});
  await log(P, { workedOn: 'Old work', entryDate: yesterday });
  await log(P, { workedOn: 'Today work' });
  const r = await api('GET', `/team/reports/daily?from=${longAgo}&to=${today}`, boss.token);
  assert.equal(r.status, 200, r.text);
  assert.match(r.body.title, new RegExp(today));
  assert.deepEqual(r.body.rows.map((x) => x[4]), ['Today work'], 'not the first day of the range');
  const y = await api('GET', `/team/reports/daily?from=${longAgo}&to=${today}&day=${yesterday}`, boss.token);
  assert.deepEqual(y.body.rows.map((x) => x[4]), ['Old work']);
  assert.equal((await api('GET', `/team/reports/daily?day=${addDays(today, 3)}`, boss.token)).status, 400, 'no daily report for a future day');
});
await check('the monthly report covers the calendar month the range ends in, one row per member', async () => {
  const r = await api('GET', `/team/reports/monthly?from=${today}&to=${today}`, boss.token);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.from, `${month}-01`);
  assert.match(r.body.title, new RegExp(`Monthly report — ${month}`));
  const p = r.body.rows.find((x) => x[0] === 'Preethi');
  assert.equal(p[6], 2, 'both of the month\'s logs are counted');
});

console.log('\n— T2: a category for tasks and logs —');
await check('the log form lists every category; a log or a task with a chosen category counts under it (not "Others")', async () => {
  const setup = (await api('GET', `/team/log-setup?date=${today}`, P.token)).body;
  assert.deepEqual(setup.categories.map((c) => c.name), ['Content', 'Campaigns']);
  const l = await log(P, { workedOn: 'Briefed the ad agency', groupId: String(gCampaigns._id) });
  assert.equal(String(l.body.activity.groupId), String(gCampaigns._id), 'chosen, with no counts');
  const counted = await log(P, { workedOn: 'Reels and a choice', groupId: String(gCampaigns._id), values: [{ metricId: String(mReels._id), value: 1 }] });
  assert.equal(String(counted.body.activity.groupId), String(gCampaigns._id), 'the choice wins over the count\'s group');
  const t = await api('POST', '/team/tasks', boss.token, { title: 'Plan the Diwali ads', assigneeId: P.mid, groupId: String(gCampaigns._id) });
  assert.equal(t.body.group, 'Campaigns');
  const viaTask = await log(P, { workedOn: 'Worked on the Diwali ads', taskId: t.body.id, status: 'in_progress' });
  assert.equal(String(viaTask.body.activity.groupId), String(gCampaigns._id), 'no choice and no count: the task\'s category');
  assert.equal((await log(P, { workedOn: 'Ghost group', groupId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  const o = await overview(boss);
  assert.ok(o.body.workload.find((w) => w.group === 'Campaigns').count >= 3, JSON.stringify(o.body.workload));
});

console.log('\n— T3: Team Activity by member, project and category; the project id is kept —');
let expo;
await check('a log keeps the CRM project picked; the views count the whole period; kind / category / project cut the feed on the server', async () => {
  expo = { _id: (await Project.collection.insertOne({ name: 'Wedding Expo', status: 'active' })).insertedId };
  const r = await log(A, { workedOn: 'Expo stall design', projectId: String(expo._id), projectLabel: 'Wedding Expo', kind: 'meeting' });
  assert.equal(r.status, 201, r.text);
  assert.equal(String(r.body.activity.projectId), String(expo._id));
  assert.equal((await log(A, { workedOn: 'Ghost project', projectId: '64b7f0c2a1b2c3d4e5f60718' })).status, 400);
  const feed = (await api('GET', `/team/activity?from=${today}&to=${today}`, boss.token)).body;
  assert.ok(feed.views.byMember.some((x) => x.key === A.mid && x.logs === 1));
  const expoRow = feed.views.byProject.find((x) => x.key === `id:${expo._id}`);
  assert.equal(expoRow.label, 'Wedding Expo');
  assert.ok(feed.views.byCategory.some((x) => x.label === 'Campaigns'));
  const onlyExpo = (await api('GET', `/team/activity?from=${today}&to=${today}&project=id:${expo._id}`, boss.token)).body;
  assert.deepEqual(onlyExpo.items.map((i) => i.workedOn), ['Expo stall design']);
  assert.equal(onlyExpo.views.byMember.reduce((s, x) => s + x.logs, 0), feed.total, 'the views stay the whole period');
  const meetings = (await api('GET', `/team/activity?from=${today}&to=${today}&kind=meeting`, boss.token)).body;
  assert.deepEqual(meetings.items.map((i) => i.kind), ['meeting']);
  const camp = (await api('GET', `/team/activity?from=${today}&to=${today}&group=${gCampaigns._id}`, boss.token)).body;
  assert.ok(camp.items.length >= 2 && camp.items.every((i) => i.group === 'Campaigns'));
  assert.equal((await api('GET', `/team/activity?kind=dance`, boss.token)).status, 400);
  const own = (await api('GET', `/team/activity?from=${today}&to=${today}`, A.token)).body;
  assert.deepEqual(own.views.byMember.map((x) => x.key), [A.mid], 'a member sees only their own');
});

console.log('\n— T4: My Tasks, Assigned by me, and the date range —');
await check('tasks: mine, the ones I made, and the range rule (open now, done in it, or due in it)', async () => {
  await Task.deleteMany({});
  const mk = (who, body) => api('POST', '/team/tasks', who.token, { title: 'Task', ...body });
  await mk(boss, { title: 'Boss gave Preethi', assigneeId: P.mid, dueDate: longAgo }); // overdue, open → in any range
  await mk(P, { title: 'Preethi for herself' });
  await mk(boss, { title: 'Boss gave Abhiram', assigneeId: A.mid });
  const doneOld = await mk(boss, { title: 'Done long ago', assigneeId: A.mid, status: 'completed' });
  await Task.updateOne({ _id: doneOld.body.id }, { $set: { completedAt: new Date(`${longAgo}T06:00:00Z`) } });
  const titles = (r) => r.body.items.map((i) => i.title).sort();
  const mine = await api('GET', `/team/tasks?scope=mine&from=${today}&to=${today}`, P.token);
  assert.deepEqual(titles(mine), ['Boss gave Preethi', 'Preethi for herself'], 'an overdue open task never drops out of the range');
  const byMe = await api('GET', `/team/tasks?scope=assigned_by_me&from=${today}&to=${today}`, boss.token);
  assert.deepEqual(titles(byMe), ['Boss gave Abhiram', 'Boss gave Preethi']);
  const all = await api('GET', `/team/tasks?from=${today}&to=${today}`, boss.token);
  assert.ok(!titles(all).includes('Done long ago'), 'completed before the range');
  const wide = await api('GET', `/team/tasks?from=${longAgo}&to=${today}`, boss.token);
  assert.ok(titles(wide).includes('Done long ago'));
  const pAll = await api('GET', `/team/tasks?from=${today}&to=${today}`, P.token);
  assert.deepEqual(titles(pAll), ['Boss gave Preethi', 'Preethi for herself'], 'a member only ever sees their own');
});

console.log('\n— T10: a Coordinations request given to a member is their task too —');
let req1;
await check('a request given to Preethi shows in her tasks (read-only here, linked to Coordinations) and in the dashboard counts', async () => {
  await E.MarketingGroup.create({ name: 'Coordination', sortOrder: 3 });
  req1 = await CoordRequest.create({ title: 'Need the expo reel', fromDept: 'Sales', toDept: 'Marketing', assigneeId: P.mid, status: 'waiting_input', dueDate: today, priority: 'high', createdBy: boss.id });
  await CoordRequest.create({ title: 'Cancelled ask', fromDept: 'Sales', toDept: 'Marketing', assigneeId: P.mid, status: 'cancelled' });
  const mine = (await api('GET', `/team/tasks?scope=mine&from=${today}&to=${today}`, P.token)).body;
  const row = mine.items.find((i) => i.title === 'Need the expo reel');
  assert.deepEqual([row.source, row.status, row.requestStatus, row.canEdit, row.link, row.group], ['request', 'pending', 'waiting_input', false, '/marketing/coordinations?tab=requests', 'Coordination']);
  assert.ok(!mine.items.some((i) => i.title === 'Cancelled ask'));
  assert.equal(mine.counts.requests, 1);
  const before = (await overview(boss)).body;
  assert.ok(before.kpis.pendingBlocked >= 1);
  // closed in Coordinations → the dashboard's completed count moves (one record, read by both)
  await CoordRequest.updateOne({ _id: req1._id }, { $set: { status: 'completed', closedAt: new Date(), progress: 100 } });
  const after = (await overview(boss)).body;
  assert.equal(after.kpis.tasksCompleted, before.kpis.tasksCompleted + 1);
  assert.equal(after.kpis.pendingBlocked, before.kpis.pendingBlocked - 1);
});

console.log('\n— T5: work mode (Office / On Shoot / Work From Home) and the month\'s rate per person —');
await check('a member sets today\'s work mode; the board shows Work From Home; a manager can set anyone\'s; a member cannot set others\'', async () => {
  let r = await api('PUT', '/team/work-mode', P.token, { mode: 'wfh' });
  assert.equal(r.status, 200, r.text);

  assert.equal((await api('PUT', '/team/work-mode', P.token, { mode: 'wfh', memberId: A.mid })).status, 403);
  assert.equal((await api('PUT', '/team/work-mode', P.token, { mode: 'beach' })).status, 400);
  assert.equal((await api('PUT', '/team/work-mode', P.token, {})).status, 400, 'say which mode (null takes it back)');
  assert.equal((await api('PUT', '/team/work-mode', P.token, { mode: 'office', day: addDays(today, 1) })).status, 400);
  assert.equal((await api('PUT', '/team/work-mode', P.token, { mode: 'office', day: longAgo })).status, 403, 'outside the edit window');
  r = await api('GET', `/team/attendance?date=${today}`, boss.token);
  const p = r.body.rows.find((x) => x.memberId === P.mid);
  assert.deepEqual([p.state, p.workMode, p.modeSet], ['Work From Home', 'wfh', true]);
  assert.equal(r.body.summary.wfh, 1);
  assert.equal(typeof p.monthRate, 'number');
  assert.equal((await api('GET', `/team/log-setup?date=${today}`, P.token)).body.workMode, 'wfh');
  const o = await overview(boss);
  assert.equal(o.body.attendance.wfh, 1);
  // a manager sets Abhiram on a shoot (his leave still wins today) and clears Preethi's
  const setA = await api('PUT', '/team/work-mode', boss.token, { mode: 'on_shoot', memberId: A.mid, day: yesterday });
  assert.equal(setA.status, 200, setA.text);
  assert.equal((await WorkMode.findOne({ memberId: A.mid, day: yesterday }).lean()).mode, 'on_shoot');
  assert.equal((await api('PUT', '/team/work-mode', P.token, { mode: null })).status, 200);
  assert.equal(await WorkMode.countDocuments({ memberId: P.mid, day: today }), 0);
  assert.equal((await api('PUT', '/team/work-mode', ceo.token, { mode: 'office' })).status >= 400, true, 'leadership reads only');
});
await check('attendance: the member filter narrows the people server-side; a member sees only themself; brand narrows the shoot logs', async () => {
  const one = await api('GET', `/team/attendance?date=${today}&memberId=${A.mid}`, boss.token);
  assert.deepEqual(one.body.rows.map((x) => x.memberId), [A.mid]);
  assert.equal((await api('GET', `/team/attendance?date=${today}&memberId=${A.mid}`, P.token)).status, 403);
  await log(P, { workedOn: 'Kerala shoot', kind: 'shoot', status: 'in_progress', brand: 'kerala' });
  const kerala = await api('GET', `/team/attendance?date=${today}&brand=kerala`, boss.token);
  const main = await api('GET', `/team/attendance?date=${today}&brand=main`, boss.token);
  assert.equal(kerala.body.rows.find((x) => x.memberId === P.mid).state, 'On Shoot');
  assert.notEqual(main.body.rows.find((x) => x.memberId === P.mid).state, 'On Shoot', 'the Kerala shoot is not a Main shoot');
  assert.equal((await api('GET', `/team/attendance?date=${today}&brand=dubai`, boss.token)).status, 400);
});

console.log('\n— T6: lead → booking per member, and each person\'s trend —');
await check('performance: the leads given to the member\'s login that arrived in the range, converted ÷ leads (the Lead Report\'s rules); a weekly trend', async () => {
  const at = new Date(`${today}T06:00:00Z`);
  const Booking = await imp('models/Booking.js');
  const { insertedIds: bk } = await Booking.collection.insertMany([{ customerName: 'B1', status: 'confirmed', totalPrice: 10000, createdAt: at }, { customerName: 'B2', status: 'cancelled', totalPrice: 5000, createdAt: at }, { customerName: 'B3', status: 'confirmed', totalPrice: 7000, createdAt: at }]);
  const pid = new mongoose.Types.ObjectId(preethi.id);
  await Lead.collection.insertMany([
    { name: 'L1', phone: '9000000001', assignedTo: pid, status: 'Converted', bookingId: bk[0], source: 'WhatsApp', leadDate: at, createdAt: at },
    { name: 'L2', phone: '9000000002', assignedTo: pid, status: 'Qualified', source: 'WhatsApp', leadDate: at, createdAt: at },
    { name: 'L4', phone: '9000000004', assignedTo: pid, status: 'Converted', bookingId: bk[1], source: 'WhatsApp', leadDate: at, createdAt: at }, // its booking was cancelled: not a booking
    { name: 'L3', phone: '9000000003', assignedTo: pid, status: 'Converted', bookingId: bk[2], source: 'WhatsApp', leadDate: new Date(`${longAgo}T06:00:00Z`), createdAt: at },
  ]);
  const r = await api('GET', `/team/performance?from=${today}&to=${today}`, boss.token);
  assert.equal(r.status, 200, r.text);
  const p = r.body.rows.find((x) => x.memberId === P.mid);
  const a = r.body.rows.find((x) => x.memberId === A.mid);
  assert.deepEqual([p.leads, p.booked, p.leadToBooking], [3, 1, 33.3], 'the Lead Report\'s rule: a Converted lead whose booking was cancelled is no booking');
  assert.deepEqual([a.leads, a.leadToBooking], [0, null], 'no lead → no rate, never 0%');
  assert.equal(r.body.kpis.leadToBooking, 33.3);
  assert.ok(Array.isArray(p.trend) && p.trend.length === 1 && 'activityPct' in p.trend[0]);
  const wide = await api('GET', `/team/performance?from=${longAgo}&to=${today}`, boss.token);
  assert.deepEqual([wide.body.rows.find((x) => x.memberId === P.mid).leads, wide.body.rows.find((x) => x.memberId === P.mid).leadToBooking], [4, 50]);
});

console.log('\n— T7: Daily Logs, Work Summary and the Activity Report —');
await check('daily logs carry everything a log says; the work summary and the activity report are counted from the same logs', async () => {
  await log(A, { workedOn: 'Edited two reels', completed: 'Reel 1 and 2', pending: 'Reel 3', nextPriority: 'Stories', values: [{ metricId: String(mReels._id), value: 2 }], timeSpentMinutes: 90 });
  const logs = (await api('GET', `/team/logs?from=${today}&to=${today}`, boss.token)).body;
  const e = logs.items.find((i) => i.workedOn === 'Edited two reels');
  assert.deepEqual([e.completed, e.pending, e.nextPriority, e.counts[0].metric, e.counts[0].value], ['Reel 1 and 2', 'Reel 3', 'Stories', 'Reels edited', 2]);
  assert.equal(logs.total, (await api('GET', `/team/activity?from=${today}&to=${today}`, boss.token)).body.total);
  const ts = (await api('GET', `/team/timesheet?from=${today}&to=${today}`, boss.token)).body;
  const ws = ts.workSummary.find((w) => w.memberId === A.mid);
  assert.deepEqual([ws.pending, ws.nextPriority], ['Reel 3', 'Stories']);
  assert.ok(ws.completed.includes('Reel 1 and 2'));
  const reels = ts.activityReport.rows.find((r) => r.metric === 'Reels edited');
  assert.ok(reels.total >= 2 && reels.members >= 1);
  const mineOnly = (await api('GET', `/team/logs?from=${today}&to=${today}`, A.token)).body;
  assert.ok(mineOnly.items.every((i) => i.memberId === A.mid));
});

console.log('\n— T11: one log that published a Socials post —');
await check('a completed log tied to a post marks it published on the log\'s day; the log form lists the posts; deleting the log puts the post back', async () => {
  const post = await ContentItem.create({ title: 'Bridal reel #12', platform: 'instagram', contentType: 'reel', status: 'scheduled', scheduledDate: new Date(`${today}T10:00:00Z`) });
  const setup = (await api('GET', `/team/log-setup?date=${today}`, P.token)).body;
  assert.ok(setup.posts.some((x) => x.id === String(post._id)));
  const r = await log(P, { workedOn: 'Posted the bridal reel', kind: 'post', contentId: String(post._id), status: 'completed' });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.published, true);
  let p = await ContentItem.findById(post._id).lean();
  assert.equal(p.status, 'published');
  assert.equal(istDay(p.publishedDate), today);
  // logging it again does not publish twice or change the day
  const again = await log(P, { workedOn: 'Boosted the bridal reel', contentId: String(post._id) });
  assert.equal(again.body.published, false);
  // the log is deleted → the post is scheduled again (nothing else changed it)
  assert.equal((await api('DELETE', `/team/activities/${r.body.activity.id}`, P.token)).status, 200);
  p = await ContentItem.findById(post._id).lean();
  assert.deepEqual([p.status, p.publishedDate], ['scheduled', null]);
  // an in-progress log does not publish; completing it later does; moving it off the post puts the post back
  const wip = await log(P, { workedOn: 'Editing the reel', contentId: String(post._id), status: 'in_progress' });
  assert.equal((await ContentItem.findById(post._id).lean()).status, 'scheduled');
  await api('PUT', `/team/activities/${wip.body.activity.id}`, P.token, { workedOn: 'Posted it', contentId: String(post._id), status: 'completed' });
  assert.equal((await ContentItem.findById(post._id).lean()).status, 'published');
  await api('PUT', `/team/activities/${wip.body.activity.id}`, P.token, { workedOn: 'Posted it', status: 'completed' });
  assert.equal((await ContentItem.findById(post._id).lean()).status, 'scheduled');
  const cancelled = await ContentItem.create({ title: 'Dropped idea', status: 'cancelled', scheduledDate: new Date() });
  assert.equal((await log(P, { workedOn: 'x', contentId: String(cancelled._id) })).status, 400);
});
await check('a post published by hand before the log is left alone (and not put back when the log goes)', async () => {
  const post = await ContentItem.create({ title: 'Already out', status: 'published', publishedDate: new Date(`${yesterday}T10:00:00Z`), scheduledDate: new Date(`${yesterday}T10:00:00Z`) });
  const r = await log(P, { workedOn: 'Shared it on stories', contentId: String(post._id) });
  assert.equal(r.body.published, false);
  await api('DELETE', `/team/activities/${r.body.activity.id}`, P.token);
  const p = await ContentItem.findById(post._id).lean();
  assert.equal(p.status, 'published');
  assert.equal(istDay(p.publishedDate), yesterday);
});

await mongoose.disconnect();
server.close();
console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? `:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
