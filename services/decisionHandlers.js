import AdminExpense from '../models/AdminExpense.js';
import ArtistPayout from '../models/ArtistPayout.js';
import HiringPlan from '../models/HiringPlan.js';
import Project from '../models/Project.js';
import { postDoc, unpostDoc, safePost } from './posting.js';
import { afterSpendChange } from './projectSpend.js';
import { applyCostDecision, decideProposal } from './projectDecisions.js';
import { money, spendingLimit } from '../utils/projectCost.js';
import { snapshotOf } from '../utils/decisionRules.js';

// What differs between the kinds of thing that wait for the CEO / Executive Director: how to read the source, what a leader is shown,
// and how to carry out the decision. services/decisions.js is the workflow that uses them.
//
//   apply({ request, action, leader, note, now }) → { result }
//       'applied'         the source was changed as decided
//       'already'         it had been changed already (a re-run after a crash): nothing more to do
//       'source_changed'  the source is no longer what the team checked (edited, deleted, decided elsewhere)
//   It must be safe to run twice: the source is changed with ONE conditional update, and what follows (posting to the books…) is idempotent.

const idStr = (v) => (v == null ? '' : String(v._id ?? v));
const day = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const row = (label, value) => (value === null || value === undefined || String(value).trim() === '' ? null : { label, value: String(value) });
const rows = (...list) => list.filter(Boolean);
const clip = (s, n = 300) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const sameRequest = (stamp, request) => !!stamp?.requestId && idStr(stamp.requestId) === idStr(request._id);

// ── a department expense ─────────────────────────────────────────────────────

const expense = {
  refModel: 'AdminExpense',
  Model: AdminExpense,
  stampPath: 'leadership',
  routeFor: () => null,
  load: (id) => AdminExpense.findById(id),
  snapshot: (src) => snapshotOf('spend_expense', src),
  requesterId: (src) => src.createdBy,
  stillHeld: (src, request) => src.status === 'pending' && src.leadership?.state === 'awaiting' && sameRequest(src.leadership, request),
  describe: (src) => ({
    title: src.title,
    subtitle: [src.vendor, src.expenseHead].filter(Boolean).join(' · '),
    department: src.department,
    amount: src.amount,
    previousAmount: null,
    summary: rows(
      row('Department', src.department),
      row('Expense head', src.expenseHead),
      row('Vendor', src.vendor),
      row('Paid by', src.paidByName),
      row('Date', day(src.date)),
      row('Payment', String(src.paymentMethod ?? '').replace('_', ' ')),
      row('Project', src.projectName),
      row('Invoice no.', src.invoiceNumber),
      row('Notes', clip(src.notes)),
    ),
    attachments: src.receiptImage ? [{ label: 'Receipt', url: src.receiptImage }] : [],
    sourceRoute: null,
  }),
  apply: async ({ request, action, leader, now }) => {
    const approve = action === 'approve';
    const done = approve ? 'approved' : 'rejected';
    const claimed = await AdminExpense.findOneAndUpdate(
      { _id: request.refId, status: 'pending', 'leadership.requestId': request._id, 'leadership.state': 'awaiting' },
      { $set: { status: done, approvedBy: leader._id, approvedAt: now, 'leadership.state': done } },
      { new: true },
    );
    let doc = claimed;
    let result = 'applied';
    if (!doc) {
      const current = await AdminExpense.findById(request.refId);
      if (!current || current.status !== done || !sameRequest(current.leadership, request) || current.leadership?.state !== done) return { result: 'source_changed' };
      doc = current;
      result = 'already';
    }
    // what follows is idempotent: posting replaces the voucher of the same source, the project re-reads what it has spent
    if (approve) await safePost(() => postDoc('AdminExpense', doc.toObject(), leader._id));
    else await safePost(() => unpostDoc('AdminExpense', doc._id));
    if (doc.projectId) await afterSpendChange(doc.projectId);
    return { result };
  },
};

// ── an artist payout ─────────────────────────────────────────────────────────

