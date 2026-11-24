// Pure unit tests: node --test tests/decisionRules.test.js
// What needs the CEO / Executive Director, how a decision is checked, and how a request reads to the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, KIND_LABELS, KIND_CHECKERS, OPEN_STATUSES, isOpenStatus, limitFor, needsLeadership, budgetIncrease, validatePolicyInput, policyIsOn, policySummary,
  validateDecision, nextStatus, snapshotOf, isMaterialChange, shapeRequest, conflictBody, waitingDays, MAX_NOTE, MAX_LIMIT,
} from '../utils/decisionRules.js';

const policy = (extra = {}) => ({ spendLimits: { expense: 50000, payout: 20000, projectBudget: 100000 }, hiringPlansNeedLeadership: true, ...extra });
const off = {};

// ── what needs a leader ──────────────────────────────────────────────────────

test('no policy set: nothing is escalated — for any kind, any amount', () => {
  for (const kind of KINDS) {
    for (const p of [undefined, null, off, { spendLimits: {} }, { spendLimits: { expense: null, payout: null, projectBudget: null } }, { hiringPlansNeedLeadership: false }]) {
      assert.equal(needsLeadership(p, kind, 1e9), false, `${kind} ${JSON.stringify(p)}`);
    }
  }
});

test('a spend needs a leader only when it is strictly ABOVE the limit', () => {
  const p = policy();
  assert.equal(needsLeadership(p, 'spend_expense', 50000), false, 'exactly at the limit is not above it');
  assert.equal(needsLeadership(p, 'spend_expense', 50000.01), true);
  assert.equal(needsLeadership(p, 'spend_expense', 49999.99), false);
  assert.equal(needsLeadership(p, 'spend_expense', 1_000_000), true);
  assert.equal(needsLeadership(p, 'spend_payout', 20000), false);
  assert.equal(needsLeadership(p, 'spend_payout', 20001), true);
  assert.equal(needsLeadership(p, 'project_budget', 100000), false);
  assert.equal(needsLeadership(p, 'project_budget', 100001), true);
});

test('each kind reads its own limit', () => {
  const p = { spendLimits: { expense: 1000, payout: null, projectBudget: null } };
  assert.equal(needsLeadership(p, 'spend_expense', 5000), true);
  assert.equal(needsLeadership(p, 'spend_payout', 5000), false, 'payouts have no limit set');
  assert.equal(needsLeadership(p, 'project_budget', 5000), false);
});

test('a limit that is not a usable number is off, never "everything" or "nothing but 0"', () => {
  for (const bad of [0, -5, NaN, 'abc', '', null, undefined, 0.5, Infinity - Infinity]) {
    assert.equal(needsLeadership({ spendLimits: { expense: bad } }, 'spend_expense', 1e6), false, String(bad));
    assert.equal(limitFor({ spendLimits: { expense: bad } }, 'spend_expense'), null, String(bad));
  }
  assert.equal(limitFor({ spendLimits: { expense: '50000' } }, 'spend_expense'), 50000, 'a number stored as text');
  assert.equal(limitFor({ spendLimits: { expense: 1 } }, 'spend_expense'), 1);
});

test('an amount that is not a number never needs a leader', () => {
  for (const a of [NaN, undefined, null, 'abc']) assert.equal(needsLeadership(policy(), 'spend_expense', a), false, String(a));
  assert.equal(needsLeadership(policy(), 'spend_expense', '60000'), true, 'text that is a number counts');
});

test('hiring plans: only when the policy says so, whatever the amount', () => {
  assert.equal(needsLeadership({ hiringPlansNeedLeadership: true }, 'hiring_plan', undefined), true);
  assert.equal(needsLeadership({ hiringPlansNeedLeadership: false }, 'hiring_plan', 1e9), false);
  assert.equal(needsLeadership({ hiringPlansNeedLeadership: 'yes' }, 'hiring_plan'), false, 'only a real true switches it on');
});

test('a proposal is never decided by amount (it always goes to the leaders, a different way)', () => {
  assert.equal(needsLeadership(policy(), 'project_proposal', 1e9), false);
  assert.equal(needsLeadership(policy(), 'something_else', 1e9), false);
  assert.equal(limitFor(policy(), 'project_proposal'), null);
  assert.equal(limitFor(policy(), 'hiring_plan'), null);
});

