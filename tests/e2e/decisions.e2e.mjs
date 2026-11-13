// End-to-end check of the CEO / Executive Director decision desk — against a THROWAWAY local MongoDB (needs a mongod on
// 127.0.0.1:27099; refuses to run against anything else and drops its database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/decisions.e2e.mjs
//
// What it proves: with no rules set every flow behaves as before; with rules set, an expense / payout / hiring plan / project budget
// ABOVE the limit is held after the team's check and only a leader can release it; two leaders deciding together get exactly one
// winner; the ways round the hold (editing, direct approval, paying) are closed; and the source is changed only after the decision.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
process.env.DECISIONS_SYNC_MS = '0'; // every read of the queue may run the repairs
await mongoose.connect('mongodb://127.0.0.1:27099/decisions_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Department = await imp('models/Department.js');
const Project = await imp('models/Project.js');
const AdminExpense = await imp('models/AdminExpense.js');
const ArtistPayout = await imp('models/ArtistPayout.js');
const HiringPlan = await imp('models/HiringPlan.js');
const DecisionRequest = await imp('models/DecisionRequest.js');
const DecisionPolicy = await imp('models/DecisionPolicy.js');
const Notification = await imp('models/Notification.js');
const AuditLog = await imp('models/AuditLog.js');
const JournalEntry = await imp('models/JournalEntry.js');
const ChartOfAccount = await imp('models/ChartOfAccount.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const decisions = await import(new URL('services/decisions.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
const decisionRoutes = await import(new URL('routes/decisionRoutes.js', root));
app.use('/api/decisions', decisionRoutes.default);
app.use('/api/decision-policy', decisionRoutes.policyRouter);
for (const [path, file] of [
  ['/api/admin-expenses', 'routes/adminExpenseRoutes.js'],
  ['/api/artist-payouts', 'routes/artistPayoutRoutes.js'],
  ['/api/recruitment', 'routes/recruitmentRoutes.js'],
  ['/api/projects', 'routes/projectRoutes.js'],
  ['/api/ceo', 'routes/ceoRoutes.js'],
  ['/api/notifications', 'routes/notificationRoutes.js'],
]) app.use(path, await imp(file));
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

// ── people ──────────────────────────────────────────────────────────────────
let n = 0;
const person = async (key, role, { dept = '', head = false } = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: dept });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, isDepartmentHead: head });
  return { id: String(user._id), emp: String(emp._id), name: key, role, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
const boss = await person('boss', 'admin');
const hr = await person('hrmgr', 'manager', { dept: 'HR' });
const accounts = await person('acc', 'accounts', { dept: 'Accounts' });
const fin = await person('fin', 'finance_head', { dept: 'Finance', head: true });
const salesHead = await person('saleshead', 'sales', { dept: 'Sales', head: true });
const mira = await person('mira', 'crm', { dept: 'Marketing' }); // a project manager
const mhead = await person('mhead', 'crm', { dept: 'Marketing', head: true });
const staff = await person('staff', 'crm', { dept: 'Marketing' }); // proposes a project
const ceo = await person('ceo', 'ceo');
const ed = await person('ed', 'executive_director');
const LEADERS = [ceo, ed];
await Department.create({ key: 'marketing', name: 'Marketing', head: mhead.emp });
await Department.create({ key: 'sales', name: 'Sales', head: salesHead.emp });
await User.updateOne({ _id: mhead.id }, { departmentId: (await Department.findOne({ key: 'marketing' }))._id });
await User.updateOne({ _id: salesHead.id }, { departmentId: (await Department.findOne({ key: 'sales' }))._id });
const artist = await Employee.create({ name: 'Freelance Fatima', department: 'Artist' });
// the ledgers an approved expense posts to (without them posting is skipped, and "never posted" would prove nothing)
for (const [code, name, nature, group] of [['OFF-01', 'Office Expense', 'expense', 'Operating Expense'], ['1000', 'Cash', 'asset', 'Cash'], ['1010', 'Bank', 'asset', 'Bank']]) {
  await ChartOfAccount.create({ code, name, nature, group });
}

// ── helpers ─────────────────────────────────────────────────────────────────
const setPolicy = (body, who = boss) => api('PUT', '/decision-policy', who.token, body);
const policyOff = () => setPolicy({ spendLimits: { expense: null, payout: null, projectBudget: null }, hiringPlansNeedLeadership: false });
const queue = (who, q = '') => api('GET', `/decisions/queue${q}`, who.token);
const decide = (id, who, body) => api('POST', `/decisions/${id}/decide`, who.token, body);
const openReq = (extra = {}) => DecisionRequest.find({ open: true, ...extra }).lean();
const reqFor = (kind, refId) => DecisionRequest.findOne({ kind, refId }).sort({ createdAt: -1 }).lean();
const notes = (userId, type) => Notification.find({ recipient: userId, type }).lean();
const posted = (id) => JournalEntry.countDocuments({ 'source.id': id });

const fileExpense = (who, amount, extra = {}) => api('POST', '/admin-expenses', who.token, { title: `Spend ${amount}`, amount, ...extra });
const verify = (id, who, body = { status: 'approved' }) => api('PUT', `/admin-expenses/${id}/verify`, who.token, body);
const newPayout = (amount) => api('POST', '/artist-payouts', accounts.token, { employeeId: String(artist._id), amount });

console.log('\n— nothing is set: every flow is as it was —');
await check('the rules start off, and say so', async () => {
  const r = await api('GET', '/decision-policy', boss.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.on, false);
  assert.deepEqual(r.body.spendLimits, { expense: null, payout: null, projectBudget: null });
  assert.equal(r.body.hiringPlansNeedLeadership, false);
  assert.equal(r.body.summary, 'Nothing is escalated by amount.');
});

await check('a huge expense checked by Accounts is approved at once (and posted) — nothing reaches the leaders', async () => {
  const filed = await fileExpense(salesHead, 25_000_000);
  assert.equal(filed.status, 201);
  const v = await verify(filed.body._id, accounts);
  assert.equal(v.status, 200);
  assert.equal(v.body.status, 'approved');
  assert.equal(v.body.awaitingLeadership, undefined);
  assert.equal(await DecisionRequest.countDocuments({ kind: 'spend_expense' }), 0);
  assert.equal(await posted(filed.body._id), 1, 'the control: an approved expense IS posted in this harness');
});

await check('a huge payout is approved, then paid, as before', async () => {
  const p = await newPayout(9_000_000);
  assert.equal(p.status, 201);
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token)).body.status, 'approved');
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {})).body.status, 'paid');
  assert.equal(await DecisionRequest.countDocuments({ kind: 'spend_payout' }), 0);
});

