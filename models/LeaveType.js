/**
 * LeaveType — a configurable category of leave (Casual, Sick, Earned, Unpaid…).
 * Defines the annual quota, whether it is paid, carry-forward rules and the
 * document requirement. Balances are computed on the fly from approved
 * LeaveRequests against each type's quota (see leaveController.computeBalances).
 */
import mongoose from 'mongoose';

const leaveTypeSchema = mongoose.Schema(
  {
    name: { type: String, required: [true, 'Leave type name is required'], trim: true },
    code: { type: String, default: '', trim: true, uppercase: true },
    annualQuota: { type: Number, default: 0, min: 0 }, // 0 = unlimited/unpaid
    paid: { type: Boolean, default: true },
    carryForward: { type: Boolean, default: false },
    carryForwardMax: { type: Number, default: 0, min: 0 },
    docRequired: { type: String, default: 'Not required', trim: true },
    color: { type: String, default: '#601A29' },
    order: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export default mongoose.model('LeaveType', leaveTypeSchema);
