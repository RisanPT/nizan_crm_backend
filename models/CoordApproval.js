import mongoose from 'mongoose';
import { APPROVAL_CATEGORIES, APPROVAL_STATUSES } from '../utils/marketingCoordinationStats.js';

// An approval asked for in Coordinations → Approvals: any member can raise one (with an amount and what it affects); only a Marketing
// Manager / admin decides. The amount is recorded for the decision — NOTHING is posted to accounts from here. A decided approval
// (approved / rejected) is final. It can be linked to the request it unblocks. Escalating it sends it up: the leadership and the Marketing
// Managers are told, and who it went to is kept (escalatedTo / escalatedBy).

const coordApprovalSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 200 },
    category: { type: String, enum: APPROVAL_CATEGORIES, required: true },
    amount: { type: Number, default: 0, min: 0, max: 1_000_000_000 },
    impact: { type: String, default: '', trim: true, maxlength: 500 },
    requestedById: { type: mongoose.Schema.Types.ObjectId, ref: 'MarketingTeamMember', default: null },
    requestedByName: { type: String, default: '', trim: true, maxlength: 100 },
    status: { type: String, enum: APPROVAL_STATUSES, default: 'pending' },
    dueDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ }, // needed by
    brand: { type: String, enum: ['main', 'kerala'], default: 'main' },
    requestId: { type: mongoose.Schema.Types.ObjectId, ref: 'CoordRequest', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedByName: { type: String, default: '', trim: true, maxlength: 100 },
    decidedAt: { type: Date, default: null }, // approved or rejected
    escalatedAt: { type: Date, default: null },
    // who an escalation was sent up to (the leadership and the Marketing Managers, at that moment) and who escalated it
    escalatedTo: { type: [{ userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, name: String, title: String, _id: false }], default: [] },
    escalatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    escalatedByName: { type: String, default: '', trim: true, maxlength: 100 },
    decisionNote: { type: String, default: '', trim: true, maxlength: 1000 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

coordApprovalSchema.index({ status: 1, createdAt: -1 });
coordApprovalSchema.index({ requestId: 1 });

export default mongoose.model('CoordApproval', coordApprovalSchema);
