import mongoose from 'mongoose';

// A ledger account in the Chart of Accounts — the backbone of the double-entry
// books. Every JournalEntry line posts to one of these.
export const ACCOUNT_NATURES = ['asset', 'liability', 'equity', 'income', 'expense'];

// Assets & expenses carry a natural DEBIT balance; liabilities, equity & income
// carry a natural CREDIT balance. Used to compute closing balances / trial balance.
export const naturalSide = (nature) =>
  nature === 'asset' || nature === 'expense' ? 'dr' : 'cr';

const chartOfAccountSchema = mongoose.Schema(
  {
    // Stable ledger code, e.g. '1010' (Bank) or 'RNT-01' (Rent). Unique.
    code: { type: String, required: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    nature: { type: String, enum: ACCOUNT_NATURES, required: true },
    // Presentation group / sub-head, e.g. 'Current Assets', 'Operating Expense'.
    group: { type: String, default: '', trim: true },
    // Roll-up parent (self-ref) for grouped statements.
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ChartOfAccount',
      default: null,
    },
    isBank: { type: Boolean, default: false },
    isCash: { type: Boolean, default: false },
    // Control account for parties (Accounts Receivable / Payable).
    isParty: { type: Boolean, default: false },
    gstApplicable: { type: Boolean, default: false },
    gstRate: { type: Number, default: 0, min: 0, max: 100 },
    // Opening balance carried in at go-live / FY start.
    openingBalance: { type: Number, default: 0 },
    openingType: { type: String, enum: ['dr', 'cr'], default: 'dr' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    // Seeded system accounts can't be deleted (only archived).
    isSystem: { type: Boolean, default: false },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true }
);

const ChartOfAccount = mongoose.model('ChartOfAccount', chartOfAccountSchema);

export default ChartOfAccount;
