import mongoose from 'mongoose';

export const REGULARIZATION_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
export const REGULARIZATION_TYPES = ['missing_punch', 'wrong_time', 'wfh', 'on_duty', 'other'];

// A request to correct one day's attendance (a missed punch, wrong time, WFH or
// on-duty). Routed through the approval engine; an approved record is the
// authoritative override the payroll/report layer reads for that day — it is NOT
// written back into Timebox (Timebox stays the raw source).
const regularizationSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    date: { type: Date, required: true },
    type: { type: String, enum: REGULARIZATION_TYPES, default: 'missing_punch' },
    requestedInTime: { type: String, default: '' }, // "HH:mm"
    requestedOutTime: { type: String, default: '' },
    reason: { type: String, default: '' },
    status: { type: String, enum: REGULARIZATION_STATUSES, default: 'pending' },
    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    month: { type: Number, default: 0 },
    year: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

regularizationSchema.index({ employeeId: 1, date: -1 });

const AttendanceRegularization = mongoose.model('AttendanceRegularization', regularizationSchema);
export default AttendanceRegularization;
