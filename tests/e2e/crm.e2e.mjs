// End-to-end check of the CRM team's work (/api/crm and what feeds it): the CRM Head role, booking requests that are handed out and
// decided (and who gets the credit), chats claimed by the first reply, cases opened by an unhappy review (once), the case tracker's
// rules, overdue alerts sent once, and who may see whose work.
// Against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against anything else, and drops its
// database first):
//
//   mkdir -p /tmp/crm-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/crm-e2e --fork --logpath /tmp/crm-e2e/log
//   node tests/e2e/crm.e2e.mjs
//
// Not part of `node --test tests/*.test.js` (those are pure; this one needs a database).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first — no booking e-mail, SMS, WhatsApp, maps or AI call reaches anybody.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/crm_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const mod = (p) => import(new URL(p, root));
const User = await imp('models/User.js');
const Role = await imp('models/Role.js');
const Booking = await imp('models/Booking.js');
const Review = await imp('models/Review.js');
const Trial = await imp('models/Trial.js');
const CrmCase = await imp('models/CrmCase.js');
const Conversation = await imp('models/Conversation.js');
const ClientUser = await imp('models/ClientUser.js');
const Notification = await imp('models/Notification.js');
const Message = await imp('models/Message.js');
const DepartmentReport = await imp('models/DepartmentReport.js');
const { ensureDefaultRoles } = await mod('controllers/roleController.js');
const { claimEach, runCrmSweep, _resetCrmSweep } = await mod('services/crmSweep.js');
const { _resetCrmTeamCache } = await mod('services/crmTeam.js');
const { sanitizeErrorResponses, errorHandler } = await mod('middleware/errorMiddleware.js');
await CrmCase.init(); // the one-case-per-review index must exist before two saves race

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/bookings', await imp('routes/bookingRoutes.js'));
app.use('/api/reviews', await imp('routes/reviewRoutes.js'));
app.use('/api/chat', await imp('routes/chatRoutes.js'));
app.use('/api/crm', await imp('routes/crmRoutes.js'));
app.use('/api/reports', await imp('routes/reportRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

const download = async (path, token) => {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, type: res.headers.get('content-type') ?? '', name: res.headers.get('content-disposition') ?? '', bytes: Buffer.from(await res.arrayBuffer()) };
};
const api = async (method, path, token, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
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
const ok = (r, what) => assert.ok(r.status >= 200 && r.status < 300, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
const notes = async (user, type) => Notification.find({ recipient: user._id, ...(type ? { type } : {}) }).lean();

// ── roles ───────────────────────────────────────────────────────────────────
console.log('Roles');
await check('a CRM role an admin customised keeps its HR access; the untouched default loses it; the CRM Head role exists', async () => {
  await Role.create({ key: 'crm', label: 'CRM', permissions: ['clients', 'calendar', 'bookings', 'trials', 'staff', 'leads'], homeRoute: '/booking/requests' });
  await ensureDefaultRoles();
  assert.ok((await Role.findOne({ key: 'crm' }).lean()).permissions.includes('staff'), 'customised: left alone');
  await Role.updateOne({ key: 'crm' }, { $set: { permissions: ['clients', 'calendar', 'bookings', 'trials', 'staff'] } });
  await ensureDefaultRoles();
  assert.deepEqual([...(await Role.findOne({ key: 'crm' }).lean()).permissions].sort(), ['bookings', 'calendar', 'clients', 'trials']);
  const head = await Role.findOne({ key: 'crm_manager' }).lean();
  assert.equal(head?.label, 'CRM Head');
  assert.ok(!head.permissions.includes('staff'));
});

// ── people ──────────────────────────────────────────────────────────────────
const mkUser = async (key, role, extra = {}) => {
  const user = await User.create({ name: key, email: `${key}@e2e.test`, password: 'secret123', role, ...extra });
  return { user, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const head = await mkUser('Meera', 'crm_manager');
const asha = await mkUser('Asha', 'crm');
const bina = await mkUser('Bina', 'crm');
const admin = await mkUser('Admin', 'admin');
const ceo = await mkUser('Ceo', 'ceo');
const sales = await mkUser('Sam', 'sales');
_resetCrmTeamCache();

console.log('Who is who');
await check('/me: the head, a member, management, leadership; anyone else is refused', async () => {
  const me = async (u) => (await api('GET', '/crm/me', u.token)).body;
  assert.deepEqual([(await me(head)).viewer, (await me(head)).canAssign], ['head', true]);
  assert.deepEqual([(await me(asha)).viewer, (await me(asha)).canAssign, (await me(asha)).onTeam], ['member', false, true]);
  assert.equal((await me(admin)).viewer, 'admin');
  assert.deepEqual([(await me(ceo)).viewer, (await me(ceo)).canWrite], ['leadership', false]);
  assert.equal((await api('GET', '/crm/me', sales.token)).status, 403);
  assert.ok((await me(head)).settings.requestSlaHours === 24 && (await me(head)).trackingSince);
});
await check('the CRM Head is let into the client chat (it used to check for the exact role "crm")', async () => {
  ok(await api('GET', '/chat/conversations', head.token), 'chat inbox');
});
await check('the team: everyone with a CRM role, the head marked', async () => {
  const r = await api('GET', '/crm/team', head.token);
  ok(r, 'team');
  assert.deepEqual(r.body.members.map((m) => [m.name, m.isHead]), [['Asha', false], ['Bina', false], ['Meera', true]]);
  assert.equal((await api('GET', '/crm/team', asha.token)).status, 403, 'a member does not see the team');
  ok(await api('GET', '/crm/team', ceo.token), 'leadership reads');
});

// ── booking requests ────────────────────────────────────────────────────────
console.log('Booking requests');
const publicBooking = async (name, phone) => {
  const r = await api('POST', '/bookings/public', null, {
    customerName: name,
    phone,
    email: `${phone}@client.test`,
    service: 'Bridal Makeup',
    bookingDate: '2027-01-20',
    selectedDates: ['2027-01-20'],
    totalPrice: 25000,
  });
  ok(r, 'public booking');
  return r.body._id ?? r.body.booking?._id;
};
const reqId = await publicBooking('Client One', '9895011111');
const req2 = await publicBooking('Client Two', '9895022222');

await check('a request from the public form records where it came from and when', async () => {
  const b = await Booking.findById(reqId).lean();
  assert.equal(b.status, 'pending');
  assert.equal(b.origin, 'public');
  assert.equal(b.statusHistory.length, 1);
  assert.equal(b.crmOwnerId ?? null, null);
});
await check('new requests wait in Unassigned; a member\'s own queue is empty', async () => {
  const un = (await api('GET', '/crm/queue?scope=unassigned&types=booking', asha.token)).body;
  assert.deepEqual(un.items.map((i) => i.title).sort(), ['Client One', 'Client Two']);
  assert.equal((await api('GET', '/crm/queue?scope=mine', asha.token)).body.counts.total, 0);
  assert.equal((await api('GET', '/crm/queue?scope=all', asha.token)).status, 403, 'a member does not see everyone\'s work');
  assert.equal((await api('GET', `/crm/queue?memberId=${bina.user._id}`, asha.token)).status, 403);
});
await check('a member takes an unassigned request; a second member cannot take it from her', async () => {
  const r = await api('POST', '/crm/assign', asha.token, { items: [{ type: 'booking', id: reqId }], ownerId: String(asha.user._id) });
  ok(r, 'claim');
  assert.equal(r.body.assigned, 1);
  const r2 = await api('POST', '/crm/assign', bina.token, { items: [{ type: 'booking', id: reqId }], ownerId: String(bina.user._id) });
  assert.equal(r2.body.assigned, 0);
  assert.match(r2.body.skipped[0].reason, /already has it/);
  assert.equal((await api('POST', '/crm/assign', asha.token, { items: [{ type: 'booking', id: req2 }], ownerId: String(bina.user._id) })).status, 403, 'a member cannot give work away');
  assert.equal((await api('POST', '/crm/assign', ceo.token, { items: [{ type: 'booking', id: req2 }], ownerId: String(asha.user._id) })).status, 403, 'leadership only reads');
});
await check('the head hands work out (and re-assigns it); the new owner is told once, in one notice', async () => {
  const before = (await notes(bina.user, 'crm_assigned')).length;
  const r = await api('POST', '/crm/assign', head.token, {
    items: [{ type: 'booking', id: reqId }, { type: 'booking', id: req2 }, { type: 'booking', id: req2 }],
    ownerId: String(bina.user._id),
  });
  ok(r, 'assign');
  assert.equal(r.body.assigned, 2, JSON.stringify(r.body));
  const after = await notes(bina.user, 'crm_assigned');
  assert.equal(after.length, before + 1);
  assert.match(after.at(-1).title, /2 booking requests/);
  const again = await api('POST', '/crm/assign', head.token, { items: [{ type: 'booking', id: reqId }], ownerId: String(bina.user._id) });
  assert.match(again.body.skipped[0].reason, /Already with Bina/);
  assert.equal((await api('POST', '/crm/assign', head.token, { items: [{ type: 'booking', id: reqId }], ownerId: String(sales.user._id) })).status, 400, 'not on the CRM team');
  const mine = (await api('GET', '/crm/queue?scope=mine&types=booking', bina.token)).body;
  assert.equal(mine.counts.booking, 2);
  assert.equal(mine.items[0].ownerName, 'Bina');
});
await check('confirming a request records who decided and credits the owner; an old-style full update keeps the owner', async () => {
  const full = (await api('GET', `/bookings/${reqId}`, asha.token)).body;
  const r = await api('PUT', `/bookings/${reqId}`, asha.token, { ...full, status: 'confirmed', crmOwnerId: null, crmOwnerName: '' });
  ok(r, 'confirm');
  const b = await Booking.findById(reqId).lean();
  assert.equal(b.status, 'confirmed');
  assert.equal(String(b.requestDecidedBy), String(asha.user._id), 'decided by Asha');
  assert.equal(String(b.decidedOwnerId), String(bina.user._id), 'credited to the owner, Bina');
  assert.equal(String(b.crmOwnerId), String(bina.user._id), 'the body cannot clear the owner');
  assert.deepEqual(b.statusHistory.map((h) => h.status), ['pending', 'confirmed']);
  // saving it again (same status) is not a new decision
  const decidedAt = b.requestDecidedAt.getTime();
  ok(await api('PUT', `/bookings/${reqId}`, head.token, { ...full, status: 'confirmed' }), 're-save');
  const b2 = await Booking.findById(reqId).lean();
  assert.equal(b2.statusHistory.length, 2);
  assert.equal(b2.requestDecidedAt.getTime(), decidedAt);
});
await check('a booking made in the app is confirmed at once and is no request', async () => {
  const r = await api('POST', '/bookings', head.token, { customerName: 'Walk In', phone: '9895033333', email: 'w@client.test', service: 'Party', bookingDate: '2027-02-01', selectedDates: ['2027-02-01'], totalPrice: 5000 });
  ok(r, 'staff booking');
  const b = await Booking.findById(r.body._id ?? r.body.booking?._id).lean();
  assert.deepEqual([b.status, b.origin, b.statusHistory[0].byName], ['confirmed', 'staff', 'Meera']);
});

// ── chats ───────────────────────────────────────────────────────────────────
console.log('Client chat');
const client = await ClientUser.create({ phone: '9895044444', name: 'Diya' });
const convo = await Conversation.create({ clientUserId: client._id, clientName: 'Diya', clientPhone: '9895044444', lastMessageAt: new Date(), awaitingSince: new Date(Date.now() - 5 * 3600 * 1000), lastMessageSenderType: 'client' });
await check('a chat waiting for an answer is in the queue; the first reply claims it and ends the wait', async () => {
  const q = (await api('GET', '/crm/queue?scope=unassigned&types=conversation', head.token)).body;
  assert.equal(q.items[0]?.id, String(convo._id));
  assert.equal(q.items[0].overdue, true, 'past the 60-minute limit');
  ok(await api('POST', `/chat/conversations/${convo._id}/messages`, asha.token, { text: 'Hello Diya!' }), 'reply');
  const c = await Conversation.findById(convo._id).lean();
  assert.deepEqual([String(c.assignedStaffId), c.assignedStaffName, c.assignedVia, c.awaitingSince], [String(asha.user._id), 'Asha', 'first_reply', null]);
  assert.equal((await api('GET', '/chat/conversations?assignee=me', asha.token)).body.length ?? (await api('GET', '/chat/conversations?assignee=me', asha.token)).body.conversations?.length, 1);
});

// ── cases from reviews ──────────────────────────────────────────────────────
console.log('Cases');
const review = await Review.create({ booking: reqId, token: 'tok-1', brideName: 'Client One', customerPhone: '9895011111', status: 'pending' });
await check('an unhappy review opens ONE complaint case, owned by the booking\'s owner; the head is told', async () => {
  const headBefore = (await notes(head.user, 'crm_case_opened')).length;
  const r = await api('POST', '/reviews/submit/tok-1', null, { nps: 4, overallRating: 2, testimonial: 'The artist came late.' });
  ok(r, 'submit');
  const cases = await CrmCase.find({ reviewId: review._id }).lean();
  assert.equal(cases.length, 1);
  assert.deepEqual([cases[0].kind, cases[0].origin, String(cases[0].ownerId), cases[0].priority], ['complaint', 'review_auto', String(bina.user._id), 'high']);
  assert.equal((await notes(head.user, 'crm_case_opened')).length, headBefore + 1);
  assert.equal((await Review.findById(review._id).lean()).complaint, true, 'a low score flags the review itself');
  // staff flag it a complaint afterwards (already one): nothing new; and a follow-up request opens a follow-up
  ok(await api('PUT', `/reviews/${review._id}`, head.token, { complaint: true }), 'flag complaint');
  ok(await api('PUT', `/reviews/${review._id}`, head.token, { complaint: true }), 'flag again');
  assert.equal(await CrmCase.countDocuments({ reviewId: review._id, kind: 'complaint' }), 1);
  ok(await api('PUT', `/reviews/${review._id}`, head.token, { followUpRequired: true }), 'follow-up');
  assert.equal(await CrmCase.countDocuments({ reviewId: review._id, kind: 'follow_up' }), 1);
  const rv = await Review.findById(review._id).lean();
  assert.deepEqual(rv.flagHistory.map((f) => `${f.field}=${f.value}`), ['followUpRequired=true'], 'only real changes are recorded');
});
await check('the database itself refuses a second automatic case of a kind for one review (a manual one is fine)', async () => {
  const rid = new mongoose.Types.ObjectId();
  const base = { kind: 'complaint', title: 't', reviewId: rid, dueAt: new Date(), slaHours: 1 };
  await CrmCase.create({ ...base, caseNumber: 'CC-IDX-0001', origin: 'review_auto' });
  await assert.rejects(CrmCase.create({ ...base, caseNumber: 'CC-IDX-0002', origin: 'review_auto' }), /E11000/);
  await CrmCase.create({ ...base, caseNumber: 'CC-IDX-0003', origin: 'manual' });
  await CrmCase.deleteMany({ reviewId: rid });
});
await check('two saves of the same review at once still open one case', async () => {
  const { openReviewCases } = await mod('services/crmCases.js');
  const rv = await Review.create({ booking: req2, token: 'tok-2', brideName: 'Client Two', nps: 2, status: 'submitted' });
  await Promise.all([openReviewCases(rv, ['complaint']), openReviewCases(rv, ['complaint']), openReviewCases(rv, ['complaint'])]);
  assert.equal(await CrmCase.countDocuments({ reviewId: rv._id, kind: 'complaint' }), 1);
});

let caseId;
await check('the tracker: only the owner or the head changes a case; resolving needs a note; only the head reopens', async () => {
  const c = await CrmCase.findOne({ reviewId: review._id, kind: 'complaint' }).lean();
  caseId = String(c._id);
  assert.equal((await api('GET', `/crm/cases/${caseId}`, asha.token)).status, 403, 'Asha may not even look at Bina\'s case');
  assert.equal((await api('PATCH', `/crm/cases/${caseId}`, asha.token, { status: 'in_progress' })).status, 403);
  // logging a call moves it to in progress
  const act = await api('POST', `/crm/cases/${caseId}/activities`, bina.token, { type: 'call', text: 'Called, she wants an apology', outcome: 'reached' });
  ok(act, 'call');
  assert.equal(act.body.status, 'in_progress');
  const noNote = await api('PATCH', `/crm/cases/${caseId}`, bina.token, { status: 'resolved' });
  assert.equal(noNote.status, 400);
  assert.match(noNote.body.message, /Write what was done/);
  const done = await api('PATCH', `/crm/cases/${caseId}`, bina.token, { status: 'resolved', resolutionNote: 'Apologised; 20% off the next booking', outcome: 'compensated' });
  ok(done, 'resolve');
  assert.equal(done.body.resolvedByName, 'Bina');
  assert.ok(done.body.resolvedAt);
  assert.equal((await api('PATCH', `/crm/cases/${caseId}`, bina.token, { status: 'open' })).status, 403, 'a member does not reopen');
  const re = await api('PATCH', `/crm/cases/${caseId}`, head.token, { status: 'open', reason: 'She called again' });
  ok(re, 'reopen');
  assert.equal(re.body.resolvedAt, null);
  assert.ok(new Date(re.body.dueAt) > new Date(), 'a fresh time limit');
  assert.deepEqual(re.body.activities.filter((a) => a.type === 'status').map((a) => a.text.split(':')[0]), ['Open → In progress', 'In progress → Resolved', 'Resolved → Open']);
});
await check('a case by hand: a member\'s is theirs; the head can leave one unassigned; a case list shows a member only theirs and the unassigned', async () => {
  const mine = await api('POST', '/crm/cases', asha.token, { kind: 'follow_up', bookingId: req2, description: 'Asked about the trial' });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.deepEqual([mine.body.ownerName, mine.body.customerName, mine.body.title], ['Asha', 'Client Two', 'Follow-up: Client Two']);
  assert.equal((await api('POST', '/crm/cases', asha.token, { kind: 'follow_up', title: 'x', ownerId: String(bina.user._id) })).status, 403);
  const open = await api('POST', '/crm/cases', head.token, { kind: 'complaint', title: 'Phone complaint', phone: '+91 98950 55555', priority: 'high' });
  assert.equal(open.status, 201);
  assert.equal(open.body.ownerId ?? null, null);
  assert.equal(open.body.phone, '9895055555');
  const list = (await api('GET', '/crm/cases?status=active', asha.token)).body;
  const names = list.items.map((c) => c.title).sort();
  assert.deepEqual(names, ['Follow-up: Client Two', 'Phone complaint'], 'not Bina\'s');
  assert.equal((await api('GET', '/crm/cases?status=active', head.token)).body.totalItems, 5);
  assert.equal((await api('GET', '/crm/cases?search=55555', head.token)).body.items[0]?.title, 'Phone complaint');
  assert.equal((await api('POST', '/crm/cases', asha.token, { kind: 'nonsense', title: 'x' })).status, 400);
});

// ── overdue ─────────────────────────────────────────────────────────────────
console.log('Overdue alerts');
await check('the sweep tells the owner and the head ONCE about overdue work, however often it runs', async () => {
  // createdAt is immutable to Mongoose: a raw write
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(req2) }, { $set: { createdAt: new Date(Date.now() - 30 * 3600 * 1000) } });
  await Conversation.updateOne({ _id: convo._id }, { $set: { awaitingSince: new Date(Date.now() - 6 * 3600 * 1000), awaitingNotifiedAt: null } });
  await CrmCase.updateOne({ _id: caseId }, { $set: { dueAt: new Date(Date.now() - 3600 * 1000) } });
  // the records began 40 hours ago: a request from 50 hours ago is the old backlog (the head hands it out; it is not announced)
  await mongoose.model('CrmSettings').updateOne({ singleton: 'crm' }, { $set: { trackingSince: new Date(Date.now() - 40 * 3600 * 1000) } });
  const backlog = await publicBooking('Old Request', '9895077777');
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(backlog) }, { $set: { createdAt: new Date(Date.now() - 50 * 3600 * 1000) } });
  _resetCrmSweep();
  const first = await runCrmSweep({ force: true });
  assert.deepEqual([first.requests, first.chats, first.cases], [1, 1, 1], JSON.stringify(first));
  assert.equal((await Booking.findById(backlog).lean()).crmOverdueNotifiedAt ?? null, null, 'the backlog request was not announced');
  const second = await runCrmSweep({ force: true });
  assert.deepEqual([second.requests, second.chats, second.cases], [0, 0, 0]);
  const headNotes = await notes(head.user, 'crm_overdue');
  assert.equal(headNotes.length, 1, 'the head: one notice with all three');
  assert.match(headNotes[0].body, /1 booking request.*1 client chat.*1 case/);
  assert.equal((await notes(bina.user, 'crm_overdue')).length, 1, 'Bina owns the request and the case');
  assert.equal((await notes(asha.user, 'crm_overdue')).length, 1, 'Asha owns the chat');
  assert.equal(await runCrmSweep(), null, 'throttled: a read within 5 minutes does not sweep again');
});
await check('two sweeps at the same moment (two servers, two screens) still announce each item once', async () => {
  const extra = await CrmCase.create({ caseNumber: 'CC-RACE-0001', kind: 'follow_up', title: 'Race', status: 'open', ownerId: asha.user._id, ownerName: 'Asha', slaHours: 1, dueAt: new Date(Date.now() - 60000) });
  const runs = await Promise.all([runCrmSweep({ force: true }), runCrmSweep({ force: true }), runCrmSweep({ force: true })]);
  assert.equal(runs.reduce((n, r) => n + r.cases, 0), 1, JSON.stringify(runs));
  // the narrow case: a sweep read the item, another stamped it, then the first tries — it must not announce it again
  const read = await CrmCase.findById(extra._id).select('_id').lean();
  assert.deepEqual(await claimEach(CrmCase, [read], 'overdueNotifiedAt', new Date()), []);
  await CrmCase.deleteOne({ _id: extra._id });
});

// ── re-engagement ───────────────────────────────────────────────────────────
console.log('Re-engagement');
await check('past clients due a call; making call cases skips a client already being called', async () => {
  const old = new Date('2025-02-01T10:00:00+05:30');
  await Booking.collection.insertOne({ customerName: 'Old Client', phone: '+91 98950 66666', service: 'Bridal', bookingDate: old, serviceStart: old, serviceEnd: old, status: 'completed', totalPrice: 1, createdAt: old });
  const list = (await api('GET', '/crm/re-engagement?months=6', asha.token)).body;
  const row = list.clients.find((c) => c.phoneKey === '9895066666');
  assert.ok(row, JSON.stringify(list.clients.map((c) => c.phoneKey)));
  assert.equal(row.openCase, null);
  const made = await api('POST', '/crm/re-engagement/cases', head.token, { clients: [row, row, { phone: '' }], ownerId: String(asha.user._id) });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.created.length, 1);
  assert.deepEqual(made.body.skipped.map((s) => s.reason), ['A call for this client is already open.', 'No phone number.']);
  const again = await api('POST', '/crm/re-engagement/cases', head.token, { clients: [row] });
  assert.equal(again.body.created.length, 0);
  const list2 = (await api('GET', '/crm/re-engagement?months=6', asha.token)).body;
  assert.equal(list2.clients.find((c) => c.phoneKey === '9895066666').openCase?.ownerName, 'Asha');
  assert.match((await notes(asha.user, 'crm_assigned')).at(-1).title, /1 re-engagement call for you/);
});