await check('a hiring plan is approved by HR alone, as before', async () => {
  const c = await api('POST', '/recruitment/plans', hr.token, { designation: 'Makeup Artist', department: 'Sales', openings: 2 });
  assert.equal(c.status, 201, c.text);
  await api('POST', `/recruitment/plans/${c.body._id}/raise`, hr.token);
  const a = await api('POST', `/recruitment/plans/${c.body._id}/approve`, boss.token);
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.status, 'approved');
  assert.equal(await DecisionRequest.countDocuments({ kind: 'hiring_plan' }), 0);
});

let budgetProject;
await check('a project cost is approved by the finance head alone, as before', async () => {
  const r = await api('POST', '/projects', boss.token, { name: 'Studio refit', targetDepartment: 'Marketing', managerId: mira.emp, budget: 5_000_000 });
  assert.equal(r.status, 201, r.text);
  budgetProject = r.body;
  const d = await api('POST', `/projects/${r.body._id}/cost/decision`, fin.token, { decision: 'approve' });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.costStatus, 'approved');
  assert.equal(d.body.cost.approvedBudget, 5_000_000);
  assert.equal(await DecisionRequest.countDocuments({ kind: 'project_budget' }), 0);
});

console.log('\n— who may set the rules —');
await check('Accounts and the department heads cannot change them; the administrator and both leaders can', async () => {
  for (const who of [accounts, salesHead, fin, hr]) {
    const r = await setPolicy({ spendLimits: { expense: 1000 } }, who);
    assert.equal(r.status, 403, who.name);
  }
  assert.equal((await api('GET', '/decision-policy', salesHead.token)).status, 403);
  assert.equal((await api('GET', '/decision-policy', accounts.token)).status, 200, 'Accounts may read the rules');
});

await check('bad amounts are refused with a reason; nothing is stored', async () => {
  for (const bad of [0, -5, 'lots', true, 1e13, [5], {}]) {
    const r = await setPolicy({ spendLimits: { expense: bad } });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await setPolicy({ hiringPlansNeedLeadership: 'yes' })).status, 400);
  assert.equal((await api('GET', '/decision-policy', boss.token)).body.on, false);
});

await check('with no CEO / Executive Director login, nothing can be switched on (409 NO_LEADERSHIP_ACCOUNT)', async () => {
  await User.updateMany({ role: { $in: ['ceo', 'executive_director'] } }, { active: false });
  const r = await setPolicy({ spendLimits: { expense: 50_000 } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'NO_LEADERSHIP_ACCOUNT');
  await User.updateMany({ role: { $in: ['ceo', 'executive_director'] } }, { active: true });
  assert.equal((await api('GET', '/decision-policy', boss.token)).body.on, false);
});

await check('the administrator sets the limits: stored, audited, and both leaders are told (the administrator is not)', async () => {
  const r = await setPolicy({ spendLimits: { expense: 50_000, payout: '20,000', projectBudget: 100000 }, hiringPlansNeedLeadership: true });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.spendLimits, { expense: 50_000, payout: 20_000, projectBudget: 100_000 });
  assert.equal(r.body.hiringPlansNeedLeadership, true);
  assert.equal(r.body.on, true);
  assert.ok(await AuditLog.findOne({ entity: 'DecisionPolicy' }), 'an audit row');
  for (const l of LEADERS) assert.equal((await notes(l.id, 'policy_changed')).length, 1, l.name);
  assert.equal((await notes(boss.id, 'policy_changed')).length, 0);
});

await check('a leader can change a limit too, and a blank switches it off', async () => {
  const r = await setPolicy({ spendLimits: { payout: '' } }, ed);
  assert.equal(r.status, 200);
  assert.equal(r.body.spendLimits.payout, null);
  assert.equal(r.body.spendLimits.expense, 50_000, 'the others are untouched');
  assert.equal((await setPolicy({ spendLimits: { payout: 20_000 } }, ceo)).body.spendLimits.payout, 20_000);
});

console.log('\n— a department expense above the limit —');
let big;
let bigReq;
await check('exactly at the limit is not escalated; just above is', async () => {
  const at = await fileExpense(salesHead, 50_000);
  assert.equal((await verify(at.body._id, accounts)).body.status, 'approved');
  const above = await fileExpense(salesHead, 50_000.01);
  const v = await verify(above.body._id, accounts);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.status, 'pending');
  assert.equal(v.body.awaitingLeadership, true);
  assert.equal(v.body.leadership.state, 'awaiting');
  await api('DELETE', `/admin-expenses/${above.body._id}`, accounts.token);
});

