/**
 * LeaveRequest — one application for leave by an employee.
 *
 * On submit it creates a linked ApprovalRequest (employee → reporting manager /
 * dept head → HR). The request's status mirrors the approval outcome. Approved
 * leave is an INPUT to payroll (LOP) — raw attendance still lives in Timebox.
 */
import mongoose from 'mongoose';

export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'];
export const HALF_DAY = ['none', 'first', 'second'];

const leaveRequestSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Employee is required'],
    },
    employeeName: { type: String, default: '', trim: true },
    department: { type: String, default: '', trim: true },

    leaveTypeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeaveType',
      default: null,
    },
    leaveTypeName: { type: String, default: '', trim: true },

    fromDate: { type: Date, required: true },
    toDate: { type: Date, required: true },
    days: { type: Number, default: 1, min: 0 },
    halfDay: { type: String, enum: HALF_DAY, default: 'none' },

    reason: { type: String, default: '' },
    documentUrl: { type: String, default: '' },

    status: { type: String, enum: LEAVE_STATUSES, default: 'pending' },
    approvalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ApprovalRequest',
      default: null,
    },
    decidedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },

    // Set when a request (pending or approved) is cancelled.
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },

    // Derived from fromDate for month-wise filtering / payroll feeds.
    month: { type: Number, min: 1, max: 12 },
    year: { type: Number },

    // When a comp-off is spent on this request.
    compOffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CompOff',
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── External app webhook integration (Timebox / PHP Portal) ──────────────
    // The foreign request_id sent by the external app (e.g. 123).
    externalRequestId: {
      type: Number,
      default: null,
      index: true,
      sparse: true,
    },
    // The webhook callback URL to hit upon approval/rejection (e.g. leave_callback.php)
    callbackUrl: {
      type: String,
      default: '',
      trim: true,
    },
    // Origin tag (e.g. 'timebox', 'external_app', 'internal_ess')
    externalSource: {
      type: String,
      default: 'internal_ess',
      trim: true,
    },
    // External employee ID from the foreign system (e.g. 20)
    externalEmployeeId: {
      type: Number,
      default: null,
    },
    // Full raw payload received from the external app for auditing
    externalPayload: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    // Outbound webhook dispatch delivery tracking
    callbackStatus: {
      type: String,
      enum: ['none', 'pending', 'delivered', 'failed'],
      default: 'none',
    },
    callbackDeliveredAt: {
      type: Date,
      default: null,
    },
    callbackError: {
      type: String,
      default: '',
      trim: true,
    },
    callbackResponse: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  { timestamps: true }
);

leaveRequestSchema.index({ employeeId: 1, fromDate: -1 });
leaveRequestSchema.index({ status: 1, fromDate: -1 });
leaveRequestSchema.index({ year: 1, month: 1 });

export default mongoose.model('LeaveRequest', leaveRequestSchema);

