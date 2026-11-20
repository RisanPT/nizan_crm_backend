// End-to-end check of Coordinations — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else and drops its own database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-coordinations.e2e.mjs
//
// The document's method: a request or approval is logged ONCE, and every screen follows — the Overview strip, the task tables, the
// Request-by-Department split, the Inter-Department board, the Approvals queue (with the real posts and assets waiting for review),
// the meetings, the follow-ups and the CSV rows all read the same records. Dates are relative to today, so the run does not depend on
// the day it is run (but not within an hour of IST midnight: meetings are placed around "now").
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
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_coordinations_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Notification = await imp('models/Notification.js');
const CoordRequest = await imp('models/CoordRequest.js');
const CoordApproval = await imp('models/CoordApproval.js');
const CoordMeeting = await imp('models/CoordMeeting.js');
const CoordFollowUp = await imp('models/CoordFollowUp.js');
const ContentItem = await imp('models/ContentItem.js');
const Asset = await imp('models/MarketingAsset.js');
const E = await import(new URL('models/MarketingEod.js', root));
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
const S = await import(new URL('utils/marketingCoordinationStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

// meetings are placed around "now": stay away from the IST day boundary so "today" means the same day all through the run
const istMinutes = Math.floor(((Date.now() + 5.5 * 3600 * 1000) % 86400000) / 60000);
if (istMinutes < 60 || istMinutes > 1430) {
  console.error('Run this check at least an hour after, and ten minutes before, IST midnight (meetings are placed around "now").');
  process.exit(2);
}

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/coordinations', await imp('routes/marketingCoordinationsRoutes.js'));
app.use('/api/marketing/team', await imp('routes/marketingTeamRoutes.js')); // the team's tasks are read by both screens
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
const co = (m, p, w, b) => call(m, `/coordinations${p}`, w, b);

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 12).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
const today = istDay(new Date());
const due = (n) => addDays(today, n);
const RANGE = `from=${due(-30)}&to=${due(30)}`; // a wide window around today; the period before it is [today-91, today-31]
const at = (day, hhmm = '06:00') => new Date(`${day}T${hhmm}:00Z`);
const minutesFromNow = (m) => new Date(Date.now() + m * 60000).toISOString();
const get = (p, who, extra = '') => co('GET', `${p}${p.includes('?') ? '&' : '?'}${RANGE}${extra}`, who);
const titles = (items) => items.map((i) => i.title);
const backdate = (Model, id, fields) => Model.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: fields });
const countDocs = async (skip) => {
  const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name).filter((n) => !skip.includes(n));
  const out = {};
  for (const n of names) out[n] = await mongoose.connection.db.collection(n).countDocuments();
  return out;
};

let n = 0;
const login = async (key, role) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const { default: Role } = await import(new URL('models/Role.js', root));
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
const boss = await login('boss', 'marketing_admin'); // admin: not on the team, may do anything
const outsider = await login('outsider', 'crm');
const nora = await login('Nora', 'marketing_staff'); // has Marketing access but is not on the team
const rManager = await E.MarketingRole.create({ name: 'Marketing Manager' });
const rEditor = await E.MarketingRole.create({ name: 'Video Editor' });
const member = async (key, role) => {
  const u = await login(key, 'marketing_staff');
  const mm = await E.MarketingTeamMember.create({ userId: u.id, name: key, shortName: key, activeFrom: new Date(`${today.slice(0, 7)}-01T00:00:00Z`) });
  await E.MarketingMemberRole.create({ memberId: mm._id, roleId: role._id, fromMonth: '2026-01' });
  return { ...u, mid: String(mm._id) };
};
const meera = await member('Meera', rManager); // a team member who holds the Marketing Manager role → a manager
const P = await member('Preethi', rEditor);
const A = await member('Abhiram', rEditor);
const J = await member('Jithya', rEditor);
const K = await member('Ashique', rEditor);
const F = await member('Faris', rEditor);
const GHOST = '64b7f0c2a1b2c3d4e5f60718';