await check('Accounts\' approval is the CHECK: the expense stays pending and out of the books; the request names who checked it', async () => {
  const filed = await fileExpense(salesHead, 80_000, { vendor: 'Lights & Co', notes: 'new ring lights' });
  big = filed.body;
  assert.equal(big.status, 'pending');
  const v = await verify(big._id, accounts, { status: 'approved', note: 'Bills match' });
  assert.equal(v.status, 200);
  assert.equal(v.body.status, 'pending');
  assert.equal(v.body.awaitingLeadership, true);
  assert.equal(await posted(big._id), 0, 'not in the books');
  bigReq = await reqFor('spend_expense', big._id);
  assert.equal(bigReq.status, 'pending');
  assert.equal(bigReq.open, true);
  assert.equal(bigReq.amount, 80_000);
  assert.equal(bigReq.checkedBy.name, 'acc');
  assert.equal(bigReq.checkNote, 'Bills match');
  assert.equal(bigReq.requestedBy.name, 'saleshead');
  assert.ok(bigReq.summary.some((s) => s.label === 'Vendor' && s.value === 'Lights & Co'));
});

await check('both leaders are told, once each; the administrator and Accounts are not', async () => {
  for (const l of LEADERS) {
    const got = (await notes(l.id, 'decision_request')).filter((x) => x.link.includes(String(bigReq._id)));
    assert.equal(got.length, 1, l.name);
  }
  for (const who of [boss, accounts, fin]) assert.equal((await notes(who.id, 'decision_request')).length, 0, who.name);
});

await check('both leaders see it on their desk with what they need; Accounts, heads and the sales head cannot open the desk', async () => {
  for (const l of LEADERS) {
    const q = await queue(l);
    assert.equal(q.status, 200, l.name);
    const item = q.body.items.find((i) => i.id === String(bigReq._id));
    assert.ok(item, l.name);
    assert.equal(item.kind, 'spend_expense');
    assert.equal(item.canDecide, true);
    assert.equal(item.amount, 80_000);
    assert.equal(item.checkedBy.label, 'Accounts');
    assert.equal(item.checkedBy.name, 'acc');
  }
  assert.equal((await queue(accounts)).status, 403);
  assert.equal((await queue(salesHead)).status, 403);
  assert.equal((await queue(boss)).status, 200, 'the administrator may look');
  assert.equal((await queue(boss)).body.items[0].canDecide, false, 'but not decide');
});

await check('nobody but a leader can decide: Accounts, the administrator and the department head are refused', async () => {
  for (const who of [accounts, boss, salesHead, fin]) {
    const r = await decide(bigReq._id, who, { action: 'approve' });
    assert.equal(r.status, 403, who.name);
    assert.equal(r.body.code, 'LEADERSHIP_ONLY');
  }
  assert.equal((await AdminExpense.findById(big._id)).status, 'pending');
});

await check('the ways round the hold are closed: filing it as approved, approving it again, editing the status', async () => {
  const direct = await fileExpense(accounts, 90_000);
  assert.equal(direct.status, 201);
  assert.equal(direct.body.status, 'pending', 'Accounts filing it does not approve it');
  assert.equal(direct.body.awaitingLeadership, true);
  assert.equal(await posted(direct.body._id), 0);
  const again = await verify(direct.body._id, accounts);
  assert.equal(again.body.status, 'pending');
  const put = await api('PUT', `/admin-expenses/${direct.body._id}`, accounts.token, { status: 'approved' });
  assert.equal(put.body.status, 'pending', 'the edit route cannot approve it either');
  assert.equal(await DecisionRequest.countDocuments({ kind: 'spend_expense', refId: direct.body._id, open: true }), 1, 'one request, not three');
  assert.equal(await posted(direct.body._id), 0);
  await api('DELETE', `/admin-expenses/${direct.body._id}`, accounts.token);
  assert.equal((await reqFor('spend_expense', direct.body._id)).status, 'withdrawn', 'deleting it takes it off their desk');
});

await check('it is not also "waiting with the team" on the CEO home; it is counted as the leaders\' own', async () => {
  const inbox = await api('GET', '/ceo/inbox', ceo.token);
  assert.equal(inbox.status, 200, inbox.text);
  const keys = inbox.body.items.map((i) => i.key);
  assert.ok(keys.includes('decision_requests'));
  assert.ok(!inbox.body.items.find((i) => i.key === 'admin_expenses'), 'the awaiting expense is not with Accounts any more');
  assert.equal(inbox.body.decisions.open, 1);
  assert.equal(inbox.body.decisions.byKind.spend_expense, 1);
  assert.equal(inbox.body.decisions.preview[0].id, String(bigReq._id));
  assert.ok(inbox.body.needsYou >= 1);
});

await check('Accounts can see where it is and what was said (by-ref)', async () => {
  const r = await api('GET', `/decisions/by-ref?model=AdminExpense&id=${big._id}`, accounts.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.request.status, 'pending');
  assert.equal(r.body.request.kind, 'spend_expense');
  assert.equal((await api('GET', `/decisions/by-ref?model=Nope&id=${big._id}`, accounts.token)).status, 400);
});

await check('a decision needs a valid action; a rejection needs a reason; a deferral needs a future date', async () => {
  assert.equal((await decide(bigReq._id, ceo, { action: 'maybe' })).body.code, 'ACTION_INVALID');
  assert.equal((await decide(bigReq._id, ceo, { action: 'reject' })).body.code, 'NOTE_REQUIRED');
  assert.equal((await decide(bigReq._id, ceo, { action: 'reject', note: ' ok' })).body.code, 'NOTE_REQUIRED', '2 characters is not a reason');
  assert.equal((await decide(bigReq._id, ceo, { action: 'defer', until: '2020-01-01' })).body.code, 'DATE_INVALID');
  assert.equal((await decide(bigReq._id, ceo, { action: 'approve', note: 'x'.repeat(501) })).body.code, 'NOTE_TOO_LONG');
  assert.equal((await decide('not-an-id', ceo, { action: 'approve' })).status, 404);
  assert.equal((await DecisionRequest.findById(bigReq._id)).status, 'pending', 'none of them did anything');
});

