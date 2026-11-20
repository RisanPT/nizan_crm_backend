import mongoose from 'mongoose';

// A CRM CASE: one thing the CRM team must see through for a client — a complaint, a follow-up, a re-engagement call to a past
// client, or a trial to follow up. Each has an owner on the CRM team, a due time (its time limit), a status, and a log of every
// call, WhatsApp, note and change. Resolving needs a note saying what was done. Rules: utils/crmCaseRules.js; service:
// services/crmCases.js.

export const CASE_KINDS = ['complaint', 'follow_up', 're_engagement', 'trial_follow_up'];
export const CASE_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
export const CASE_OUTCOMES = ['', 'resolved', 'compensated', 'unresolved', 'won', 'not_interested', 'referral'];
export const CASE_ORIGINS = ['manual', 'review_auto', 'trial_auto', 're_engagement_list'];
export const ACTIVITY_TYPES = ['call', 'whatsapp', 'note', 'status', 'assign'];

const activitySchema = new mongoose.Schema(
  {
    type: { type: String, enum: ACTIVITY_TYPES, required: true },
    text: { type: String, default: '', trim: true },
    // what came of a call / WhatsApp: e.g. 'reached', 'no_answer', 'interested'
    outcome: { type: String, default: '', trim: true },
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    byName: { type: String, default: '' },
  },
  { _id: true }
);

const crmCaseSchema = new mongoose.Schema(
  {
    caseNumber: { type: String, unique: true, index: true },
    kind: { type: String, enum: CASE_KINDS, required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },

    // the client
    customerName: { type: String, default: '', trim: true },
    // digits only, last 10 — so "+91 98950 00001" and "9895000001" are the same client
    phone: { type: String, default: '', index: true },
    bookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },
    reviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Review', default: null },
    trialId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trial', default: null },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    // manual = opened by staff; review_auto = a review flagged a complaint / follow-up; re_engagement_list = from the list of
    // past clients to call; trial_auto = a trial to follow up
    origin: { type: String, enum: CASE_ORIGINS, default: 'manual' },

    // who owns it (a CRM team login); null = waiting in Unassigned for the CRM Head
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    ownerName: { type: String, default: '' },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    status: { type: String, enum: CASE_STATUSES, default: 'open' },
    // the time limit, in hours, and when that makes it due
    slaHours: { type: Number, default: 48, min: 1 },
    dueAt: { type: Date, required: true },

    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedByName: { type: String, default: '' },
    // closed WITHOUT being resolved (a duplicate, a client who could not be reached): never counts as resolved on time
    closedAt: { type: Date, default: null },
    resolutionNote: { type: String, default: '', trim: true },
    outcome: { type: String, enum: CASE_OUTCOMES, default: '' },
    // a re-engagement / trial case that won a booking
    wonBookingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking', default: null },

    // when the owner and the CRM Head were told it is overdue (once — utils/crmSweep.js)
    overdueNotifiedAt: { type: Date, default: null },

    activities: { type: [activitySchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

crmCaseSchema.index({ status: 1, dueAt: 1 });
crmCaseSchema.index({ ownerId: 1, status: 1 });
crmCaseSchema.index({ createdAt: -1 });
// the CRM figures: cases resolved / closed in a period, and the calls logged on re-engagement cases
crmCaseSchema.index({ resolvedAt: 1 });
crmCaseSchema.index({ closedAt: 1 });
crmCaseSchema.index({ kind: 1, 'activities.at': 1 });
// a flagged review opens ONE case of a kind, however often it is saved
crmCaseSchema.index(
  { reviewId: 1, kind: 1 },
  { unique: true, partialFilterExpression: { origin: 'review_auto' } }
);

const CrmCase = mongoose.model('CrmCase', crmCaseSchema);
export default CrmCase;
