import mongoose from 'mongoose';

export const SALARY_STATUSES = ['draft', 'approved_by_hr', 'paid', 'cancelled'];
export const SALARY_TYPES = ['fixed_monthly', 'per_booking', 'daily', 'hybrid', 'commission'];
export const SALARY_PAYMENT_METHODS = ['bank_transfer', 'upi', 'cash', 'cheque', 'other'];

const salarySchema = mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      required: [true, 'Please specify employee'],
    },
    employeeName: {
      type: String,
      required: true,
      trim: true,
    },
    employeeCategory: {
      type: String,
      enum: ['administrative', 'operations'],
      default: 'administrative',
    },
    department: {
      type: String,
      default: 'General',
    },
    role: {
      type: String,
      default: 'Staff',
    },
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: true,
      min: 2020,
    },
    salaryType: {
      type: String,
      enum: SALARY_TYPES,
      default: 'fixed_monthly',
    },
    baseSalary: {
      type: Number,
      default: 0,
      min: 0,
    },
    allowances: {
      type: Number,
      default: 0,
      min: 0,
    },
    bonus: {
      type: Number,
      default: 0,
      min: 0,
    },
    deductions: {
      type: Number,
      default: 0,
      min: 0,
    },
    netAmount: {
      type: Number,
      required: true,
      default: 0,
    },
    status: {
      type: String,
      enum: SALARY_STATUSES,
      default: 'approved_by_hr',
    },
    paymentDate: {
      type: Date,
      default: null,
    },
    paymentMethod: {
      type: String,
      enum: SALARY_PAYMENT_METHODS,
      default: 'bank_transfer',
    },
    transactionRef: {
      type: String,
      default: '',
      trim: true,
    },
    bankDetails: {
      bankName: { type: String, default: '' },
      accountNumber: { type: String, default: '' },
      ifscCode: { type: String, default: '' },
      upiId: { type: String, default: '' },
    },
    notes: {
      type: String,
      default: '',
      trim: true,
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    approvedAt: {
      type: Date,
      default: null,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    paidAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Prevent duplicate salary slip for same employee, month, year
salarySchema.index({ employeeId: 1, month: 1, year: 1 }, { unique: true });
salarySchema.index({ employeeCategory: 1, month: 1, year: 1 });
salarySchema.index({ status: 1 });

const Salary = mongoose.model('Salary', salarySchema);

export default Salary;
