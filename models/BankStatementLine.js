import mongoose from 'mongoose';

// One line imported from a bank (or cash) statement, to be reconciled against
// the ledger for the same account.
//
// `amount` is SIGNED from the account holder's point of view, matching the
// ledger convention for a bank asset (debit − credit):
//   +ve  = money IN  (a deposit / "credit" on the bank statement)
//   -ve  = money OUT (a withdrawal / "debit" on the bank statement)
// so a statement line matches a ledger movement when their signed amounts are
// equal.
const bankStatementLineSchema = mongoose.Schema(
  {
    bankAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccount',
      required: true,
      index: true,
    },
    txnDate: { type: Date, required: true },
    description: { type: String, default: '', trim: true },
    refNo: { type: String, default: '', trim: true },
    amount: { type: Number, required: true },
    // Statement running balance after this line, when the file provides it.
    runningBalance: { type: Number, default: null },
    // Label of the import that brought this line in (e.g. the file name).
    importBatch: { type: String, default: '' },
    // Deterministic per physical statement line, so re-importing the same file
    // is idempotent. Built as date|amount|description|occurrence.
    dedupeKey: { type: String, required: true },
    status: {
      type: String,
      enum: ['unmatched', 'matched'],
      default: 'unmatched',
    },
    // The ledger voucher this line is reconciled against.
    matchedEntry: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'JournalEntry',
      default: null,
    },
    matchedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

// One physical statement line imports once per account.
bankStatementLineSchema.index({ bankAccount: 1, dedupeKey: 1 }, { unique: true });

const BankStatementLine = mongoose.model('BankStatementLine', bankStatementLineSchema);

export default BankStatementLine;