test('a budget: only the INCREASE counts; a first approval counts from zero; a cut is none', () => {
  assert.equal(budgetIncrease({ proposed: 150000, previousApproved: 100000 }), 50000);
  assert.equal(budgetIncrease({ proposed: 150000, previousApproved: 0 }), 150000);
  assert.equal(budgetIncrease({ proposed: 150000 }), 150000);
  assert.equal(budgetIncrease({ proposed: 80000, previousApproved: 100000 }), 0);
  assert.equal(budgetIncrease({ proposed: 100000, previousApproved: 100000 }), 0);
  assert.equal(budgetIncrease({ proposed: 100000.5, previousApproved: 0.25 }), 100000.25);
  assert.equal(budgetIncrease({ proposed: NaN, previousApproved: 5 }), 0);
  // so a 20,000 top-up of a 400,000 budget is not a "big spend" against a 100,000 limit
  assert.equal(needsLeadership(policy(), 'project_budget', budgetIncrease({ proposed: 420000, previousApproved: 400000 })), false);
  assert.equal(needsLeadership(policy(), 'project_budget', budgetIncrease({ proposed: 520000, previousApproved: 400000 })), true);
});

// ── the policy as sent ───────────────────────────────────────────────────────

test('policy input: limits are numbers from 1 up; blank switches one off; an unmentioned one stays', () => {
  const current = { spendLimits: { expense: 50000, payout: 20000, projectBudget: null }, hiringPlansNeedLeadership: false };
  const r = validatePolicyInput({ spendLimits: { expense: '75,000', projectBudget: 250000 } }, current);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { spendLimits: { expense: 75000, payout: 20000, projectBudget: 250000 }, hiringPlansNeedLeadership: false });
  const cleared = validatePolicyInput({ spendLimits: { expense: '', payout: null } }, current);
  assert.deepEqual(cleared.value.spendLimits, { expense: null, payout: null, projectBudget: null });
});

test('policy input: refused with a code and the field', () => {
  for (const bad of [0, -1, 0.5, 'lots', 1e13, {}, [], true]) {
    const r = validatePolicyInput({ spendLimits: { payout: bad } }, {});
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.code, 'LIMIT_INVALID');
    assert.equal(r.field, 'payout');
  }
  assert.equal(validatePolicyInput({ spendLimits: 5 }, {}).code, 'LIMITS_INVALID');
  assert.equal(validatePolicyInput({ spendLimits: null }, {}).code, 'LIMITS_INVALID');
  assert.equal(validatePolicyInput({ spendLimits: [] }, {}).code, 'LIMITS_INVALID');
  assert.equal(validatePolicyInput({ hiringPlansNeedLeadership: 'yes' }, {}).code, 'FLAG_INVALID');
  assert.equal(validatePolicyInput({ spendLimits: { expense: MAX_LIMIT } }, {}).ok, true, 'the top of the range');
  assert.equal(validatePolicyInput({ spendLimits: { expense: 1 } }, {}).ok, true, 'the bottom of the range');
});

test('policy input: the hiring switch, and an empty body changes nothing', () => {
  assert.equal(validatePolicyInput({ hiringPlansNeedLeadership: true }, {}).value.hiringPlansNeedLeadership, true);
  assert.equal(validatePolicyInput({ hiringPlansNeedLeadership: false }, { hiringPlansNeedLeadership: true }).value.hiringPlansNeedLeadership, false);
  assert.deepEqual(validatePolicyInput({}, { spendLimits: { expense: 5000 }, hiringPlansNeedLeadership: true }).value, { spendLimits: { expense: 5000, payout: null, projectBudget: null }, hiringPlansNeedLeadership: true });
  assert.deepEqual(validatePolicyInput(undefined, undefined).value, { spendLimits: { expense: null, payout: null, projectBudget: null }, hiringPlansNeedLeadership: false });
});

test('policy: is anything on, and how it reads', () => {
  assert.equal(policyIsOn(off), false);
  assert.equal(policyIsOn({ hiringPlansNeedLeadership: true }), true);
  assert.equal(policyIsOn({ spendLimits: { payout: 1 } }), true);
  assert.equal(policyIsOn({ spendLimits: { payout: 0 } }), false);
  assert.equal(policySummary(off), 'Nothing is escalated by amount.');
  assert.equal(policySummary(policy()), 'department expenses above ₹50,000, artist payouts above ₹20,000, project budget increases above ₹1,00,000, hiring plans');
  assert.equal(policySummary({ hiringPlansNeedLeadership: true }), 'hiring plans');
});