// ── settings ────────────────────────────────────────────────────────────────
console.log('Settings');
await check('the head changes the time limits; a member cannot; nonsense is refused', async () => {
  const r = await api('PUT', '/crm/settings', head.token, { requestSlaHours: 12, caseSlaHours: { complaint: 24 } });
  ok(r, 'settings');
  assert.deepEqual([r.body.requestSlaHours, r.body.caseSlaHours.complaint, r.body.caseSlaHours.follow_up, r.body.updatedByName], [12, 24, 72, 'Meera']);
  assert.equal((await api('PUT', '/crm/settings', asha.token, { requestSlaHours: 1 })).status, 403);
  assert.equal((await api('PUT', '/crm/settings', head.token, { requestSlaHours: 0 })).status, 400);
  assert.equal((await api('PUT', '/crm/settings', head.token, { lowNps: 11 })).status, 400);
});

// ── the dashboard ───────────────────────────────────────────────────────────
console.log('Dashboard');
const istDay = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const from = istDay(new Date(Date.now() - 10 * 86400000));
const to = istDay(new Date());
const period = `from=${from}&to=${to}`;
// a client chat with real messages: waiting 30 minutes for Asha's answer
const convo2 = await Conversation.create({ clientUserId: client._id, clientName: 'Esha', clientPhone: '9895088888', lastMessageAt: new Date() });
await Message.create({ conversationId: convo2._id, senderType: 'client', senderId: client._id, senderName: 'Esha', text: 'Is 20 Jan free?', createdAt: new Date(Date.now() - 2 * 3600000) });
await Message.create({ conversationId: convo2._id, senderType: 'staff', senderId: asha.user._id, senderName: 'Asha', text: 'Yes!', createdAt: new Date(Date.now() - 90 * 60000) });

