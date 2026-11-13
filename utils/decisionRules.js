// The rules of the leadership decision workflow. Pure — no database (tests/decisionRules.test.js); services/decisions.js applies them.
//
//   what needs a leader:  a project proposal (always shown to them), a hiring plan (when the policy says so), a department expense / an
//                         artist payout ABOVE its limit, a project budget INCREASE above its limit — and only once the team has checked it
//   how it ends:          a leader approves, rejects (with a note) or defers; first decision wins; deferred stays open for either leader
//   no policy set:        nothing is escalated (a blank limit is "off", the hiring switch starts off)

import { cleanAmount } from './projectCost.js';
import { isLeadershipRole, leadershipTitle } from './leadership.js';

export const KINDS = ['project_proposal', 'hiring_plan', 'spend_expense', 'spend_payout', 'project_budget'];

export const KIND_LABELS = {
  project_proposal: 'Project proposal',
  hiring_plan: 'Hiring plan',
  spend_expense: 'Department expense',
  spend_payout: 'Artist payout',
  project_budget: 'Project budget',
};

// Who the team's check is by (for "Verified by …"); a proposal has none.
export const KIND_CHECKERS = {
  project_proposal: null,
  hiring_plan: 'HR',
  spend_expense: 'Accounts',
  spend_payout: 'Accounts',
  project_budget: 'the finance head',
};

export const OPEN_STATUSES = ['pending', 'deferred'];
export const SETTLED_STATUSES = ['approved', 'rejected', 'withdrawn', 'superseded'];
export const isOpenStatus = (status) => OPEN_STATUSES.includes(status);

export const ACTIONS = ['approve', 'reject', 'defer'];
export const MIN_NOTE = 3;
export const MAX_NOTE = 500;
export const MAX_LIMIT = 1e12;

const DAY = 86_400_000;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

// ── the policy ───────────────────────────────────────────────────────────────

const LIMIT_KEY = { spend_expense: 'expense', spend_payout: 'payout', project_budget: 'projectBudget' };

/// The limit for a spend kind, or null when it is off (not set, or not a usable number).
export const limitFor = (policy, kind) => {
  const key = LIMIT_KEY[kind];
  if (!key) return null;
  const raw = policy?.spendLimits?.[key];
  if (typeof raw !== 'number' && typeof raw !== 'string') return null; // `true` or a list must never read as ₹1
  const v = num(raw);
  return v !== null && Number.isFinite(v) && v >= 1 ? v : null;
};

/// Does this item need a leader? A spend: strictly ABOVE its limit, per item (not added up). A hiring plan: when the policy says so.
/// A proposal is not decided by amount (it always goes to the leaders), so this is false for it.
export const needsLeadership = (policy, kind, amount) => {
  if (kind === 'hiring_plan') return policy?.hiringPlansNeedLeadership === true;
  const limit = limitFor(policy, kind);
  if (limit === null) return false;
  const a = Number(amount);
  return Number.isFinite(a) && a > limit;
};

/// A project budget: only the increase counts against the limit. A first approval counts from zero; a cut is no increase.
export const budgetIncrease = ({ proposed, previousApproved }) => {
  const p = Number(proposed);
  const before = Number(previousApproved) || 0;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.round((p - before) * 100) / 100);
};

/**
 * The policy as sent by the Decision rules screen, checked. [current] is what is stored; a limit that is not mentioned stays as it
 * is, null or "" turns it off, anything else must be a number from 1 to 1e12.
 * → { ok: true, value: { spendLimits: {expense, payout, projectBudget}, hiringPlansNeedLeadership } } | { ok: false, code, message }
 */