// ── a decision ───────────────────────────────────────────────────────────────

const now = new Date('2026-11-12T10:00:00Z');

test('decision: approve needs nothing; a note is optional', () => {
  assert.deepEqual(validateDecision({ action: 'approve' }, now), { ok: true, value: { action: 'approve', note: '', until: null } });
  assert.equal(validateDecision({ action: 'approve', note: '  Go ahead  ' }, now).value.note, 'Go ahead');
  assert.equal(validateDecision({ action: ' APPROVE ' }, now).ok, true, 'case and spaces');
});

test('decision: reject needs a note of at least three letters', () => {
  for (const note of [undefined, '', '  ', 'no', ' ok ']) {
    const r = validateDecision({ action: 'reject', note }, now);
    assert.equal(r.ok, false, JSON.stringify(note));
    assert.equal(r.code, 'NOTE_REQUIRED');
  }
  assert.equal(validateDecision({ action: 'reject', note: 'Too costly' }, now).ok, true);
  assert.equal(validateDecision({ action: 'reject', note: 'abc' }, now).ok, true, 'exactly three');
});

test('decision: the note has a ceiling', () => {
  assert.equal(validateDecision({ action: 'approve', note: 'x'.repeat(MAX_NOTE) }, now).ok, true);
  const r = validateDecision({ action: 'approve', note: 'x'.repeat(MAX_NOTE + 1) }, now);
  assert.equal(r.code, 'NOTE_TOO_LONG');
});

test('decision: defer — the date is optional, but must be in the future and within a year', () => {
  assert.deepEqual(validateDecision({ action: 'defer' }, now).value, { action: 'defer', note: '', until: null });
  assert.equal(validateDecision({ action: 'defer', until: '2026-11-20' }, now).value.until.toISOString(), '2026-11-20T00:00:00.000Z');
  for (const until of ['2026-11-12T09:59:59Z', '2026-11-12T10:00:00Z', '2020-01-01', 'soon', '2028-01-01']) {
    const r = validateDecision({ action: 'defer', until }, now);
    assert.equal(r.ok, false, until);
    assert.equal(r.code, 'DATE_INVALID');
  }
  assert.equal(validateDecision({ action: 'defer', until: '2026-11-12T10:00:01Z' }, now).ok, true, 'a second ahead');
  assert.equal(validateDecision({ action: 'defer', until: '' }, now).value.until, null);
  assert.equal(validateDecision({ action: 'defer', until: null }, now).value.until, null);
});

test('decision: a date on anything but a deferral is ignored', () => {
  assert.equal(validateDecision({ action: 'approve', until: '2020-01-01' }, now).ok, true);
  assert.equal(validateDecision({ action: 'approve', until: '2026-12-01' }, now).value.until, null);
});

test('decision: any other action is refused', () => {
  for (const action of [undefined, '', 'maybe', 'APPROVED', 'withdraw']) assert.equal(validateDecision({ action }, now).code, 'ACTION_INVALID', String(action));
  assert.equal(validateDecision(undefined, now).code, 'ACTION_INVALID');
});

test('status: only an open request can be decided; each action has its own outcome', () => {
  for (const s of OPEN_STATUSES) {
    assert.equal(isOpenStatus(s), true);
    assert.equal(nextStatus(s, 'approve'), 'approved');
    assert.equal(nextStatus(s, 'reject'), 'rejected');
    assert.equal(nextStatus(s, 'defer'), 'deferred');
  }
  for (const s of ['approved', 'rejected', 'withdrawn', 'superseded', undefined]) {
    assert.equal(isOpenStatus(s), false, String(s));
    assert.equal(nextStatus(s, 'approve'), null, String(s));
  }
  assert.equal(nextStatus('pending', 'bogus'), null);
});

// ── has the source changed? ──────────────────────────────────────────────────