await check('the CEO defers; the Executive Director still sees it and decides; the source is changed only then', async () => {
  const until = new Date(Date.now() + 5 * 86_400_000).toISOString();
  const d = await decide(bigReq._id, ceo, { action: 'defer', until, note: 'after the festival' });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.status, 'deferred');
  assert.equal((await AdminExpense.findById(big._id)).status, 'pending');
  assert.equal((await queue(ed)).body.items.find((i) => i.id === String(bigReq._id)).status, 'deferred');
  assert.equal((await notes(ed.id, 'decision_result')).some((x) => /put .* off/.test(x.body)), true, 'the other leader is told');
  const inbox = await api('GET', '/ceo/inbox', ceo.token);
  assert.equal(inbox.body.items.find((i) => i.key === 'decision_requests'), undefined, 'a deferred item leaves the "needs you" count until its date');
  assert.equal(inbox.body.decisions.deferred, 1);
});

await check('two leaders deciding at the same moment: exactly one wins, the other is told who, when and why', async () => {
  const [a, b] = await Promise.all([
    decide(bigReq._id, ceo, { action: 'approve', note: 'Go ahead' }),
    decide(bigReq._id, ed, { action: 'reject', note: 'Too much right now' }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `got ${a.status} and ${b.status}`);
  const [win, lose] = a.status === 200 ? [a, b] : [b, a];
  const winner = a.status === 200 ? ceo : ed;
  assert.equal(lose.body.code, 'ALREADY_DECIDED');
  assert.equal(lose.body.decision.by.name, winner.name);
  assert.equal(lose.body.decision.by.role, winner.role);
  assert.ok(lose.body.decision.at);
  assert.equal(lose.body.decision.note, win.body.decision.note);
  assert.match(lose.body.message, new RegExp(winner.role === 'ceo' ? 'CEO' : 'Executive Director'));
  // the source followed the winner, once
  const e = await AdminExpense.findById(big._id);
  assert.equal(e.status, winner === ceo ? 'approved' : 'rejected');
  assert.equal(String(e.approvedBy), winner.id, 'approved/decided by the leader, not by Accounts');
  assert.equal(await DecisionRequest.countDocuments({ refId: big._id, status: { $in: ['approved', 'rejected'] } }), 1);
  big.winner = winner;
});

await check('after the decision: the books follow the outcome, a third try is a 409, the team is told with the reason', async () => {
  const e = await AdminExpense.findById(big._id);
  assert.equal(await posted(big._id), e.status === 'approved' ? 1 : 0, 'posted once if approved, never if rejected');
  const again = await decide(bigReq._id, ceo, { action: 'approve' });
  assert.equal(again.status, 409);
  assert.equal(await posted(big._id), e.status === 'approved' ? 1 : 0, 'still once');
  const told = await notes(accounts.id, 'decision_result');
  assert.ok(told.some((x) => x.body.includes(big.winner.name)), 'the checker is told');
  assert.ok((await notes(salesHead.id, 'decision_result')).length >= 1, 'so is the requester');
  const settled = await DecisionRequest.findById(bigReq._id).lean();
  assert.ok(settled.appliedAt, 'recorded as carried out');
  assert.equal(settled.open, undefined, 'no longer open');
  assert.ok(settled.history.map((h) => h.action).includes('applied'));
});

await check('running the apply again does nothing twice (the retry sweep after a crash)', async () => {
  const before = await posted(big._id);
  await DecisionRequest.updateOne({ _id: bigReq._id }, { $set: { appliedAt: null, decidedAt: new Date(Date.now() - 10 * 60_000) } });
  const fixed = await decisions.retryUnapplied();
  assert.equal(fixed, 1);
  assert.equal(await posted(big._id), before, 'no double posting');
  assert.ok((await DecisionRequest.findById(bigReq._id)).appliedAt);
});

await check('a rejection needs a reason and carries it to the team; the expense is rejected and never posted', async () => {
  const f = await fileExpense(salesHead, 120_000);
  await verify(f.body._id, accounts);
  const r = await reqFor('spend_expense', f.body._id);
  const rej = await decide(r._id, ed, { action: 'reject', note: 'Not budgeted this quarter' });
  assert.equal(rej.status, 200, rej.text);
  assert.equal(rej.body.status, 'rejected');
  assert.equal(rej.body.decision.note, 'Not budgeted this quarter');
  const e = await AdminExpense.findById(f.body._id);
  assert.equal(e.status, 'rejected');
  assert.equal(e.leadership.state, 'rejected');
  assert.equal(await posted(f.body._id), 0);
  assert.ok((await notes(salesHead.id, 'decision_result')).some((x) => x.body.includes('Not budgeted this quarter')));
});

await check('edited while it waited: the old request is superseded, the expense stays pending and goes back to Accounts', async () => {
  const f = await fileExpense(salesHead, 70_000);
  await verify(f.body._id, accounts);
  const first = await reqFor('spend_expense', f.body._id);
  const edit = await api('PUT', `/admin-expenses/${f.body._id}`, accounts.token, { amount: 95_000 });
  assert.equal(edit.status, 200);
  assert.equal(edit.body.status, 'pending');
  assert.equal(edit.body.leadership.state, 'none', 'the hold is released');
  assert.equal((await DecisionRequest.findById(first._id)).status, 'superseded');
  const late = await decide(first._id, ceo, { action: 'approve' });
  assert.equal(late.status, 409, 'a leader acting on the stale card is told');
  assert.equal((await AdminExpense.findById(f.body._id)).status, 'pending', 'and nothing was approved');
  // checked again, a fresh request with the new amount
  await verify(f.body._id, accounts);
  const second = await reqFor('spend_expense', f.body._id);
  assert.notEqual(String(second._id), String(first._id));
  assert.equal(second.amount, 95_000);
  assert.equal(second.open, true);
});

await check('Accounts rejecting it while it waits takes it off the leaders\' desk', async () => {
  const f = await fileExpense(salesHead, 66_000);
  await verify(f.body._id, accounts);
  const r = await reqFor('spend_expense', f.body._id);
  await verify(f.body._id, accounts, { status: 'rejected' });
  assert.equal((await DecisionRequest.findById(r._id)).status, 'withdrawn');
  assert.equal((await AdminExpense.findById(f.body._id)).leadership.state, 'none');
});

await check('a leader can approve in the other order (Executive Director first) and the CEO then sees who did', async () => {
  const f = await fileExpense(salesHead, 77_000);
  await verify(f.body._id, accounts);
  const r = await reqFor('spend_expense', f.body._id);
  assert.equal((await decide(r._id, ed, { action: 'approve', note: 'Fine' })).status, 200);
  const late = await decide(r._id, ceo, { action: 'reject', note: 'Not now' });
  assert.equal(late.status, 409);
  assert.equal(late.body.decision.by.name, 'ed');
  assert.match(late.body.message, /Executive Director/);
  assert.equal((await AdminExpense.findById(f.body._id)).status, 'approved');
  assert.equal(await posted(f.body._id), 1);
});

console.log('\n— an artist payout above the limit —');
await check('Accounts\' approval is the check; it cannot be paid, however it is asked, until a leader approves', async () => {
  const p = await newPayout(30_000);
  const ap = await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token);
  assert.equal(ap.status, 200, ap.text);
  assert.equal(ap.body.status, 'pending');
  assert.equal(ap.body.awaitingLeadership, true);
  const pay = await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {});
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'NEEDS_LEADERSHIP');
  assert.equal((await ArtistPayout.findById(p.body._id)).status, 'pending');
  const req = await reqFor('spend_payout', p.body._id);
  assert.equal(req.checkedBy.name, 'acc');
  assert.equal((await decide(req._id, ceo, { action: 'approve', note: 'ok' })).status, 200);
  const approved = await ArtistPayout.findById(p.body._id);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.leadership.state, 'approved');
  const paid = await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {});
  assert.equal(paid.status, 200);
  assert.equal(paid.body.status, 'paid');
});

