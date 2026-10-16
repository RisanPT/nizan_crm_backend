import mongoose from 'mongoose';

export const CLAIM_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'paid'];
export const CLAIM_CATEGORIES = ['travel', 'food', 'supplies', 'medical', 'communication', 'other'];

// An employee-facing reimbursement claim. Submitted → routed through the
// approval engine; once approved, HR marks it paid, which posts a payment
// voucher to the ledger (via services/posting.js, best-effort).
const expenseClaimSchema = new mongoose.Schema(
  {
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    employeeName: { type: String, default: '' },
    department: { type: String, default: '' },
    category: { type: String, enum: CLAIM_CATEGORIES, default: 'other' },
    title: { type: String, required: true, trim: true },
    amount: { type: Number, default: 0 },
    date: { type: Date, default: Date.now }, // when the expense was incurred
    description: { type: String, default: '' },
    receiptUrl: { type: String, default: '' },
    status: { type: String, enum: CLAIM_STATUSES, default: 'pending' },
    approvalId: { type: mongoose.Schema.Types.ObjectId, ref: 'ApprovalRequest', default: null },
    paymentMethod: { type: String, default: 'bank' }, // cash | bank
    paidAt: { type: Date, default: null },
    decidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: '' },
    month: { type: Number, default: 0 },
    year: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

expenseClaimSchema.index({ employeeId: 1, date: -1 });

const ExpenseClaim = mongoose.model('ExpenseClaim', expenseClaimSchema);
export default ExpenseClaim;
