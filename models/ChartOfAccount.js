import mongoose from 'mongoose';

// A ledger account in the Chart of Accounts — the backbone of the double-entry
// books. Every JournalEntry line posts to one of these.
export const ACCOUNT_NATURES = ['asset', 'liability', 'equity', 'income', 'expense'];

// Assets & expenses carry a natural DEBIT balance; liabilities, equity & income
// carry a natural CREDIT balance. Used to compute closing balances / trial balance.
export const naturalSide = (nature) =>
  nature === 'asset' || nature === 'expense' ? 'dr' : 'cr';

// Account Type — the finer classification under each nature (Zoho-style list
// from Accounts' "Account Type Summary"). The type decides the nature and the
// cash / bank / party role, so the three can't drift apart.
export const ACCOUNT_TYPES = [
  { key: 'cash', label: 'Cash', nature: 'asset', prefix: 'CSH' },
  { key: 'bank', label: 'Bank', nature: 'asset', prefix: 'BNK' },
  { key: 'accounts_receivable', label: 'Accounts Receivable', nature: 'asset', prefix: 'ARC' },
  { key: 'other_current_asset', label: 'Other Current Asset', nature: 'asset', prefix: 'OCA' },
  { key: 'fixed_asset', label: 'Fixed Asset', nature: 'asset', prefix: 'FXA' },
  { key: 'stock', label: 'Stock', nature: 'asset', prefix: 'STK' },
  { key: 'accounts_payable', label: 'Accounts Payable', nature: 'liability', prefix: 'APY' },
  { key: 'other_current_liability', label: 'Other Current Liability', nature: 'liability', prefix: 'OCL' },
  { key: 'non_current_liability', label: 'Non Current Liability', nature: 'liability', prefix: 'NCL' },
  { key: 'other_liability', label: 'Other Liability', nature: 'liability', prefix: 'OLB' },
  { key: 'equity', label: 'Equity', nature: 'equity', prefix: 'EQT' },
  { key: 'direct_income', label: 'Direct Income', nature: 'income', prefix: 'DIN' },
  { key: 'indirect_income', label: 'Indirect Income (Other Income)', nature: 'income', prefix: 'IIN' },
  { key: 'direct_expense', label: 'Direct Expense', nature: 'expense', prefix: 'DEX' },
  { key: 'cost_of_goods_sold', label: 'Cost of Goods Sold', nature: 'expense', prefix: 'COG' },
  { key: 'indirect_expense', label: 'Indirect Expense (Other Expense)', nature: 'expense', prefix: 'IEX' },
];
export const ACCOUNT_TYPE_KEYS = ACCOUNT_TYPES.map((t) => t.key);
export const accountTypeOf = (key) => ACCOUNT_TYPES.find((t) => t.key === key) || null;

// Type for an account saved before Account Type existed (field empty). Read-time
// only — nothing is written back until someone edits the account.
const LEGACY_TYPE_BY_CODE = {
  1000: 'cash',
  1010: 'bank',
  1200: 'accounts_receivable',
  1300: 'other_current_asset',
  1400: 'other_current_asset',
  1500: 'fixed_asset',
  1510: 'fixed_asset',
  1590: 'fixed_asset',
  2000: 'accounts_payable',
  4000: 'direct_income',
  4010: 'direct_income',
  4020: 'direct_income',
  4090: 'indirect_income',
  'SRT-01': 'direct_income',
  'APO-01': 'direct_expense',
  'DRP-01': 'direct_expense',
  'ASC-01': 'direct_expense',
  'PRD-01': 'cost_of_goods_sold',
};

export const resolveAccountType = (a) => {
  if (a.accountType && accountTypeOf(a.accountType)) return a.accountType;
  const byCode = LEGACY_TYPE_BY_CODE[a.code];
  if (byCode) return byCode;
  const group = String(a.group || '');
  switch (a.nature) {
    case 'asset':
      if (a.isCash) return 'cash';
      if (a.isBank) return 'bank';
      if (a.isParty) return 'accounts_receivable';
      if (/fixed/i.test(group)) return 'fixed_asset';
      if (/stock|inventory/i.test(group)) return 'stock';
      return 'other_current_asset';
    case 'liability':
      if (a.isParty) return 'accounts_payable';
      if (/non[- ]?current|long[- ]?term/i.test(group)) return 'non_current_liability';
      return 'other_current_liability';
    case 'equity':
      return 'equity';
    case 'income':
      return /indirect|other/i.test(group) ? 'indirect_income' : 'direct_income';
    default:
      if (/cogs|cost of goods/i.test(group)) return 'cost_of_goods_sold';
      if (/direct/i.test(group) && !/indirect/i.test(group)) return 'direct_expense';
      return 'indirect_expense';
  }
};

const chartOfAccountSchema = mongoose.Schema(
  {
    // Stable ledger code, e.g. '1010' (Bank) or 'RNT-01' (Rent). Unique.
    code: { type: String, required: true, trim: true, unique: true },
    name: { type: String, required: true, trim: true },
    nature: { type: String, enum: ACCOUNT_NATURES, required: true },
    // '' on accounts created before this field — see resolveAccountType().
    accountType: { type: String, enum: [...ACCOUNT_TYPE_KEYS, ''], default: '' },
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

// Next free code for a type, e.g. BNK-01, BNK-02 … (used when an account is
// created without a code).
export const nextAccountCode = async (typeKey) => {
  const prefix = accountTypeOf(typeKey)?.prefix || 'ACC';
  const pattern = new RegExp('^' + prefix + '-\\d+$');
  const taken = await ChartOfAccount.find({ code: pattern }).select('code').lean();
  const max = taken.reduce((m, a) => Math.max(m, Number(a.code.split('-')[1]) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(2, '0')}`;
};

export default ChartOfAccount;
