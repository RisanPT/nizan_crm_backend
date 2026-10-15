import mongoose from 'mongoose';

export const REVISION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];

// A proposed salary revision for an employee. Routed through the approval
// engine; on approval the new base salary is applied to the Employee and a
// SalaryIncrement history row is written.
const revisionSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    currentSalary: { type: Number, default: 0 }, // snapshot at propose time
    proposedSalary: { type: Number, required: true },
    effectiveDate: { type: Date, default: null },
    reason: { type: String, default: '' },
    status: { type: String, enum: REVISION_STATUSES, default: 'pending' },
    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', default: null },
    appliedAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

const CompensationRevision = mongoose.model('CompensationRevision', revisionSchema);
export default CompensationRevision;