export const validatePolicyInput = (body = {}, current = {}) => {
  const out = {
    spendLimits: {
      expense: limitFor(current, 'spend_expense'),
      payout: limitFor(current, 'spend_payout'),
      projectBudget: limitFor(current, 'project_budget'),
    },
    hiringPlansNeedLeadership: current?.hiringPlansNeedLeadership === true,
  };
  const given = body?.spendLimits;
  if (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given))) {
    return { ok: false, code: 'LIMITS_INVALID', message: 'The spend limits must be an object.' };
  }
  for (const [kind, key] of Object.entries(LIMIT_KEY)) {
    if (!given || !(key in given)) continue;
    const raw = given[key];
    if (raw === null || raw === '' || raw === undefined) {
      out.spendLimits[key] = null;
      continue;
    }
    // only a number, or text that is one — `true`, a list or an object must not read as ₹1
    const v = typeof raw === 'number' || typeof raw === 'string' ? cleanAmount(raw) : null;
    if (v === null || !(v >= 1) || v > MAX_LIMIT) {
      return { ok: false, code: 'LIMIT_INVALID', field: key, message: `The ${KIND_LABELS[kind].toLowerCase()} limit must be an amount of at least ₹1, or left blank to switch it off.` };
    }
    out.spendLimits[key] = v;
  }
  if (body?.hiringPlansNeedLeadership !== undefined) {
    if (typeof body.hiringPlansNeedLeadership !== 'boolean') return { ok: false, code: 'FLAG_INVALID', message: 'Say yes or no for hiring plans.' };
    out.hiringPlansNeedLeadership = body.hiringPlansNeedLeadership;
  }
  return { ok: true, value: out };
};

/// Is anything switched on?
export const policyIsOn = (policy) =>
  policy?.hiringPlansNeedLeadership === true || ['spend_expense', 'spend_payout', 'project_budget'].some((k) => limitFor(policy, k) !== null);

/// "Nothing is escalated" / "Department expenses above ₹50,000, hiring plans" — a line for the screen.
export const policySummary = (policy) => {
  const parts = [];
  const rupees = (n) => `₹${Number(n).toLocaleString('en-IN')}`;
  if (limitFor(policy, 'spend_expense') !== null) parts.push(`department expenses above ${rupees(limitFor(policy, 'spend_expense'))}`);
  if (limitFor(policy, 'spend_payout') !== null) parts.push(`artist payouts above ${rupees(limitFor(policy, 'spend_payout'))}`);
  if (limitFor(policy, 'project_budget') !== null) parts.push(`project budget increases above ${rupees(limitFor(policy, 'project_budget'))}`);
  if (policy?.hiringPlansNeedLeadership === true) parts.push('hiring plans');
  return parts.length ? parts.join(', ') : 'Nothing is escalated by amount.';
};

// ── a decision ───────────────────────────────────────────────────────────────

/// A leader's decision as sent, checked. → { ok: true, value: { action, note, until } } | { ok: false, code, message }
export const validateDecision = (input = {}, now = new Date()) => {
  const action = String(input?.action ?? '').trim().toLowerCase();
  if (!ACTIONS.includes(action)) return { ok: false, code: 'ACTION_INVALID', message: 'Choose approve, reject or defer.' };
  const note = String(input?.note ?? '').trim();
  if (note.length > MAX_NOTE) return { ok: false, code: 'NOTE_TOO_LONG', message: `Keep the note under ${MAX_NOTE} characters.` };
  if (action === 'reject' && note.length < MIN_NOTE) return { ok: false, code: 'NOTE_REQUIRED', message: 'Say why it is rejected.' };
  let until = null;
  if (action === 'defer' && input?.until !== undefined && input?.until !== null && input?.until !== '') {
    const d = new Date(input.until);
    if (Number.isNaN(d.getTime()) || !(d.getTime() > now.getTime())) return { ok: false, code: 'DATE_INVALID', message: 'Defer to a date in the future.' };
    if (d.getTime() - now.getTime() > 366 * DAY) return { ok: false, code: 'DATE_INVALID', message: 'Defer for no more than a year.' };
    until = d;
  }
  return { ok: true, value: { action, note, until } };
};

/// Where a request goes on [action]; null when it is not open (it was decided already).
export const nextStatus = (current, action) => {
  if (!isOpenStatus(current)) return null;
  return { approve: 'approved', reject: 'rejected', defer: 'deferred' }[action] ?? null;
};

// ── has the source changed since the team checked it? ────────────────────────

