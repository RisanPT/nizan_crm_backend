// End-to-end check of monthly objectives per department against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099;
// refuses to run against anything else and drops its database first):
//
//   mkdir -p /tmp/mo-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/mo-e2e --fork --logpath /tmp/mo-e2e/log
//   node tests/e2e/monthly-objectives.e2e.mjs
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
await mongoose.connect('mongodb://127.0.0.1:27099/monthly_objectives_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Department = await imp('models/Department.js');
const MonthlyObjective = await imp('models/MonthlyObjective.js');
const Notification = await imp('models/Notification.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { runMonthlyObjectiveReminders } = await import(new URL('services/monthlyObjectiveReminders.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/monthly-objectives', await imp('routes/monthlyObjectiveRoutes.js'));
app.use('/api/notifications', await imp('routes/notificationRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}/api`;

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
    console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 7).join('\n      ')}`);
  }
};

// ── the company ─────────────────────────────────────────────────────────────
const emp = async (name, department = '') => (await mongoose.connection.collection('employees').insertOne({ name, department, status: 'active', createdAt: new Date() })).insertedId;
const itHeadEmp = await emp('Ishaan (IT head)', 'IT');
const hrHeadEmp = await emp('Hana (HR head)', 'HR');
const itMemberEmp = await emp('Irfan (IT member)', 'IT');
const itOtherEmp = await emp('Ilyas (IT)', 'IT');
const outsiderEmp = await emp('Omar (Fleet)', 'Fleet');

const dIT = await Department.create({ key: 'it', name: 'IT', division: 'administrative', head: itHeadEmp });
const dHR = await Department.create({ key: 'hr', name: 'HR', division: 'administrative', head: hrHeadEmp });
const dArtist = await Department.create({ key: 'artist', name: 'Artist', division: 'creative' }); // no head
await Department.create({ key: 'old', name: 'Old department', division: 'creative', active: false });

let n = 0;
const mk = async (key, role, extra = {}) => {
  n += 1;
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, ...extra });
  return { id: String(user._id), role, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const admin = await mk('boss', 'admin');
const ceo = await mk('ceo', 'ceo');
const itHead = await mk('ithead', 'sales', { employeeId: itHeadEmp });
const hrHead = await mk('hrhead', 'sales', { employeeId: hrHeadEmp });
const itMember = await mk('itmember', 'sales', { employeeId: itMemberEmp });
const itOther = await mk('itother', 'sales', { employeeId: itOtherEmp });
const outsider = await mk('outsider', 'sales', { employeeId: outsiderEmp });

const NOW = new Date();
const ist = new Date(NOW.getTime() + 330 * 60_000);
const Y = ist.getUTCFullYear();
const M = ist.getUTCMonth() + 1;
const next = M === 12 ? { year: Y + 1, month: 1 } : { year: Y, month: M + 1 };
const past = M === 1 ? { year: Y - 1, month: 12 } : { year: Y, month: M - 1 };
const list = (token, ym = { year: Y, month: M }) => api('GET', `/monthly-objectives?year=${ym.year}&month=${ym.month}`, token);
const block = (r, name) => r.body.departments.find((d) => d.name === name);
const kr = (title, target, extra = {}) => ({ title, targetValue: target, ...extra });
const make = (token, body) => api('POST', '/monthly-objectives', token, { departmentId: String(dIT._id), year: Y, month: M, ...body });

// ── who sees what ───────────────────────────────────────────────────────────
await check('an administrator sees every ACTIVE department, including one with no head and nothing set; an inactive one is left out', async () => {
  const r = await list(admin.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.departments.map((d) => d.name).sort(), ['Artist', 'HR', 'IT']);
  assert.equal(block(r, 'Artist').head, null);
  assert.equal(block(r, 'Artist').objectives.length, 0);
  assert.equal(block(r, 'IT').head.name, 'Ishaan (IT head)');
  assert.equal(r.body.isCurrent, true);
  assert.deepEqual(r.body.current, { year: Y, month: M });
  assert.equal(r.body.totals.departments, 3);
  assert.equal(r.body.totals.withObjectives, 0);
});

await check('a department head sees their own department, and manages it', async () => {
  const r = await list(itHead.token);
  assert.deepEqual(r.body.departments.map((d) => d.name), ['IT']);
  assert.equal(block(r, 'IT').canManage, true);
});

await check('a member sees their department but cannot manage it; someone in no department sees none', async () => {
  const m = await list(itMember.token);
  assert.deepEqual(m.body.departments.map((d) => d.name), ['IT']);
  assert.equal(block(m, 'IT').canManage, false);
  const o = await list(outsider.token);
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.departments, []);
});

await check('the CEO sees every department — and manages none', async () => {
  const r = await list(ceo.token);
  assert.equal(r.body.departments.length, 3);
  assert.ok(r.body.departments.every((d) => d.canManage === false));
});

await check('a bad month is refused; no token is 401', async () => {
  assert.equal((await api('GET', '/monthly-objectives?year=2026&month=13', admin.token)).status, 400);
  assert.equal((await api('GET', '/monthly-objectives?year=1999&month=5', admin.token)).status, 400);
  assert.equal((await api('GET', '/monthly-objectives', null)).status, 401);
});

// ── creating ────────────────────────────────────────────────────────────────
let first;
await check('the head of IT sets an objective with key results and an owner (201)', async () => {
  const r = await make(itHead.token, {
    objective: 'Ship the booking app',
    description: 'v2 to staff',
    priority: 'high',
    ownerId: String(itMemberEmp),
    keyResults: [kr('Screens done', 40, { unit: 'screens' }), kr('Bugs closed', 10)],
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  first = r.body;
  assert.equal(first.objective, 'Ship the booking app');
  assert.equal(first.departmentName, 'IT');
  assert.equal(first.ownerName, 'Irfan (IT member)');
  assert.equal(first.priority, 'high');
  assert.equal(first.progress, 0);
  assert.equal(first.keyResults.length, 2);
  assert.ok(first.keyResults[0].id);
  assert.equal(first.access.canManage, true);
  assert.equal(first.result, null);
});

await check('it shows up in the month, with the department summary', async () => {
  const r = await list(itHead.token);
  assert.equal(block(r, 'IT').objectives.length, 1);
  assert.equal(block(r, 'IT').summary.count, 1);
  assert.equal(block(r, 'IT').summary.open, 1);
});

await check('nobody else may set IT\'s objectives: another head, a member, someone outside, the CEO (403)', async () => {
  for (const who of [hrHead, itMember, outsider, ceo]) {
    const r = await make(who.token, { objective: 'Nope' });
    assert.equal(r.status, 403, who.role + ' ' + JSON.stringify(r.body));
  }
  assert.equal((await list(itHead.token)).body.departments[0].objectives.length, 1);
});

await check('an administrator may set any department\'s', async () => {
  const r = await api('POST', '/monthly-objectives', admin.token, { departmentId: String(dArtist._id), year: Y, month: M, objective: 'Train 5 junior artists' });
  assert.equal(r.status, 201);
});

await check('what is wrong is refused with a reason: no title, a zero target, no department, a stranger as owner', async () => {
  assert.equal((await make(itHead.token, { objective: '  ' })).status, 400);
  assert.equal((await make(itHead.token, { objective: 'x', keyResults: [kr('a', 0)] })).status, 400);
  assert.equal((await api('POST', '/monthly-objectives', itHead.token, { year: Y, month: M, objective: 'x' })).status, 400);
  assert.equal((await api('POST', '/monthly-objectives', itHead.token, { departmentId: String(new mongoose.Types.ObjectId()), year: Y, month: M, objective: 'x' })).status, 404);
  const owner = await make(itHead.token, { objective: 'x', ownerId: String(new mongoose.Types.ObjectId()) });
  assert.equal(owner.status, 400);
  assert.match(owner.body.message, /staff list/);
  assert.equal((await make(itHead.token, { objective: 'x', year: 2026, month: 14 })).status, 400);
});

await check('a past month is closed to a head (403 MONTH_CLOSED), still open to an administrator', async () => {
  const r = await make(itHead.token, { objective: 'Back-dated', ...past });
  assert.equal(r.status, 403);
  assert.equal(r.body.code, 'MONTH_CLOSED');
  const a = await api('POST', '/monthly-objectives', admin.token, { departmentId: String(dIT._id), ...past, objective: 'Put right by an admin' });
  assert.equal(a.status, 201);
});

await check('a future month can be planned ahead', async () => {
  const r = await make(itHead.token, { objective: 'Next month\'s plan', ...next });
  assert.equal(r.status, 201);
  assert.equal(r.body.month, next.month);
});

// ── editing ─────────────────────────────────────────────────────────────────
await check('the head edits it: the key results keep their ids; one is added, one removed', async () => {
  const keep = first.keyResults[0];
  const r = await api('PUT', `/monthly-objectives/${first.id}`, itHead.token, {
    objective: 'Ship the booking app v2',
    keyResults: [{ id: keep.id, title: 'Screens done', targetValue: 50, unit: 'screens' }, kr('Docs written', 5)],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.objective, 'Ship the booking app v2');
  assert.equal(r.body.keyResults.length, 2);
  assert.equal(r.body.keyResults[0].id, keep.id);
  assert.equal(r.body.keyResults[0].targetValue, 50);
  assert.ok(!r.body.keyResults.some((k) => k.title === 'Bugs closed'));
  first = r.body;
});

await check('an edit made on a stale copy is refused (409 OBJECTIVE_CONFLICT), and changes nothing', async () => {
  const r = await api('PUT', `/monthly-objectives/${first.id}`, itHead.token, { objective: 'Stale edit', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'OBJECTIVE_CONFLICT');
  assert.equal((await MonthlyObjective.findById(first.id)).objective, 'Ship the booking app v2');
});

await check('a member and the owner cannot rewrite it (403); a bad edit is refused (400)', async () => {
  assert.equal((await api('PUT', `/monthly-objectives/${first.id}`, itMember.token, { objective: 'x' })).status, 403); // the owner, but not the head
  assert.equal((await api('PUT', `/monthly-objectives/${first.id}`, itOther.token, { objective: 'x' })).status, 403);
  assert.equal((await api('PUT', `/monthly-objectives/${first.id}`, itHead.token, { objective: '' })).status, 400);
  assert.equal((await api('PUT', '/monthly-objectives/not-an-id', itHead.token, { objective: 'x' })).status, 404);
});

// ── reporting progress ──────────────────────────────────────────────────────
await check('the objective\'s OWNER may report progress on a key result — and the objective\'s progress follows', async () => {
  const k = first.keyResults[0];
  const r = await api('PATCH', `/monthly-objectives/${first.id}/key-results/${k.id}`, itMember.token, { value: 25 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.keyResults[0].currentValue, 25);
  assert.equal(r.body.keyResults[0].checkIns.length, 1);
  assert.equal(r.body.keyResults[0].completed, false);
  assert.equal(r.body.progress, 25); // (25/50 + 0/5) / 2
  assert.equal(r.body.access.canManage, false);
  assert.equal(r.body.access.canCheckIn, true);
});

await check('someone else in the department may not (403); the head may', async () => {
  const k = first.keyResults[0];
  assert.equal((await api('PATCH', `/monthly-objectives/${first.id}/key-results/${k.id}`, itOther.token, { value: 30 })).status, 403);
  const r = await api('PATCH', `/monthly-objectives/${first.id}/key-results/${k.id}`, itHead.token, { value: 50 });
  assert.equal(r.status, 200);
  assert.equal(r.body.keyResults[0].completed, true); // reached its target
  assert.equal(r.body.progress, 50);
});

await check('a check-in is validated: nothing sent, a negative number, an unknown key result', async () => {
  const k = first.keyResults[0];
  assert.equal((await api('PATCH', `/monthly-objectives/${first.id}/key-results/${k.id}`, itHead.token, {})).status, 400);
  assert.equal((await api('PATCH', `/monthly-objectives/${first.id}/key-results/${k.id}`, itHead.token, { value: -4 })).status, 400);
  assert.equal((await api('PATCH', `/monthly-objectives/${first.id}/key-results/nope`, itHead.token, { value: 4 })).status, 404);
});

await check('"done" can be ticked without a number', async () => {
  const k2 = first.keyResults[1];
  const r = await api('PATCH', `/monthly-objectives/${first.id}/key-results/${k2.id}`, itHead.token, { completed: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.keyResults[1].completed, true);
  assert.equal(r.body.progress, 100);
});

// ── closing and reopening ───────────────────────────────────────────────────
await check('the head closes it with a result and a note; a bad result is refused; the others may not', async () => {
  assert.equal((await api('POST', `/monthly-objectives/${first.id}/close`, itHead.token, { result: 'great' })).status, 400);
  assert.equal((await api('POST', `/monthly-objectives/${first.id}/close`, itMember.token, { result: 'achieved' })).status, 403);
  assert.equal((await api('POST', `/monthly-objectives/${first.id}/close`, ceo.token, { result: 'achieved' })).status, 403);
  const r = await api('POST', `/monthly-objectives/${first.id}/close`, itHead.token, { result: 'achieved', note: 'Shipped on the 28th' });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'achieved');
  assert.equal(r.body.resultNote, 'Shipped on the 28th');
  assert.ok(r.body.closedAt);
});

await check('a closed objective cannot be edited, reported on or deleted (409 OBJECTIVE_CLOSED)', async () => {
  const k = first.keyResults[0];
  for (const [m, p, b] of [
    ['PUT', `/monthly-objectives/${first.id}`, { objective: 'x' }],
    ['PATCH', `/monthly-objectives/${first.id}/key-results/${k.id}`, { value: 1 }],
    ['DELETE', `/monthly-objectives/${first.id}`, undefined],
  ]) {
    const r = await api(m, p, itHead.token, b);
    assert.equal(r.status, 409, `${m} ${p}`);
    assert.equal(r.body.code, 'OBJECTIVE_CLOSED');
  }
});

await check('reopening makes it editable again, and clears the result', async () => {
  assert.equal((await api('POST', `/monthly-objectives/${first.id}/reopen`, itMember.token)).status, 403);
  const r = await api('POST', `/monthly-objectives/${first.id}/reopen`, itHead.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.result, null);
  assert.equal(r.body.resultNote, '');
  assert.equal(r.body.closedAt, null);
  assert.equal((await api('PUT', `/monthly-objectives/${first.id}`, itHead.token, { priority: 'medium' })).status, 200);
});

// ── carrying over ───────────────────────────────────────────────────────────
let carryIds = {};
await check('set up three objectives for the month: one achieved, one partly done, one still open', async () => {
  const a = (await make(itHead.token, { objective: 'Achieved one', keyResults: [kr('K', 10)] })).body;
  const b = (await make(itHead.token, { objective: 'Partly one', keyResults: [kr('Signups', 40), kr('Reviews', 10)] })).body;
  const c = (await make(itHead.token, { objective: 'Open one' })).body; // no key results
  await api('PATCH', `/monthly-objectives/${a.id}/key-results/${a.keyResults[0].id}`, itHead.token, { value: 10 });
  await api('PATCH', `/monthly-objectives/${b.id}/key-results/${b.keyResults[0].id}`, itHead.token, { value: 25 });
  await api('PATCH', `/monthly-objectives/${b.id}/key-results/${b.keyResults[1].id}`, itHead.token, { value: 10 }); // done
  await api('POST', `/monthly-objectives/${a.id}/close`, itHead.token, { result: 'achieved' });
  await api('POST', `/monthly-objectives/${b.id}/close`, itHead.token, { result: 'partly', note: 'Half way' });
  carryIds = { a: a.id, b: b.id, c: c.id };
});

await check('carrying over takes the unfinished into next month — what is LEFT of each open key result — and leaves the achieved one', async () => {
  const r = await api('POST', '/monthly-objectives/carry-over', itHead.token, { departmentId: String(dIT._id), year: Y, month: M, ids: [carryIds.a, carryIds.b, carryIds.c] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.toMonth, next.month);
  assert.deepEqual(r.body.created.map((o) => o.objective).sort(), ['Open one', 'Partly one']);
  const partly = r.body.created.find((o) => o.objective === 'Partly one');
  assert.equal(partly.keyResults.length, 1); // "Reviews" was done
  assert.equal(partly.keyResults[0].title, 'Signups');
  assert.equal(partly.keyResults[0].targetValue, 15); // 40 − 25
  assert.equal(partly.keyResults[0].currentValue, 0);
  assert.equal(partly.carriedFrom, true);
  assert.equal(partly.month, next.month);
  assert.deepEqual(r.body.skipped.map((s) => s.reason), ['achieved']);
});

await check('the source says it was carried; the next month shows the copies', async () => {
  const r = await list(itHead.token, next);
  const titles = block(r, 'IT').objectives.map((o) => o.objective);
  assert.ok(titles.includes('Partly one') && titles.includes('Open one'));
  const now = await list(itHead.token);
  assert.equal(block(now, 'IT').objectives.find((o) => o.objective === 'Partly one').carriedTo, true);
});

await check('pressing it twice makes the copies once (idempotent)', async () => {
  const again = await api('POST', '/monthly-objectives/carry-over', itHead.token, { departmentId: String(dIT._id), year: Y, month: M, ids: [carryIds.a, carryIds.b, carryIds.c] });
  assert.equal(again.body.created.length, 0);
  assert.ok(again.body.skipped.some((s) => s.reason === 'already carried over'));
  const titles = block(await list(itHead.token, next), 'IT').objectives.filter((o) => o.objective === 'Partly one');
  assert.equal(titles.length, 1);
});

await check('only the department\'s head may carry over (403); a missing department is 404', async () => {
  assert.equal((await api('POST', '/monthly-objectives/carry-over', hrHead.token, { departmentId: String(dIT._id), year: Y, month: M })).status, 403);
  assert.equal((await api('POST', '/monthly-objectives/carry-over', itMember.token, { departmentId: String(dIT._id), year: Y, month: M })).status, 403);
  assert.equal((await api('POST', '/monthly-objectives/carry-over', itHead.token, { departmentId: String(new mongoose.Types.ObjectId()), year: Y, month: M })).status, 404);
});

await check('last month\'s result is on the department\'s card for this month', async () => {
  // carried copies live in next month; the month after that sees them as "last month"
  const after = M >= 11 ? { year: next.year + (next.month === 12 ? 1 : 0), month: next.month === 12 ? 1 : next.month + 1 } : { year: next.year, month: next.month + 1 };
  const r = await list(itHead.token, after);
  // next month holds the plan made ahead earlier plus the two carried copies — all still open
  assert.equal(block(r, 'IT').lastMonth.count, 3);
  assert.equal(block(r, 'IT').lastMonth.open, 3);
  assert.equal(block(r, 'IT').lastMonth.achieved, 0);
});

await check('a December month carries into January of the next year', async () => {
  const dec = await MonthlyObjective.create({ departmentId: dHR._id, departmentName: 'HR', departmentKey: 'hr', year: 2027, month: 12, objective: 'Year-end audit', keyResults: [{ id: 'k', title: 'Files', targetValue: 10, currentValue: 4 }] });
  const r = await api('POST', '/monthly-objectives/carry-over', hrHead.token, { departmentId: String(dHR._id), year: 2027, month: 12 });
  assert.equal(r.status, 200);
  assert.equal(r.body.toYear, 2028);
  assert.equal(r.body.toMonth, 1);
  assert.equal(r.body.created[0].keyResults[0].targetValue, 6);
  assert.ok(dec);
});

// ── deleting ────────────────────────────────────────────────────────────────
await check('an open objective can be deleted by its head only; a copy carried from it no longer points back', async () => {
  const keepMe = (await list(itHead.token, next)).body.departments[0].objectives.find((o) => o.objective === 'Open one');
  assert.equal(keepMe.carriedFrom, true);
  assert.equal((await api('DELETE', `/monthly-objectives/${carryIds.c}`, itMember.token)).status, 403);
  assert.equal((await api('DELETE', `/monthly-objectives/${carryIds.c}`, itHead.token)).status, 200);
  assert.equal(await MonthlyObjective.findById(carryIds.c), null);
  const after = (await list(itHead.token, next)).body.departments[0].objectives.find((o) => o.objective === 'Open one');
  assert.equal(after.carriedFrom, false);
});

// ── reminders ───────────────────────────────────────────────────────────────
const notes = (userId, type) => Notification.find({ recipient: userId, type }).lean();
const AT = new Date('2031-03-10T10:00:00Z'); // March 2031: nothing exists for it

await check('on a month with nothing set, the head of each department with a head is asked to set it; Artist has no head, so nobody is', async () => {
  await MonthlyObjective.create({ departmentId: dHR._id, departmentName: 'HR', departmentKey: 'hr', year: 2031, month: 2, objective: 'Feb thing', keyResults: [] }); // still open
  const r = await runMonthlyObjectiveReminders(AT);
  const it = await notes(itHead.id, 'monthly_objectives_set');
  assert.equal(it.length, 1);
  assert.equal(it[0].title, "Set March 2031's objectives");
  assert.match(it[0].body, /^IT has no objectives for March 2031/);
  assert.equal(it[0].link, '/monthly-objectives');
  assert.equal((await notes(hrHead.id, 'monthly_objectives_set')).length, 1);
  assert.equal(r.sent, 3); // IT set, HR set, HR close
  assert.equal(await Notification.countDocuments({ type: 'monthly_objectives_set' }), 2); // not the Artist department
});

await check('…and HR\'s head is also asked to close out February, which is still open', async () => {
  const close = await notes(hrHead.id, 'monthly_objectives_close');
  assert.equal(close.length, 1);
  assert.equal(close[0].title, 'Close out February 2031');
  assert.equal((await notes(itHead.id, 'monthly_objectives_close')).length, 0); // IT had nothing in February
});

await check('running it again, or on another day of the same month, sends nothing more', async () => {
  const again = await runMonthlyObjectiveReminders(new Date('2031-03-20T10:00:00Z'));
  assert.equal(await Notification.countDocuments({ type: 'monthly_objectives_set' }), 2);
  assert.equal(await Notification.countDocuments({ type: 'monthly_objectives_close' }), 1);
  assert.equal(again.sent, 3); // it tried; the dedupe kept them to one each
});

await check('a department that has set its month is not asked', async () => {
  await MonthlyObjective.create({ departmentId: dIT._id, departmentName: 'IT', departmentKey: 'it', year: 2031, month: 4, objective: 'April plan', keyResults: [] });
  await runMonthlyObjectiveReminders(new Date('2031-04-02T10:00:00Z'));
  assert.equal((await notes(itHead.id, 'monthly_objectives_set')).filter((x) => /April/.test(x.title)).length, 0);
  assert.equal((await notes(hrHead.id, 'monthly_objectives_set')).filter((x) => /April/.test(x.title)).length, 1);
});

await check('someone who leads two departments gets ONE message naming both', async () => {
  const dFleet = await Department.create({ key: 'fleet', name: 'Fleet', division: 'creative', head: itHeadEmp });
  await runMonthlyObjectiveReminders(new Date('2031-06-03T10:00:00Z'));
  const june = (await notes(itHead.id, 'monthly_objectives_set')).filter((x) => /June/.test(x.title));
  assert.equal(june.length, 1);
  assert.match(june[0].body, /^Fleet and IT have no objectives for June 2031/);
  assert.ok(dFleet);
});

await check('an administrator is never sent these (admins only get the month-end summary)', async () => {
  assert.equal(await Notification.countDocuments({ recipient: admin.id }), 0);
});

await check('opening the notifications runs the sweep without trouble', async () => {
  const r = await api('GET', '/notifications', itHead.token);
  assert.equal(r.status, 200);
});

// ── when the objective is not just "a number, then a result" ────────────────
const FAR = { year: 2034, month: 5 }; // a month of their own, so averages are known
const SIX = { year: 2034, month: 6 };
const post = (ym, body, token = itHead.token) => api('POST', '/monthly-objectives', token, { departmentId: String(dIT._id), ...ym, ...body });
const closeIt = (id, result, note, token = itHead.token) => api('POST', `/monthly-objectives/${id}/close`, token, { result, ...(note === undefined ? {} : { note }) });
const checkIn = (id, krId, body, token = itHead.token) => api('PATCH', `/monthly-objectives/${id}/key-results/${krId}`, token, body);
const carry = (ym, ids, token = itHead.token) => api('POST', '/monthly-objectives/carry-over', token, { departmentId: String(dIT._id), ...ym, ids });
const objectives = MonthlyObjective.collection;

let kinds;
await check('key results come in three kinds: a number, a percentage (out of 100) and a yes/no (no target needed)', async () => {
  const r = await post(FAR, {
    objective: 'Marketing automation',
    keyResults: [kr('Bookings', 40, { unit: 'b' }), kr('Automation built', 3, { kind: 'percent', unit: 'pages' }), { title: 'Launched', kind: 'yesno' }],
  });
  assert.equal(r.status, 201);
  const [a, b, c] = r.body.keyResults;
  assert.deepEqual([a.kind, b.kind, c.kind], ['number', 'percent', 'yesno']);
  assert.deepEqual([b.targetValue, b.unit, c.targetValue, c.unit], [100, '%', 1, '']); // whatever the form sent, they are fixed
  kinds = r.body;
});

await check('a yes/no is ticked and never given a number; a percentage stops at 100; the progress follows', async () => {
  const [, b, c] = kinds.keyResults;
  assert.equal((await checkIn(kinds.id, c.id, { value: 1 })).status, 400);
  assert.equal((await checkIn(kinds.id, b.id, { value: 130 })).status, 400);
  assert.equal((await checkIn(kinds.id, b.id, { value: 60 })).body.progress, 20); // (0 + 60 + 0) / 3
  const done = await checkIn(kinds.id, c.id, { completed: true });
  assert.equal(done.body.progress, 53); // (0 + 60 + 100) / 3
  assert.equal(done.body.keyResults[2].completed, true);
  assert.equal((await checkIn(kinds.id, c.id, { completed: false })).body.progress, 20);
});

await check('editing keeps a key result\'s kind and history; changing its kind starts it afresh', async () => {
  const [a, b, c] = kinds.keyResults;
  const same = await api('PUT', `/monthly-objectives/${kinds.id}`, itHead.token, {
    keyResults: [{ id: a.id, title: 'Bookings', targetValue: 40, unit: 'b' }, { id: b.id, title: 'Automation built', kind: 'percent' }, { id: c.id, title: 'Launched', kind: 'yesno' }],
  });
  assert.equal(same.status, 200);
  assert.equal(same.body.keyResults[1].currentValue, 60); // the 60% is still there
  const changed = await api('PUT', `/monthly-objectives/${kinds.id}`, itHead.token, {
    keyResults: [{ id: a.id, title: 'Bookings', targetValue: 40, unit: 'b' }, { id: b.id, title: 'Automation built', kind: 'yesno' }, { id: c.id, title: 'Launched', kind: 'yesno' }],
  });
  assert.equal(changed.status, 200);
  assert.deepEqual([changed.body.keyResults[1].kind, changed.body.keyResults[1].currentValue, changed.body.keyResults[1].completed], ['yesno', 0, false]);
});

await check('a result that differs from the progress needs a note: 100% but missed (late)', async () => {
  const o = (await post(FAR, { objective: 'Hire two', keyResults: [kr('Offers', 10, { currentValue: 10 })] })).body;
  assert.deepEqual([o.progress, o.suggestedResult], [100, 'achieved']);
  const bad = await closeIt(o.id, 'missed');
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'RESULT_NEEDS_REASON');
  assert.match(bad.body.message, /100%/);
  const ok = await closeIt(o.id, 'missed', 'Both joined after the deadline');
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.result, ok.body.overridden, ok.body.progressAtClose, ok.body.resultNote], ['missed', true, 100, 'Both joined after the deadline']);
  assert.equal(ok.body.suggestedResult, null); // closed: nothing left to suggest
  // reopening clears how it ended
  const re = await api('POST', `/monthly-objectives/${o.id}/reopen`, itHead.token);
  assert.deepEqual([re.body.result, re.body.overridden, re.body.progressAtClose], [null, false, null]);
});

await check('…and the other way: 40% called achieved because the scope was cut', async () => {
  const o = (await post(FAR, { objective: 'Train staff', keyResults: [kr('Sessions', 10, { currentValue: 4 })] })).body;
  assert.equal(o.suggestedResult, 'missed');
  assert.equal((await closeIt(o.id, 'achieved')).status, 400);
  assert.equal((await closeIt(o.id, 'achieved', '  ')).status, 400); // blank is not a reason
  const ok = await closeIt(o.id, 'achieved', 'Only two venues were needed');
  assert.deepEqual([ok.status, ok.body.overridden, ok.body.progressAtClose], [200, true, 40]);
});

await check('the result its progress points to needs no note and is not marked as overridden', async () => {
  const o = (await post(FAR, { objective: 'Open a branch desk', keyResults: [kr('Visits', 10, { currentValue: 6 })] })).body;
  const ok = await closeIt(o.id, 'partly');
  assert.deepEqual([ok.status, ok.body.overridden, ok.body.progressAtClose], [200, false, 60]);
});

await check('an objective with no key results has nothing to measure, so it can end any way', async () => {
  const o = (await post(FAR, { objective: 'Culture' })).body;
  assert.equal(o.suggestedResult, null);
  const ok = await closeIt(o.id, 'achieved');
  assert.deepEqual([ok.status, ok.body.overridden], [200, false]);
});

let cancelled;
let postponed;
await check('cancelling or postponing needs a reason; each drops out of the month\'s average and is counted on its own', async () => {
  const live = (await post(SIX, { objective: 'Live one', keyResults: [kr('a', 10, { currentValue: 10 })] })).body;
  cancelled = (await post(SIX, { objective: 'Dropped', keyResults: [kr('b', 10)] })).body;
  postponed = (await post(SIX, { objective: 'Later', keyResults: [kr('c', 10)] })).body;
  assert.equal((await closeIt(live.id, 'achieved')).status, 200);
  assert.equal((await closeIt(cancelled.id, 'cancelled')).status, 400);
  assert.equal((await closeIt(postponed.id, 'deferred', '')).status, 400);
  const before = block(await list(admin.token, SIX), 'IT').summary;
  assert.deepEqual([before.count, before.avgProgress], [3, 33]); // (100 + 0 + 0) / 3 while all three count
  assert.equal((await closeIt(cancelled.id, 'cancelled', 'The supplier pulled out')).body.result, 'cancelled');
  assert.equal((await closeIt(postponed.id, 'deferred', 'Waiting on the new office')).body.result, 'deferred');
  const after = block(await list(admin.token, SIX), 'IT').summary;
  assert.deepEqual([after.count, after.avgProgress, after.cancelled, after.deferred, after.achieved, after.open], [3, 100, 1, 1, 1, 0]);
});

await check('a cancelled objective is not carried (and says why); a postponed one is, with what it had, into the next month', async () => {
  const r = await carry(SIX, [cancelled.id, postponed.id]);
  assert.equal(r.status, 200);
  assert.equal(r.body.created.length, 1);
  assert.equal(r.body.created[0].objective, 'Later');
  assert.deepEqual([r.body.toYear, r.body.toMonth], [2034, 7]);
  assert.deepEqual(r.body.skipped.map((x) => x.reason), ['cancelled']);
  assert.equal(r.body.created[0].keyResults[0].targetValue, 10);
  const again = await carry(SIX, [postponed.id]);
  assert.equal(again.body.created.length, 0); // pressing it twice makes it once
});

await check('a cancelled objective is closed: it cannot be edited, but it can be reopened', async () => {
  const edit = await api('PUT', `/monthly-objectives/${cancelled.id}`, itHead.token, { objective: 'Changed my mind' });
  assert.equal(edit.status, 409);
  assert.equal(edit.body.code, 'OBJECTIVE_CLOSED');
  const re = await api('POST', `/monthly-objectives/${cancelled.id}/reopen`, itHead.token);
  assert.equal(re.body.result, null);
});

await check('a new objective can be touched up freely; after a day, in a month that has started, changing the plan needs a reason', async () => {
  const o = (await make(itHead.token, { objective: 'Win brides', keyResults: [kr('Bookings', 40), kr('Reviews', 10)] })).body;
  const fresh = await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { objective: 'Win more brides' });
  assert.equal(fresh.status, 200);
  assert.deepEqual([fresh.body.planLocked, fresh.body.changes.length], [false, 0]);

  await objectives.updateOne({ _id: new mongoose.Types.ObjectId(o.id) }, { $set: { createdAt: new Date(Date.now() - 2 * 864e5) } });
  const noReason = await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { objective: 'Win even more brides' });
  assert.equal(noReason.status, 400);
  assert.equal(noReason.body.code, 'CHANGE_NEEDS_REASON');

  // the details are not the plan
  const details = await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { description: 'More detail', priority: 'high' });
  assert.equal(details.status, 200);
  assert.equal(details.body.planLocked, true);
  assert.equal(details.body.changes.length, 0);

  // lowering a target is — and with a reason it goes through and is kept
  const [a, b] = fresh.body.keyResults;
  const lower = [{ id: a.id, title: 'Bookings', targetValue: 30 }, { id: b.id, title: 'Reviews', targetValue: 10 }];
  assert.equal((await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { keyResults: lower })).status, 400);
  const done = await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { keyResults: lower, changeReason: 'Two artists left' });
  assert.equal(done.status, 200);
  assert.equal(done.body.keyResults[0].targetValue, 30);
  assert.equal(done.body.changes.length, 1);
  assert.deepEqual([done.body.changes[0].reason, done.body.changes[0].summary, done.body.changes[0].byName], ['Two artists left', ['“Bookings” target 40 → 30'], 'ithead']);

  // removing a key result and adding one is recorded together
  const swap = await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { keyResults: [lower[0], kr('Referrals', 8)], changeReason: 'Focus on referrals' });
  assert.deepEqual(swap.body.changes[1].summary, ['Added key result “Referrals”', 'Removed key result “Reviews”']);
});

await check('a month that has not started is still being planned: no reason needed', async () => {
  const o = (await post(next, { objective: 'Plan ahead', keyResults: [kr('x', 5)] })).body;
  await objectives.updateOne({ _id: new mongoose.Types.ObjectId(o.id) }, { $set: { createdAt: new Date(Date.now() - 5 * 864e5) } });
  const r = await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { objective: 'Plan further ahead' });
  assert.deepEqual([r.status, r.body.planLocked], [200, false]);
});

let run;
await check('a several-month objective: month 1 of 3 continues rather than being scored; "continues" is for those alone', async () => {
  run = (await make(itHead.token, { objective: 'Marketing automation', spanMonths: 3, keyResults: [kr('Campaigns live', 40, { currentValue: 12 }), { title: 'Launched', kind: 'yesno' }] })).body;
  assert.deepEqual([run.span.number, run.span.total, run.span.final, run.span.overran], [1, 3, false, false]);
  assert.equal(run.suggestedResult, 'continued'); // 30% and 0% → 15%, but months remain
  const plain = (await make(itHead.token, { objective: 'A one-month thing', keyResults: [kr('a', 10)] })).body;
  assert.equal(plain.span, null);
  const nope = await closeIt(plain.id, 'continued');
  assert.deepEqual([nope.status, nope.body.code], [400, 'RESULT_NOT_ALLOWED']);
});

await check('closing it as "continues" needs no note; carrying it keeps the running total and the run, not "what is left"', async () => {
  const closed = await closeIt(run.id, 'continued');
  assert.deepEqual([closed.status, closed.body.overridden, closed.body.result], [200, false, 'continued']);
  const r = await carry({ year: Y, month: M }, [run.id]);
  assert.equal(r.body.created.length, 1);
  const m2 = r.body.created[0];
  assert.deepEqual([m2.year, m2.month], [next.year, next.month]);
  assert.deepEqual([m2.span.number, m2.span.total, m2.span.final], [2, 3, false]);
  assert.deepEqual([m2.keyResults[0].targetValue, m2.keyResults[0].currentValue], [40, 12]); // the total runs on
  assert.equal(m2.keyResults.length, 2);
  assert.equal(m2.progress, run.progress); // nothing lost in the move
  run = m2;
});

await check('the last planned month is scored like any other; it can no longer "continue"', async () => {
  assert.equal((await closeIt(run.id, 'continued')).status, 200); // month 2
  const r = await carry(next, [run.id]);
  const m3 = r.body.created[0];
  assert.deepEqual([m3.span.number, m3.span.final], [3, true]);
  assert.equal(m3.suggestedResult, 'missed'); // 15% at the end of the run
  const nope = await closeIt(m3.id, 'continued');
  assert.deepEqual([nope.status, nope.body.code], [400, 'RESULT_NOT_ALLOWED']);
  // …and finishing it all is simply achieved
  await checkIn(m3.id, m3.keyResults[0].id, { value: 40 });
  const finished = await checkIn(m3.id, m3.keyResults[1].id, { completed: true });
  assert.deepEqual([finished.body.progress, finished.body.suggestedResult], [100, 'achieved']);
});

await check('how long it runs can be changed, or taken away; 2 to 24 months only', async () => {
  const o = (await post(FAR, { objective: 'Rebrand', spanMonths: 2, keyResults: [kr('a', 5)] })).body;
  assert.equal(o.span.total, 2);
  assert.equal((await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { spanMonths: 25 })).status, 400);
  assert.equal((await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { spanMonths: 5 })).body.span.total, 5);
  assert.equal((await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { spanMonths: 1 })).body.span, null);
});

await check('the CEO still sees all of it and changes none of it', async () => {
  const r = await list(ceo.token, SIX);
  assert.equal(block(r, 'IT').objectives[0].access.canManage, false);
  assert.equal((await closeIt(postponed.id, 'deferred', 'x', ceo.token)).status, 403);
});

// ── the team sees its own month, and what is assigned to them ───────────────
const artistMemberEmp = await emp('Aisha (Artist)', 'Artist');
const mgr = await mk('mgr', 'manager', { employeeId: artistMemberEmp });
const ASSIGN = { year: 2034, month: 8 };
let given;
await check('an objective given to someone is theirs to see and report on — even from another department — and nobody else\'s', async () => {
  given = (await post(ASSIGN, { objective: 'Fleet audit for IT', ownerId: String(outsiderEmp), keyResults: [kr('Vehicles checked', 10, { currentValue: 2 }), { title: 'Report filed', kind: 'yesno' }] })).body;
  await post(ASSIGN, { objective: 'Not for Omar', keyResults: [kr('x', 5)] });
  const r = await list(outsider.token, ASSIGN);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.assigned.map((o) => o.objective), ['Fleet audit for IT']);
  const o = r.body.assigned[0];
  assert.deepEqual([o.assignedToMe, o.access.canCheckIn, o.access.canManage, o.departmentName], [true, true, false, 'IT']);
  // IT itself stays out of sight: only what was given to him
  assert.equal(r.body.departments.some((d) => d.name === 'IT'), false);
});

await check('…he can report progress on it, but not rewrite, close or delete it', async () => {
  const [a, b] = given.keyResults;
  assert.equal((await checkIn(given.id, a.id, { value: 6 }, outsider.token)).status, 200);
  assert.equal((await checkIn(given.id, b.id, { completed: true }, outsider.token)).body.progress, 80); // (60 + 100) / 2
  assert.equal((await api('PUT', `/monthly-objectives/${given.id}`, outsider.token, { objective: 'Mine now' })).status, 403);
  assert.equal((await closeIt(given.id, 'achieved', 'x', outsider.token)).status, 403);
  assert.equal((await api('DELETE', `/monthly-objectives/${given.id}`, outsider.token)).status, 403);
});

await check('what is assigned is for that month only, and someone with nothing assigned gets an empty list', async () => {
  assert.deepEqual((await list(outsider.token)).body.assigned, []); // the current month
  assert.deepEqual((await list(hrHead.token, ASSIGN)).body.assigned, []);
});

await check('a member of the department sees it twice, rightly: in their department and under what is assigned to them', async () => {
  await post(ASSIGN, { objective: 'Irfan\'s own', ownerId: String(itMemberEmp), keyResults: [kr('y', 3)] });
  const r = await list(itMember.token, ASSIGN);
  assert.deepEqual(r.body.assigned.map((o) => o.objective), ['Irfan\'s own']);
  const itBlock = block(r, 'IT');
  assert.equal(itBlock.member, true);
  assert.equal(itBlock.objectives.find((o) => o.objective === 'Irfan\'s own').assignedToMe, true);
  assert.equal(itBlock.objectives.find((o) => o.objective === 'Fleet audit for IT').assignedToMe, false);
});

await check('the team\'s own department is marked and listed first', async () => {
  const r = await list(mgr.token); // a manager sees every department; Artist is where this one belongs — it would otherwise come after HR and IT
  assert.equal(r.body.departments[0].name, 'Artist');
  assert.deepEqual(r.body.departments.map((d) => d.member), r.body.departments.map((_, i) => i === 0)); // Artist only
  const admins = await list(admin.token);
  assert.equal(admins.body.departments.every((d) => d.member === false), true); // an administrator belongs to none…
  const byDivisionThenName = [...admins.body.departments].sort((x, y) => x.division.localeCompare(y.division) || x.name.localeCompare(y.name));
  assert.deepEqual(admins.body.departments.map((d) => d.name), byDivisionThenName.map((d) => d.name)); // …so nothing is moved
});

await check('the CEO, with no staff record, has nothing assigned', async () => {
  const r = await list(ceo.token, ASSIGN);
  assert.deepEqual(r.body.assigned, []); // no staff record, nothing assigned
});

// ── when a key result is done ───────────────────────────────────────────────
const DONE_M = { year: 2034, month: 9 };
const ready = (id) => notes(itHead.id, 'monthly_objective_ready').then((all) => all.filter((n) => /Ready to close: /.test(n.title) && n.title.includes(id)));

await check('done follows the target: raise it past what was reached and the key result opens again; lower it back and it is done', async () => {
  const o = (await post(DONE_M, { objective: 'Bookings drive', keyResults: [kr('Bookings', 40)] })).body;
  const k = o.keyResults[0];
  const done = (await checkIn(o.id, k.id, { value: 40 })).body;
  assert.deepEqual([done.keyResults[0].completed, done.progress, done.keyResults[0].completedByName], [true, 100, 'ithead']);
  const raised = (await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { keyResults: [{ id: k.id, title: 'Bookings', targetValue: 60 }] })).body;
  assert.deepEqual([raised.keyResults[0].completed, raised.progress, raised.keyResults[0].completedAt, raised.keyResults[0].completedByName], [false, 67, null, '']);
  const lowered = (await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { keyResults: [{ id: k.id, title: 'Bookings', targetValue: 40 }] })).body;
  assert.deepEqual([lowered.keyResults[0].completed, lowered.progress, lowered.keyResults[0].completedByName], [true, 100, 'ithead']);
});

await check('a key result ticked done under its target stays done through an edit that leaves its target alone', async () => {
  const o = (await post(DONE_M, { objective: 'Training', keyResults: [kr('Sessions', 10, { currentValue: 3 })] })).body;
  const k = o.keyResults[0];
  assert.equal((await checkIn(o.id, k.id, { completed: true })).body.keyResults[0].completed, true);
  const edited = (await api('PUT', `/monthly-objectives/${o.id}`, itHead.token, { keyResults: [{ id: k.id, title: 'Sessions held', targetValue: 10 }] })).body;
  assert.deepEqual([edited.keyResults[0].completed, edited.keyResults[0].completedByName], [true, 'ithead']);
});

await check('who finished a key result, and when, is kept — and goes if it is put back', async () => {
  const o = (await post(DONE_M, { objective: 'Fleet check', ownerId: String(outsiderEmp), keyResults: [kr('Vehicles', 10), kr('Report', 1, { kind: 'yesno' })] })).body;
  const before = Date.now();
  const r = (await checkIn(o.id, o.keyResults[1].id, { completed: true }, outsider.token)).body;
  const k = r.keyResults[1];
  assert.equal(k.completedByName, 'outsider');
  assert.ok(Math.abs(new Date(k.completedAt).getTime() - before) < 5000);
  const again = (await checkIn(o.id, o.keyResults[1].id, { completed: true }, itHead.token)).body; // reported again by someone else
  assert.equal(again.keyResults[1].completedByName, 'outsider'); // the first one to finish it
  const back = (await checkIn(o.id, o.keyResults[1].id, { completed: false }, outsider.token)).body;
  assert.deepEqual([back.keyResults[1].completed, back.keyResults[1].completedAt, back.keyResults[1].completedByName], [false, null, '']);
});

let flow;
await check('ready to close: only when every key result is done and it is still open', async () => {
  flow = (await post(DONE_M, { objective: 'Hire two trainers', ownerId: String(itMemberEmp), keyResults: [kr('Offers', 2), { title: 'Contracts signed', kind: 'yesno' }] })).body;
  assert.equal(flow.readyToClose, false);
  const [a, b] = flow.keyResults;
  assert.equal((await checkIn(flow.id, a.id, { value: 2 }, itMember.token)).body.readyToClose, false);
  assert.equal((await checkIn(flow.id, b.id, { completed: true }, itMember.token)).body.readyToClose, true);
  const listed = block(await list(admin.token, DONE_M), 'IT').objectives.find((x) => x.id === flow.id);
  assert.equal(listed.readyToClose, true);
});

await check('the department\'s head is told once, when the last key result is done — not the person who did it, not an administrator', async () => {
  const got = await ready('Hire two trainers');
  assert.equal(got.length, 1);
  assert.match(got[0].body, /Every key result of “Hire two trainers” in IT is done \(itmember reported the last one\)/);
  assert.equal(got[0].link, '/monthly-objectives');
  assert.equal((await notes(itMember.id, 'monthly_objective_ready')).length, 0); // the one who reported it
  assert.equal((await notes(admin.id, 'monthly_objective_ready')).length, 0); // admins only get the month-end summary
});

await check('…and not again for a report that changes nothing; but put one back and finish it again, and it is news again', async () => {
  const [a, b] = flow.keyResults;
  await checkIn(flow.id, a.id, { value: 2 }, itMember.token); // already ready
  assert.equal((await ready('Hire two trainers')).length, 1);
  await checkIn(flow.id, b.id, { completed: false }, itMember.token);
  await checkIn(flow.id, b.id, { completed: true }, itMember.token);
  assert.equal((await ready('Hire two trainers')).length, 2);
});

await check('a head who finishes the last key result themself is not told about their own report', async () => {
  const o = (await post(DONE_M, { objective: 'Own it all', keyResults: [kr('x', 2)] })).body;
  await checkIn(o.id, o.keyResults[0].id, { value: 2 }, itHead.token);
  assert.equal((await ready('Own it all')).length, 0);
});

await check('a department with no head has nobody to tell, and the report still goes through', async () => {
  const o = (await api('POST', '/monthly-objectives', admin.token, { departmentId: String(dArtist._id), ...DONE_M, objective: 'Artist plan', keyResults: [kr('x', 2)] })).body;
  const r = await checkIn(o.id, o.keyResults[0].id, { value: 2 }, admin.token);
  assert.deepEqual([r.status, r.body.readyToClose], [200, true]);
});

await check('closing a ready objective as achieved takes one tap: no note, not marked as overridden', async () => {
  const closed = await closeIt(flow.id, 'achieved');
  assert.deepEqual([closed.status, closed.body.result, closed.body.overridden, closed.body.readyToClose], [200, 'achieved', false, false]);
});

await check('a several-month objective with months to go is never "ready to close"; its last month is', async () => {
  const run = (await post(DONE_M, { objective: 'A long one', spanMonths: 2, keyResults: [kr('x', 2)] })).body;
  const r = await checkIn(run.id, run.keyResults[0].id, { value: 2 });
  assert.deepEqual([r.body.progress, r.body.readyToClose], [100, false]);
  assert.equal((await ready('A long one')).length, 0);
});

// ── the trend (how the last months went) ────────────────────────────────────
const TREND_END = { year: 2036, month: 5 };
const trend = (token, q = '') => api('GET', `/monthly-objectives/trend?year=${TREND_END.year}&month=${TREND_END.month}${q}`, token);
const postHr = (ym, body) => api('POST', '/monthly-objectives', hrHead.token, { departmentId: String(dHR._id), ...ym, ...body });
await check('set up the months to look back over', async () => {
  const a = (await post({ year: 2036, month: 4 }, { objective: 'IT in April', keyResults: [kr('Screens', 10)] })).body;
  assert.equal((await checkIn(a.id, a.keyResults[0].id, { value: 5 })).body.progress, 50);
  const b = (await post(TREND_END, { objective: 'IT in May', keyResults: [kr('Screens', 10)] })).body;
  assert.equal((await checkIn(b.id, b.keyResults[0].id, { value: 10 })).body.progress, 100);
  assert.equal((await postHr(TREND_END, { objective: 'HR in May' })).status, 201);
});

await check('an administrator gets the last months of the whole company, oldest first, ending with the month asked for', async () => {
  const r = await trend(admin.token, '&months=3');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.end, TREND_END);
  assert.deepEqual(r.body.months.map((m) => [m.year, m.month, m.count]), [[2036, 3, 0], [2036, 4, 1], [2036, 5, 2]]);
  assert.equal(r.body.months[1].avgProgress, 50);
  assert.equal(r.body.months[2].avgProgress, 50, '(100 + 0) / 2');
});

await check('each month also says how each department went', async () => {
  const may = (await trend(admin.token, '&months=3')).body.months[2];
  const by = Object.fromEntries(may.departments.map((d) => [d.name, d]));
  assert.deepEqual(Object.keys(by).sort(), ['Artist', 'Fleet', 'HR', 'IT'], 'every active department, as in the page itself (an earlier check added Fleet)');
  assert.deepEqual([by.IT.count, by.IT.avgProgress], [1, 100]);
  assert.deepEqual([by.HR.count, by.HR.avgProgress], [1, 0]);
  assert.deepEqual([by.Artist.count, by.Artist.avgProgress], [0, 0]);
  assert.ok(by.IT.departmentId);
});

await check('six months unless asked otherwise', async () => {
  const r = await trend(admin.token);
  assert.equal(r.body.months.length, 6);
  assert.deepEqual([r.body.months[0].year, r.body.months[0].month], [2035, 12], 'runs back over the year end');
  assert.equal((await trend(admin.token, '&months=12')).body.months.length, 12);
});

await check('a head sees only their own department in it — and the whole is only theirs', async () => {
  const r = await trend(itHead.token, '&months=3');
  const may = r.body.months[2];
  assert.deepEqual(may.departments.map((d) => d.name).sort(), ['Fleet', 'IT'], 'the departments they lead (an earlier check made them head of Fleet too) — never HR');
  assert.deepEqual([may.count, may.avgProgress], [1, 100], 'HR\'s objective is not counted for them');
});

await check('a member sees their own department\'s; someone elsewhere sees none of IT\'s or HR\'s', async () => {
  assert.deepEqual((await trend(itMember.token, '&months=3')).body.months[2].departments.map((d) => d.name), ['IT']);
  const o = await trend(outsider.token, '&months=3');
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.months.map((m) => m.count), [0, 0, 0], 'nothing of IT\'s or HR\'s is counted for them');
  assert.ok(o.body.months[2].departments.every((d) => d.name === 'Fleet'), 'only their own department (Fleet) is listed');
});

await check('the CEO sees every department\'s', async () => {
  const r = await trend(ceo.token, '&months=3');
  assert.equal(r.body.months[2].count, 2);
  assert.equal(r.body.months[2].departments.length, 4, 'every active department');
});

await check('bad asks are refused; no token is 401', async () => {
  assert.equal((await trend(admin.token, '&months=1')).status, 400);
  assert.equal((await trend(admin.token, '&months=13')).status, 400);
  assert.equal((await trend(admin.token, '&months=abc')).status, 400);
  assert.equal((await api('GET', '/monthly-objectives/trend?year=2026&month=13', admin.token)).status, 400);
  assert.equal((await api('GET', '/monthly-objectives/trend', null)).status, 401);
});

await check('with no month given it ends with this month', async () => {
  const r = await api('GET', '/monthly-objectives/trend', admin.token);
  assert.deepEqual(r.body.end, { year: Y, month: M });
  assert.deepEqual([r.body.months[5].year, r.body.months[5].month], [Y, M]);
});

console.log(`\n${pass} passed, ${failures.length} failed`);
server.close();
await mongoose.disconnect();
if (failures.length) {
  console.log('FAILED:\n - ' + failures.join('\n - '));
  process.exit(1);
}