await check('paying a pending payout above the limit, without approving it first, is refused too', async () => {
  const p = await newPayout(45_000);
  const pay = await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {});
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'NEEDS_LEADERSHIP');
  assert.equal((await ArtistPayout.findById(p.body._id)).status, 'pending');
});

await check('a payout at or under the limit is untouched: approve, pay', async () => {
  const p = await newPayout(20_000);
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token)).body.status, 'approved');
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {})).body.status, 'paid');
});

await check('raising an approved payout above the limit sends it back to be checked; a rejected one can never be paid', async () => {
  const p = await newPayout(15_000);
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token)).body.status, 'approved');
  const up = await api('PUT', `/artist-payouts/${p.body._id}`, accounts.token, { amount: 40_000 });
  assert.equal(up.body.status, 'pending', 'its approval was for ₹15,000');
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {})).status, 409);
  await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token);
  const req = await reqFor('spend_payout', p.body._id);
  assert.equal((await decide(req._id, ed, { action: 'reject', note: 'Too high for that job' })).status, 200);
  assert.equal((await ArtistPayout.findById(p.body._id)).status, 'cancelled');
  const pay = await api('PUT', `/artist-payouts/${p.body._id}/pay`, accounts.token, {});
  assert.equal(pay.status, 409);
  assert.equal(pay.body.code, 'REJECTED_BY_LEADERSHIP');
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token)).status, 409, 'and cannot be approved back');
});

console.log('\n— a hiring plan (the switch is on) —');
let plan;
await check('HR\'s approval is the vet: the plan waits, and approved cannot be set another way', async () => {
  const c = await api('POST', '/recruitment/plans', hr.token, { designation: 'Senior Stylist', department: 'Sales', openings: 3 });
  plan = c.body;
  await api('POST', `/recruitment/plans/${plan._id}/raise`, hr.token);
  const a = await api('POST', `/recruitment/plans/${plan._id}/approve`, boss.token, { note: 'Job description is complete' });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.status, 'raised', 'not approved yet');
  assert.equal(a.body.awaitingLeadership, true);
  const viaEdit = await api('PUT', `/recruitment/plans/${plan._id}`, hr.token, { status: 'approved' });
  assert.equal(viaEdit.status, 409);
  assert.equal(viaEdit.body.code, 'NEEDS_LEADERSHIP');
  const viaCreate = await api('POST', '/recruitment/plans', hr.token, { designation: 'X', department: 'Sales', status: 'approved' });
  assert.equal(viaCreate.status, 409);
  assert.equal((await HiringPlan.findById(plan._id)).status, 'raised');
  assert.equal(await HiringPlan.countDocuments({ designation: 'X' }), 0, 'and no pre-approved plan was made');
});

await check('a leader approves it: the plan is approved, by the leader; the vet is kept on the record', async () => {
  const req = await reqFor('hiring_plan', plan._id);
  assert.equal(req.checkNote, 'Job description is complete');
  const q = (await queue(ed)).body.items.find((i) => i.id === String(req._id));
  assert.equal(q.checkedBy.label, 'HR');
  assert.equal(q.title, 'Senior Stylist × 3');
  assert.equal((await decide(req._id, ed, { action: 'approve' })).status, 200);
  const p = await HiringPlan.findById(plan._id);
  assert.equal(p.status, 'approved');
  assert.equal(String(p.approvedBy), ed.id);
  assert.equal(p.leadership.checkedByName, 'boss');
});