test('snapshots hold what a decision rests on, per kind', () => {
  assert.deepEqual(snapshotOf('spend_expense', { amount: '60000', department: 'IT', projectId: 'p1', title: 'ignored' }), { amount: 60000, department: 'IT', projectId: 'p1' });
  assert.deepEqual(snapshotOf('spend_payout', { amount: 30000, employeeId: { _id: 'e1' }, notes: 'x' }), { amount: 30000, employeeId: 'e1' });
  assert.deepEqual(snapshotOf('hiring_plan', { designation: 'Editor', department: 'Marketing', openings: 2, employmentType: 'Full-time', jobDescription: 'x' }), { designation: 'Editor', department: 'Marketing', openings: 2, employmentType: 'Full-time' });
  assert.deepEqual(snapshotOf('project_budget', { budget: 150000, approvedBudget: 100000 }), { budget: 150000, approvedBudget: 100000 });
  assert.deepEqual(snapshotOf('project_budget', { budget: 150000 }), { budget: 150000, approvedBudget: 0 });
  assert.deepEqual(snapshotOf('project_proposal', { name: 'P', targetDepartment: 'IT' }), { name: 'P', targetDepartment: 'IT' });
  assert.deepEqual(snapshotOf('nonsense', { a: 1 }), {});
});

test('a material change: amount, department, who, what — not a note, a title or a receipt', () => {
  const e = snapshotOf('spend_expense', { amount: 60000, department: 'IT', projectId: 'p1' });
  assert.equal(isMaterialChange('spend_expense', e, { ...e }), false);
  assert.equal(isMaterialChange('spend_expense', e, { ...e, amount: 60000.001 }), false, 'a rounding speck');
  assert.equal(isMaterialChange('spend_expense', e, { ...e, amount: 60001 }), true);
  assert.equal(isMaterialChange('spend_expense', e, { ...e, department: 'HR' }), true);
  assert.equal(isMaterialChange('spend_expense', e, { ...e, projectId: 'p2' }), true);
  assert.equal(isMaterialChange('spend_expense', e, { ...e, projectId: '' }), true);
  const p = snapshotOf('spend_payout', { amount: 30000, employeeId: 'e1' });
  assert.equal(isMaterialChange('spend_payout', p, { ...p, employeeId: 'e2' }), true);
  assert.equal(isMaterialChange('spend_payout', p, { ...p, amount: 29000 }), true);
  const h = snapshotOf('hiring_plan', { designation: 'Editor', department: 'M', openings: 2, employmentType: 'Full-time' });
  for (const change of [{ designation: 'Writer' }, { department: 'IT' }, { openings: 3 }, { employmentType: 'Contract' }]) assert.equal(isMaterialChange('hiring_plan', h, { ...h, ...change }), true, JSON.stringify(change));
  const b = snapshotOf('project_budget', { budget: 150000, approvedBudget: 100000 });
  assert.equal(isMaterialChange('project_budget', b, { ...b, budget: 160000 }), true);
  assert.equal(isMaterialChange('project_budget', b, { ...b, approvedBudget: 120000 }), true);
  assert.equal(isMaterialChange('project_budget', b, { ...b }), false);
});

test('a proposal is decided as it stands: renaming it is not a material change', () => {
  assert.equal(isMaterialChange('project_proposal', { name: 'A' }, { name: 'B' }), false);
});

test('missing fields compare as empty, not as a change', () => {
  assert.equal(isMaterialChange('spend_expense', {}, {}), false);
  assert.equal(isMaterialChange('spend_expense', { projectId: '' }, { projectId: undefined }), false);
  assert.equal(isMaterialChange('spend_expense', { amount: null }, { amount: 0 }), false);
});

// ── how a request reads to the app ───────────────────────────────────────────

const doc = (extra = {}) => ({
  _id: 'r1', kind: 'spend_expense', status: 'pending', title: 'New AC for the studio', subtitle: 'IT · invoice 1182', department: 'IT', amount: 82000, previousAmount: null,
  requestedBy: { id: 'u1', name: 'Imran', role: 'crm' }, requestedAt: new Date('2026-11-08T08:00:00Z'),
  checkedBy: { id: 'u2', name: 'Anu', role: 'accounts' }, checkedAt: new Date('2026-11-10T08:00:00Z'), checkNote: 'Bills match',
  summary: [{ label: 'Vendor', value: 'CoolAir' }], attachments: [{ label: 'Invoice', url: 'https://x/y.pdf' }], sourceRoute: null, ...extra,
});

test('an open request: who asked, who checked it and how long it has waited since', () => {
  const r = shapeRequest(doc(), { now, canDecide: true });
  assert.equal(r.id, 'r1');
  assert.equal(r.kindLabel, 'Department expense');
  assert.equal(r.open, true);
  assert.equal(r.amount, 82000);
  assert.deepEqual(r.requestedBy, { id: 'u1', name: 'Imran', role: 'crm' });
  assert.deepEqual(r.checkedBy, { id: 'u2', name: 'Anu', role: 'accounts', label: 'Accounts' });
  assert.equal(r.checkNote, 'Bills match');
  assert.equal(r.waitingDays, 2, 'counted from the team\'s check, not from when it was filed');
  assert.equal(r.canDecide, true);
  assert.equal(r.decision, null);
  assert.deepEqual(r.summary, [{ label: 'Vendor', value: 'CoolAir' }]);
  assert.deepEqual(r.attachments, [{ label: 'Invoice', url: 'https://x/y.pdf' }]);
});

