import mongoose from 'mongoose';
import { moneyAccountFields } from '../utils/moneyAccount.js';

// A money movement keyed in directly by Accounts (Zoho-Books style):
//   in       — money received into a bank / cash account (Cr `account`)
//   out      — money paid out of a bank / cash account   (Dr `account`)
//   transfer — bank ↔ cash ↔ bank (contra), no income / expense side
// Posted to the ledger as soon as it is saved — see services/posting.js
// (CashTransaction builder).
export const CASH_TXN_TYPES = ['in', 'out', 'transfer'];

const cashTransactionSchema = mongoose.Schema(
  {
    type: { type: String, enum: CASH_TXN_TYPES, required: true },
    date: { type: Date, required: true },
    department: { type: String, default: '', trim: true },
    // The other side of the entry (Account Type → Account Name on the form):
    // an income / expense / asset / liability / equity ledger. Not used for
    // transfers.
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Base amount; for `out` with GST, the voucher pays amount + gstAmount.
    amount: { type: Number, required: true, min: 0 },
    gstType: { type: String, enum: ['none', 'gst', 'rcm'], default: 'none' },
    gstAmount: { type: Number, default: 0, min: 0 },
    paymentMode: { type: String, default: '', trim: true },
    // Paid through / deposited to (and the "from" side of a transfer).
    ...moneyAccountFields,
    // Transfer destination.
    toMoneyAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    toLedgerAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Vendor / customer / payee name.
    party: { type: String, default: '', trim: true },
    // Bill / invoice number.
    reference: { type: String, default: '', trim: true },
    notes: { type: String, default: '', trim: true },
    attachmentUrl: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    createdByName: { type: String, default: '' },
  },
  { timestamps: true }
);

cashTransactionSchema.index({ date: -1 });

const CashTransaction = mongoose.model('CashTransaction', cashTransactionSchema);

export default CashTransaction;
