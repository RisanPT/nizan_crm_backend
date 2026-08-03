import mongoose from 'mongoose';

export const ADMIN_DEPARTMENTS = [
  'CRM',
  'Finance',
  'Accounts',
  'IT',
  'Sales',
  'Marketing',
  'HR',
  'Operations',
  'General',
];

export const ADMIN_EXPENSE_CATEGORIES = [
  'office_supplies',
  'rent_utilities',
  'travel_transport',
  'food_beverage',
  'hardware_equipment',
  'marketing_ads',
  'professional_services',
  'maintenance',
  'training',
  'other',
];

export const ADMIN_PAYMENT_METHODS = [
  'bank_transfer',
  'upi',
  'credit_card',
  'debit_card',
  'cash',
  'petty_cash',
  'other',
];

const adminExpenseSchema = mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Please provide an expense title'],
      trim: true,
    },
    department: {
      type: String,
      enum: ADMIN_DEPARTMENTS,
      default: 'General',
      required: true,
    },
    category: {
      type: String,
      enum: ADMIN_EXPENSE_CATEGORIES,
      default: 'other',
    },
    amount: {
      type: Number,
      required: [true, 'Please specify the amount'],
      min: [0, 'Amount cannot be negative'],
    },
    date: {
      type: Date,
      required: true,
      default: Date.now,
    },
    paymentMethod: {
      type: String,
      enum: ADMIN_PAYMENT_METHODS,
      default: 'bank_transfer',
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Employee',
      default: null,
    },
    paidByName: {
      type: String,
      default: '',
      trim: true,
    },
    receiptImage: {
      type: String,
      default: '',
    },
    invoiceNumber: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
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
  {
    timestamps: true,
  }
);

const AdminExpense = mongoose.model('AdminExpense', adminExpenseSchema);

export default AdminExpense;