await check('the head sees the team: requests received and decided, credited to the owner; the chat answer to Asha; "partial" before the records began', async () => {
  const r = await api('GET', `/crm/overview?${period}`, head.token);
  ok(r, 'overview');
  const o = r.body;
  assert.equal(o.scope.kind, 'team');
  assert.equal(o.kpis.requestsReceived.value, 3, 'One, Two and the old request (it arrived in the app today)');
  assert.equal(o.kpis.requestsDecided.value, 1);
  assert.equal(o.kpis.requestConfirmRate.value, 100);
  assert.equal(o.kpis.chatMedianReplyMins.value, 30);
  assert.equal(o.partial, true);
  const bina = o.members.find((m) => m.name === 'Bina');
  const ashaRow = o.members.find((m) => m.name === 'Asha');
  assert.equal(bina.kpis.requestsDecided.value, 1, 'Bina owned it when Asha confirmed it');
  assert.equal(ashaRow.kpis.requestsDecided.value, 0);
  assert.equal(ashaRow.kpis.chatMedianReplyMins.value, 30);
  assert.equal(bina.kpis.chatMedianReplyMins.value, null, 'no answers: "—", not 0');
  assert.ok(o.trend.length >= 10 && o.trend.every((t) => 'requestsReceived' in t));
  assert.ok(o.breachCount >= 1, 'the overdue case is a breach');
  // the dashboard's own cards: trials and reviews in the period, recent activity, the next trials (no phone numbers)
  assert.ok('trialsScheduled' in o.kpis && 'reviewsSubmitted' in o.kpis);
  assert.ok(Array.isArray(o.recent) && o.recent.length >= 2, JSON.stringify(o.recent));
  assert.ok(o.recent.some((e) => e.kind === 'request' && /New booking request from/.test(e.text)));
  assert.ok(o.recent.length <= 8, 'the eight newest');
  assert.ok(o.recent.every((e, i, a) => i === 0 || new Date(a[i - 1].at) >= new Date(e.at)), 'newest first');
  assert.ok(Array.isArray(o.upcomingTrials));
});
await check('upcoming trials: from today, scheduled or postponed, soonest first, with the package tried — never the phone', async () => {
  const { default: Trial } = await import(new URL('models/Trial.js', root));
  const day = (n) => new Date(Date.now() + n * 86400000 + 5.5 * 3600000).toISOString().slice(0, 10);
  await Trial.create({ clientName: 'Fathima P.', phone: '9895012345', trialDate: day(2), startTime: '10:30', status: 'scheduled', trialItems: [{ packageName: 'Bridal Trial' }], assignedStaff: [{ artistName: 'Anu' }] });
  await Trial.create({ clientName: 'Rizwana S.', phone: '9895012346', trialDate: day(1), startTime: '14:00', status: 'postponed' });
  await Trial.create({ clientName: 'Gone', phone: '9895012347', trialDate: day(1), status: 'cancelled' });
  await Trial.create({ clientName: 'Past', phone: '9895012348', trialDate: day(-3), status: 'scheduled' });
  const o = (await api('GET', `/crm/overview?${period}`, head.token)).body;
  assert.deepEqual(o.upcomingTrials.map((t) => [t.clientName, t.what, t.status]), [['Rizwana S.', 'Trial', 'postponed'], ['Fathima P.', 'Bridal Trial', 'scheduled']]);
  assert.ok(!JSON.stringify(o.upcomingTrials).includes('98950123'), 'no phone numbers');
  assert.deepEqual(o.upcomingTrials[1].artists, ['Anu']);
});
await check('a member sees only their own figures; asking for another member\'s is refused; leadership reads', async () => {
  const r = await api('GET', `/crm/overview?${period}`, asha.token);
  ok(r, 'own');
  assert.deepEqual([r.body.scope.kind, r.body.scope.name, r.body.members.length], ['member', 'Asha', 0]);
  assert.equal((await api('GET', `/crm/overview?${period}&memberId=${bina.user._id}`, asha.token)).status, 403);
  ok(await api('GET', `/crm/overview?${period}&memberId=${bina.user._id}`, head.token), 'the head: one member');
  ok(await api('GET', `/crm/overview?${period}`, ceo.token), 'leadership');
  assert.equal((await api('GET', '/crm/overview?from=2025-01-01&to=2026-11-30', head.token)).status, 400, 'over a year');
});

