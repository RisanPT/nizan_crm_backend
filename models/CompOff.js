/**
 * CompOff — a compensatory day-off earned for working on a week-off / holiday
 * (common for event days). Valid for a window, then expires; can be spent on a
 * LeaveRequest. Granted by HR / a manager.
 */
import mongoose from 'mongoose';

export const COMPOFF_STATUSES = ['available', 'used', 'expired'];

const compOffSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: true,
    },
    employeeName: { type: String, default: '', trim: true },
    workedOn: { type: Date, required: true },
    reason: { type: String, default: '' },
    grantedDays: { type: Number, default: 1, min: 0 },
    expiresOn: { type: Date },
    status: { type: String, enum: COMPOFF_STATUSES, default: 'available' },
    usedInLeaveId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LeaveRequest',
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

compOffSchema.index({ employeeId: 1, status: 1 });

export default mongoose.model('CompOff', compOffSchema);
