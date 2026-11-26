import mongoose from 'mongoose';

// Something that waits for the CEO or the Executive Director to decide: a project proposal, a hiring plan, a big spend (a department
// expense, an artist payout) or a project budget increase. It is created at the moment the TEAM has checked the item (Accounts has
// verified the bills, HR has vetted the plan); until a leader decides, the source is held — not posted, not paid, not approved.
// First decision wins: either leader may decide, and the other sees who did, when and why. (utils/decisionRules.js has the rules,
// services/decisions.js the workflow.)
export const DECISION_KINDS = ['project_proposal', 'hiring_plan', 'spend_expense', 'spend_payout', 'project_budget'];
export const DECISION_REF_MODELS = ['Project', 'HiringPlan', 'AdminExpense', 'ArtistPayout'];
// pending / deferred are OPEN (a leader still has to decide); the rest are settled.
export const DECISION_REQUEST_STATUSES = ['pending', 'deferred', 'approved', 'rejected', 'withdrawn', 'superseded'];

const personSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    name: { type: String, default: '' },
    role: { type: String, default: '' },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: personSchema, default: () => ({}) },
    action: { type: String, required: true }, // requested | checked | approved | rejected | deferred | withdrawn | superseded | applied | apply_failed
    note: { type: String, default: '' },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const decisionRequestSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: DECISION_KINDS, required: true, index: true },
    refModel: { type: String, enum: DECISION_REF_MODELS, required: true },
    refId: { type: mongoose.Schema.Types.ObjectId, required: true },

    // A snapshot, so a leader needs no access to the source screens (and so a later edit of the source can be noticed).
    title: { type: String, required: true, trim: true },
    subtitle: { type: String, default: '' },
    department: { type: String, default: '' },
    amount: { type: Number, default: null },
    previousAmount: { type: Number, default: null }, // a budget: what was approved before
    summary: { type: [{ label: String, value: String, _id: false }], default: [] },
    attachments: { type: [{ label: String, url: String, _id: false }], default: [] },
    sourceRoute: { type: String, default: null }, // only a route a leader may open

    requestedBy: { type: personSchema, default: () => ({}) },
    requestedAt: { type: Date, default: Date.now },
    // The team's check: who verified it before it came to leadership (null for a proposal, which has none).
    checkedBy: { type: personSchema, default: null },
    checkedAt: { type: Date, default: null },
    checkNote: { type: String, default: '' },

    status: { type: String, enum: DECISION_REQUEST_STATUSES, default: 'pending', index: true },
    // true while pending/deferred; REMOVED (unset) once settled — the partial unique index below keys on it. No schema default on
    // purpose: a settled request has no `open`, and Mongoose must not put one back when it loads the document. Set at creation.
    open: { type: Boolean },
    deferredUntil: { type: Date, default: null },

    decidedBy: { type: personSchema, default: null },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: '' },

    // The source is changed only after the decision: when that worked, and what went wrong when it did not.
    appliedAt: { type: Date, default: null },
    applyError: { type: String, default: '' },
    // Anything the handler needs to carry out the decision later (e.g. the budget the finance head proposed).
    payload: { type: mongoose.Schema.Types.Mixed, default: null },

    history: { type: [historySchema], default: [] },
  },
  { timestamps: true },
);

// One OPEN request per kind and source item: a double click on "approve" cannot raise two. (Equality-only partial index — fine on any
// Mongo. The kind is in it because a project can have a proposal AND a budget to decide, one after the other.)
decisionRequestSchema.index({ kind: 1, refId: 1 }, { unique: true, partialFilterExpression: { open: true } });
decisionRequestSchema.index({ refModel: 1, refId: 1, createdAt: -1 });
decisionRequestSchema.index({ open: 1, createdAt: 1 });
decisionRequestSchema.index({ status: 1, decidedAt: -1 });

const DecisionRequest = mongoose.model('DecisionRequest', decisionRequestSchema);
export default DecisionRequest;