// ── the report ──────────────────────────────────────────────────────────────
console.log('Report');
const { default: XLSX } = await import('xlsx');
await check('the Excel report: the summary, the team and every record behind the figures', async () => {
  const f = await download(`/crm/report?${period}&format=xlsx`, head.token);
  assert.equal(f.status, 200, f.bytes.toString().slice(0, 200));
  assert.match(f.name, /CRM_Report_.*\.xlsx/);
  const wb = XLSX.read(f.bytes);
  assert.deepEqual(wb.SheetNames, ['Summary', 'Team', 'Overdue now', 'Requests', 'Chats', 'Reviews', 'Cases', 'Trials', 'Re-engagement']);
  const rows = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name]);
  assert.equal(rows('Requests').length, 3);
  const decided = rows('Requests').find((r) => r.Client === 'Client One');
  assert.deepEqual([decided.Owner, decided.Decision, decided['Decided by'], decided['Within limit']], ['Bina', 'Confirmed', 'Asha', 'Yes']);
  assert.equal(rows('Chats').find((r) => r.Client === 'Esha')?.['Minutes to answer'], 30);
  assert.ok(rows('Cases').length >= 4);
  const summary = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
  assert.ok(summary.some((r) => r[0] === 'Booking requests decided' && r[1] === '1'), JSON.stringify(summary.slice(6, 10)));
  assert.ok(summary.some((r) => r[0] === 'Time to first answer in chat (median)' && r[1] === '30 min'));
});
await check('the PDF report; a member\'s own report holds only their work', async () => {
  const pdf = await download(`/crm/report?${period}&format=pdf`, head.token);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.bytes.length > 2000);
  const mine = await download(`/crm/report?${period}&format=xlsx`, asha.token);
  assert.match(mine.name, /_Asha\.xlsx/);
  const wb = XLSX.read(mine.bytes);
  assert.ok(!wb.SheetNames.includes('Team'));
  assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets.Requests).map((r) => r.Client), [], 'Asha owned no request and is not credited with the one she pressed');
  assert.equal((await download(`/crm/report?${period}&format=xlsx&memberId=${bina.user._id}`, asha.token)).status, 403);
  assert.equal((await api('GET', `/crm/report?${period}&format=doc`, head.token)).status, 400);
});

