import mongoose from 'mongoose';

export const TIMESHEET_STATUSES = ['draft', 'pending', 'approved', 'rejected'];

// One entry = hours logged on a day against a project/booking/task label.
const entrySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    project: { type: String, default: '' },
    hours: { type: Number, default: 0 },
    note: { type: String, default: '' },
  },
  { _id: false }
);

// A period timesheet an employee fills and submits for approval. The period is
// identified by periodStart (the week's Monday or the month's first day) plus a
// human label. Submit routes through the generic approval engine.
const timesheetSchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
      index: true,
    },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    periodType: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
    periodStart: { type: Date, required: true },
    periodLabel: { type: String, default: '' },
    entries: { type: [entrySchema], default: [] },
    totalHours: { type: Number, default: 0 },
    status: { type: String, enum: TIMESHEET_STATUSES, default: 'draft' },
    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

timesheetSchema.index({ employeeId: 1, periodStart: -1 });

const Timesheet = mongoose.model('Timesheet', timesheetSchema);
export default Timesheet;