test('who may decide: only when the viewer is a leader and it is still open', () => {
  assert.equal(shapeRequest(doc(), { now }).canDecide, false);
  assert.equal(shapeRequest(doc({ status: 'deferred' }), { now, canDecide: true }).canDecide, true);
  assert.equal(shapeRequest(doc({ status: 'approved' }), { now, canDecide: true }).canDecide, false);
});

test('a settled request says who decided, when and why — and no longer counts waiting days', () => {
  const r = shapeRequest(doc({ status: 'rejected', decidedBy: { id: 'u9', name: 'Dir', role: 'executive_director' }, decidedAt: new Date('2026-11-11T09:00:00Z'), note: 'Too costly' }), { now, canDecide: true });
  assert.equal(r.open, false);
  assert.deepEqual(r.decision, { by: { id: 'u9', name: 'Dir', role: 'executive_director' }, at: new Date('2026-11-11T09:00:00Z'), note: 'Too costly' });
  assert.equal(r.waitingDays, 0);
  assert.equal(r.canDecide, false);
});

test('a proposal has no team check; each kind names its own checker', () => {
  const r = shapeRequest(doc({ kind: 'project_proposal', checkedBy: null, checkedAt: null }), { now });
  assert.equal(r.checkedBy, null);
  assert.equal(r.waitingDays, 4, 'counted from when it was filed');
  assert.deepEqual(Object.fromEntries(KINDS.map((k) => [k, KIND_CHECKERS[k]])), { project_proposal: null, hiring_plan: 'HR', spend_expense: 'Accounts', spend_payout: 'Accounts', project_budget: 'the finance head' });
  for (const k of KINDS) assert.ok(KIND_LABELS[k], k);
});

test('waiting days: never negative, zero without a date', () => {
  assert.equal(waitingDays({ requestedAt: new Date('2026-11-20T00:00:00Z') }, now), 0);
  assert.equal(waitingDays({}, now), 0);
  assert.equal(waitingDays({ checkedAt: new Date('2026-11-11T09:00:00Z'), requestedAt: new Date('2026-10-01T00:00:00Z') }, now), 1);
});

test('the shaped request never carries the payload, the history or the raw snapshot', () => {
  const r = shapeRequest(doc({ payload: { proposedApprovedAmount: 5, snapshot: { amount: 1 } }, history: [{ action: 'requested' }] }), { now });
  assert.equal('payload' in r, false);
  assert.equal('history' in r, false);
});

test('a Mongoose-style document is read through toObject()', () => {
  const r = shapeRequest({ toObject: () => doc({ title: 'From a document' }) }, { now });
  assert.equal(r.title, 'From a document');
});

test('conflict: who settled it, how, when and why — in words the other leader reads', () => {
  const c = conflictBody(doc({ status: 'approved', decidedBy: { id: 'u9', name: 'Dir', role: 'executive_director' }, decidedAt: new Date('2026-11-11T09:00:00Z'), note: 'Fine' }));
  assert.equal(c.code, 'ALREADY_DECIDED');
  assert.equal(c.status, 'approved');
  assert.equal(c.message, 'Already approved by Dir (Executive Director): “Fine”');
  assert.equal(c.decision.by.name, 'Dir');
  assert.equal(c.decision.note, 'Fine');
  const ceo = conflictBody(doc({ status: 'rejected', decidedBy: { id: 'u1', name: 'Boss', role: 'ceo' }, decidedAt: new Date(), note: '' }));
  assert.equal(ceo.message, 'Already rejected by Boss (CEO).');
});

test('conflict: a request that was withdrawn or changed is "no longer waiting", not decided', () => {
  assert.equal(conflictBody(doc({ status: 'withdrawn' })).message, 'This is no longer waiting: it was withdrawn.');
  assert.equal(conflictBody(doc({ status: 'superseded' })).message, 'This is no longer waiting: it was changed since it was checked.');
  assert.equal(conflictBody(doc({ status: 'withdrawn' })).decision, null);
});