const mkReq = async (who, body, status = 201) => {
  const r = await co('POST', '/requests', who, { toDept: 'Production', ...body });
  assert.equal(r.status, status, r.text);
  return r.body;
};
const setStatus = async (who, id, status) => {
  const r = await co('PUT', `/requests/${id}`, who, { status });
  assert.equal(r.status, 200, r.text);
  return r.body;
};
const mkApp = async (who, body) => {
  const r = await co('POST', '/approvals', who, { category: 'Marketing', amount: 1000, ...body });
  assert.equal(r.status, 201, r.text);
  return r.body;
};
const decide = (who, id, decision, note) => co('POST', `/approvals/${id}/decide`, who, { decision, ...(note ? { note } : {}) });

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— setup and who may do what —');
await check('the form setup lists the ten teams, the team with roles, and who is asking (and whether they are a manager)', async () => {
  const s = (await co('GET', '/setup', P)).body;
  assert.deepEqual(s.departments, ['Production', 'Socials', 'Marketing', 'Sales', 'Operations', 'HR', 'Finance', 'IT', 'Design', 'Others']);
  assert.ok(s.approvalCategories.includes('Brand'));
  assert.deepEqual(s.members.map((m) => m.name).sort(), ['Abhiram', 'Ashique', 'Faris', 'Jithya', 'Meera', 'Preethi']);
  assert.equal(s.members.find((m) => m.name === 'Meera').role, 'Marketing Manager');
  assert.equal(s.statuses.length, 7);
  assert.deepEqual(s.stages.map((x) => x.key), ['requested', 'in_progress', 'in_review', 'completed']);
  assert.deepEqual([s.me.memberId, s.me.isManager], [P.mid, false]);
  assert.deepEqual([(await co('GET', '/setup', meera)).body.me.isManager, (await co('GET', '/setup', boss)).body.me.isManager], [true, true], 'the Marketing Manager role and an admin are managers');
  const b = (await co('GET', '/setup', boss)).body.me;
  assert.equal(b.memberId, null, 'an admin is not on the team');
});
await check('someone outside Marketing is refused everywhere; no login is refused', async () => {
  for (const p of ['/setup', '/overview', '/requests', '/interdepartment', '/approvals', '/review-queue', '/meetings', '/followups', '/followups/calendar', '/export/requests']) assert.equal((await co('GET', p, outsider)).status, 403, p);
  for (const [m, p] of [['POST', '/requests'], ['POST', '/approvals'], ['POST', '/meetings'], ['POST', '/followups'], ['PUT', `/requests/${GHOST}`], ['POST', `/approvals/${GHOST}/decide`], ['DELETE', `/meetings/${GHOST}`]]) assert.equal((await co(m, p, outsider, {})).status, 403, `${m} ${p}`);
  for (const p of ['/overview', '/requests', '/approvals', '/meetings', '/followups', '/setup']) assert.equal((await co('GET', p)).status, 401, p);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— requests: raise, change, move, delete —');
let q1;
await check('a request needs a title and a real team; a good one is stored with who asked and who was given it; the assignee is told', async () => {
  for (const body of [{ toDept: 'Sales' }, { title: 'Ok title', toDept: 'Mars' }, { title: 'Ok title' }, { title: 'Ok title', toDept: 'Sales', dueDate: '2026-02-31' }, { title: 'Ok title', toDept: 'Sales', priority: 'urgent' }, { title: 'Ok title', toDept: 'Sales', progress: 150 }, { title: 'Ok title', toDept: 'Sales', status: 'completed' }, { title: 'Ok title', toDept: 'Sales', kind: 'task' }, { title: 'Ok title', toDept: 'Sales', brand: 'mars' }]) {
    const r = await co('POST', '/requests', P, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.ok(r.body.message.length > 8 && !/undefined|Cast/.test(r.body.message), r.body.message);
  }
  assert.equal((await co('POST', '/requests', P, { title: 'Ok title', toDept: 'Sales', assigneeId: GHOST })).status, 400, 'an assignee that is not on the team');
  assert.equal((await co('POST', '/requests', P, { title: 'Ok title', toDept: 'Sales', assigneeId: 'nope' })).status, 400);
  q1 = await mkReq(P, { title: '  Social media creatives for new campaign ', toDept: 'Production', priority: 'high', dueDate: due(2), assigneeId: A.mid, detail: 'Three reels' });
  assert.equal(q1.title, 'Social media creatives for new campaign');
  assert.deepEqual([q1.kind, q1.fromDept, q1.toDept, q1.status, q1.priority, q1.progress, q1.brand], ['request', 'Marketing', 'Production', 'open', 'high', 0, 'main']);
  assert.deepEqual([q1.requestedBy, q1.requestedById, q1.assignee, q1.assigneeId], ['Preethi', P.mid, 'Abhiram', A.mid]);
  assert.equal((await Notification.countDocuments({ recipient: A.id, type: 'coord_request' })), 1, 'the person it was given to is told');
  assert.equal((await Notification.countDocuments({ recipient: P.id })), 0, 'the person who raised it is not');
  await mkReq(P, { title: 'A task for myself', assigneeId: P.mid });
  assert.equal((await Notification.countDocuments({ recipient: P.id })), 0, 'giving it to yourself tells nobody');
  assert.deepEqual([q1.canEdit, q1.canDelete], [true, true]);
});
await check('raising a request for someone else is a manager\'s job; an admin who is not on the team is named as the requester', async () => {
  assert.equal((await co('POST', '/requests', P, { title: 'On behalf', toDept: 'Sales', requestedById: A.mid })).status, 403);
  const own = await mkReq(P, { title: 'Own id is fine', toDept: 'Sales', requestedById: P.mid });
  assert.equal(own.requestedBy, 'Preethi');
  const onBehalf = await mkReq(meera, { title: 'Raised by a manager for Abhiram', toDept: 'Sales', requestedById: A.mid });
  assert.equal(onBehalf.requestedBy, 'Abhiram');
  const adminReq = await mkReq(boss, { title: 'Raised by the admin', toDept: 'Sales' });
  assert.deepEqual([adminReq.requestedBy, adminReq.requestedById], ['boss', null]);
  const nonMember = await mkReq(nora, { title: 'Raised by Nora', toDept: 'IT' });
  assert.equal(nonMember.requestedBy, 'Nora');
  assert.equal((await co('GET', '/requests?scope=my', nora)).body.total, 0, 'someone not on the team has no tasks of their own');
});
await check('the status machine: start, review, complete (progress and closing follow), reopen; a move the machine does not allow is refused in plain words', async () => {
  const put = (who, body) => co('PUT', `/requests/${q1.id}`, who, body);
  let r = await put(A, { status: 'in_progress' });
  assert.deepEqual([r.status, r.body.status, r.body.progress, r.body.closedAt], [200, 'in_progress', 10, null]);
  r = await put(A, { status: 'open' });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /In Progress cannot be moved to Open/);
  r = await put(A, { status: 'in_review' });
  assert.deepEqual([r.body.status, r.body.progress], ['in_review', 75]);
  r = await put(A, { status: 'completed' });
  assert.deepEqual([r.body.status, r.body.progress, r.body.onTime, r.body.overdue], ['completed', 100, true, false]);
  assert.ok(r.body.closedAt);
  assert.deepEqual(r.body.nextStatuses, ['in_progress']);
  r = await put(A, { status: 'in_progress' });
  assert.deepEqual([r.body.status, r.body.progress, r.body.closedAt], ['in_progress', 90, null], 'reopened: capped at 90, closing cleared');
  r = await put(A, { progress: 50, status: 'in_review' });
  assert.equal(r.body.progress, 50, 'a figure that was typed wins over the stage floor');
  assert.equal((await put(A, { status: 'weird' })).status, 400);
  const fresh = await mkReq(P, { title: 'Straight to done', assigneeId: A.mid });
  const done = await setStatus(A, fresh.id, 'completed');
  assert.deepEqual([done.status, done.progress], ['completed', 100], 'a small request can be completed in one step');
});
await check('who may change a request: the one who raised it, the one it was given to, a manager — not a bystander', async () => {
  const put = (who, body) => co('PUT', `/requests/${q1.id}`, who, body);
  assert.equal((await put(F, { title: 'Hijacked title' })).status, 403);
  assert.match((await put(F, { title: 'Hijacked title' })).body.message, /You can change the requests you raised or were given/);
  assert.equal((await put(nora, { title: 'Hijacked title' })).status, 403);
  assert.equal((await put(P, { title: 'Social media creatives – v2' })).status, 200, 'the requester');
  assert.equal((await put(boss, { detail: 'Admin note' })).body.detail, 'Admin note');
  assert.equal((await put(meera, { priority: 'medium' })).body.priority, 'medium');
  assert.equal((await put(P, { requestedById: A.mid })).status, 403, 'who raised it is a manager\'s to change');
  assert.equal((await put(meera, { requestedById: A.mid })).body.requestedBy, 'Abhiram');
  assert.equal((await put(meera, { requestedById: P.mid })).body.requestedBy, 'Preethi');
  assert.equal((await co('PUT', `/requests/${GHOST}`, P, { title: 'x y' })).status, 404);
  assert.equal((await co('PUT', '/requests/not-an-id', P, { title: 'x y' })).status, 404);
  assert.equal((await put(P, { title: 'x' })).status, 400);
});
await check('reassigning tells the new person; only the requester or a manager deletes (cancel instead otherwise); a deleted request frees its approval', async () => {
  const r = await co('PUT', `/requests/${q1.id}`, P, { assigneeId: J.mid });
  assert.equal(r.body.assignee, 'Jithya');
  assert.equal((await Notification.countDocuments({ recipient: J.id, type: 'coord_request' })), 1);
  await co('PUT', `/requests/${q1.id}`, P, { assigneeId: J.mid, title: 'Social media creatives – v2' });
  assert.equal((await Notification.countDocuments({ recipient: J.id, type: 'coord_request' })), 1, 'saving again with the same person is not a new request');
  const linked = await mkApp(P, { title: 'Budget for the creatives', requestId: q1.id });
  assert.equal(linked.requestId, q1.id);
  assert.equal((await co('DELETE', `/requests/${q1.id}`, J)).status, 403, 'the assignee cannot delete it');
  assert.match((await co('DELETE', `/requests/${q1.id}`, J)).body.message, /Cancel it instead/);
  assert.equal((await co('DELETE', `/requests/${q1.id}`, P)).status, 200);
  assert.equal((await co('GET', '/requests?scope=all&q=creatives&' + RANGE.replace(/&/, '&'), P)).body.items.filter((x) => x.id === q1.id).length, 0);
  assert.equal((await CoordApproval.findById(linked.id).lean()).requestId, null, 'the approval stays, no longer pointing at a request that is gone');
  const other = await mkReq(P, { title: 'Manager deletes this one' });
  assert.equal((await co('DELETE', `/requests/${other.id}`, meera)).status, 200);
  assert.equal((await co('DELETE', `/requests/${other.id}`, meera)).status, 404);
  assert.equal((await co('DELETE', '/requests/not-an-id', meera)).status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— the Overview: log once, every number follows —');
await Promise.all([CoordRequest, CoordApproval, CoordMeeting, CoordFollowUp, ContentItem, Asset, Notification].map((m) => m.deleteMany({})));
const R = {};
await check('build the data: requests and handovers across teams and states, approvals decided by a manager, posts and assets in review, a meeting, follow-ups', async () => {
  R.r1 = await mkReq(P, { title: 'Edit bridal campaign v2', fromDept: 'Marketing', toDept: 'Production', assigneeId: A.mid, dueDate: due(-1), priority: 'high' });
  await setStatus(A, R.r1.id, 'in_progress');
  R.r2 = await mkReq(A, { title: 'Studio tour reel publishing', fromDept: 'Production', toDept: 'Socials', assigneeId: P.mid, dueDate: due(1) });
  R.r3 = await mkReq(J, { title: 'Provide artist availability', fromDept: 'Socials', toDept: 'Marketing', assigneeId: P.mid, dueDate: due(0) });
  await setStatus(P, R.r3.id, 'completed');
  R.r4 = await mkReq(K, { title: 'Send product details & pricing', fromDept: 'Sales', toDept: 'Marketing', assigneeId: J.mid, dueDate: due(-3), priority: 'high' });
  await setStatus(J, R.r4.id, 'completed');
  R.r5 = await mkReq(P, { kind: 'handover', title: 'Campaign assets & lead integration', fromDept: 'Marketing', toDept: 'Sales', assigneeId: J.mid, dueDate: due(2) });
  await co('POST', `/requests/${R.r5.id}/move`, J, { stage: 'in_progress' });
  assert.equal((await co('POST', `/requests/${R.r5.id}/move`, J, { stage: 'in_review' })).status, 200);
  R.r6 = await mkReq(P, { title: 'A request that was cancelled', fromDept: 'Marketing', toDept: 'Production' });
  await setStatus(P, R.r6.id, 'cancelled');
  R.r7 = await mkReq(P, { title: 'Old work carried over', fromDept: 'Marketing', toDept: 'Production' });
  await setStatus(P, R.r7.id, 'in_progress');
  await backdate(CoordRequest, R.r7.id, { createdAt: at(due(-60)) });
  R.r8 = await mkReq(P, { title: 'Logged far in the future', toDept: 'Production' });
  await backdate(CoordRequest, R.r8.id, { createdAt: at(due(40)) });
  R.r9 = await mkReq(P, { title: 'Finished long ago', toDept: 'Production' });
  await setStatus(P, R.r9.id, 'completed');
  await backdate(CoordRequest, R.r9.id, { createdAt: at(due(-60)), closedAt: at(due(-50)) });
  R.r10 = await mkReq(meera, { title: 'Kerala launch teaser', fromDept: 'Marketing', toDept: 'Socials', brand: 'kerala', priority: 'low' });
  R.r11 = await mkReq(P, { title: 'Done in the period before', toDept: 'Production' });
  await setStatus(P, R.r11.id, 'completed');
  await backdate(CoordRequest, R.r11.id, { createdAt: at(due(-45)), closedAt: at(due(-40)) });
  R.r12 = await mkReq(J, { kind: 'handover', title: 'Shoot footage to Socials', fromDept: 'Production', toDept: 'Socials', assigneeId: A.mid, dueDate: due(3) });
  R.r13 = await mkReq(P, { kind: 'handover', title: 'Brand assets to Production', fromDept: 'Marketing', toDept: 'Production', assigneeId: A.mid });
  await co('POST', `/requests/${R.r13.id}/move`, A, { stage: 'in_progress' });
  await co('POST', `/requests/${R.r13.id}/move`, A, { stage: 'completed' });

  R.a1 = await mkApp(P, { title: 'Campaign ad budget – Nov', category: 'Marketing', amount: 20000, impact: 'Reach +20%', dueDate: due(-1) });
  R.a2 = await mkApp(J, { title: 'Equipment purchase (SD Card)', category: 'Production', amount: 8500 });
  R.a3 = await mkApp(K, { title: 'Quarterly magazine – print', category: 'Brand', amount: 45000 });
  R.a4 = await mkApp(A, { title: 'Brand shoot location booking', category: 'Production', amount: 12000 });
  R.a5 = await mkApp(P, { title: 'Hiring campaign – Sales Exec', category: 'HR', amount: 3000, dueDate: due(5) });
  R.a6 = await mkApp(P, { title: 'Kerala billboard', category: 'Marketing', amount: 7000, brand: 'kerala' });
  assert.equal((await decide(meera, R.a2.id, 'review')).body.status, 'in_review');
  assert.equal((await decide(meera, R.a3.id, 'escalate', 'Above my limit')).body.status, 'escalated');
  assert.equal((await decide(meera, R.a4.id, 'approve', 'Go ahead')).body.status, 'approved');
  assert.equal((await decide(meera, R.a5.id, 'reject', 'Not this quarter')).body.status, 'rejected');

  R.c1 = await ContentItem.create({ title: 'Bridal reel', platform: 'instagram', contentType: 'reel', status: 'in-review', brand: 'main', scheduledDate: at(due(1)) });
  R.c2 = await ContentItem.create({ title: 'Kerala story', platform: 'facebook', contentType: 'story', status: 'in-review', brand: 'kerala', scheduledDate: at(due(2)) });
  await ContentItem.create({ title: 'Already scheduled', status: 'scheduled', brand: 'main', scheduledDate: at(due(1)) });
  R.as1 = await Asset.create({ title: 'Final cut – bridal', kind: 'reel', stage: 'in_review', brand: 'main', url: 'https://d.test/final' });
  await Asset.create({ title: 'Approved still', kind: 'still', stage: 'approved', brand: 'main', url: 'https://d.test/still' });

  const live = await co('POST', '/meetings', P, { title: 'Content sync', startAt: minutesFromNow(-5), endAt: minutesFromNow(55), departments: ['Marketing', 'Socials'], location: 'Conference room', agenda: ['Pipeline'] });
  assert.equal(live.status, 201, live.text);
  R.live = live.body;
  for (const [item, d, dept] of [['Chase the print vendor', due(-2), 'Marketing'], ['Chase the studio', due(-5), 'Production']]) {
    assert.equal((await co('POST', '/followups', P, { item, dueDate: d, department: dept })).status, 201);
  }
});
await check('the strip counts requests AND approvals: total, completed, in progress, pending approvals, overdue, on-time — from the records', async () => {
  const o = (await get('/overview', P)).body;
  assert.deepEqual([o.from, o.to, o.brand, o.dept, o.today], [due(-30), due(30), 'all', 'all', today]);
  assert.equal(o.kpis.requests, 9, 'R1 R2 R3 R4 R5 R7 R10 R12 R13 — not the cancelled, the future, or the old ones');
  assert.equal(o.kpis.approvals, 6);
  assert.equal(o.kpis.total, 15);
  assert.equal(o.kpis.completed, 4, 'three requests and the approved approval');
  assert.equal(o.kpis.inProgress, 2);
  assert.equal(o.kpis.pending, 4);
  assert.equal(o.kpis.pendingApprovals, 4, 'pending, in review, escalated and the Kerala one');
  assert.equal(o.kpis.overdue, 2, 'the request past its day and the approval past its needed-by day');
  assert.equal(o.kpis.onTimeRate, 67, 'on time: the request due today and the rejected approval decided in time; late: the one due 3 days ago');
  assert.equal(o.kpis.onTimeOf, 3);
  assert.deepEqual(o.change, { total: 400, completed: 100 }, 'against the period before: 3 items, 2 completed');
});
await check('the brand and the Departments pill narrow every figure', async () => {
  const k = (await get('/overview', P, '&brand=kerala')).body.kpis;
  assert.deepEqual([k.total, k.requests, k.approvals, k.pendingApprovals, k.completed], [2, 1, 1, 1, 0]);
  const main = (await get('/overview', P, '&brand=main')).body.kpis;
  assert.equal(main.total, 13);
  const sales = (await get('/overview', P, '&dept=Sales')).body.kpis;
  assert.deepEqual([sales.requests, sales.approvals, sales.total], [2, 0, 2], 'R4 and R5 involve Sales; no approval is in the Sales category');
  const prod = (await get('/overview', P, '&dept=Production')).body.kpis;
  assert.deepEqual([prod.requests, prod.approvals], [5, 2]);
  assert.equal((await get('/overview', P, '&dept=Mars')).status, 400);
});
await check('Coordination Tasks: my (assigned to me), team (assigned to any marketing member), all — with their counts', async () => {
  const o = (await get('/overview', P)).body;
  assert.deepEqual(o.tabCounts, { my: 2, team: 7, all: 9 });
  assert.deepEqual(titles(o.tasks.my), ['Studio tour reel publishing', 'Provide artist availability'], 'open work first');
  assert.equal(o.tasks.team.length, 5);
  assert.deepEqual(titles(o.tasks.all).slice(0, 4), ['Edit bridal campaign v2', 'Studio tour reel publishing', 'Campaign assets & lead integration', 'Shoot footage to Socials'], 'soonest due first, overdue on top');
  assert.equal(o.tasks.all[0].overdue, true);
  const b = (await get('/overview', boss)).body;
  assert.deepEqual(b.tabCounts, { my: 0, team: 7, all: 9 });
  assert.deepEqual(b.tasks.my, []);
});
await check('Request by Department: requesting, receiving or both (the default)', async () => {
  const pick = (d) => d.rows.map((r) => [r.label, r.count, r.pct]);
  const both = (await get('/overview', P)).body.byDepartment;
  assert.equal(both.total, 9);
  assert.deepEqual(pick(both), [['Marketing', 7, 39], ['Production', 5, 28], ['Socials', 4, 22], ['Sales', 2, 11]]);
  const from = (await get('/overview', P, '&by=requesting')).body.byDepartment;
  assert.deepEqual(pick(from), [['Marketing', 5, 56], ['Production', 2, 22], ['Socials', 1, 11], ['Sales', 1, 11]]);
  const to = (await get('/overview', P, '&by=receiving')).body.byDepartment;
  assert.deepEqual(pick(to), [['Production', 3, 33], ['Socials', 3, 33], ['Marketing', 2, 22], ['Sales', 1, 11]]);
  assert.equal((await get('/overview', P, '&by=nonsense')).body.byDepartment.by, 'both', 'an unknown grouping falls back');
});
await check('Recent requests, Inter-Department rows with progress, and Approvals Pending (approvals and content waiting for review, from the real records)', async () => {
  const o = (await get('/overview', P)).body;
  assert.equal(o.recent.length, 5);
  assert.equal(o.recent[0].title, 'Brand assets to Production', 'the newest first');
  assert.deepEqual(titles(o.interDepartment), ['Campaign assets & lead integration', 'Shoot footage to Socials', 'Brand assets to Production'], 'open handovers by day, then the completed');
  assert.deepEqual(o.interDepartment.map((r) => r.progress), [75, 0, 100]);
  assert.equal(o.approvalsPending.approvalCount, 4);
  assert.deepEqual(titles(o.approvalsPending.approvals), ['Campaign ad budget – Nov', 'Equipment purchase (SD Card)', 'Quarterly magazine – print', 'Kerala billboard'], 'the longest waiting first');
  const rv = o.approvalsPending.review;
  assert.deepEqual([rv.total, rv.content, rv.assets], [3, 2, 1]);
  assert.deepEqual(rv.items.map((x) => [x.type, x.title, x.link]), [
    ['asset', 'Final cut – bridal', '/marketing/portfolio?tab=gallery'],
    ['content', 'Bridal reel', '/marketing/socials?tab=publishing'],
    ['content', 'Kerala story', '/marketing/socials?tab=publishing'],
  ]);
  const kerala = (await get('/overview', P, '&brand=kerala')).body.approvalsPending.review;
  assert.deepEqual(kerala.items.map((x) => x.title), ['Kerala story']);
});
await check('Upcoming Coordinations merges meetings and open requests\' due days; the Today / This Week / This Month dropdown narrows it', async () => {
  const next = await co('POST', '/meetings', P, { title: 'Shoot logistics', startAt: `${due(1)}T04:30:00Z`, endAt: `${due(1)}T05:30:00Z`, departments: ['Production'] });
  assert.equal(next.status, 201);
  const todayItems = (await get('/overview', P, '&upcoming=today')).body.upcoming;
  assert.equal(todayItems.period, 'today');
  assert.deepEqual(todayItems.items.map((i) => [i.type, i.title]), [['meeting', 'Content sync']], 'the meeting that is on now; nothing is due today that is still open');
  const month = (await get('/overview', P, '&upcoming=month')).body.upcoming;
  const until = S.periodEnd(today, 'month');
  const wanted = [['Content sync', today], ['Shoot logistics', due(1)], ['Studio tour reel publishing', due(1)], ['Campaign assets & lead integration', due(2)], ['Shoot footage to Socials', due(3)]].filter(([, d]) => d <= until);
  assert.deepEqual(month.items.map((i) => i.title), wanted.map((w) => w[0]), 'by day; on a day, the meeting (with its time) before the due day');
  const sync = month.items.find((i) => i.title === 'Content sync');
  assert.equal(sync.type, 'meeting');
  assert.match(sync.time, /^\d\d:\d\d$/);
  assert.equal(sync.subtitle, 'Marketing, Socials');
  const week = (await get('/overview', P, '')).body.upcoming;
  assert.equal(week.period, 'week', 'the default is this week');
  const dept = (await get('/overview', P, '&upcoming=month&dept=Production')).body.upcoming.items.map((i) => i.title);
  assert.ok(dept.includes('Shoot logistics') && !dept.includes('Content sync'), 'the Departments pill narrows meetings too');
});
await check('Key Updates are sentences the numbers support', async () => {
  const k = (await get('/overview', P)).body.keyUpdates;
  assert.deepEqual(k.slice(0, 4).map((x) => x.text), ['4 of 15 items completed (27%).', '2 items overdue.', '4 approvals waiting for a decision.', '1 escalated approval needs attention.']);
  assert.match(k[4].text, /^Next meeting: Content sync, today at \d\d:\d\d\.$/);
  assert.equal(k[5].text, '2 follow-ups overdue.');
  assert.deepEqual(k.map((x) => x.tone), ['info', 'bad', 'info', 'warn', 'info', 'bad']);
});
await check('a default range (no dates) is this week, Monday to Sunday; bad ranges and brands are refused', async () => {
  const o = (await co('GET', '/overview', P)).body;
  const w = S.weekRange(today);
  assert.deepEqual([o.from, o.to], [w.from, w.to]);
  for (const q of ['from=nope', `from=${due(5)}&to=${due(1)}`, `from=${due(-400)}&to=${due(0)}`, 'brand=mars', 'from=2026-02-31&to=2026-03-01']) assert.equal((await co('GET', `/overview?${q}`, P)).status, 400, q);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— Requests & Tasks: the same records, as a table —');
await check('the strip uses the same function as the Overview (requests only): total = in progress + pending + completed', async () => {
  const r = (await get('/requests', P)).body;
  const o = (await get('/overview', P)).body;
  assert.deepEqual([r.kpis.total, r.kpis.inProgress, r.kpis.pending, r.kpis.completed, r.kpis.overdue], [9, 2, 4, 3, 1]);
  assert.equal(r.kpis.total, r.kpis.inProgress + r.kpis.pending + r.kpis.completed);
  assert.equal(r.kpis.approvals, 0, 'approvals have their own tab');
  assert.equal(r.kpis.onTimeRate, 50);
  assert.equal(o.kpis.requests, r.kpis.total, 'what the Overview counts as requests is what this tab counts');
  assert.equal(o.kpis.completed - 1, r.kpis.completed, 'the Overview adds the approved approval');
  assert.deepEqual(r.tabCounts, { my: 2, team: 7, all: 9 });
  assert.equal(r.total, 9);
});
await check('My Tasks / Team Tasks / All Requests; rows say who asked, which teams, priority, due and status; whether you may change them', async () => {
  const mine = (await get('/requests', P, '&scope=my')).body;
  assert.deepEqual(titles(mine.items), ['Studio tour reel publishing', 'Provide artist availability']);
  assert.equal((await get('/requests', P, '&scope=team')).body.total, 7);
  assert.equal((await get('/requests', P, '&scope=all')).body.total, 9);
  assert.equal((await get('/requests', P, '&scope=weird')).body.total, 9, 'an unknown tab is all');
  const row = mine.items[0];
  assert.deepEqual([row.requestedBy, row.fromDept, row.toDept, row.priority, row.dueDate, row.status, row.assignee], ['Abhiram', 'Production', 'Socials', 'medium', due(1), 'open', 'Preethi']);
  const all = (await get('/requests', P)).body.items;
  assert.equal(all.find((x) => x.title === 'Edit bridal campaign v2').canEdit, true, 'Preethi raised it');
  assert.equal(all.find((x) => x.title === 'Send product details & pricing').canEdit, false, 'someone else\'s');
  assert.equal((await get('/requests', boss)).body.items.every((x) => x.canEdit && x.canDelete), true, 'an admin may change anything');
  assert.equal((await get('/requests', boss, '&scope=my')).body.total, 0);
});
await check('filters: status (and the pending / overdue groups), priority, kind, search; a regex in the box is only text', async () => {
  const f = async (q) => (await get('/requests', P, q)).body;
  assert.deepEqual(titles((await f('&status=pending')).items).sort(), ['Campaign assets & lead integration', 'Kerala launch teaser', 'Shoot footage to Socials', 'Studio tour reel publishing']);
  assert.deepEqual(titles((await f('&status=overdue')).items), ['Edit bridal campaign v2']);
  assert.deepEqual(titles((await f('&status=in_progress')).items).sort(), ['Edit bridal campaign v2', 'Old work carried over']);
  assert.equal((await f('&status=completed')).total, 3);
  assert.deepEqual(titles((await f('&status=cancelled')).items), ['A request that was cancelled'], 'cancelled ones count nowhere but can be found');
  assert.deepEqual(titles((await f('&priority=high')).items).sort(), ['Edit bridal campaign v2', 'Send product details & pricing']);
  assert.equal((await f('&kind=handover')).total, 3);
  assert.equal((await f('&kind=request')).total, 6);
  assert.deepEqual(titles((await f('&q=BRIDAL')).items), ['Edit bridal campaign v2']);
  assert.deepEqual(titles((await f('&q=ashique')).items), ['Send product details & pricing'], 'search reaches the requester\'s name');
  assert.equal((await f('&q=' + encodeURIComponent('.*'))).total, 0);
  assert.equal((await f('&q=' + encodeURIComponent('(['))).total, 0);
  assert.equal((await f('&brand=kerala')).total, 1);
  assert.equal((await f('&dept=Sales')).total, 2);
  assert.equal((await f('&status=pending&scope=my')).total, 1, 'filters add up');
  for (const q of ['&status=junk', '&priority=junk', '&kind=junk']) assert.equal((await get('/requests', P, q)).status, 400, q);
});
await check('paging', async () => {
  const p1 = (await get('/requests', P, '&limit=4&page=1')).body;
  const p3 = (await get('/requests', P, '&limit=4&page=3')).body;
  assert.deepEqual([p1.items.length, p1.total, p1.page, p1.pageSize, p3.items.length], [4, 9, 1, 4, 1]);
  assert.equal((await get('/requests', P, '&limit=4&page=4')).body.items.length, 0);
  assert.equal((await get('/requests', P, '&limit=500')).body.pageSize, 50, 'capped');
  const seen = new Set();
  for (const page of [1, 2, 3]) for (const x of (await get('/requests', P, `&limit=4&page=${page}`)).body.items) seen.add(x.id);
  assert.equal(seen.size, 9, 'every request appears once across the pages');
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— Inter-Department: the handover board —');
await check('the board has a column per stage with its handovers; the strip counts active, awaiting action, in review, overdue, completed', async () => {
  const b = (await get('/interdepartment', P)).body;
  assert.deepEqual(b.stages.map((s) => [s.key, s.label, s.count]), [['requested', 'Requested', 1], ['in_progress', 'In Progress', 0], ['in_review', 'In Review', 1], ['completed', 'Completed', 1]]);
  assert.deepEqual(titles(b.stages[0].items), ['Shoot footage to Socials']);
  assert.deepEqual(titles(b.stages[2].items), ['Campaign assets & lead integration']);
  assert.deepEqual(b.kpis, { active: 2, awaitingAction: 1, inReview: 1, overdue: 0, completed: 1 });
  assert.deepEqual((await get('/interdepartment', P, '&dept=Sales')).body.stages.map((s) => s.count), [0, 0, 1, 0], 'one handover involves Sales');
  assert.equal((await get('/interdepartment', P, '&brand=kerala')).body.kpis.active, 0);
  assert.equal(b.stages[0].items[0].moveTo.join(), 'in_progress,completed', 'a card offers only the columns it may go to');
});
await check('moving a card: the assignee moves it on; skipping a stage is refused in plain words; completing stamps it; moving back reopens', async () => {
  const mv = (who, id, stage) => co('POST', `/requests/${id}/move`, who, { stage });
  assert.equal((await mv(F, R.r12.id, 'in_progress')).status, 403, 'a bystander cannot');
  assert.equal((await mv(A, R.r12.id, 'in_review')).status, 400, 'requested → in review skips a stage');
  assert.match((await mv(A, R.r12.id, 'in_review')).body.message, /Open cannot be moved to In Review/);
  let r = await mv(A, R.r12.id, 'in_progress');
  assert.deepEqual([r.status, r.body.status, r.body.progress, r.body.stage], [200, 'in_progress', 10, 'in_progress']);
  assert.equal((await mv(A, R.r12.id, 'in_progress')).body.status, 'in_progress', 'the same column is not a change');
  r = await mv(A, R.r12.id, 'in_review');
  assert.deepEqual([r.body.status, r.body.progress], ['in_review', 75]);
  r = await mv(A, R.r12.id, 'completed');
  assert.deepEqual([r.body.status, r.body.progress, r.body.moveTo], ['completed', 100, ['in_progress']]);
  assert.ok(r.body.closedAt);
  assert.equal((await mv(A, R.r12.id, 'in_review')).status, 400, 'back one stage at a time: via in progress');
  r = await mv(A, R.r12.id, 'in_progress');
  assert.deepEqual([r.body.status, r.body.closedAt, r.body.progress], ['in_progress', null, 90]);
  assert.equal((await mv(A, R.r12.id, 'nowhere')).status, 400);
  assert.equal((await mv(A, R.r12.id, '')).status, 400);
  assert.equal((await mv(P, R.r6.id, 'in_progress')).status, 409, 'a cancelled request has to be reopened first');
  assert.equal((await mv(meera, GHOST, 'in_progress')).status, 404);
});
await check('every screen follows the move: board, strip, Overview and Requests all agree', async () => {
  const b = (await get('/interdepartment', P)).body;
  assert.deepEqual(b.stages.map((s) => s.count), [0, 1, 1, 1]);
  assert.deepEqual(b.kpis, { active: 2, awaitingAction: 0, inReview: 1, overdue: 0, completed: 1 });
  const o = (await get('/overview', P)).body.kpis;
  const r = (await get('/requests', P)).body.kpis;
  assert.deepEqual([o.inProgress, o.pending, r.inProgress, r.pending], [3, 3, 3, 3]);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— Approvals —');
await check('the strip and the tabs: Pending, In Review (with escalated), Approved, Rejected — and the amount still waiting', async () => {
  const a = (await get('/approvals', P)).body;
  assert.deepEqual(a.kpis, { total: 6, pending: 2, inReview: 1, escalated: 1, approved: 1, rejected: 1, awaitingAmount: 80500 });
  assert.deepEqual(a.tabCounts, { pending: 2, in_review: 2, approved: 1, rejected: 1 });
  assert.deepEqual(titles(a.items), ['Kerala billboard', 'Campaign ad budget – Nov'], 'the default tab is Pending, newest first');
  const tab = async (s, extra = '') => titles((await get('/approvals', P, `&status=${s}${extra}`)).body.items).sort();
  assert.deepEqual(await tab('in_review'), ['Equipment purchase (SD Card)', 'Quarterly magazine – print']);
  assert.deepEqual(await tab('approved'), ['Brand shoot location booking']);
  assert.deepEqual(await tab('rejected'), ['Hiring campaign – Sales Exec']);
  assert.equal((await get('/approvals', P, '&status=all')).body.total, 6);
  assert.deepEqual(await tab('pending', '&brand=kerala'), ['Kerala billboard']);
  assert.deepEqual(await tab('all', '&dept=Production'), ['Brand shoot location booking', 'Equipment purchase (SD Card)']);
  assert.deepEqual(await tab('in_review', '&q=magazine'), ['Quarterly magazine – print']);
  assert.equal((await get('/approvals', P, '&status=weird')).status, 400);
  assert.equal((await get('/approvals', P, '&status=all&limit=2&page=3')).body.items.length, 2);
});
await check('a row shows who asked, the category, the amount and impact, the status and decision; and what you may do with it', async () => {
  const all = (await get('/approvals', meera, '&status=all')).body.items;
  const a1 = all.find((x) => x.id === R.a1.id);
  assert.deepEqual([a1.requestedBy, a1.category, a1.amount, a1.impact, a1.status, a1.dueDate, a1.overdue], ['Preethi', 'Marketing', 20000, 'Reach +20%', 'pending', due(-1), true]);
  const a4 = all.find((x) => x.id === R.a4.id);
  assert.deepEqual([a4.status, a4.decidedBy, a4.decisionNote, a4.canDecide, a4.canEdit], ['approved', 'Meera', 'Go ahead', false, false]);
  assert.ok(a4.decidedAt);
  assert.equal(all.find((x) => x.id === R.a3.id).decisionNote, 'Above my limit');
  assert.equal(all.find((x) => x.id === R.a2.id).canDecide, true, 'a manager decides what is waiting, including what is in review');
  const mine = (await get('/approvals', P, '&status=all')).body.items;
  assert.deepEqual([mine.find((x) => x.id === R.a1.id).canDecide, mine.find((x) => x.id === R.a1.id).canEdit, mine.find((x) => x.id === R.a2.id).canEdit], [false, true, false], 'a member edits their own pending approval, never decides');
});
await check('content awaiting review is listed on the Approvals tab from the real posts and assets, with where to decide them', async () => {
  const q = (await get('/approvals', P)).body.review;
  assert.equal(q.total, 3);
  assert.deepEqual(q.items.map((x) => x.type), ['asset', 'content', 'content']);
  const direct = (await get('/review-queue', P)).body;
  assert.equal(direct.total, 3);
  assert.equal((await get('/review-queue', P, '&brand=main')).body.total, 2);
  // approving the post in Socials takes it off the list at once — it was never typed here
  await ContentItem.updateOne({ _id: R.c1._id }, { status: 'scheduled' });
  await Asset.updateOne({ _id: R.as1._id }, { stage: 'approved' });
  assert.equal((await get('/review-queue', P)).body.total, 1);
  assert.equal((await get('/overview', P)).body.approvalsPending.review.total, 1);
  await ContentItem.updateOne({ _id: R.c1._id }, { status: 'in-review' });
  await Asset.updateOne({ _id: R.as1._id }, { stage: 'in_review' });
});
await check('raising an approval: what, a category, an amount that is zero or more; a member may not raise one for someone else', async () => {
  for (const body of [{ category: 'Marketing' }, { title: 'Ok title' }, { title: 'Ok title', category: 'Nowhere' }, { title: 'Ok title', category: 'HR', amount: -5 }, { title: 'Ok title', category: 'HR', amount: 'lots' }, { title: 'Ok title', category: 'HR', dueDate: 'soon' }, { title: 'Ok title', category: 'HR', requestId: 'nope' }]) assert.equal((await co('POST', '/approvals', P, body)).status, 400, JSON.stringify(body));
  assert.equal((await co('POST', '/approvals', P, { title: 'Ok title', category: 'HR', requestId: GHOST })).status, 400, 'a request that does not exist');
  assert.equal((await co('POST', '/approvals', P, { title: 'For someone else', category: 'HR', requestedById: A.mid })).status, 403);
  const onBehalf = await co('POST', '/approvals', meera, { title: 'Raised by a manager', category: 'HR', requestedById: A.mid, amount: '1500.456' });
  assert.deepEqual([onBehalf.status, onBehalf.body.requestedBy, onBehalf.body.amount], [201, 'Abhiram', 1500.46]);
  const adminOne = await mkApp(boss, { title: 'Raised by the admin' });
  assert.equal(adminOne.requestedBy, 'boss');
  assert.equal((await co('DELETE', `/approvals/${onBehalf.body.id}`, meera)).status, 200);
  assert.equal((await co('DELETE', `/approvals/${adminOne.id}`, boss)).status, 200);
});
await check('ONLY a manager or admin decides: approve, reject (with a note), escalate, review — not the requester, not a bystander, not an outsider', async () => {
  const x = await mkApp(P, { title: 'Decide me', amount: 2500 });
  for (const who of [P, F, nora]) {
    const r = await decide(who, x.id, 'approve');
    assert.equal(r.status, 403);
    assert.match(r.body.message, /Only the Marketing Manager or Admin can decide/);
  }
  assert.equal((await CoordApproval.findById(x.id).lean()).status, 'pending', 'nothing changed');
  assert.equal((await decide(meera, x.id, 'reject')).status, 400, 'a rejection needs a reason');
  assert.equal((await decide(meera, x.id, 'reject', 'no')).status, 400);
  assert.equal((await decide(meera, x.id, 'delete')).status, 400);
  assert.equal((await decide(meera, GHOST, 'approve')).status, 404);
  const r = await decide(boss, x.id, 'reject', 'Over the monthly cap');
  assert.deepEqual([r.status, r.body.status, r.body.decidedBy, r.body.decisionNote], [200, 'rejected', 'boss', 'Over the monthly cap']);
  const again = await decide(meera, x.id, 'approve');
  assert.equal(again.status, 409);
  assert.match(again.body.message, /already rejected, so it is final/);
  assert.equal((await decide(meera, R.a4.id, 'escalate')).status, 409, 'an approved one is final too');
  assert.equal((await decide(meera, R.a3.id, 'escalate')).status, 409, 'already escalated');
  assert.match((await decide(meera, R.a2.id, 'review')).body.message, /already in review/);
  assert.equal((await decide(meera, R.a3.id, 'approve', 'Approved at the top')).body.status, 'approved', 'an escalated one can still be decided');
  assert.equal((await CoordApproval.findById(R.a3.id).lean()).decidedByName, 'Meera');
  await CoordApproval.updateOne({ _id: R.a3.id }, { status: 'escalated', decidedAt: null, decidedBy: null, decidedByName: '', decisionNote: 'Above my limit' }); // put the data set back
});
await check('the requester is told of a decision (not of "in review"); nothing is posted to accounts — only this module\'s own records change', async () => {
  const y = await mkApp(K, { title: 'Notify me', amount: 999999 });
  const before = await countDocs(['coordapprovals', 'notifications']);
  const told = () => Notification.countDocuments({ recipient: K.id, type: 'coord_approval' });
  const base = await told();
  await decide(meera, y.id, 'review');
  assert.equal(await told(), base, 'moving it to "in review" tells nobody');
  const ok = await decide(meera, y.id, 'approve', 'Fine');
  assert.equal(ok.status, 200);
  assert.equal(await told(), base + 1);
  const last = (await Notification.find({ recipient: K.id, type: 'coord_approval' }).sort({ createdAt: -1 }).limit(1).lean())[0];
  assert.match(last.title, /approved/);
  assert.match(last.body, /Notify me/);
  assert.equal(last.link, '/marketing/coordinations?tab=approvals');
  assert.equal((await Notification.countDocuments({ recipient: meera.id })), 0, 'the one who decided is not told');
  assert.deepEqual(await countDocs(['coordapprovals', 'notifications']), before, 'no expense, ledger or booking record was created or changed');
  const pBase = await Notification.countDocuments({ recipient: P.id, type: 'coord_approval' });
  await decide(meera, R.a1.id, 'escalate');
  assert.equal((await Notification.countDocuments({ recipient: P.id, type: 'coord_approval' })), pBase + 1, 'an escalation tells the requester too');
  await CoordApproval.updateOne({ _id: R.a1.id }, { status: 'pending', escalatedAt: null }); // back to pending for the next checks
});
await check('an approval linked to a request: it is counted once, and approving it moves the waiting request on', async () => {
  const before = (await get('/overview', P)).body.kpis;
  const q = await mkReq(P, { title: 'Waiting for the budget', assigneeId: A.mid });
  await setStatus(A, q.id, 'in_progress');
  await setStatus(A, q.id, 'pending_approval');
  const mid = (await get('/overview', P)).body.kpis;
  assert.equal(mid.pendingApprovals, before.pendingApprovals + 1, 'a request waiting for approval with no approval record is a pending approval');
  assert.deepEqual((await co('GET', '/setup', P)).body.waitingRequests.map((x) => x.title), ['Waiting for the budget'], 'the form offers the requests that are waiting for approval to link to');
  const link = await mkApp(A, { title: 'Budget for the work', requestId: q.id, amount: 4000 });
  const linked = (await get('/overview', P)).body.kpis;
  assert.equal(linked.pendingApprovals, before.pendingApprovals + 1, 'the approval record replaces it — not counted twice');
  assert.equal(linked.total, before.total + 2);
  assert.equal((await decide(meera, link.id, 'reject', 'Not this month')).status, 200);
  assert.equal((await CoordRequest.findById(q.id).lean()).status, 'pending_approval', 'a rejection does not move the request');
  const link2 = await mkApp(A, { title: 'Budget, second try', requestId: q.id, amount: 3000 });
  assert.equal((await decide(meera, link2.id, 'approve', 'OK')).status, 200);
  const moved = await CoordRequest.findById(q.id).lean();
  assert.deepEqual([moved.status, moved.progress >= 75], ['in_progress', true], 'approved: the request is unblocked');
  assert.equal((await get('/overview', P)).body.kpis.pendingApprovals, before.pendingApprovals);
});
await check('changing and withdrawing: a member while it is pending; a manager until it is decided; a decided one is a record', async () => {
  const z = await mkApp(P, { title: 'Change me', amount: 100 });
  assert.equal((await co('PUT', `/approvals/${z.id}`, F, { amount: 5 })).status, 403);
  assert.equal((await co('PUT', `/approvals/${z.id}`, P, { amount: 250, impact: 'Needed for Saturday' })).body.amount, 250);
  assert.equal((await co('PUT', `/approvals/${z.id}`, P, { amount: -1 })).status, 400);
  assert.equal((await co('PUT', `/approvals/${z.id}`, P, { requestedById: A.mid })).status, 403);
  await decide(meera, z.id, 'review');
  const locked = await co('PUT', `/approvals/${z.id}`, P, { amount: 300 });
  assert.equal(locked.status, 403);
  assert.match(locked.body.message, /until it is being reviewed/);
  assert.equal((await co('PUT', `/approvals/${z.id}`, meera, { amount: 300 })).body.amount, 300, 'a manager can still correct it');
  assert.equal((await co('DELETE', `/approvals/${z.id}`, P)).status, 403, 'it is no longer yours to withdraw');
  await decide(meera, z.id, 'approve');
  const done = await co('PUT', `/approvals/${z.id}`, meera, { amount: 1 });
  assert.equal(done.status, 409);
  assert.match(done.body.message, /already approved/);
  assert.equal((await co('DELETE', `/approvals/${z.id}`, meera)).status, 200, 'a manager can remove it');
  const w = await mkApp(P, { title: 'Withdraw me' });
  assert.equal((await co('DELETE', `/approvals/${w.id}`, F)).status, 403);
  assert.equal((await co('DELETE', `/approvals/${w.id}`, P)).status, 200);
  assert.equal((await co('DELETE', `/approvals/${w.id}`, P)).status, 404);
  assert.equal((await co('PUT', `/approvals/${GHOST}`, P, { amount: 1 })).status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— Meetings —');
await Promise.all([CoordMeeting, CoordFollowUp].map((m) => m.deleteMany({})));
const M = {};
await check('scheduling: a title and times that make sense, a real link, attendees who are on the team, departments from the list', async () => {
  const ok = { title: 'Marketing Sync', startAt: minutesFromNow(10), endAt: minutesFromNow(70) };
  for (const body of [{ ...ok, title: '' }, { ...ok, startAt: undefined }, { ...ok, endAt: ok.startAt }, { ...ok, endAt: new Date(Date.now() + 30 * 3600 * 1000).toISOString() }, { ...ok, link: 'javascript:alert(1)' }, { ...ok, attendees: [{ memberId: GHOST }] }, { ...ok, attendees: [{ memberId: 'nope' }] }, { ...ok, departments: ['Mars'] }, { ...ok, agenda: 'one' }, { ...ok, status: 'completed' }]) {
    assert.equal((await co('POST', '/meetings', P, body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  const r = await co('POST', '/meetings', P, { ...ok, location: 'Conference Room', link: 'https://meet.google.com/abc-defg-hij', departments: ['Marketing', 'Socials', 'Sales'], agenda: ['Campaign performance review', ' Upcoming creatives ', ''], attendees: [{ memberId: K.mid }, { memberId: A.mid }, { name: 'Client rep' }], notes: '' });
  assert.equal(r.status, 201, r.text);
  M.future = r.body;
  assert.deepEqual([M.future.status, M.future.state, M.future.agendaCount, M.future.attendeeCount], ['upcoming', 'upcoming', 2, 3]);
  assert.match(M.future.time, /^\d\d:\d\d$/);
  assert.equal(M.future.day, istDay(new Date(ok.startAt)));
  const live = await co('POST', '/meetings', K, { title: 'Studio walk-through', startAt: minutesFromNow(-5), endAt: minutesFromNow(30), departments: ['Production'], attendees: [{ memberId: P.mid }] });
  M.live = live.body;
  assert.equal(M.live.state, 'live');
  M.past = (await co('POST', '/meetings', P, { title: 'Campaign Review – SkyCity', startAt: minutesFromNow(-50), endAt: minutesFromNow(-20), departments: ['Marketing', 'Sales'], agenda: ['Results'], attendees: [{ memberId: K.mid }] })).body;
  assert.equal(M.past.state, 'to_close', 'ended and never closed');
  M.kerala = (await co('POST', '/meetings', meera, { title: 'Kerala launch call', startAt: minutesFromNow(15), endAt: minutesFromNow(45), brand: 'kerala' })).body;
  M.cancel = (await co('POST', '/meetings', P, { title: 'Cancelled call', startAt: minutesFromNow(20), endAt: minutesFromNow(40) })).body;
  assert.equal((await co('PUT', `/meetings/${M.cancel.id}`, P, { status: 'cancelled' })).body.status, 'cancelled');
});
await check('the strip: total, this week, completed, upcoming (including live), and the ones that ended without being closed', async () => {
  const m = (await get('/meetings', P)).body;
  assert.deepEqual(m.kpis, { total: 4, thisWeek: 4, completed: 0, upcoming: 3, toClose: 1 });
  assert.equal(m.total, 4, 'cancelled meetings count nowhere');
  assert.deepEqual(titles(m.items), ['Campaign Review – SkyCity', 'Studio walk-through', 'Marketing Sync', 'Kerala launch call'], 'by time');
  const week = (await co('GET', `/meetings?from=${due(-120)}&to=${due(-100)}`, P)).body;
  assert.deepEqual([week.kpis.total, week.kpis.thisWeek], [0, 4], 'this week is always the week of today');
});
await check('the upcoming list and its filters: status, department, brand, search', async () => {
  const f = async (q) => titles((await get('/meetings', P, q)).body.items);
  assert.deepEqual(await f('&status=upcoming'), ['Studio walk-through', 'Marketing Sync', 'Kerala launch call']);
  assert.deepEqual(await f('&status=to_close'), ['Campaign Review – SkyCity']);
  assert.deepEqual(await f('&status=completed'), []);
  assert.deepEqual(await f('&dept=Sales'), ['Campaign Review – SkyCity', 'Marketing Sync']);
  assert.deepEqual(await f('&brand=kerala'), ['Kerala launch call']);
  assert.deepEqual(await f('&q=walk'), ['Studio walk-through']);
  assert.deepEqual(await f('&q=conference'), ['Marketing Sync'], 'the search reaches the location');
  assert.deepEqual(await f('&q=' + encodeURIComponent('.*')), []);
  assert.equal((await get('/meetings', P, '&status=weird')).status, 400);
});
await check('the detail panel: agenda, attendees (team members by name, others as typed), the way to join', async () => {
  const d = (await co('GET', `/meetings/${M.future.id}`, P)).body;
  assert.deepEqual(d.agenda, ['Campaign performance review', 'Upcoming creatives']);
  assert.deepEqual(d.attendees.map((a) => a.name), ['Ashique', 'Abhiram', 'Client rep']);
  assert.equal(d.attendees[0].memberId, K.mid);
  assert.deepEqual([d.location, d.link, d.departments], ['Conference Room', 'https://meet.google.com/abc-defg-hij', ['Marketing', 'Socials', 'Sales']]);
  assert.equal((await co('GET', `/meetings/${GHOST}`, P)).status, 404);
  assert.equal((await co('GET', '/meetings/nope', P)).status, 404);
});
await check('who may change a meeting: whoever set it up, an attendee, a manager — nobody else; deleting is the organiser\'s or a manager\'s', async () => {
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, F, { notes: 'sneaky' })).status, 403);
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, nora, { notes: 'sneaky' })).status, 403);
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, K, { notes: 'Added by an attendee' })).body.notes, 'Added by an attendee');
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, P, { location: 'Studio 2' })).body.location, 'Studio 2');
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, meera, { title: 'Marketing Sync (weekly)' })).body.title, 'Marketing Sync (weekly)');
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, P, { startAt: minutesFromNow(200) })).status, 400, 'the new start would be after the end');
  assert.equal((await co('PUT', `/meetings/${M.future.id}`, P, { link: 'ftp://x' })).status, 400);
  assert.equal((await co('DELETE', `/meetings/${M.future.id}`, K)).status, 403, 'an attendee does not delete it');
  assert.equal((await co('DELETE', `/meetings/${M.future.id}`, F)).status, 403);
});
await check('closing a meeting: it cannot be completed before it starts; completed with discussion notes and action items; it then counts as completed', async () => {
  const early = await co('PUT', `/meetings/${M.future.id}`, P, { status: 'completed' });
  assert.equal(early.status, 400);
  assert.match(early.body.message, /has not started/);
  const r = await co('PUT', `/meetings/${M.past.id}`, P, {
    status: 'completed',
    notes: 'Agreed the pipeline for the festive season.',
    actionItems: [
      { text: 'Send the revised plan', ownerId: K.mid, due: due(3) },
      { text: 'Book the studio', ownerName: 'Vendor' },
      { text: 'Share the numbers', ownerId: A.mid, due: due(1), done: true },
    ],
  });
  assert.equal(r.status, 200, r.text);
  M.past = r.body;
  assert.deepEqual([M.past.status, M.past.state, !!M.past.completedAt], ['completed', 'completed', true]);
  assert.deepEqual(M.past.actionItems.map((i) => [i.text, i.owner, i.due, i.done]), [['Send the revised plan', 'Ashique', due(3), false], ['Book the studio', 'Vendor', null, false], ['Share the numbers', 'Abhiram', due(1), true]]);
  assert.equal(M.past.openActions, 2);
  const k = (await get('/meetings', P)).body.kpis;
  assert.deepEqual([k.completed, k.toClose, k.upcoming], [1, 0, 3]);
  assert.equal((await get('/meetings', P, '&status=completed')).body.items[0].title, 'Campaign Review – SkyCity');
  assert.equal((await co('PUT', `/meetings/${M.past.id}`, P, { actionItems: [{ text: '' }] })).status, 400);
  assert.equal((await co('PUT', `/meetings/${M.past.id}`, P, { actionItems: [{ text: 'ok', due: '2026-13-40' }] })).status, 400);
});
await check('an action item becomes a follow-up (once, and only with a due day); from then on the follow-up decides whether it is done', async () => {
  const [item1, item2, item3] = M.past.actionItems;
  const conv = (who, id) => co('POST', `/meetings/${M.past.id}/action-items/${id}/follow-up`, who);
  assert.equal((await conv(F, item1.id)).status, 403);
  assert.equal((await conv(P, item2.id)).status, 400, 'no due day yet');
  assert.match((await conv(P, item2.id)).body.message, /due date first/);
  assert.equal((await conv(P, item3.id)).status, 409, 'it is already done');
  assert.equal((await conv(P, GHOST)).status, 404);
  assert.equal((await conv(P, 'nope')).status, 404);
  const r = await conv(P, item1.id);
  assert.equal(r.status, 201, r.text);
  M.fu = r.body.followUp;
  assert.deepEqual([M.fu.item, M.fu.relatedTo, M.fu.owner, M.fu.department, M.fu.dueDate, M.fu.reminder, M.fu.meetingId, M.fu.state], ['Send the revised plan', 'Campaign Review – SkyCity', 'Ashique', 'Marketing', due(3), true, M.past.id, 'upcoming']);
  assert.equal((await conv(P, item1.id)).status, 409, 'already a follow-up');
  assert.equal(r.body.meeting.actionItems[0].followUpId, M.fu.id);
  const listed = (await get('/followups', P)).body.items.find((f) => f.id === M.fu.id);
  assert.ok(listed, 'it shows in Follow-ups');
  // the follow-up is done by its owner → the action item reads done, in the meeting, without anyone typing it twice
  assert.equal((await co('PUT', `/followups/${M.fu.id}`, K, { status: 'done' })).body.state, 'completed');
  let d = (await co('GET', `/meetings/${M.past.id}`, P)).body;
  assert.deepEqual([d.actionItems[0].done, d.openActions], [true, 1]);
  // saving the meeting again cannot undo it from the meeting side
  const resend = await co('PUT', `/meetings/${M.past.id}`, P, { actionItems: d.actionItems.map((i) => ({ id: i.id, text: i.text, ownerId: i.ownerId, ownerName: i.ownerName, due: i.due, done: false })) });
  assert.equal(resend.body.actionItems[0].done, true, 'the follow-up decides');
  assert.equal(resend.body.actionItems[0].followUpId, M.fu.id, 'and the link survives an edit');
  // reopen the follow-up → the item is open again
  await co('PUT', `/followups/${M.fu.id}`, K, { status: 'open' });
  d = (await co('GET', `/meetings/${M.past.id}`, P)).body;
  assert.deepEqual([d.actionItems[0].done, d.openActions], [false, 2], 'open again; the converted one is tracked in Follow-ups, so it is not counted as an open action here (the resend above also reopened the third item)');
  // deleting the follow-up makes it a plain action item again
  assert.equal((await co('DELETE', `/followups/${M.fu.id}`, F)).status, 403);
  assert.equal((await co('DELETE', `/followups/${M.fu.id}`, P)).status, 200);
  d = (await co('GET', `/meetings/${M.past.id}`, P)).body;
  assert.equal(d.actionItems[0].followUpId, null);
  assert.equal(d.openActions, 3, 'a plain open action item again');
});
await check('an item removed in an edit disappears; deleting a meeting keeps its follow-ups (detached); cancelling is how a meeting is called off', async () => {
  const d0 = (await co('GET', `/meetings/${M.past.id}`, P)).body;
  const conv = await co('POST', `/meetings/${M.past.id}/action-items/${d0.actionItems[0].id}/follow-up`, P);
  const fuId = conv.body.followUp.id;
  const kept = await co('PUT', `/meetings/${M.past.id}`, P, { actionItems: d0.actionItems.slice(0, 1).map((i) => ({ id: i.id, text: i.text, ownerId: i.ownerId, due: i.due })) });
  assert.equal(kept.body.actionItems.length, 1);
  assert.equal(kept.body.actionItems[0].followUpId, fuId);
  assert.equal((await co('DELETE', `/meetings/${M.past.id}`, K)).status, 403);
  assert.equal((await co('DELETE', `/meetings/${M.past.id}`, P)).status, 200);
  assert.equal((await co('GET', `/meetings/${M.past.id}`, P)).status, 404);
  const left = await CoordFollowUp.findById(fuId).lean();
  assert.deepEqual([!!left, left.meetingId], [true, null], 'the follow-up stays, and keeps what it was related to');
  assert.equal(left.relatedTo, 'Campaign Review – SkyCity');
  assert.equal((await co('DELETE', `/meetings/${M.live.id}`, meera)).status, 200, 'a manager deletes any');
  assert.equal((await co('DELETE', `/meetings/${M.live.id}`, meera)).status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— Follow-ups —');
await CoordFollowUp.deleteMany({});
const FU = {};
await check('adding a follow-up: what and when are needed; the owner is you unless you name someone; an admin who is not on the team owns nothing by default', async () => {
  for (const body of [{ dueDate: due(1) }, { item: 'Ok item' }, { item: 'Ok item', dueDate: '2026-02-30' }, { item: 'Ok item', dueDate: due(1), department: 'Mars' }, { item: 'Ok item', dueDate: due(1), ownerId: 'nope' }, { item: 'Ok item', dueDate: due(1), meetingId: 'nope' }, { item: 'Ok item', dueDate: due(1), status: 'overdue' }]) assert.equal((await co('POST', '/followups', P, body)).status, 400, JSON.stringify(body));
  assert.equal((await co('POST', '/followups', P, { item: 'Ok item', dueDate: due(1), ownerId: GHOST })).status, 400);
  assert.equal((await co('POST', '/followups', P, { item: 'Ok item', dueDate: due(1), meetingId: GHOST })).status, 400);
  FU.f1 = (await co('POST', '/followups', P, { item: 'Get final content approval', relatedTo: 'Bridal Campaign', dueDate: due(0), reminder: true })).body;
  assert.deepEqual([FU.f1.owner, FU.f1.ownerId, FU.f1.department, FU.f1.state, FU.f1.reminder, FU.f1.status], ['Preethi', P.mid, 'Marketing', 'due_today', true, 'open']);
  const adminOne = (await co('POST', '/followups', boss, { item: 'Admin to-do', dueDate: due(40) })).body;
  assert.equal(adminOne.owner, '');
  assert.equal(adminOne.ownerId, null);
  await CoordFollowUp.deleteOne({ _id: adminOne.id });
});
await check('build the follow-ups: due today, upcoming, overdue in the range, overdue from before it, done, another brand, outside the range', async () => {
  const mk = async (who, body) => (await co('POST', '/followups', who, body)).body;
  FU.f2 = await mk(P, { item: 'Share revised video (v2)', relatedTo: 'Studio Shoot', ownerId: A.mid, department: 'Production', dueDate: due(1) });
  FU.f3 = await mk(P, { item: 'Confirm budget for hiring ad', relatedTo: 'Sales Hiring', ownerId: J.mid, department: 'HR', dueDate: due(-1) });
  FU.f4 = await mk(P, { item: 'Collect campaign leads report', relatedTo: 'Meta Campaign – Oct', ownerId: F.mid, department: 'Sales', dueDate: due(-3) });
  FU.f5 = await mk(P, { item: 'Follow up on location confirmation', relatedTo: 'Brand Shoot', ownerId: K.mid, department: 'Production', dueDate: due(2) });
  FU.f6 = await mk(P, { item: 'Send moodboard', dueDate: due(-2) });
  await co('PUT', `/followups/${FU.f6.id}`, P, { status: 'done' });
  FU.f7 = await mk(P, { item: 'Chase the print vendor', dueDate: due(-50) });
  FU.f8 = await mk(meera, { item: 'Kerala shoot permissions', ownerId: P.mid, dueDate: due(3), brand: 'kerala' });
  FU.f9 = await mk(P, { item: 'Next quarter review', dueDate: due(45) });
  assert.equal((await CoordFollowUp.countDocuments({})), 9);
});
await check('the strip: total = completed + overdue + due today + upcoming; an overdue follow-up from before the range is still counted', async () => {
  const f = (await get('/followups', P)).body;
  assert.deepEqual(f.kpis, { total: 8, dueToday: 1, upcoming: 3, overdue: 3, completed: 1 }, 'F1 today · F2 F5 F8 upcoming · F3 F4 and F7 (from before the range) overdue · F6 done; F9 is outside');
  assert.equal(f.kpis.total, f.kpis.dueToday + f.kpis.upcoming + f.kpis.overdue + f.kpis.completed);
  assert.equal(f.total, 8);
  const rows = Object.fromEntries(f.items.map((x) => [x.id, x]));
  assert.deepEqual([rows[FU.f1.id].state, rows[FU.f2.id].state, rows[FU.f3.id].state, rows[FU.f6.id].state, rows[FU.f7.id].state], ['due_today', 'upcoming', 'overdue', 'completed', 'overdue']);
  assert.equal(rows[FU.f9.id], undefined);
  assert.deepEqual(f.items.map((x) => x.state).slice(-1), ['completed'], 'open ones first, by day');
  const todayOnly = await co('GET', `/followups?from=${today}&to=${today}`, P);
  assert.deepEqual(todayOnly.body.kpis, { total: 4, dueToday: 1, upcoming: 0, overdue: 3, completed: 0 }, 'a one-day range still carries what is overdue');
  const next = await co('GET', `/followups?from=${due(10)}&to=${due(20)}`, P);
  assert.deepEqual(next.body.kpis, { total: 3, dueToday: 0, upcoming: 0, overdue: 3, completed: 0 }, 'a future range: only what is overdue now');
});
await check('the Overdue panel lists every open follow-up past its day, longest first, whatever the range', async () => {
  const o = (await co('GET', `/followups?from=${due(10)}&to=${due(20)}`, P)).body.overdue;
  assert.equal(o.total, 3);
  assert.deepEqual(o.items.map((x) => [x.item, x.daysAgo]), [['Chase the print vendor', 50], ['Collect campaign leads report', 3], ['Confirm budget for hiring ad', 1]]);
  assert.equal(o.items[0].state, 'overdue');
  assert.equal((await get('/followups', P, `&ownerId=${F.mid}`)).body.overdue.total, 1, 'the owner filter narrows the panel too');
  assert.equal((await get('/followups', P, '&dept=HR')).body.overdue.total, 1);
});
await check('filters: status, owner, department, brand, search; paging', async () => {
  const f = async (q) => (await get('/followups', P, q)).body;
  assert.deepEqual((await f('&status=overdue')).items.map((x) => x.item).sort(), ['Chase the print vendor', 'Collect campaign leads report', 'Confirm budget for hiring ad']);
  assert.equal((await f('&status=due_today')).total, 1);
  assert.equal((await f('&status=upcoming')).total, 3);
  assert.equal((await f('&status=completed')).total, 1);
  assert.deepEqual((await f(`&ownerId=${P.mid}`)).items.map((x) => x.item).sort(), ['Chase the print vendor', 'Get final content approval', 'Kerala shoot permissions', 'Send moodboard']);
  assert.equal((await f('&dept=Production')).total, 2);
  assert.equal((await f('&brand=kerala')).total, 1);
  assert.equal((await f('&brand=main')).total, 7);
  assert.deepEqual((await f('&q=moodboard')).items.map((x) => x.item), ['Send moodboard']);
  assert.deepEqual((await f('&q=meta')).items.map((x) => x.item), ['Collect campaign leads report'], 'the search reaches what it is related to');
  assert.equal((await f('&q=' + encodeURIComponent('.*'))).total, 0);
  assert.equal((await f('&limit=3&page=3')).items.length, 2);
  for (const q of ['&status=weird', '&ownerId=nope', '&dept=Mars']) assert.equal((await get('/followups', P, q)).status, 400, q);
});
await check('the month calendar is a view over the same follow-ups: per day open / done / overdue; filters carry over; a bad month is refused', async () => {
  const month = today.slice(0, 7);
  const all = Object.values(FU).filter((f) => f.dueDate.startsWith(month));
  const expectFor = (list) => {
    const by = new Map();
    for (const f of list) {
      const d = by.get(f.dueDate) ?? { day: f.dueDate, total: 0, open: 0, done: 0, overdue: 0 };
      d.total += 1;
      const done = f.id === FU.f6.id;
      if (done) d.done += 1;
      else {
        d.open += 1;
        if (f.dueDate < today) d.overdue += 1;
      }
      by.set(f.dueDate, d);
    }
    return [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  };
  const c = (await get('/followups/calendar', P, `&month=${month}`)).body;
  assert.equal(c.month, month);
  assert.equal(c.today, today);
  assert.deepEqual(c.days, expectFor(all));
  assert.deepEqual((await get('/followups/calendar', P)).body.days, c.days, 'the month defaults to this month');
  const mine = (await get('/followups/calendar', P, `&month=${month}&ownerId=${P.mid}`)).body.days;
  assert.deepEqual(mine, expectFor(all.filter((f) => [FU.f1.id, FU.f6.id, FU.f7.id, FU.f8.id].includes(f.id))));
  assert.deepEqual((await get('/followups/calendar', P, `&month=${month}&dept=Nope`)).status, 400);
  const prevMonth = `${addDays(`${month}-01`, -1).slice(0, 7)}`;
  assert.deepEqual((await get('/followups/calendar', P, `&month=${prevMonth}`)).body.days, expectFor(Object.values(FU).filter((f) => f.dueDate.startsWith(prevMonth))));
  for (const m of ['2026-13', 'x', '2026-1', '202611']) assert.equal((await get('/followups/calendar', P, `&month=${m}`)).status, 400, m);
});
await check('who may change one: whoever made it, its owner, a manager; marking it done stamps the day and reopening clears it; deleting is the maker\'s or a manager\'s', async () => {
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, F, { item: 'Hijacked' })).status, 403);
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, nora, { item: 'Hijacked' })).status, 403);
  const own = await co('PUT', `/followups/${FU.f5.id}`, K, { status: 'done' });
  assert.deepEqual([own.status, own.body.state, !!own.body.doneAt], [200, 'completed', true], 'the owner marks it done');
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, K, { status: 'open' })).body.doneAt, null);
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, P, { dueDate: due(4), reminder: true })).body.reminder, true, 'the one who made it');
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, meera, { department: 'Design' })).body.department, 'Design');
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, K, { dueDate: 'soon' })).status, 400);
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, K, { ownerId: GHOST })).status, 400);
  assert.equal((await co('PUT', `/followups/${FU.f5.id}`, meera, { ownerId: J.mid })).body.owner, 'Jithya');
  assert.equal((await co('DELETE', `/followups/${FU.f5.id}`, J)).status, 403, 'the owner does not delete what someone else made');
  assert.equal((await co('DELETE', `/followups/${FU.f5.id}`, P)).status, 200);
  assert.equal((await co('DELETE', `/followups/${FU.f5.id}`, P)).status, 404);
  assert.equal((await co('DELETE', `/followups/${FU.f8.id}`, meera)).status, 200);
  assert.equal((await co('PUT', `/followups/${GHOST}`, P, { item: 'x y' })).status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n— CSV rows: the same records, all of them —');
await check('each report returns its columns and one row per record on screen, with the same filters', async () => {
  const rq = (await get('/export/requests', P)).body;
  assert.deepEqual(rq.columns.slice(0, 3), ['Request', 'Type', 'Requested by']);
  assert.equal(rq.rows.length, (await get('/requests', P)).body.total);
  assert.ok(rq.rows.some((r) => r[0] === 'Edit bridal campaign v2' && r[1] === 'Request' && r[2] === 'Preethi' && r[8] === 'In Progress'));
  assert.ok(rq.rows.some((r) => r[1] === 'Handover'));
  assert.equal((await get('/export/requests', P, '&status=overdue')).body.rows.length, 1, 'the tab\'s filters carry into the file');
  assert.equal((await get('/export/requests', P, '&brand=kerala')).body.rows.length, 1);
  const ap = (await get('/export/approvals', P)).body;
  assert.equal(ap.rows.length, (await get('/approvals', P, '&status=all')).body.total);
  assert.deepEqual(ap.columns.slice(0, 4), ['Approval', 'Category', 'Requested by', 'Amount (INR)']);
  assert.ok(ap.rows.some((r) => r[0] === 'Campaign ad budget – Nov' && r[3] === 20000));
  assert.ok(ap.rows.every((r) => typeof r[3] === 'number'), 'amounts are numbers, so a sheet can add them up');
  const mt = (await get('/export/meetings', P)).body;
  assert.equal(mt.rows.length, (await get('/meetings', P)).body.total);
  assert.ok(mt.rows.some((r) => r[0] === 'Marketing Sync (weekly)' && r[5] === 'Marketing; Socials; Sales' && /Ashique; Abhiram; Client rep/.test(r[7])));
  const fu = (await get('/export/followups', P)).body;
  assert.equal(fu.rows.length, (await get('/followups', P)).body.total);
  assert.ok(fu.rows.some((r) => r[0] === 'Send moodboard' && r[5] === 'completed'));
  assert.equal((await get('/export/followups', P, `&ownerId=${P.mid}`)).body.rows.length, 3, 'Preethi\'s: today, the moodboard, the vendor (the Kerala one was deleted)');
  assert.equal((await get('/export/nothing', P)).status, 404);
  assert.equal((await get('/export/requests', P, '&from=nope')).status, 400);
  assert.equal((await get('/export/requests', outsider)).status, 403);
});

console.log('\n— one request, every screen —');
await check('a request logged once shows in the Overview, the table, the by-department split and the CSV; completing it moves the same figures everywhere', async () => {
  const before = { o: (await get('/overview', P)).body, r: (await get('/requests', P)).body, x: (await get('/export/requests', P)).body };
  const mine = await mkReq(P, { title: 'One record, many screens', fromDept: 'Marketing', toDept: 'Design', assigneeId: P.mid, dueDate: due(0), priority: 'high' });
  const after = { o: (await get('/overview', P)).body, r: (await get('/requests', P)).body, x: (await get('/export/requests', P)).body };
  assert.equal(after.o.kpis.total, before.o.kpis.total + 1);
  assert.equal(after.r.kpis.total, before.r.kpis.total + 1);
  assert.equal(after.x.rows.length, before.x.rows.length + 1);
  assert.equal(after.o.tabCounts.my, before.o.tabCounts.my + 1);
  assert.equal(after.r.tabCounts.my, before.r.tabCounts.my + 1);
  const design = (r) => r.byDepartment.rows.find((x) => x.label === 'Design')?.count ?? 0;
  assert.equal(design(after.o), design(before.o) + 1);
  assert.ok(after.o.recent.some((x) => x.id === mine.id));
  assert.equal(after.o.kpis.pending, before.o.kpis.pending + 1);
  await setStatus(P, mine.id, 'completed');
  const done = { o: (await get('/overview', P)).body, r: (await get('/requests', P)).body };
  assert.equal(done.o.kpis.completed, before.o.kpis.completed + 1);
  assert.equal(done.r.kpis.completed, before.r.kpis.completed + 1);
  assert.equal(done.o.kpis.pending, before.o.kpis.pending, 'it moved out of pending');
  assert.equal(done.o.kpis.onTimeOf, before.o.kpis.onTimeOf + 1, 'and into the on-time rate, because it has a due day');
  assert.equal(done.o.kpis.onTimeRate, Math.round(((before.o.kpis.onTimeRate / 100) * before.o.kpis.onTimeOf + 1) / (before.o.kpis.onTimeOf + 1) * 100), 'closed the day it was due: on time');
  assert.equal(done.r.items.find((x) => x.id === mine.id).onTime, true);
  assert.equal((await co('DELETE', `/requests/${mine.id}`, P)).status, 200);
  assert.equal((await get('/overview', P)).body.kpis.total, before.o.kpis.total, 'deleting it takes it out of every figure again');
});
await check('leaving the data: what is in review elsewhere never gets typed here — the approvals tab and the Overview read the same posts and assets', async () => {
  assert.deepEqual((await get('/approvals', P)).body.review.items.map((x) => x.id), (await get('/overview', P)).body.approvalsPending.review.items.map((x) => x.id));
});


// ── the audit's fixes (T10, C1, C2, C3) ─────────────────────────────────────
const Task = await imp('models/MarketingTask.js');
const { runFollowUpReminders, _resetFollowUpSweep } = await import(new URL('services/marketingCoordReminders.js', root));
const tm = (p, w, b) => call(w ? (b === undefined ? 'GET' : 'PUT') : 'GET', `/team${p}`, w, b);

console.log('\n— T10: the Team Dashboard\'s tasks are in the task table; closing one in either place shows in both —');
await check('a team task given to Preethi is in her My Tasks (Marketing → Marketing), not in the request figures; kind and department cut it', async () => {
  const before = (await get('/requests', P, '&scope=my')).body;
  const t = await Task.create({ title: 'Cut the expo teaser', assigneeId: P.mid, dueDate: due(1), priority: 'high', status: 'blocked', progress: 30, createdBy: meera.id });
  const r = (await get('/requests', P, '&scope=my')).body;
  const row = r.items.find((x) => x.id === String(t._id));
  assert.deepEqual([row.kind, row.fromDept, row.toDept, row.status, row.taskStatus, row.requestedBy, row.canEdit, row.canDelete, row.link], ['task', 'Marketing', 'Marketing', 'waiting_input', 'blocked', 'Meera', true, false, '/marketing/team?tab=tasks']);
  assert.ok(row.taskStatuses.includes('completed') && !row.taskStatuses.includes('blocked'));
  assert.equal(r.tabCounts.my, before.tabCounts.my + 1);
  assert.equal(r.teamTasks >= 1, true);
  assert.deepEqual(r.kpis, before.kpis, 'the request strip counts requests only');
  assert.ok((await get('/overview', P)).body.tasks.my.some((x) => x.id === String(t._id)), 'the Overview\'s task table too');
  assert.ok(!(await get('/requests', P, '&scope=my&kind=request')).body.items.some((x) => x.kind === 'task'));
  assert.ok((await get('/requests', P, '&scope=my&kind=task')).body.items.every((x) => x.kind === 'task'));
  assert.ok(!(await get('/requests', P, '&scope=my&dept=Sales')).body.items.some((x) => x.kind === 'task'), 'a team task is Marketing work');
  // closed where it lives (the Team Dashboard) → the Coordinations table shows it completed
  const closed = await tm(`/tasks/${t._id}`, P, { status: 'completed' });
  assert.equal(closed.status, 200, closed.text);
  const after = (await get('/requests', P, '&scope=my')).body.items.find((x) => x.id === String(t._id));
  assert.deepEqual([after.status, after.taskStatus, after.progress], ['completed', 'completed', 100]);
  const csv = (await get('/export/requests', P, '&scope=my')).body;
  assert.ok(csv.rows.some((x) => x[0] === 'Cut the expo teaser' && x[1] === 'Team task' && x[8] === 'Completed'));
  await Task.deleteOne({ _id: t._id });
});
await check('a request given to a member is on the Team Dashboard (its counts and the member\'s tasks) — one record, read by both', async () => {
  const q = await mkReq(meera, { title: 'Shoot the venue walkthrough', fromDept: 'Sales', toDept: 'Marketing', assigneeId: P.mid, dueDate: due(2) });
  const mine = await tm(`/tasks?scope=mine&from=${due(-30)}&to=${due(30)}`, P);
  assert.equal(mine.status, 200, mine.text);
  const row = mine.body.items.find((x) => x.id === q.id);
  assert.deepEqual([row.source, row.status, row.canEdit], ['request', 'not_started', false]);
  await setStatus(P, q.id, 'in_progress');
  await setStatus(P, q.id, 'completed');
  const done = (await tm(`/tasks?scope=mine&from=${due(-30)}&to=${due(30)}`, P)).body.items.find((x) => x.id === q.id);
  assert.deepEqual([done.status, done.progress], ['completed', 100]);
  assert.equal((await co('DELETE', `/requests/${q.id}`, meera)).status, 200);
});

console.log('\n— C1: a follow-up reminder tells its owner once per due day —');
const toldAbout = (who, text) => Notification.countDocuments({ recipient: who.id, type: 'coord_followup_due', body: new RegExp(text) });
await check('due today: the owner is told when the Follow-ups are read — once, however often they are read or the scheduler runs', async () => {
  const f = (await co('POST', '/followups', meera, { item: 'Chase the florist quote', ownerId: P.mid, dueDate: due(0), reminder: true })).body;
  const quiet = (await co('POST', '/followups', meera, { item: 'No reminder please', ownerId: P.mid, dueDate: due(0), reminder: false })).body;
  const raced = (await co('POST', '/followups', meera, { item: 'Book the venue recce', ownerId: P.mid, dueDate: due(0), reminder: true })).body;
  await Promise.all([runFollowUpReminders(), runFollowUpReminders(), runFollowUpReminders(), runFollowUpReminders()]);
  assert.equal(await toldAbout(P, 'Book the venue recce'), 1, 'four runs at once: the atomic stamp lets exactly one send');
  await co('DELETE', `/followups/${raced.id}`, meera);
  _resetFollowUpSweep();
  assert.equal((await get('/followups', P)).status, 200);
  assert.equal(await toldAbout(P, 'Chase the florist quote'), 1);
  const n1 = (await Notification.findOne({ recipient: P.id, body: /Chase the florist quote/ }).lean());
  assert.deepEqual([n1.title, n1.link], ['Follow-up due today', '/marketing/coordinations?tab=followups']);
  _resetFollowUpSweep();
  await get('/followups', P);
  await Promise.all([runFollowUpReminders(), runFollowUpReminders(), runFollowUpReminders()]);
  assert.equal(await toldAbout(P, 'Chase the florist quote'), 1, 'never twice for the same due day, even when runs race');
  assert.equal(await toldAbout(P, 'No reminder please'), 0, 'reminder off → nothing');
  assert.equal((await CoordFollowUp.findById(f.id).lean()).remindedFor, due(0));
  // the due day moves (and is now past): it is armed again — and says overdue
  await co('PUT', `/followups/${f.id}`, meera, { dueDate: due(-1) });
  await runFollowUpReminders();
  assert.equal(await toldAbout(P, 'Chase the florist quote'), 2);
  assert.equal((await Notification.find({ recipient: P.id, body: /Chase the florist quote/ }).sort({ createdAt: -1 }).limit(1).lean())[0].title, 'Follow-up overdue');
  // done → never again
  await co('PUT', `/followups/${f.id}`, meera, { status: 'done', dueDate: due(-3) });
  await runFollowUpReminders();
  assert.equal(await toldAbout(P, 'Chase the florist quote'), 2);
  await co('DELETE', `/followups/${f.id}`, meera);
  await co('DELETE', `/followups/${quiet.id}`, meera);
});
await check('an owner typed by name (no login) → the person who made the follow-up is told; a future one waits', async () => {
  const f = (await co('POST', '/followups', meera, { item: 'Call the outside photographer', ownerId: null, ownerName: 'Vendor Ravi', dueDate: due(0), reminder: true })).body;
  const later = (await co('POST', '/followups', meera, { item: 'Next week thing', ownerId: P.mid, dueDate: due(5), reminder: true })).body;
  await runFollowUpReminders();
  assert.equal(await toldAbout(meera, 'Call the outside photographer'), 1);
  assert.equal(await toldAbout(P, 'Next week thing'), 0, 'not due yet');
  await co('DELETE', `/followups/${f.id}`, meera);
  await co('DELETE', `/followups/${later.id}`, meera);
});

console.log('\n— C2: an escalation goes up, and says to whom —');
await check('escalating records who it went to and who escalated it; the CEO and the Marketing Managers are told; the app reads "Escalated to …"', async () => {
  const ceo = await login('Anjali', 'ceo');
  const ed = await login('Rafeeq', 'executive_director');
  const a = await mkApp(K, { title: 'Billboard on MG Road', amount: 250000 });
  const r = await co('POST', `/approvals/${a.id}/decide`, meera, { decision: 'escalate', note: 'Above my limit' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.status, 'escalated');
  assert.equal(r.body.escalatedBy, 'Meera');
  assert.match(r.body.escalatedToLabel, /^Escalated to Anjali \(CEO\), Rafeeq \(Executive Director\)/);
  assert.ok(r.body.escalatedTo.some((p) => p.title === 'Marketing Manager' && p.name === 'boss'), 'the Marketing Managers too');
  assert.ok(!r.body.escalatedTo.some((p) => p.name === 'Meera'), 'the one escalating is not in the list');
  const stored = await CoordApproval.findById(a.id).lean();
  assert.equal(String(stored.escalatedBy), meera.id);
  for (const who of [ceo, ed]) {
    const n = await Notification.findOne({ recipient: who.id, type: 'coord_approval' }).lean();
    assert.ok(n, `${who.name} is told`);
    assert.equal(n.title, 'Approval escalated to you');
    assert.match(n.body, /Billboard on MG Road/);
    assert.match(n.body, /escalated by Meera/);
  }
  assert.equal(await Notification.countDocuments({ recipient: meera.id, title: 'Approval escalated to you' }), 0);
  const listed = (await get('/approvals', meera, '&status=in_review')).body.items.find((x) => x.id === a.id);
  assert.match(listed.escalatedToLabel, /Anjali \(CEO\)/);
  const csv = (await get('/export/approvals', meera)).body;
  assert.ok(csv.columns.includes('Escalated to'));
  assert.ok(csv.rows.some((x) => x[0] === 'Billboard on MG Road' && /Anjali \(CEO\)/.test(x[10])));
  await co('DELETE', `/approvals/${a.id}`, meera);
});

console.log('\n— C3: the Overview exports —');
await check('the Overview exports its figures: the headline strip, the department split, what waits and what is coming up', async () => {
  const x = await get('/export/overview', P);
  assert.equal(x.status, 200, x.text);
  assert.deepEqual(x.body.columns, ['Section', 'Item', 'Value', 'Note']);
  const o = (await get('/overview', P)).body;
  const head = (label) => x.body.rows.find((r) => r[0] === 'Headline' && r[1] === label)?.[2];
  assert.equal(head('Total requests & approvals'), o.kpis.total);
  assert.equal(head('Overdue'), o.kpis.overdue);
  assert.equal(x.body.rows.filter((r) => r[0] === 'Requests by department').length, o.byDepartment.rows.length);
  assert.equal(x.body.rows.filter((r) => r[0] === 'Waiting for approval').length, o.approvalsPending.approvalCount);
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