// ── the month-end department report ─────────────────────────────────────────
console.log('Month-end report');
const [y, mo] = [Number(to.slice(0, 4)), Number(to.slice(5, 7))];
await check('the CRM Head opens the CRM month-end report (filled in from the records) — not another department\'s; a member does not', async () => {
  const r = await api('GET', `/reports/department/crm?month=${mo}&year=${y}`, head.token);
  ok(r, 'crm report');
  const metric = (key) => [...r.body.sections.flatMap((s) => s.metrics)].find((x) => x.key === key);
  assert.equal(metric('avgResponseTime').auto, true);
  assert.equal(metric('avgResponseTime').value, 0.5, '30 minutes');
  assert.equal(metric('bookingsAssisted').value, 1);
  assert.ok(metric('pendingCases').value >= 3);
  assert.equal((await api('GET', `/reports/department/sales?month=${mo}&year=${y}`, head.token)).status, 403);
  assert.equal((await api('GET', `/reports/department/crm?month=${mo}&year=${y}`, asha.token)).status, 403);
});
await check('saving keeps what was typed for a figure that is now automatic; a month before the records shows that typed figure', async () => {
  await DepartmentReport.create({ department: 'crm', month: 1, year: 2025, values: { pendingCases: 9, activeClients: 50, nps: 41 } });
  const save = await api('PUT', '/reports/department/crm', head.token, { month: 1, year: 2025, values: { inactiveClients: 3 }, targets: {}, actionItems: [], notes: '' });
  ok(save, 'save');
  const v = (await DepartmentReport.findOne({ department: 'crm', month: 1, year: 2025 }).lean()).values;
  assert.deepEqual(Object.fromEntries(Object.entries(v).sort()), { inactiveClients: 3, nps: 41, pendingCases: 9 }, 'activeClients was cleared on the screen; the automatic ones stay');
  const old = await api('GET', '/reports/department/crm?month=1&year=2025', head.token);
  const metric = (key) => [...old.body.sections.flatMap((s) => s.metrics)].find((x) => x.key === key);
  assert.equal(metric('pendingCases').value, 9, 'no CRM records then: the typed figure');
  assert.equal(metric('nps').value, 41);
});

