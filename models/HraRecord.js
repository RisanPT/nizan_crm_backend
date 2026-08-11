/**
 * HraRecord — House Rent Allowance paid separately from the salary run.
 *
 * The Accounts team records HRA per employee with an amount + date; it is NOT
 * bundled into the monthly salary slip. Each record is one HRA payment.
 */
import mongoose from 'mongoose';

export const HRA_PAYMENT_METHODS = ['bank_transfer', 'upi', 'cash', 'cheque', 'other'];
export const HRA_STATUSES = ['pending', 'paid'];

const hraRecordSchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Please select an employee'],
    },
    employeeName: {
      type: String,
      required: true,
      trim: true,
    },
    department: {
      type: String,
      default: 'General',
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, 'Please specify the HRA amount'],
      min: [0, 'Amount cannot be negative'],
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    // Derived from date for month-wise filtering.
    month: { type: Number, min: 1, max: 12 },
    year: { type: Number },

    paymentMethod: {
      type: String,
      enum: HRA_PAYMENT_METHODS,
      default: 'bank_transfer',
    },
    status: {
      type: String,
      enum: HRA_STATUSES,
      default: 'pending',
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true },
);

hraRecordSchema.index({ employeeId: 1, date: -1 });

const HraRecord = mongoose.model('HraRecord', hraRecordSchema);

export default HraRecord;