await check('a rejection\'s reason becomes the plan\'s rejection reason', async () => {
  const c = await api('POST', '/recruitment/plans', hr.token, { designation: 'Receptionist', department: 'Sales' });
  await api('POST', `/recruitment/plans/${c.body._id}/raise`, hr.token);
  await api('POST', `/recruitment/plans/${c.body._id}/approve`, boss.token);
  const req = await reqFor('hiring_plan', c.body._id);
  assert.equal((await decide(req._id, ceo, { action: 'reject', note: 'Hiring freeze until March' })).status, 200);
  const p = await HiringPlan.findById(c.body._id);
  assert.equal(p.status, 'rejected');
  assert.equal(p.rejectionReason, 'Hiring freeze until March');
});

await check('HR rejecting, or deleting, a plan that is with the leaders takes it off their desk', async () => {
  for (const how of ['reject', 'delete']) {
    const c = await api('POST', '/recruitment/plans', hr.token, { designation: `Temp ${how}`, department: 'Sales' });
    await api('POST', `/recruitment/plans/${c.body._id}/raise`, hr.token);
    await api('POST', `/recruitment/plans/${c.body._id}/approve`, boss.token);
    const req = await reqFor('hiring_plan', c.body._id);
    assert.equal(req.open, true);
    if (how === 'reject') await api('POST', `/recruitment/plans/${c.body._id}/reject`, hr.token, { reason: 'Wrong department' });
    else await api('DELETE', `/recruitment/plans/${c.body._id}`, hr.token);
    assert.equal((await DecisionRequest.findById(req._id)).status, 'withdrawn', how);
  }
});

console.log('\n— a project\'s budget —');
await check('the finance head\'s approval of a big increase is the check; the cost stays pending and the project is not stopped', async () => {
  const r = await api('POST', '/projects', boss.token, { name: 'Bridal expo', targetDepartment: 'Marketing', managerId: mira.emp, budget: 400_000 });
  assert.equal(r.status, 201, r.text);
  const pid = r.body._id;
  const d = await api('POST', `/projects/${pid}/cost/decision`, fin.token, { decision: 'approve', approvedAmount: 350_000, note: 'Trimmed the catering' });
  assert.equal(d.status, 200, d.text);
  assert.equal(d.body.costStatus, 'pending', 'not approved yet');
  assert.equal(d.body.access.awaitingLeadership, true);
  assert.equal(d.body.access.canDecideCost, false, 'the finance head cannot decide it a second time');
  assert.equal(d.body.cost.approvedBudget, 0);
  const again = await api('POST', `/projects/${pid}/cost/decision`, fin.token, { decision: 'approve' });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'AWAITING_LEADERSHIP');
  const req = await reqFor('project_budget', pid);
  assert.equal(req.amount, 350_000, 'they decide on what the finance head would approve');
  assert.equal(req.previousAmount, null);
  const q = (await queue(ceo)).body.items.find((i) => i.id === String(req._id));
  assert.equal(q.checkedBy.label, 'the finance head');
  assert.equal((await decide(req._id, ceo, { action: 'approve', note: 'Agreed' })).status, 200);
  const p = await Project.findById(pid);
  assert.equal(p.costStatus, 'approved');
  assert.equal(p.approvedBudget, 350_000, 'the finance head\'s amount, not the amount asked');
  assert.equal(p.costDecisionNote, 'Agreed');
  assert.equal(p.costLeadership.state, 'approved');
  budgetProject = p.toObject();
});

await check('afterwards only the INCREASE counts against the limit: +₹60,000 goes straight through, +₹150,000 goes up', async () => {
  const pid = String(budgetProject._id);
  assert.equal((await api('PUT', `/projects/${pid}/cost`, boss.token, { budget: 410_000, reason: 'extra day' })).status, 200);
  const small = await api('POST', `/projects/${pid}/cost/decision`, fin.token, { decision: 'approve' });
  assert.equal(small.body.costStatus, 'approved', '₹410,000 − ₹350,000 = ₹60,000 ≤ ₹100,000');
  assert.equal(await DecisionRequest.countDocuments({ kind: 'project_budget', refId: pid }), 1, 'no second request');
  assert.equal((await api('PUT', `/projects/${pid}/cost`, boss.token, { budget: 560_000, reason: 'scope grew' })).status, 200);
  const big2 = await api('POST', `/projects/${pid}/cost/decision`, fin.token, { decision: 'approve' });
  assert.equal(big2.body.costStatus, 'pending', '₹560,000 − ₹410,000 = ₹150,000 > ₹100,000');
  const req = await reqFor('project_budget', pid);
  assert.equal(req.previousAmount, 410_000);
  assert.equal(req.open, true);
  // asked to change again while it waits: the leaders\' card is replaced
  assert.equal((await api('PUT', `/projects/${pid}/cost`, boss.token, { budget: 600_000, reason: 'again' })).status, 200);
  assert.equal((await DecisionRequest.findById(req._id)).status, 'superseded');
  assert.equal((await Project.findById(pid)).costLeadership.state, 'none');
  // the finance head sends the new figure back instead
  const back = await api('POST', `/projects/${pid}/cost/decision`, fin.token, { decision: 'return', note: 'Split it in two' });
  assert.equal(back.body.costStatus, 'returned');
  assert.equal(back.body.cost.approvedBudget, 410_000, 'the earlier approved amount stays the limit');
});

await check('sending it back while it waits for the leaders takes it off their desk', async () => {
  const r = await api('POST', '/projects', boss.token, { name: 'Salon branch', targetDepartment: 'Marketing', managerId: mira.emp, budget: 900_000 });
  await api('POST', `/projects/${r.body._id}/cost/decision`, fin.token, { decision: 'approve' });
  const req = await reqFor('project_budget', r.body._id);
  assert.equal(req.open, true);
  const back = await api('POST', `/projects/${r.body._id}/cost/decision`, fin.token, { decision: 'return', note: 'Need the lease first' });
  assert.equal(back.status, 200, back.text);
  assert.equal((await DecisionRequest.findById(req._id)).status, 'withdrawn');
  assert.equal(back.body.costStatus, 'returned');
});