/// The fields of the source a decision rests on — taken when the request is made, compared when it is decided.
export const snapshotOf = (kind, source = {}) => {
  switch (kind) {
    case 'spend_expense':
      return { amount: num(source.amount), department: String(source.department ?? ''), projectId: idOf(source.projectId) };
    case 'spend_payout':
      return { amount: num(source.amount), employeeId: idOf(source.employeeId) };
    case 'hiring_plan':
      return { designation: String(source.designation ?? ''), department: String(source.department ?? ''), openings: num(source.openings), employmentType: String(source.employmentType ?? '') };
    case 'project_budget':
      return { budget: num(source.budget), approvedBudget: num(source.approvedBudget) ?? 0 };
    case 'project_proposal':
      return { name: String(source.name ?? ''), targetDepartment: String(source.targetDepartment ?? '') };
    default:
      return {};
  }
};

/// Did what the decision rests on change? (A proposal's name is not material: it can be decided as it stands.)
export const isMaterialChange = (kind, before = {}, after = {}) => {
  if (kind === 'project_proposal') return false;
  const keys = Object.keys(snapshotOf(kind, {}));
  return keys.some((k) => {
    const a = before?.[k];
    const b = after?.[k];
    if (typeof a === 'number' || typeof b === 'number') return Math.abs((Number(a) || 0) - (Number(b) || 0)) > 0.004;
    return String(a ?? '') !== String(b ?? '');
  });
};

// ── how a request reads to the app ───────────────────────────────────────────

const person = (p) => (p && (p.id || p.name) ? { id: idOf(p.id), name: p.name ?? '', role: p.role ?? '' } : null);

export const waitingDays = (doc, now = new Date()) => {
  const since = doc?.checkedAt ?? doc?.requestedAt ?? doc?.createdAt;
  return since ? Math.max(0, Math.floor((now.getTime() - new Date(since).getTime()) / DAY)) : 0;
};

/// The request as the app receives it. [canDecide]: this viewer is a leader and it is still open.
export const shapeRequest = (doc, { now = new Date(), canDecide = false } = {}) => {
  const d = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  const checkedBy = person(d.checkedBy);
  const decidedBy = person(d.decidedBy);
  const open = isOpenStatus(d.status);
  return {
    id: idOf(d._id),
    kind: d.kind,
    kindLabel: KIND_LABELS[d.kind] ?? d.kind,
    status: d.status,
    open,
    title: d.title,
    subtitle: d.subtitle ?? '',
    department: d.department ?? '',
    amount: d.amount ?? null,
    previousAmount: d.previousAmount ?? null,
    requestedBy: person(d.requestedBy),
    requestedAt: d.requestedAt ?? d.createdAt ?? null,
    checkedBy: checkedBy ? { ...checkedBy, label: KIND_CHECKERS[d.kind] ?? '' } : null,
    checkedAt: d.checkedAt ?? null,
    checkNote: d.checkNote ?? '',
    waitingDays: open ? waitingDays(d, now) : 0,
    deferredUntil: d.deferredUntil ?? null,
    decision: decidedBy && d.decidedAt ? { by: decidedBy, at: d.decidedAt, note: d.note ?? '' } : null,
    summary: (d.summary ?? []).map((s) => ({ label: s.label, value: s.value })),
    attachments: (d.attachments ?? []).map((a) => ({ label: a.label, url: a.url })),
    sourceRoute: d.sourceRoute ?? null,
    applyError: d.applyError ?? '',
    canDecide: !!canDecide && open,
  };
};

/// The 409 body for a request somebody else already settled: who, what, when, why.
export const conflictBody = (doc) => {
  const d = typeof doc?.toObject === 'function' ? doc.toObject() : doc;
  const by = person(d.decidedBy);
  const verb = { approved: 'approved', rejected: 'rejected', withdrawn: 'withdrawn', superseded: 'changed since it was checked' }[d.status] ?? d.status;
  const who = by?.name ? ` by ${by.name}${isLeadershipRole(by.role) ? ` (${leadershipTitle(by.role)})` : ''}` : '';
  return {
    code: 'ALREADY_DECIDED',
    status: d.status,
    decision: by && d.decidedAt ? { by, at: d.decidedAt, note: d.note ?? '' } : null,
    message: d.status === 'withdrawn' || d.status === 'superseded' ? `This is no longer waiting: it was ${verb}.` : `Already ${verb}${who}${d.note ? `: “${d.note}”` : '.'}`,
  };
};
