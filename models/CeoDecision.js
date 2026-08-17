import mongoose from 'mongoose';

export const DECISION_TYPES = [
  'cost_approval',
  'hiring',
  'capex',
  'investment',
  'strategic',
  'action_item',
];
export const DECISION_STATUSES = ['pending', 'approved', 'rejected', 'deferred', 'done'];

// A CEO decision or action item raised in the month-end review / planning
// meeting — approvals (cost/hiring/CapEx/investment), strategic calls, and
// assigned action items with an owner and a deadline. Ties the review to
// accountability.
const ceoDecisionSchema = mongoose.Schema(
  {
    // The meeting month this belongs to (for grouping in the review/planning).
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },

    type: { type: String, enum: DECISION_TYPES, default: 'action_item' },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    amount: { type: Number, default: 0 }, // ₹ for cost/CapEx/investment items

    status: { type: String, enum: DECISION_STATUSES, default: 'pending' },
    owner: { type: String, default: '' }, // person accountable (free text or name)
    dueDate: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

ceoDecisionSchema.index({ year: 1, month: 1, status: 1 });

const CeoDecision = mongoose.model('CeoDecision', ceoDecisionSchema);

export default CeoDecision;
