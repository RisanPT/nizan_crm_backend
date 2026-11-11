import mongoose from 'mongoose';

// A finalised payroll month. While a lock exists, salary slips for that
// month can't be generated, created, edited, approved or deleted — only paid.
// Unlocking is admin-only and is recorded (unlockedBy/unlockedAt) rather than
// deleting the row, so there is a trail of who reopened a month.
const payrollLockSchema = new mongoose.Schema(
  {
    month: { type: Number, required: true, min: 1, max: 12 },
    year: { type: Number, required: true },
    locked: { type: Boolean, default: true },
    lockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    lockedAt: { type: Date, default: null },
    unlockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    unlockedAt: { type: Date, default: null },
    note: { type: String, default: '' },
  },
  { timestamps: true }
);

payrollLockSchema.index({ month: 1, year: 1 }, { unique: true });

export const isPayrollLocked = async (month, year) =>
  Boolean(await PayrollLock.exists({ month: Number(month), year: Number(year), locked: true }));

const PayrollLock = mongoose.model('PayrollLock', payrollLockSchema);
export default PayrollLock;