console.log('\n— a project proposal —');
await check('a proposal is shown to both leaders on its own; nothing is held — the department head can still decide', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'Wedding showcase', targetDepartment: 'Marketing', budget: 200_000 });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.body.status, 'proposed');
  const req = await reqFor('project_proposal', r.body._id);
  assert.equal(req.open, true);
  assert.equal(req.checkedBy, null, 'nobody has checked a proposal');
  assert.equal(req.requestedBy.name, 'staff');
  for (const l of LEADERS) assert.ok((await queue(l)).body.items.some((i) => i.id === String(req._id)), l.name);
  assert.equal(r.body.access.canDecide, false, 'the proposer cannot');
});

await check('the department head approves first: the leaders\' card closes with the head\'s decision; a leader\'s later click is a 409 naming the head', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'Pop-up studio', targetDepartment: 'Marketing', budget: 80_000 });
  const req = await reqFor('project_proposal', r.body._id);
  const ok = await api('POST', `/projects/${r.body._id}/approve`, mhead.token, { note: 'Good fit' });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.status, 'planning');
  const closed = await DecisionRequest.findById(req._id).lean();
  assert.equal(closed.status, 'approved');
  assert.equal(closed.decidedBy.name, 'mhead');
  const late = await decide(req._id, ceo, { action: 'reject', note: 'Not now' });
  assert.equal(late.status, 409);
  assert.equal(late.body.decision.by.name, 'mhead');
  assert.equal((await Project.findById(r.body._id)).status, 'planning', 'unchanged');
  const lateOld = await api('POST', `/projects/${r.body._id}/reject`, ceo.token, { note: 'Not now' });
  assert.equal(lateOld.status, 409, 'the old endpoint says so too');
  assert.equal(lateOld.body.code, 'ALREADY_DECIDED');
  assert.match(lateOld.body.message, /mhead/);
});

await check('a leader approves from the desk: the project starts planning; the department head is told it is already decided', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'Bridal fair', targetDepartment: 'Marketing', budget: 90_000 });
  const req = await reqFor('project_proposal', r.body._id);
  const d = await decide(req._id, ed, { action: 'approve', note: 'Go' });
  assert.equal(d.status, 200, d.text);
  const p = await Project.findById(r.body._id);
  assert.equal(p.status, 'planning');
  assert.equal(String(p.decidedBy), ed.id);
  const head = await api('POST', `/projects/${r.body._id}/approve`, mhead.token);
  assert.equal(head.status, 409);
  assert.match(head.body.message, /Executive Director/);
  assert.ok((await notes(staff.id, 'project_decision')).length >= 1, 'the proposer is told');
});