const payout = {
  refModel: 'ArtistPayout',
  Model: ArtistPayout,
  stampPath: 'leadership',
  routeFor: () => null,
  load: (id) => ArtistPayout.findById(id),
  snapshot: (src) => snapshotOf('spend_payout', src),
  requesterId: (src) => src.createdBy,
  stillHeld: (src, request) => src.status === 'pending' && src.leadership?.state === 'awaiting' && sameRequest(src.leadership, request),
  describe: (src) => ({
    title: `Payout to ${src.employeeName || 'an artist'}`,
    subtitle: src.bookingNumber ? `Booking ${src.bookingNumber}` : 'Not tied to a booking',
    department: 'Artist',
    amount: src.amount,
    previousAmount: null,
    summary: rows(
      row('Artist', src.employeeName),
      row('Booking', src.bookingNumber),
      row('Work date', day(src.date)),
      row('Pay by', String(src.paymentMode ?? '').replace('_', ' ')),
      row('Notes', clip(src.notes)),
    ),
    attachments: [],
    sourceRoute: null,
  }),
  apply: async ({ request, action, leader, now }) => {
    const approve = action === 'approve';
    const done = approve ? 'approved' : 'cancelled';
    const stamp = approve ? 'approved' : 'rejected';
    const claimed = await ArtistPayout.findOneAndUpdate(
      { _id: request.refId, status: 'pending', 'leadership.requestId': request._id, 'leadership.state': 'awaiting' },
      { $set: { status: done, approvedBy: leader._id, approvedAt: now, 'leadership.state': stamp } },
      { new: true },
    );
    if (claimed) return { result: 'applied' };
    const current = await ArtistPayout.findById(request.refId);
    if (current && current.status === done && sameRequest(current.leadership, request) && current.leadership?.state === stamp) return { result: 'already' };
    return { result: 'source_changed' };
  },
};

// ── a hiring plan ────────────────────────────────────────────────────────────

const hiring = {
  refModel: 'HiringPlan',
  Model: HiringPlan,
  stampPath: 'leadership',
  routeFor: () => null,
  load: (id) => HiringPlan.findById(id),
  snapshot: (src) => snapshotOf('hiring_plan', src),
  requesterId: (src) => src.createdBy,
  stillHeld: (src, request) => ['draft', 'raised'].includes(src.status) && src.leadership?.state === 'awaiting' && sameRequest(src.leadership, request),
  describe: (src) => ({
    title: `${src.designation}${Number(src.openings) > 1 ? ` × ${src.openings}` : ''}`,
    subtitle: `${src.department} · ${src.employmentType}`,
    department: src.department,
    amount: null,
    previousAmount: null,
    summary: rows(
      row('Role', src.designation),
      row('Department', src.department),
      row('Openings', src.openings),
      row('Type', src.employmentType),
      row('Reports to', src.reportingLine),
      row('Experience', src.experienceBand),
      row('Why', clip(src.businessJustification)),
      row('Skills', clip(src.requiredSkills, 200)),
    ),
    attachments: [],
    sourceRoute: null,
  }),
  apply: async ({ request, action, leader, note, now }) => {
    const approve = action === 'approve';
    const done = approve ? 'approved' : 'rejected';
    const set = approve
      ? { status: 'approved', approvedAt: now, approvedBy: leader._id, 'leadership.state': 'approved' }
      : { status: 'rejected', rejectionReason: note || 'Not approved', 'leadership.state': 'rejected' };
    const claimed = await HiringPlan.findOneAndUpdate(
      { _id: request.refId, status: { $in: ['draft', 'raised'] }, 'leadership.requestId': request._id, 'leadership.state': 'awaiting' },
      { $set: set },
      { new: true },
    );
    if (claimed) return { result: 'applied' };
    const current = await HiringPlan.findById(request.refId);
    if (current && current.status === done && sameRequest(current.leadership, request) && current.leadership?.state === done) return { result: 'already' };
    return { result: 'source_changed' };
  },
};

