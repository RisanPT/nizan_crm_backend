/**
 * ApprovalRequest — the generic HR approval engine.
 *
 * Every request-driven HR action (leave, attendance regularization, timesheet,
 * reimbursement, travel, comp revision…) creates ONE ApprovalRequest and routes
 * it through an ordered `chain` of steps. A step clears when its approver (a
 * specific user OR anyone holding a role) approves; the request is `approved`
 * only when every step is approved, and `rejected` the moment one step rejects.
 *
 * The source document (e.g. a LeaveRequest) links back via refModel/refId, and
 * reacts to the final decision — ApprovalRequest itself stays domain-agnostic.
 */
import mongoose from 'mongoose';

export const APPROVAL_MODULES = [
  'leave',
  'regularization',
  'timesheet',
  'reimbursement',
  'travel',
  'comp_revision',
  'probation',
  'other',
];
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
const STEP_STATES = ['pending', 'approved', 'rejected', 'skipped'];

const stepSchema = new mongoose.Schema(
  {
    level: { type: Number, required: true },
    label: { type: String, default: '' },
    // Either a specific approver, or any active user holding `approverRole`.
    approverUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approverRole: { type: String, default: '', trim: true, lowercase: true },
    state: { type: String, enum: STEP_STATES, default: 'pending' },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    decidedAt: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  { _id: false }
);

const approvalRequestSchema = mongoose.Schema(
  {
    module: { type: String, enum: APPROVAL_MODULES, required: true },
    title: { type: String, default: '', trim: true },
    summary: { type: String, default: '' },

    requesterEmployeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    requesterUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    // Who the request is ABOUT (usually the requester).
    subjectEmployeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },

    // Polymorphic link to the source document.
    refModel: { type: String, default: '' },
    refId: { type: mongoose.Schema.Types.ObjectId, default: null },

    amount: { type: Number, default: 0 }, // for claims/comp revisions
    status: { type: String, enum: APPROVAL_STATUSES, default: 'pending' },
    currentLevel: { type: Number, default: 0 }, // index into chain of the live step
    chain: { type: [stepSchema], default: [] },
    slaHours: { type: Number, default: 24 },
    link: { type: String, default: '' }, // in-app deep link for notifications

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

approvalRequestSchema.index({ status: 1, 'chain.approverUserId': 1 });
approvalRequestSchema.index({ status: 1, 'chain.approverRole': 1 });
approvalRequestSchema.index({ requesterEmployeeId: 1, createdAt: -1 });
approvalRequestSchema.index({ refModel: 1, refId: 1 });

export default mongoose.model('ApprovalRequest', approvalRequestSchema);