await check('a department head and a leader deciding together: exactly one decision stands', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'Race project', targetDepartment: 'Marketing', budget: 50_000 });
  const req = await reqFor('project_proposal', r.body._id);
  const [a, b] = await Promise.all([
    api('POST', `/projects/${r.body._id}/approve`, mhead.token, { note: 'head says yes' }),
    decide(req._id, ceo, { action: 'reject', note: 'ceo says no' }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.status}/${b.status}`);
  const p = await Project.findById(r.body._id);
  assert.equal(p.status, a.status === 200 ? 'planning' : 'cancelled');
  const settled = await DecisionRequest.findById(req._id).lean();
  assert.equal(settled.status, a.status === 200 ? 'approved' : 'rejected');
  assert.equal(await DecisionRequest.countDocuments({ refId: r.body._id, status: { $in: ['approved', 'rejected'] } }), 1);
});

await check('deleting a proposal withdraws it', async () => {
  const r = await api('POST', '/projects', staff.token, { name: 'Dropped idea', targetDepartment: 'Marketing', budget: 10_000 });
  const req = await reqFor('project_proposal', r.body._id);
  assert.equal((await api('DELETE', `/projects/${r.body._id}`, boss.token)).status, 200);
  assert.equal((await DecisionRequest.findById(req._id)).status, 'withdrawn');
});

await check('proposals made before the desk existed appear on it when it is read', async () => {
  const old = await Project.collection.insertOne({
    name: 'Legacy proposal', targetDepartment: 'Marketing', status: 'proposed', budget: 30000, costStatus: 'pending', proposedBy: new mongoose.Types.ObjectId(staff.id),
    createdBy: new mongoose.Types.ObjectId(staff.id), createdAt: new Date(Date.now() - 3 * 86_400_000), updatedAt: new Date(), departments: [],
  });
  assert.equal(await DecisionRequest.countDocuments({ refId: old.insertedId }), 0);
  const q = await queue(ed);
  assert.ok(q.body.items.some((i) => i.title === 'Legacy proposal'));
  assert.equal(await DecisionRequest.countDocuments({ refId: old.insertedId, open: true }), 1);
  await queue(ed); // reading again does not make a second
  assert.equal(await DecisionRequest.countDocuments({ refId: old.insertedId }), 1);
});

console.log('\n— what is left behind is cleaned up —');
await check('a request whose source vanished is withdrawn when the desk is read', async () => {
  const f = await fileExpense(salesHead, 88_000);
  await verify(f.body._id, accounts);
  const req = await reqFor('spend_expense', f.body._id);
  await AdminExpense.collection.deleteOne({ _id: new mongoose.Types.ObjectId(f.body._id) }); // gone behind the app's back
  await queue(ed);
  assert.equal((await DecisionRequest.findById(req._id)).status, 'withdrawn');
});

await check('a request whose hold was lifted outside the workflow is superseded, never approved', async () => {
  const f = await fileExpense(salesHead, 91_000);
  await verify(f.body._id, accounts);
  const req = await reqFor('spend_expense', f.body._id);
  await AdminExpense.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.body._id) }, { $set: { 'leadership.state': 'none' } });
  const late = await decide(req._id, ceo, { action: 'approve' });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'SOURCE_CHANGED');
  assert.equal((await AdminExpense.findById(f.body._id)).status, 'pending');
});

await check('changed behind the app\'s back (amount raised in the database): the leader\'s approval is refused, never applied to the new amount', async () => {
  const f = await fileExpense(salesHead, 60_000);
  await verify(f.body._id, accounts);
  const req = await reqFor('spend_expense', f.body._id);
  await AdminExpense.collection.updateOne({ _id: new mongoose.Types.ObjectId(f.body._id) }, { $set: { amount: 400_000 } });
  const late = await decide(req._id, ceo, { action: 'approve' });
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'SOURCE_CHANGED');
  assert.equal((await AdminExpense.findById(f.body._id)).status, 'pending');
  assert.equal(await posted(f.body._id), 0);
  assert.equal((await DecisionRequest.findById(req._id)).status, 'superseded');
});

await check('checking an item twice raises ONE request and tells the leaders once', async () => {
  const f = await fileExpense(salesHead, 71_000);
  await verify(f.body._id, accounts);
  const first = await reqFor('spend_expense', f.body._id);
  await verify(f.body._id, accounts);
  await api('PUT', `/admin-expenses/${f.body._id}`, accounts.token, { status: 'approved' });
  const again = await reqFor('spend_expense', f.body._id);
  assert.equal(String(again._id), String(first._id), 'the same request, not a replacement');
  assert.equal(await DecisionRequest.countDocuments({ refId: f.body._id }), 1);
  for (const l of LEADERS) assert.equal((await notes(l.id, 'decision_request')).filter((x) => x.link.includes(String(first._id))).length, 1, l.name);
});

const { HANDLERS } = await import(new URL('services/decisionHandlers.js', root));
await check('carrying out a decision refuses a source that is no longer held — for every kind, whatever checked before', async () => {
  const leader = { _id: new mongoose.Types.ObjectId(ceo.id), name: 'ceo', role: 'ceo' };
  const cases = [];
  const e = await fileExpense(salesHead, 62_000);
  await verify(e.body._id, accounts);
  cases.push(['spend_expense', e.body._id, AdminExpense, 'leadership.state', async (id) => (await AdminExpense.findById(id)).status === 'pending']);
  const p = await newPayout(33_000);
  await api('PUT', `/artist-payouts/${p.body._id}/approve`, accounts.token);
  cases.push(['spend_payout', p.body._id, ArtistPayout, 'leadership.state', async (id) => (await ArtistPayout.findById(id)).status === 'pending']);
  const h = await api('POST', '/recruitment/plans', hr.token, { designation: 'Apply check', department: 'Sales' });
  await api('POST', `/recruitment/plans/${h.body._id}/raise`, hr.token);
  await api('POST', `/recruitment/plans/${h.body._id}/approve`, boss.token);
  cases.push(['hiring_plan', h.body._id, HiringPlan, 'leadership.state', async (id) => (await HiringPlan.findById(id)).status === 'raised']);
  const pr = await api('POST', '/projects', boss.token, { name: 'Apply check', targetDepartment: 'Marketing', managerId: mira.emp, budget: 700_000 });
  await api('POST', `/projects/${pr.body._id}/cost/decision`, fin.token, { decision: 'approve' });
  cases.push(['project_budget', pr.body._id, Project, 'costLeadership.state', async (id) => (await Project.findById(id)).costStatus === 'pending']);

  for (const [kind, id, Model, path, untouched] of cases) {
    const request = await DecisionRequest.findOne({ kind, refId: id, open: true });
    assert.ok(request, `${kind}: a request is open`);
    await Model.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { [path]: 'none' } }); // the hold is lifted behind the workflow's back
    for (const action of ['approve', 'reject']) {
      const out = await HANDLERS[kind].apply({ request, action, leader, note: 'x', now: new Date() });
      assert.equal(out.result, 'source_changed', `${kind} ${action}`);
      assert.ok(await untouched(id), `${kind} ${action}: the source was not touched`);
    }
  }
});

console.log('\n— the leaders themselves —');
await check('a leader can decide but cannot do the team\'s work: verifying, paying or approving a plan is refused by the guard', async () => {
  const f = await fileExpense(salesHead, 10_000);
  assert.equal((await verify(f.body._id, ceo)).status, 403);
  const p = await newPayout(1000);
  assert.equal((await api('PUT', `/artist-payouts/${p.body._id}/pay`, ed.token, {})).status, 403);
  assert.equal((await api('POST', '/recruitment/plans', ceo.token, { designation: 'Z', department: 'Sales' })).status, 403);
});

await check('with no CEO / Executive Director login the hold fails open: Accounts\' approval goes through as it did', async () => {
  await User.updateMany({ role: { $in: ['ceo', 'executive_director'] } }, { active: false });
  const f = await fileExpense(salesHead, 300_000);
  const v = await verify(f.body._id, accounts);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.body.status, 'approved', 'nobody could decide, so it is not left hanging');
  assert.equal(await DecisionRequest.countDocuments({ refId: f.body._id }), 0);
  await User.updateMany({ role: { $in: ['ceo', 'executive_director'] } }, { active: true });
});

await check('switching the rules off again: new items go through, the ones already with the leaders stay until decided', async () => {
  const f = await fileExpense(salesHead, 99_000);
  await verify(f.body._id, accounts);
  const req = await reqFor('spend_expense', f.body._id);
  assert.equal((await policyOff()).status, 200);
  const g = await fileExpense(salesHead, 5_000_000);
  assert.equal((await verify(g.body._id, accounts)).body.status, 'approved');
  assert.equal((await DecisionRequest.findById(req._id)).open, true, 'the earlier one still waits');
  assert.equal((await decide(req._id, ceo, { action: 'approve' })).status, 200);
});

await mongoose.disconnect();
server.close();
console.log(`\n${pass} passed, ${failures.length} failed${failures.length ? `:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
