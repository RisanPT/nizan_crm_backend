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
  'staff_mess',
  'hardware_equipment',
  'marketing_ads',
  'professional_services',
  'maintenance',
  'training',
  'staff_welfare',
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

// Controlled chart of administrative expense heads (ledgers) per the Accounts
// "Expense Heads" request. `jobLinked` heads require a bride/event cost tag;
// `recurring` heads can be flagged as monthly recurring bills; `foreign` heads
// (subscriptions) commonly need GST reverse-charge (RCM).
export const EXPENSE_HEADS = [
  { code: 'FUE-01', label: 'Fuel Expense', group: 'Operating Expense' },
  { code: 'FOO-01', label: 'Food Expense', group: 'Operating Expense' },
  { code: 'TRP-01', label: 'Transportation Expenses', group: 'Operating Expense' },
  { code: 'TRV-01', label: 'Travel Expenses', group: 'Operating Expense' },
  { code: 'MES-01', label: 'Staff Mess Expenses', group: 'Employee Benefit' },
  { code: 'TEL-01', label: 'Telephone & Internet', group: 'Operating Expense', recurring: true },
  { code: 'ELE-01', label: 'Electricity Charges', group: 'Utilities', recurring: true },
  { code: 'SUB-01', label: 'Subscription Charge', group: 'Software / IT', foreign: true },
  { code: 'PRN-01', label: 'Printing & Stationery', group: 'Operating Expense' },
  { code: 'TRN-01', label: 'Training & Recruitment', group: 'Employee / Operating' },
  { code: 'WEL-01', label: 'Staff Welfare', group: 'Employee Benefit' },
  { code: 'PRD-01', label: 'Product Purchase', group: 'COGS / Direct Purchase', jobLinked: true },
  { code: 'SRT-01', label: 'Sales Return – Credit Note', group: 'Contra-Revenue', jobLinked: true },
  { code: 'OFF-01', label: 'Office Expense', group: 'Operating Expense' },
  { code: 'RNT-01', label: 'Rent – Office', group: 'Rent', recurring: true },
  { code: 'RNT-02', label: 'Additional Rent', group: 'Rent', recurring: true },
  { code: 'DRP-01', label: 'Drapist Expenses', group: 'Direct / Job Expense', jobLinked: true },
  { code: 'ASC-01', label: 'Associate Expenses', group: 'Direct / Job Expense', jobLinked: true },
  { code: 'SAL-01', label: 'Salary & Allowance', group: 'Payroll' },
  { code: 'REP-01', label: 'Repairs & Maintenance', group: 'Operating Expense' },
];

export const EXPENSE_HEAD_CODES = EXPENSE_HEADS.map((h) => h.code);
export const GST_TYPES = ['none', 'gst', 'rcm'];

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
    // Controlled expense head (ledger) code from EXPENSE_HEADS — the doc's
    // "no free-text heads" requirement. Optional for legacy rows.
    expenseHead: {
      type: String,
      enum: [...EXPENSE_HEAD_CODES, ''],
      default: '',
    },
    // Vendor / payee the money was paid to.
    vendor: {
      type: String,
      default: '',
      trim: true,
    },
    // Bride / event cost tag (cost centre) — mandatory for job-linked heads
    // (Drapist, Associate, Product Purchase, Sales Return).
    costTag: {
      type: String,
      default: '',
      trim: true,
    },
    // Monthly recurring bill (Electricity, Telephone/Internet, Rent).
    isRecurring: {
      type: Boolean,
      default: false,
    },
    // Tax treatment — 'rcm' for GST reverse-charge on foreign subscriptions.
    gstType: {
      type: String,
      enum: GST_TYPES,
      default: 'none',
    },
    gstAmount: {
      type: Number,
      default: 0,
      min: 0,
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
    // Provenance — set when this expense mirrors another record (e.g. an HRA
    // payment) so the two stay in sync and aren't double-entered.
    source: {
      type: String,
      default: 'manual', // manual | hra
    },
    sourceHraId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'HraRecord',
      default: null,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const AdminExpense = mongoose.model('AdminExpense', adminExpenseSchema);

export default AdminExpense;