// ── a booking's care, and the weekly report ────────────────────────────────
console.log('Booking care');
const Employee = await imp('models/Employee.js');
const CrmBookingCare = await imp('models/CrmBookingCare.js');
const CrmSettings = await imp('models/CrmSettings.js');
const { addDays: plus, istStart: dayStart, istWeekStart } = await mod('utils/istDate.js');
const todayIst = istDay(new Date());
const W = { from: plus(istWeekStart(todayIst), -7) };
W.to = plus(W.from, 6);
const N = { from: istWeekStart(todayIst), to: plus(istWeekStart(todayIst), 6) };
const dA = plus(W.from, 1);
const dB = plus(W.from, 2);
const dB2 = plus(N.from, 5);
const dFuture = plus(todayIst, 3);
const rani = await Employee.create({ name: 'Rani Outsource', type: 'outsource', isAssociate: true, phone: '9000011111' });
const artistEmp = await Employee.create({ name: 'Artist Kavya', type: 'in-house', phone: '9000022222' });
const artist = await mkUser('Kavya', 'artist', { employeeId: artistEmp._id });
const raw = async (fields) => {
  const day0 = fields.selectedDates[0];
  const r = await Booking.collection.insertOne({
    service: 'Bridal Makeup', totalPrice: 1, status: 'confirmed', serviceStart: dayStart(day0), serviceEnd: dayStart(day0), bookingDate: new Date(`${day0}T00:00:00Z`), createdAt: new Date(), ...fields,
  });
  return String(r.insertedId);
};
const bk1 = await raw({ customerName: 'Week One', phone: '9895100001', bookingNumber: 'WK-1', selectedDates: [dA], assignedStaff: [{ employeeId: rani._id, artistName: 'Rani Outsource', roleType: 'lead' }] });
const bk2 = await raw({ customerName: 'Week Two', phone: '9895100002', bookingNumber: 'WK-2', selectedDates: [dB, dB2], assignedStaff: [{ employeeId: artistEmp._id, artistName: 'Artist Kavya', roleType: 'lead' }] });
await raw({ customerName: 'Week Cancelled', phone: '9895100003', bookingNumber: 'WK-3', status: 'cancelled', selectedDates: [dA] });
const bk4 = await raw({ customerName: 'Week Four', phone: '9895100004', bookingNumber: 'WK-4', selectedDates: [N.to] });
const bk5 = await raw({ customerName: 'Week Five', phone: '9895100005', bookingNumber: 'WK-5', selectedDates: [dFuture] });
// the care records began before last week (as if this had been live for a while)
await CrmSettings.updateOne({ singleton: 'crm' }, { $set: { careSince: dayStart(plus(W.from, -1)) } });