// ── a project's budget ───────────────────────────────────────────────────────

const budget = {
  refModel: 'Project',
  Model: Project,
  stampPath: 'costLeadership',
  routeFor: () => '/projects',
  load: (id) => Project.findById(id),
  snapshot: (src) => snapshotOf('project_budget', src),
  requesterId: (src) => src.createdBy,
  stillHeld: (src, request) => src.costStatus === 'pending' && src.status !== 'cancelled' && src.costLeadership?.state === 'awaiting' && sameRequest(src.costLeadership, request),
  describe: (src, payload = {}) => {
    const proposed = Number(payload.amount ?? src.budget) || 0;
    const before = spendingLimit(src);
    return {
      title: `Budget for ${src.name}`,
      subtitle: before > 0 ? `${money(before)} → ${money(proposed)}` : `First approval: ${money(proposed)}`,
      department: src.targetDepartment,
      amount: proposed,
      previousAmount: before > 0 ? before : null,
      summary: rows(
        row('Project', src.name),
        row('Department', src.targetDepartment),
        row('Asked by the team', money(src.budget)),
        row('Finance head would approve', money(proposed)),
        row('Approved so far', before > 0 ? money(before) : 'Nothing yet'),
        row('Increase', money(Math.max(0, proposed - before))),
        ...(src.costPlan ?? []).map((l) => row(`  ${l.category}`, money(l.amount))),
      ),
      attachments: [],
      sourceRoute: '/projects',
    };
  },
  apply: async ({ request, action, leader, note }) => {
    const approve = action === 'approve';
    const final = approve ? 'approved' : 'rejected';
    // The state moves first (and may be re-run: the cost is still `pending` until applyCostDecision has saved it).
    const project = await Project.findOneAndUpdate(
      { _id: request.refId, costStatus: 'pending', 'costLeadership.requestId': request._id, 'costLeadership.state': { $in: ['awaiting', final] } },
      { $set: { 'costLeadership.state': final } },
      { new: true },
    );
    if (!project) {
      const current = await Project.findById(request.refId);
      const settled = current && sameRequest(current.costLeadership, request) && ['approved', 'returned'].includes(current.costStatus);
      return { result: settled ? 'already' : 'source_changed' };
    }
    await applyCostDecision(project, { approve, amount: Number(request.payload?.amount) || 0, note, user: leader });
    return { result: 'applied' };
  },
};

// ── a project proposal ───────────────────────────────────────────────────────

const proposal = {
  refModel: 'Project',
  Model: Project,
  stampPath: null, // decided in parallel with the department head: nothing is held
  routeFor: () => '/projects',
  load: (id) => Project.findById(id),
  snapshot: (src) => snapshotOf('project_proposal', src),
  requesterId: (src) => src.proposedBy ?? src.createdBy,
  stillHeld: (src) => src.status === 'proposed',
  describe: (src) => ({
    title: src.name,
    subtitle: `Proposed for ${src.targetDepartment}`,
    department: src.targetDepartment,
    amount: Number(src.budget) > 0 ? Number(src.budget) : null,
    previousAmount: null,
    summary: rows(
      row('Project', src.name),
      row('Department', src.targetDepartment),
      row('Estimated cost', Number(src.budget) > 0 ? money(src.budget) : ''),
      row('Start', day(src.startDate)),
      row('End', day(src.endDate)),
      row('About', clip(src.description)),
    ),
    attachments: [],
    sourceRoute: '/projects',
  }),
  apply: async ({ request, action, leader, note }) => {
    const project = await decideProposal(request.refId, { approve: action === 'approve', note, user: leader });
    return { result: project ? 'applied' : 'source_changed' };
  },
};

export const HANDLERS = {
  spend_expense: expense,
  spend_payout: payout,
  hiring_plan: hiring,
  project_budget: budget,
  project_proposal: proposal,
};

export const handlerFor = (kind) => HANDLERS[kind] ?? null;