await check('verified / photos: a tick per work day, by whom; photos only for a work that has happened; only the booking\'s own days', async () => {
  const v = await api('PUT', `/crm/care/${bk4}/verify`, asha.token, { day: N.to, note: 'Called, 6 am start' });
  ok(v, 'verify');
  assert.deepEqual(v.body.verifications.map((m) => [m.day, m.byName, m.note]), [[N.to, 'Asha', 'Called, 6 am start']]);
  ok(await api('PUT', `/crm/care/${bk1}/photos`, bina.token, { day: dA }), 'photos');
  assert.equal((await api('PUT', `/crm/care/${bk5}/photos`, bina.token, { day: dFuture })).status, 400, 'not happened yet');
  assert.equal((await api('PUT', `/crm/care/${bk1}/verify`, asha.token, { day: dB })).status, 400, 'not its day');
  assert.equal((await api('PUT', `/crm/care/${bk1}/verify`, ceo.token, { day: dA })).status, 403, 'leadership only reads');
  assert.equal((await api('PUT', `/crm/care/${bk1}/verify`, sales.token, { day: dA })).status, 403);
  const off = await api('PUT', `/crm/care/${bk1}/photos`, bina.token, { day: dA, done: false });
  assert.equal(off.body.photos.length, 0, 'taken back');
  ok(await api('PUT', `/crm/care/${bk1}/photos`, bina.token, { day: dA }), 'ticked again');
  assert.equal(await CrmBookingCare.countDocuments({ bookingId: new mongoose.Types.ObjectId(bk1) }), 1, 'one care record per booking');
});
await check('medical notes: the CRM writes them; the booking\'s own artist reads them (and nothing else); sales cannot', async () => {
  ok(await api('PUT', `/crm/care/${bk2}/medical`, asha.token, { conditions: ['allergy', 'pregnancy'], note: 'Latex allergy; 6 months pregnant' }), 'medical');
  assert.equal((await api('PUT', `/crm/care/${bk2}/medical`, asha.token, { conditions: ['other'] })).status, 400, '"other" needs a note');
  const mine = await api('GET', `/crm/care/${bk2}`, artist.token);
  ok(mine, 'the artist on it');
  assert.deepEqual(mine.body.medical.conditions, ['allergy', 'pregnancy']);
  assert.equal(mine.body.verifications, undefined, 'an artist sees the medical notes only');
  assert.equal(mine.body.canWrite, false);
  assert.equal((await api('GET', `/crm/care/${bk1}`, artist.token)).status, 403, 'not her booking');
  assert.equal((await api('GET', `/crm/care/${bk2}`, sales.token)).status, 403);
  const head2 = await api('GET', `/crm/care/${bk2}`, head.token);
  assert.ok(Array.isArray(head2.body.verifications) && head2.body.canWrite);
  const booking = (await api('GET', `/bookings/${bk2}`, sales.token)).body;
  assert.equal(JSON.stringify(booking).includes('Latex'), false, 'the booking itself never carries the notes');
});
await check('an emergency is logged against a work day that has happened', async () => {
  const r = await api('POST', `/crm/care/${bk1}/emergencies`, asha.token, { day: dA, what: 'Skin rash after primer', action: 'Removed, cold compress, switched product' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.emergencies[0].byName, 'Asha');
  assert.equal((await api('POST', `/crm/care/${bk5}/emergencies`, asha.token, { day: dFuture, what: 'x happened' })).status, 400);
  assert.equal((await api('POST', `/crm/care/${bk1}/emergencies`, asha.token, { day: dA, what: '' })).status, 400);
});
await check('the to-verify list: the coming 7 days\' works with their tick', async () => {
  const r = await api('GET', '/crm/care-list?kind=verify', asha.token);
  ok(r, 'list');
  const four = r.body.items.find((i) => i.bookingId === bk4);
  if (N.to <= plus(todayIst, 7)) assert.deepEqual([four?.done, four?.byName], [true, 'Asha']);
  assert.ok(r.body.items.some((i) => i.bookingId === bk5 && i.done === false));
  assert.equal((await api('GET', '/crm/care-list?kind=verify', sales.token)).status, 403);
});

console.log('Weekly report');
await Review.create({ booking: bk1, token: 'tok-week', brideName: 'Week One', status: 'submitted', submittedAt: dayStart(dA), nps: 9 });
await Trial.collection.insertOne({ clientName: 'Trial Bride', phone: '9895100009', trialDate: dB, status: 'completed', createdAt: new Date() });
const convo3 = await Conversation.create({ clientUserId: client._id, clientName: 'Week One', clientPhone: '+91 98951 00001', lastMessageAt: new Date() });
await Message.collection.insertOne({ conversationId: convo3._id, senderType: 'staff', senderId: bina.user._id, senderName: 'Bina', text: 'See you Tuesday', createdAt: dayStart(dA) });
const weekly = (token, q = `week=${W.from}`) => api('GET', `/crm/weekly?${q}`, token);

await check('the week\'s figures: trials, photos and reviews, clients handled, verification, medical, workload, outsource', async () => {
  const r = await weekly(head.token);
  ok(r, 'weekly');
  const f = r.body.figures;
  assert.deepEqual([r.body.week.from, r.body.status, r.body.live], [W.from, 'new', true]);
  // the 'Past' trial (3 days ago, still scheduled) is held last week too when today is a Monday, Tuesday or Wednesday
  const pastToo = plus(todayIst, -3) >= W.from && plus(todayIst, -3) < N.from;
  assert.deepEqual([f.trials.held, f.trials.completed], [pastToo ? 2 : 1, 1]);
  assert.deepEqual([f.photosReviews.worksDone, f.photosReviews.photos, f.photosReviews.clientsDone, f.photosReviews.reviews], [2, 1, 2, 1], 'the cancelled booking is no work');
  assert.deepEqual(f.photosReviews.missingPhotos.map((m) => m.client), ['Week Two']);
  assert.equal(f.support.clients, 1, 'Bina answered Week One in the chat');
  assert.deepEqual(f.support.byMember, [{ name: 'Bina', clients: 1 }]);
  // the coming week: Week Two's second day, Week Four — and Week Five when today + 3 is still this week
  const fiveToo = dFuture <= N.to;
  assert.deepEqual([f.verification.nextWeek.works, f.verification.nextWeek.verified], [fiveToo ? 3 : 2, 1]);
  assert.deepEqual(f.verification.nextWeek.unverified.map((u) => u.client).sort(), fiveToo ? ['Week Five', 'Week Two'] : ['Week Two']);
  assert.deepEqual(f.medical.withConditions.map((m) => [m.client, m.days]), [['Week Two', [dB, dB2]]]);
  assert.deepEqual(f.medical.emergencies.map((e) => e.what), ['Skin rash after primer']);
  assert.equal(f.workload.nextWeek.days.length, 7);
  assert.ok(f.workload.nextWeek.booked >= (fiveToo ? 2 : 1), JSON.stringify(f.workload.nextWeek)); // Week Four (+ Week Five)
  assert.deepEqual(f.outsource.lines.map((l) => [l.bride, l.outsource, l.phone]), [['Week One', 'Rani Outsource', '9000011111']]);
  assert.equal(f.support.monthTarget, 100);
});
await check('the report is the CRM Head\'s: a member cannot open or fill it; leadership reads it', async () => {
  assert.equal((await weekly(asha.token)).status, 403);
  assert.equal((await api('PUT', '/crm/weekly', asha.token, { week: W.from, startingMessagesNizan: 3 })).status, 403);
  ok(await weekly(ceo.token), 'leadership');
  assert.equal((await api('PUT', '/crm/weekly', ceo.token, { week: W.from, startingMessagesNizan: 3 })).status, 403);
});
await check('the Head types the rest; it is handed in only when complete, and then keeps its figures', async () => {
  const saved = await api('PUT', '/crm/weekly', head.token, { week: W.from, startingMessagesNizan: 14, startingMessagesTeamN: '9' });
  ok(saved, 'save');
  assert.deepEqual([saved.body.status, saved.body.typed.startingMessagesNizan, saved.body.typed.startingMessagesTeamN], ['draft', 14, 9]);
  const early = await api('POST', '/crm/weekly/submit', head.token, { week: W.from });
  assert.equal(early.status, 400);
  assert.match(early.body.message, /plan for extra manpower.*enough work/);
  ok(await api('PUT', '/crm/weekly', head.token, { week: W.from, manpowerPlan: 'Two freelancers booked for Saturday', enoughWork: 'yes' }), 'save 2');
  const sub = await api('POST', '/crm/weekly/submit', head.token, { week: W.from });
  ok(sub, 'submit');
  assert.deepEqual([sub.body.status, sub.body.live, sub.body.submittedByName, sub.body.typed.startingMessagesNizan], ['submitted', false, 'Meera', 14], 'typing again keeps what was typed before');
  // a later tick does not change a report already handed in
  ok(await api('PUT', `/crm/care/${bk2}/photos`, bina.token, { day: dB }), 'late photo tick');
  assert.equal((await weekly(head.token)).body.figures.photosReviews.photos, 1);
  assert.equal((await api('PUT', '/crm/weekly', head.token, { week: W.from, notes: 'x' })).status, 409);
  assert.equal((await api('POST', '/crm/weekly/submit', head.token, { week: W.from })).status, 409);
  const re = await api('POST', '/crm/weekly/reopen', head.token, { week: W.from });
  ok(re, 'reopen');
  assert.deepEqual([re.body.status, re.body.live, re.body.figures.photosReviews.photos], ['draft', true, 2]);
  // this week, filled in completely, still cannot be handed in before it is over
  ok(await api('PUT', '/crm/weekly', head.token, { week: N.from, startingMessagesNizan: 1, startingMessagesTeamN: 1, manpowerPlan: 'none', enoughWork: 'yes' }), 'this week');
  const tooSoon = await api('POST', '/crm/weekly/submit', head.token, { week: N.from });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.body.message, /not over/);
  const list = await api('GET', '/crm/weekly/list', head.token);
  assert.equal(list.body[0].from, W.from);
  assert.equal(list.body[0].status, 'draft');
});
await check('the Head types a figure by hand: it shows (marked) with the records\' one; a part bigger than its whole is refused', async () => {
  const put = (body) => api('PUT', '/crm/weekly', head.token, { week: W.from, ...body });
  const bad = await put({ overrides: { photos: 3 } });
  assert.equal(bad.status, 400);
  assert.match(bad.body.message, /Photos collected \(3\) can't be more than makeover works done \(2\)/);
  const r = await put({ overrides: { worksDone: 5, photos: 4 }, sectionNotes: { photos: 'Two works kept on paper' } });
  ok(r, 'typed');
  const p = r.body.figures.photosReviews;
  assert.deepEqual([p.worksDone, p.photos, p.photosPct], [5, 4, 80]);
  assert.deepEqual([r.body.records.worksDone, r.body.records.photos], [2, 2], 'the records\' figures beside them');
  assert.deepEqual(r.body.typed.overrides, { worksDone: 5, photos: 4 });
  assert.deepEqual(r.body.typed.sectionNotes, { photos: 'Two works kept on paper' });
  assert.ok(r.body.fields.some((f) => f.key === 'verified' && f.section === 'verification'));
  // one figure at a time: what was typed before stays; null goes back to the records
  ok(await put({ overrides: { trialsHeld: 3 } }), 'trials');
  ok(await put({ overrides: { photos: 5 } }), 'checked against the works done typed before (5), not the records\' 2');
  const back = await put({ overrides: { photos: null } });
  assert.deepEqual(back.body.typed.overrides, { worksDone: 5, trialsHeld: 3 });
  assert.deepEqual([back.body.figures.photosReviews.photos, back.body.figures.trials.held], [2, 3]);
  assert.equal(back.body.typed.startingMessagesNizan, 14, 'the rest untouched');
  // outside-artist works the records missed
  assert.equal((await put({ outsourceLines: [{ bride: 'Paper Bride' }] })).status, 400);
  const o = await put({ outsourceLines: [{ bride: 'Paper Bride', outsource: 'Lini', work: 'Party', phone: '9000033333', day: dA }] });
  ok(o, 'outsource line');
  assert.deepEqual(o.body.figures.outsource.lines.map((l) => [l.bride, l.byHand === true]), [['Week One', false], ['Paper Bride', true]]);
  assert.equal(o.body.figures.outsource.total, 2);
  // a typed figure the records no longer agree with stops the hand-in
  const works = o.body.figures.verification.nextWeek.works;
  ok(await put({ overrides: { verified: works } }), 'verified typed');
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(bk4) }, { $set: { status: 'cancelled' } });
  const stale = await api('POST', '/crm/weekly/submit', head.token, { week: W.from });
  assert.equal(stale.status, 400, JSON.stringify(stale.body));
  assert.match(stale.body.message, new RegExp(`works verified \\(${works}\\) can't be more than coming week's works \\(${works - 1}\\)`));
  await Booking.collection.updateOne({ _id: new mongoose.Types.ObjectId(bk4) }, { $set: { status: 'confirmed' } });
  // handed in: the snapshot is the records', what was typed still shows over it
  const sub = await api('POST', '/crm/weekly/submit', head.token, { week: W.from });
  ok(sub, 'submit with typed figures');
  assert.deepEqual([sub.body.figures.photosReviews.worksDone, sub.body.records.worksDone, sub.body.figures.verification.nextWeek.verified], [5, 2, works]);
  const doc = await (await imp('models/CrmWeeklyReport.js')).findOne({ weekStart: W.from }).lean();
  assert.equal(doc.snapshot.photosReviews.worksDone, 2, 'the snapshot keeps the records\' figure');
  assert.equal((await put({ overrides: { worksDone: 6 } })).status, 409, 'handed in: no typing');
});
await check('the weekly report downloads as PDF and Excel', async () => {
  const pdf = await download(`/crm/weekly/file?week=${W.from}&format=pdf`, head.token);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  assert.match(pdf.name, new RegExp(`CRM_Weekly_Report_${W.from}_to_${W.to}\\.pdf`));
  const x = await download(`/crm/weekly/file?week=${W.from}&format=xlsx`, head.token);
  const wb = XLSX.read(x.bytes);
  assert.deepEqual(wb.SheetNames, ['Summary', 'Photos missing', 'Reviews missing', 'Support by member', 'Not verified', 'Medical', 'Workload next week', 'Outsource']);
  const summary = XLSX.utils.sheet_to_json(wb.Sheets.Summary, { header: 1 });
  assert.ok(summary.some((r) => r[1] === 'Nizan · Team N' && r[2] === '14 · 9 (total 23)'), JSON.stringify(summary.slice(4, 16)));
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.Outsource)[0]['Outsource artist'], 'Rani Outsource');
  assert.ok(summary.some((r) => r[1] === 'Makeover works done' && r[2] === '5 · typed by hand (records: 2)'), JSON.stringify(summary.slice(4, 12)));
  assert.ok(summary.some((r) => r[1] === 'Note' && r[2] === 'Two works kept on paper'));
  assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets.Outsource).map((l) => [l.Bride, l['Typed by hand'] ?? '']).slice(0, 2), [['Week One', ''], ['Paper Bride', 'Yes']]);
});

server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
