import mongoose from 'mongoose';
import ChartOfAccount, { naturalSide } from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import { EXPENSE_HEADS } from '../models/AdminExpense.js';
import Collection from '../models/Collection.js';
import AdminExpense from '../models/AdminExpense.js';
import FuelExpense from '../models/FuelExpense.js';
import Salary from '../models/Salary.js';
import HraRecord from '../models/HraRecord.js';
import SalesReturn from '../models/SalesReturn.js';
import Booking from '../models/Booking.js';
import Purchase from '../models/Purchase.js';
import GstSetting from '../models/GstSetting.js';
import AccountingSetting from '../models/AccountingSetting.js';
import {
  buildSpecFor,
  POSTABLE_MODELS,
  ensureGstConfig,
  setGstConfig,
  ensureLockDate,
  setLockDate,
  isLocked,
} from '../services/posting.js';

const SOURCE_MODELS = { Collection, AdminExpense, FuelExpense, Salary, HraRecord, SalesReturn, Booking };

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManageFinance = (user) => FINANCE_ROLES.includes(user?.role);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Indian financial year label for a date, e.g. 2026-07-xx → '2026-27'.
const fyLabelFor = (date) => {
  const d = new Date(date);
  const y = d.getFullYear();
  const startYear = d.getMonth() >= 3 ? y : y - 1; // FY starts April (month index 3)
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
};

const VOUCHER_PREFIX = {
  journal: 'JV',
  sales: 'SAL',
  purchase: 'PUR',
  receipt: 'RCP',
  payment: 'PAY',
  contra: 'CTR',
  credit_note: 'CRN',
  debit_note: 'DRN',
};

const nextVoucherNo = async (voucherType, fyLabel) => {
  const count = await JournalEntry.countDocuments({ voucherType, fyLabel });
  const prefix = VOUCHER_PREFIX[voucherType] || 'JV';
  return `${prefix}/${fyLabel}/${String(count + 1).padStart(4, '0')}`;
};

// ── Default Chart of Accounts ────────────────────────────────────────────────
// Core system accounts + the existing AdminExpense heads folded in as expense
// ledgers (so the ledger stays continuous with what Accounts already uses).
const CORE_ACCOUNTS = [
  // Assets
  { code: '1000', name: 'Cash in Hand', nature: 'asset', group: 'Current Assets', isCash: true },
  { code: '1010', name: 'Bank Account', nature: 'asset', group: 'Current Assets', isBank: true },
  { code: '1200', name: 'Accounts Receivable', nature: 'asset', group: 'Current Assets', isParty: true },
  { code: '1300', name: 'GST Input Credit (ITC)', nature: 'asset', group: 'Duties & Taxes' },
  { code: '1400', name: 'Prepaid Expenses', nature: 'asset', group: 'Current Assets' },
  { code: '1500', name: 'Fixed Assets', nature: 'asset', group: 'Fixed Assets' },
  { code: '1510', name: 'Digital Assets', nature: 'asset', group: 'Fixed Assets' },
  { code: '1590', name: 'Accumulated Depreciation', nature: 'asset', group: 'Fixed Assets' },
  // Liabilities
  { code: '2000', name: 'Accounts Payable', nature: 'liability', group: 'Current Liabilities', isParty: true },
  { code: '2100', name: 'Output CGST', nature: 'liability', group: 'Duties & Taxes' },
  { code: '2110', name: 'Output SGST', nature: 'liability', group: 'Duties & Taxes' },
  { code: '2120', name: 'Output IGST', nature: 'liability', group: 'Duties & Taxes' },
  { code: '2200', name: 'TDS Payable', nature: 'liability', group: 'Duties & Taxes' },
  { code: '2300', name: 'Salary Payable', nature: 'liability', group: 'Current Liabilities' },
  // Equity
  { code: '3000', name: "Owner's Capital", nature: 'equity', group: 'Capital' },
  { code: '3100', name: 'Retained Earnings', nature: 'equity', group: 'Reserves' },
  { code: '3200', name: 'Drawings', nature: 'equity', group: 'Capital' },
  // Income
  { code: '4000', name: 'Bridal Revenue', nature: 'income', group: 'Direct Income', gstApplicable: true },
  { code: '4010', name: 'Party / Event Revenue', nature: 'income', group: 'Direct Income', gstApplicable: true },
  { code: '4020', name: 'Add-on Revenue', nature: 'income', group: 'Direct Income', gstApplicable: true },
  { code: '4090', name: 'Other Income', nature: 'income', group: 'Indirect Income' },
  // Expenses (core, beyond the AdminExpense heads)
  { code: '5010', name: 'House Rent Allowance', nature: 'expense', group: 'Payroll' },
  { code: '5020', name: 'Salary Incentives', nature: 'expense', group: 'Payroll' },
  { code: '5030', name: 'Room Rent Allowance', nature: 'expense', group: 'Payroll' },
  { code: '5900', name: 'Depreciation', nature: 'expense', group: 'Non-cash' },
];

// @desc    Seed the default Chart of Accounts (idempotent — only inserts gaps)
// @route   POST /api/accounting/accounts/seed
const seedAccounts = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const heads = EXPENSE_HEADS.map((h) => ({
      code: h.code,
      name: h.label,
      nature: h.nature || 'expense', // SRT-01 is contra-revenue (income)
      group: h.group || 'Operating Expense',
    }));
    const seed = [...CORE_ACCOUNTS, ...heads];
    const existing = new Set(
      (await ChartOfAccount.find({}).select('code').lean()).map((a) => a.code)
    );
    const toInsert = seed
      .filter((a) => !existing.has(a.code))
      .map((a) => ({ ...a, isSystem: true }));
    if (toInsert.length) await ChartOfAccount.insertMany(toInsert);
    res.json({ inserted: toInsert.length, total: existing.size + toInsert.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    List chart of accounts (optional nature filter)
// @route   GET /api/accounting/accounts
const getAccounts = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const q = {};
    if (req.query.nature && req.query.nature !== 'all') q.nature = req.query.nature;
    if (req.query.status && req.query.status !== 'all') q.status = req.query.status;
    const accounts = await ChartOfAccount.find(q).sort({ code: 1 });
    res.json(accounts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const cleanAccount = (b) => ({
  name: String(b.name ?? '').trim(),
  nature: b.nature,
  group: String(b.group ?? '').trim(),
  isBank: !!b.isBank,
  isCash: !!b.isCash,
  isParty: !!b.isParty,
  gstApplicable: !!b.gstApplicable,
  gstRate: Math.max(0, Number(b.gstRate) || 0),
  openingBalance: Math.max(0, Number(b.openingBalance) || 0),
  openingType: b.openingType === 'cr' ? 'cr' : 'dr',
  status: b.status === 'archived' ? 'archived' : 'active',
});

const createAccount = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const code = String(req.body.code ?? '').trim();
    const data = cleanAccount(req.body);
    if (!code || !data.name || !data.nature) {
      return res.status(400).json({ message: 'Code, name and nature are required' });
    }
    const exists = await ChartOfAccount.findOne({ code });
    if (exists) return res.status(400).json({ message: `Account code ${code} already exists` });
    const account = await ChartOfAccount.create({ ...data, code, createdBy: req.user?._id || null });
    res.status(201).json(account);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const updateAccount = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const account = await ChartOfAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found' });
    Object.assign(account, cleanAccount({ ...account.toObject(), ...req.body }));
    await account.save();
    res.json(account);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const deleteAccount = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const account = await ChartOfAccount.findById(req.params.id);
    if (!account) return res.status(404).json({ message: 'Account not found' });
    if (account.isSystem) {
      return res.status(400).json({ message: 'System accounts cannot be deleted — archive it instead.' });
    }
    const used = await JournalEntry.countDocuments({ 'lines.account': account._id, status: { $ne: 'void' } });
    if (used > 0) {
      return res.status(400).json({ message: `Account has ${used} postings — archive it instead of deleting.` });
    }
    await account.deleteOne();
    res.json({ message: 'Account removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Journal entries ──────────────────────────────────────────────────────────

const getJournalEntries = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const q = {};
    if (req.query.type && req.query.type !== 'all') q.voucherType = req.query.type;
    if (req.query.status && req.query.status !== 'all') q.status = req.query.status;
    if (req.query.from || req.query.to) {
      q.date = {};
      if (req.query.from) q.date.$gte = new Date(req.query.from);
      if (req.query.to) q.date.$lte = new Date(req.query.to);
    }
    const entries = await JournalEntry.find(q)
      .populate('lines.account', 'code name nature')
      .populate('createdBy', 'name')
      .sort({ date: -1, createdAt: -1 })
      .limit(500);
    res.json(entries);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const createJournalEntry = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const date = req.body.date ? new Date(req.body.date) : new Date();
    await ensureLockDate();
    if (isLocked(date)) {
      return res.status(400).json({ message: 'That date is in a closed period. Reopen it to post here.' });
    }
    const voucherType = req.body.voucherType || 'journal';
    const lines = (Array.isArray(req.body.lines) ? req.body.lines : [])
      .map((l) => ({
        account: mongoose.Types.ObjectId.isValid(l.account) ? l.account : null,
        debit: round2(l.debit),
        credit: round2(l.credit),
        narration: String(l.narration ?? '').trim(),
      }))
      .filter((l) => l.account && (l.debit > 0 || l.credit > 0));

    const fyLabel = fyLabelFor(date);
    const voucherNo = req.body.voucherNo?.trim() || (await nextVoucherNo(voucherType, fyLabel));

    const entry = await JournalEntry.create({
      date,
      voucherType,
      voucherNo,
      narration: String(req.body.narration ?? '').trim(),
      lines,
      fyLabel,
      status: 'posted',
      postedAt: new Date(),
      createdBy: req.user?._id || null,
    });
    const populated = await JournalEntry.findById(entry._id).populate('lines.account', 'code name nature');
    res.status(201).json(populated);
  } catch (error) {
    // Balanced-invariant failures surface as 400s with a clear message.
    res.status(400).json({ message: error.message });
  }
};

// Posted entries are immutable — "delete" voids (keeps the audit trail).
const voidJournalEntry = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const entry = await JournalEntry.findById(req.params.id);
    if (!entry) return res.status(404).json({ message: 'Entry not found' });
    await ensureLockDate();
    if (isLocked(entry.date)) {
      return res.status(400).json({ message: 'This voucher is in a closed period and cannot be voided.' });
    }
    entry.status = 'void';
    await entry.save();
    res.json({ message: 'Entry voided', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Trial Balance ────────────────────────────────────────────────────────────
// Opening balance + period movement per account, netted to a closing Dr/Cr.
// The grand totals of the debit and credit columns must be equal.
const getTrialBalance = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const match = { status: 'posted' };
    if (req.query.from || req.query.to) {
      match.date = {};
      if (req.query.from) match.date.$gte = new Date(req.query.from);
      if (req.query.to) match.date.$lte = new Date(req.query.to);
    }

    const accounts = await ChartOfAccount.find({}).sort({ code: 1 }).lean();
    const movements = await JournalEntry.aggregate([
      { $match: match },
      { $unwind: '$lines' },
      {
        $group: {
          _id: '$lines.account',
          debit: { $sum: '$lines.debit' },
          credit: { $sum: '$lines.credit' },
        },
      },
    ]);
    const moveMap = new Map(movements.map((m) => [String(m._id), m]));

    let totalDr = 0;
    let totalCr = 0;
    const rows = accounts.map((a) => {
      const mv = moveMap.get(String(a._id)) || { debit: 0, credit: 0 };
      const openDr = a.openingType === 'dr' ? a.openingBalance || 0 : 0;
      const openCr = a.openingType === 'cr' ? a.openingBalance || 0 : 0;
      const net = round2(openDr + mv.debit - openCr - mv.credit); // +ve = debit balance
      const closingDr = net > 0 ? net : 0;
      const closingCr = net < 0 ? -net : 0;
      totalDr += closingDr;
      totalCr += closingCr;
      return {
        accountId: a._id,
        code: a.code,
        name: a.name,
        nature: a.nature,
        group: a.group,
        naturalSide: naturalSide(a.nature),
        periodDebit: round2(mv.debit),
        periodCredit: round2(mv.credit),
        closingDebit: closingDr,
        closingCredit: closingCr,
      };
    });

    res.json({
      rows: rows.filter((r) => r.closingDebit !== 0 || r.closingCredit !== 0 || r.periodDebit !== 0 || r.periodCredit !== 0),
      totalDebit: round2(totalDr),
      totalCredit: round2(totalCr),
      balanced: round2(totalDr) === round2(totalCr),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Per-account posted movements, optionally bounded by a date window.
const accountMovements = async ({ from, to } = {}) => {
  const match = { status: 'posted' };
  if (from || to) {
    match.date = {};
    if (from) match.date.$gte = new Date(from);
    if (to) match.date.$lte = new Date(to);
  }
  const rows = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
};

// @desc    Profit & Loss for a period (income − expense). Nominal accounts, so
//          no opening balances — pure period movement.
// @route   GET /api/accounting/profit-loss
const getProfitAndLoss = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const { from, to } = req.query;
    const [accounts, mv] = await Promise.all([
      ChartOfAccount.find({ nature: { $in: ['income', 'expense'] } }).sort({ code: 1 }).lean(),
      accountMovements({ from, to }),
    ]);
    const income = [];
    const expense = [];
    let totalIncome = 0;
    let totalExpense = 0;
    for (const a of accounts) {
      const m = mv.get(String(a._id)) || { debit: 0, credit: 0 };
      if (a.nature === 'income') {
        const amt = round2(m.credit - m.debit);
        if (amt !== 0) { income.push({ accountId: a._id, code: a.code, name: a.name, group: a.group, amount: amt }); totalIncome += amt; }
      } else {
        const amt = round2(m.debit - m.credit);
        if (amt !== 0) { expense.push({ accountId: a._id, code: a.code, name: a.name, group: a.group, amount: amt }); totalExpense += amt; }
      }
    }
    res.json({
      from: from || null,
      to: to || null,
      income,
      expense,
      totalIncome: round2(totalIncome),
      totalExpense: round2(totalExpense),
      netProfit: round2(totalIncome - totalExpense),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Balance Sheet as of a date. Assets = Liabilities + Equity + retained
//          earnings (cumulative income − expense).
// @route   GET /api/accounting/balance-sheet
const getBalanceSheet = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const asOf = req.query.to || null;
    const [accounts, mv] = await Promise.all([
      ChartOfAccount.find({}).sort({ code: 1 }).lean(),
      accountMovements({ to: asOf }),
    ]);

    const assets = [];
    const liabilities = [];
    const equity = [];
    let totalAssets = 0;
    let totalLiabilities = 0;
    let totalEquity = 0;
    let retained = 0; // cumulative income − expense → earnings

    for (const a of accounts) {
      const m = mv.get(String(a._id)) || { debit: 0, credit: 0 };
      const openDr = a.openingType === 'dr' ? a.openingBalance || 0 : 0;
      const openCr = a.openingType === 'cr' ? a.openingBalance || 0 : 0;
      const drTotal = openDr + m.debit;
      const crTotal = openCr + m.credit;

      if (a.nature === 'asset') {
        const bal = round2(drTotal - crTotal);
        if (bal !== 0) { assets.push({ accountId: a._id, code: a.code, name: a.name, group: a.group, amount: bal }); totalAssets += bal; }
      } else if (a.nature === 'liability') {
        const bal = round2(crTotal - drTotal);
        if (bal !== 0) { liabilities.push({ accountId: a._id, code: a.code, name: a.name, group: a.group, amount: bal }); totalLiabilities += bal; }
      } else if (a.nature === 'equity') {
        const bal = round2(crTotal - drTotal);
        if (bal !== 0) { equity.push({ accountId: a._id, code: a.code, name: a.name, group: a.group, amount: bal }); totalEquity += bal; }
      } else if (a.nature === 'income') {
        retained += m.credit - m.debit;
      } else if (a.nature === 'expense') {
        retained -= m.debit - m.credit;
      }
    }

    retained = round2(retained);
    const equityPlusEarnings = round2(totalEquity + retained);
    res.json({
      asOf,
      assets,
      liabilities,
      equity,
      retainedEarnings: retained,
      totalAssets: round2(totalAssets),
      totalLiabilities: round2(totalLiabilities),
      totalEquity: equityPlusEarnings,
      liabilitiesAndEquity: round2(totalLiabilities + equityPlusEarnings),
      balanced: round2(totalAssets) === round2(totalLiabilities + equityPlusEarnings),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Age a number of days into a bucket key.
// Bucket by days OVERDUE (measured from the due date to the as-of date).
// Negative days → the due date is still in the future = not yet due.
const ageBucket = (days) =>
  days < 0 ? 'notYetDue'
  : days <= 30 ? 'current'
  : days <= 60 ? 'days30'
  : days <= 90 ? 'days60'
  : 'days90';

const emptyTotals = () => ({ notYetDue: 0, current: 0, days30: 0, days60: 0, days90: 0, outstanding: 0 });

// Whole days from a due date to the as-of date (negative = not yet due).
const daysTo = (due, asOf) =>
  Math.floor((asOf.getTime() - new Date(due).getTime()) / 86400000);

// Roll a set of {name, phone, amount, days} obligations into an aging report.
// `days` is days overdue vs the as-of date; negative means upcoming (not due).
const buildAging = (items, asOf) => {
  const parties = new Map();
  const totals = emptyTotals();
  for (const it of items) {
    if (it.amount <= 0.5) continue; // ignore rounding dust
    const bucket = ageBucket(it.days);
    totals[bucket] += it.amount;
    totals.outstanding += it.amount;
    const key = `${it.name}|${it.phone || ''}`;
    if (!parties.has(key)) {
      parties.set(key, {
        name: it.name, phone: it.phone || '',
        outstanding: 0, notYetDue: 0, current: 0, days30: 0, days60: 0, days90: 0, oldestDays: 0, count: 0,
      });
    }
    const p = parties.get(key);
    p.outstanding += it.amount;
    p[bucket] += it.amount;
    if (it.days > p.oldestDays) p.oldestDays = it.days; // oldest days overdue (0 if none overdue)
    p.count += 1;
  }
  const overdueOf = (o) => o.current + o.days30 + o.days60 + o.days90;
  const finishParty = (p) => {
    p.overdue = round2(overdueOf(p));
    for (const k of ['outstanding', 'notYetDue', 'current', 'days30', 'days60', 'days90']) p[k] = round2(p[k]);
    return p;
  };
  return {
    asOf,
    totalOutstanding: round2(totals.outstanding),
    totalOverdue: round2(overdueOf(totals)),
    totalNotYetDue: round2(totals.notYetDue),
    buckets: {
      current: round2(totals.current),
      days30: round2(totals.days30),
      days60: round2(totals.days60),
      days90: round2(totals.days90),
    },
    // Overdue parties first (that's the point of the report), then by amount.
    parties: [...parties.values()].map(finishParty).sort((a, b) => (b.overdue - a.overdue) || (b.outstanding - a.outstanding)),
  };
};

// @desc    Receivables aging — who owes us, from bookings' unpaid balance.
// @route   GET /api/accounting/receivables
const getReceivables = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
    const bookings = await Booking.find({})
      .select('customerName phone totalPrice collectedAmount bookingDate serviceStart createdAt status')
      .limit(20000)
      .lean();
    const items = [];
    for (const b of bookings) {
      const st = String(b.status || '').toLowerCase();
      if (['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'].includes(st)) continue;
      const amount = round2((b.totalPrice || 0) - (b.collectedAmount || 0));
      if (amount <= 0.5) continue;
      // The balance is due by the event (serviceStart); overdue once it passes.
      const due = b.serviceStart || b.bookingDate || b.createdAt;
      items.push({ name: b.customerName || 'Unknown', phone: b.phone || '', amount, days: daysTo(due, asOf) });
    }
    res.json(buildAging(items, asOf));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Payables aging — whom we owe, from unpaid vendor purchase bills.
// @route   GET /api/accounting/payables
const getPayables = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const asOf = req.query.asOf ? new Date(req.query.asOf) : new Date();
    const purchases = await Purchase.find({ paid: { $ne: true } })
      .populate('vendor', 'name')
      .select('supplier vendor total gstAmount amountPaid paid date dueDate')
      .limit(20000)
      .lean();
    const items = [];
    for (const p of purchases) {
      const grand = round2((p.total || 0) + (p.gstAmount || 0));
      const amount = round2(grand - (p.amountPaid || 0));
      if (amount <= 0.5) continue;
      const name = (p.vendor && p.vendor.name) || p.supplier || 'Unknown vendor';
      items.push({ name, phone: '', amount, days: daysTo(p.dueDate || p.date, asOf) });
    }
    res.json(buildAging(items, asOf));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Statement of account for one party — every booking (receivable) or
//          purchase bill (payable) with a running outstanding balance.
// @route   GET /api/accounting/party-statement?kind&name&phone
const getPartyStatement = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const { name, phone } = req.query;
    const kind = req.query.kind === 'payables' ? 'payables' : 'receivables';
    if (!name) return res.status(400).json({ message: 'Party name is required' });

    const rows = [];
    let invoiced = 0;
    let received = 0;

    if (kind === 'payables') {
      const purchases = await Purchase.find({})
        .populate('vendor', 'name')
        .select('supplier vendor total gstAmount amountPaid date dueDate invoiceNo')
        .limit(5000)
        .lean();
      const mine = purchases.filter(
        (p) => ((p.vendor && p.vendor.name) || p.supplier || 'Unknown vendor') === name
      );
      mine.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
      let running = 0;
      for (const p of mine) {
        const bill = round2((p.total || 0) + (p.gstAmount || 0));
        const paid = round2(p.amountPaid || 0);
        const balance = round2(bill - paid);
        running = round2(running + balance);
        invoiced += bill;
        received += paid;
        rows.push({
          date: p.date || p.dueDate || null,
          description: p.invoiceNo ? `Bill ${p.invoiceNo}` : 'Purchase bill',
          invoiced: bill,
          received: paid,
          balance,
          runningBalance: running,
        });
      }
    } else {
      const q = { customerName: name };
      if (phone) q.phone = phone;
      const bookings = await Booking.find(q)
        .select('type service customerName phone totalPrice collectedAmount bookingDate createdAt status')
        .limit(5000)
        .lean();
      const active = bookings.filter(
        (b) =>
          !['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'].includes(
            String(b.status || '').toLowerCase()
          )
      );
      active.sort(
        (a, b) => new Date(a.bookingDate || a.createdAt || 0) - new Date(b.bookingDate || b.createdAt || 0)
      );
      let running = 0;
      for (const b of active) {
        const inv = round2(b.totalPrice || 0);
        const rec = round2(b.collectedAmount || 0);
        const balance = round2(inv - rec);
        running = round2(running + balance);
        invoiced += inv;
        received += rec;
        const desc =
          (typeof b.type === 'string' && b.type) ||
          (typeof b.service === 'string' && b.service) ||
          'Booking';
        rows.push({
          date: b.bookingDate || b.createdAt || null,
          description: desc,
          invoiced: inv,
          received: rec,
          balance,
          runningBalance: running,
        });
      }
    }

    res.json({
      kind,
      party: { name, phone: phone || '' },
      rows,
      invoicedTotal: round2(invoiced),
      receivedTotal: round2(received),
      outstanding: round2(invoiced - received),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    General ledger for one account — every posting with a running
//          balance (the account's statement / cash book / bank book).
// @route   GET /api/accounting/ledger/:accountId
const getAccountLedger = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.accountId)) {
      return res.status(400).json({ message: 'Invalid account' });
    }
    const accId = new mongoose.Types.ObjectId(req.params.accountId);
    const account = await ChartOfAccount.findById(accId).lean();
    if (!account) return res.status(404).json({ message: 'Account not found' });

    const { from, to } = req.query;

    // Opening balance (debit-positive): the account's own opening + all
    // movements dated before the window start.
    let running =
      account.openingType === 'cr' ? -(account.openingBalance || 0) : account.openingBalance || 0;
    if (from) {
      const before = await JournalEntry.aggregate([
        { $match: { status: 'posted', 'lines.account': accId, date: { $lt: new Date(from) } } },
        { $unwind: '$lines' },
        { $match: { 'lines.account': accId } },
        { $group: { _id: null, dr: { $sum: '$lines.debit' }, cr: { $sum: '$lines.credit' } } },
      ]);
      running += (before[0]?.dr || 0) - (before[0]?.cr || 0);
    }
    const openingBalance = round2(running);

    const q = { status: 'posted', 'lines.account': accId };
    if (from || to) {
      q.date = {};
      if (from) q.date.$gte = new Date(from);
      if (to) q.date.$lte = new Date(to);
    }
    const entries = await JournalEntry.find(q).sort({ date: 1, createdAt: 1 }).limit(20000).lean();

    const rows = [];
    let totalDebit = 0;
    let totalCredit = 0;
    for (const e of entries) {
      for (const l of e.lines) {
        if (String(l.account) !== String(accId)) continue;
        running = round2(running + (l.debit || 0) - (l.credit || 0));
        totalDebit += l.debit || 0;
        totalCredit += l.credit || 0;
        rows.push({
          date: e.date,
          voucherNo: e.voucherNo,
          voucherType: e.voucherType,
          narration: e.narration,
          debit: round2(l.debit || 0),
          credit: round2(l.credit || 0),
          balance: Math.abs(running),
          balanceSide: running >= 0 ? 'dr' : 'cr',
        });
      }
    }

    res.json({
      account: { id: account._id, code: account.code, name: account.name, nature: account.nature, group: account.group },
      openingBalance: Math.abs(openingBalance),
      openingSide: openingBalance >= 0 ? 'dr' : 'cr',
      rows,
      totalDebit: round2(totalDebit),
      totalCredit: round2(totalCredit),
      closingBalance: Math.abs(round2(running)),
      closingSide: running >= 0 ? 'dr' : 'cr',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── GST ──────────────────────────────────────────────────────────────────────

// ── Accounting settings (period lock) ────────────────────────────────────────

// @desc    Accounting settings — currently the period lock date.
// @route   GET /api/accounting/settings
const getAccountingSettings = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    let s = await AccountingSetting.findOne({}).populate('lockedBy', 'name');
    if (!s) s = await AccountingSetting.create({});
    res.json(s);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Close / reopen the books. body { lockDate: ISO | null }.
// @route   PUT /api/accounting/settings
const updateAccountingSettings = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const lockDate = req.body.lockDate ? new Date(req.body.lockDate) : null;
    const patch = {
      lockDate,
      lockedBy: lockDate ? (req.user?._id || null) : null,
      lockedAt: lockDate ? new Date() : null,
    };
    const s = await AccountingSetting.findOneAndUpdate({}, patch, { new: true, upsert: true });
    setLockDate(lockDate);
    const populated = await AccountingSetting.findById(s._id).populate('lockedBy', 'name');
    res.json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get the studio's GST configuration (creates a default if none).
// @route   GET /api/accounting/gst/settings
const getGstSettings = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    let s = await GstSetting.findOne({});
    if (!s) s = await GstSetting.create({});
    res.json(s);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Update GST configuration (and refresh the posting cache).
// @route   PUT /api/accounting/gst/settings
const updateGstSettings = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const patch = {
      enabled: !!req.body.enabled,
      rate: Math.max(0, Math.min(100, Number(req.body.rate) || 0)),
      pricesIncludeTax: req.body.pricesIncludeTax !== false,
      interState: !!req.body.interState,
      homeStateCode: String(req.body.homeStateCode ?? '').trim(),
      gstin: String(req.body.gstin ?? '').trim(),
    };
    const s = await GstSetting.findOneAndUpdate({}, patch, { new: true, upsert: true });
    setGstConfig(s);
    res.json(s);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    GST summary (GSTR-3B style): output tax − input credit = net payable.
// @route   GET /api/accounting/gst/summary
const getGstSummary = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { from, to } = req.query;
    const [accounts, mv] = await Promise.all([
      ChartOfAccount.find({ code: { $in: ['2100', '2110', '2120', '1300'] } }).lean(),
      accountMovements({ from, to }),
    ]);
    const netOf = (code, side) => {
      const a = accounts.find((x) => x.code === code);
      const m = (a && mv.get(String(a._id))) || { debit: 0, credit: 0 };
      return side === 'cr' ? round2(m.credit - m.debit) : round2(m.debit - m.credit);
    };
    const outputCgst = netOf('2100', 'cr');
    const outputSgst = netOf('2110', 'cr');
    const outputIgst = netOf('2120', 'cr');
    const totalOutput = round2(outputCgst + outputSgst + outputIgst);
    const inputCredit = netOf('1300', 'dr');
    res.json({
      from: from || null,
      to: to || null,
      outputCgst,
      outputSgst,
      outputIgst,
      totalOutput,
      inputCredit,
      netPayable: round2(totalOutput - inputCredit),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    GSTR-1 outward supplies register — per-invoice taxable + tax, from
//          bookings, split per the current GST config.
// @route   GET /api/accounting/gst/gstr1
const getGstr1 = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const gst = await ensureGstConfig();
    const { from, to } = req.query;
    const q = {};
    if (from || to) {
      q.bookingDate = {};
      if (from) q.bookingDate.$gte = new Date(from);
      if (to) q.bookingDate.$lte = new Date(to);
    }
    const bookings = await Booking.find(q)
      .select('bookingNumber customerName totalPrice bookingDate status')
      .limit(20000)
      .lean();

    const rows = [];
    const totals = { taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
    for (const b of bookings) {
      const st = String(b.status || '').toLowerCase();
      if (['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'].includes(st)) continue;
      const price = round2(b.totalPrice);
      if (price <= 0) continue;
      const taxable = !gst.enabled || gst.rate <= 0
        ? price
        : (gst.inclusive ? round2(price / (1 + gst.rate / 100)) : price);
      const tax = round2(price - taxable) < 0 ? 0 : (gst.inclusive ? round2(price - taxable) : round2(price * (gst.rate / 100)));
      const cgst = gst.interState ? 0 : round2(tax / 2);
      const sgst = gst.interState ? 0 : round2(tax - cgst);
      const igst = gst.interState ? tax : 0;
      const total = round2(taxable + tax);
      rows.push({
        invoiceNo: b.bookingNumber || '',
        customer: b.customerName || '',
        date: b.bookingDate,
        rate: gst.rate,
        taxable,
        cgst,
        sgst,
        igst,
        total,
      });
      totals.taxable += taxable;
      totals.cgst += cgst;
      totals.sgst += sgst;
      totals.igst += igst;
      totals.total += total;
    }
    rows.sort((a, b) => new Date(b.date) - new Date(a.date));
    for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
    totals.count = rows.length;
    res.json({ rate: gst.rate, enabled: gst.enabled, interState: gst.interState, rows, totals });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Post existing operational documents into the ledger (idempotent —
//          re-runnable). Populates the books from real bookings, collections,
//          expenses, payroll and returns using the posting engine.
// @route   POST /api/accounting/backfill
const backfillLedger = async (req, res) => {
  if (!canManageFinance(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const coaCount = await ChartOfAccount.countDocuments();
    if (coaCount === 0) {
      return res.status(400).json({ message: 'Seed the Chart of Accounts before syncing the ledger.' });
    }
    const requested = Array.isArray(req.body.models) && req.body.models.length
      ? req.body.models.filter((m) => POSTABLE_MODELS.includes(m))
      : POSTABLE_MODELS;

    await ensureGstConfig(); // sales split reads the current GST config
    const lock = await ensureLockDate(); // never re-post into a closed period

    // 1) Load the chart of accounts once (code → id).
    const accounts = await ChartOfAccount.find({}).select('code').lean();
    const codeToId = new Map(accounts.map((a) => [a.code, String(a._id)]));

    // 2) Build every entry in memory (no per-doc DB calls).
    const summary = {};
    const pending = []; // { source, voucherType, date, narration, lines }
    for (const model of requested) {
      const Model = SOURCE_MODELS[model];
      if (!Model) continue;
      const docs = await Model.find({}).limit(20000).lean();
      let posted = 0;
      for (const d of docs) {
        const spec = buildSpecFor(model, d);
        if (!spec) continue;
        const lines = [];
        let dr = 0;
        let cr = 0;
        let ok = true;
        for (const l of spec.rawLines) {
          const id = codeToId.get(l.code);
          if (!id) { ok = false; break; }
          const debit = round2(l.debit);
          const credit = round2(l.credit);
          if (debit <= 0 && credit <= 0) continue;
          lines.push({ account: id, debit, credit, narration: l.narration || '' });
          dr += debit;
          cr += credit;
        }
        if (!ok || lines.length < 2 || round2(dr) !== round2(cr) || round2(dr) <= 0) continue;
        const date = spec.date || new Date();
        if (isLocked(date)) continue; // leave closed periods untouched
        pending.push({
          source: { model, id: d._id },
          voucherType: spec.voucherType,
          date,
          narration: spec.narration || '',
          lines,
        });
        posted += 1;
      }
      summary[model] = { total: docs.length, posted };
    }

    // 3) Replace prior auto-generated entries for these models — but never touch
    //    entries in a closed (locked) period.
    await JournalEntry.deleteMany({
      'source.model': { $in: requested },
      ...(lock ? { date: { $gt: lock } } : {}),
    });

    // 4) Seed voucher-number counters from what remains (manual + other types).
    const counts = await JournalEntry.aggregate([
      { $group: { _id: { t: '$voucherType', fy: '$fyLabel' }, n: { $sum: 1 } } },
    ]);
    const counter = new Map(counts.map((c) => [`${c._id.t}|${c._id.fy}`, c.n]));

    // 5) Number + insert in bulk.
    const now = new Date();
    const docsToInsert = pending.map((p) => {
      const fyLabel = fyLabelFor(p.date);
      const key = `${p.voucherType}|${fyLabel}`;
      const next = (counter.get(key) || 0) + 1;
      counter.set(key, next);
      const prefix = VOUCHER_PREFIX[p.voucherType] || 'JV';
      return {
        ...p,
        fyLabel,
        voucherNo: `${prefix}/${fyLabel}/${String(next).padStart(4, '0')}`,
        status: 'posted',
        postedAt: now,
        createdBy: req.user?._id || null,
      };
    });
    if (docsToInsert.length) {
      await JournalEntry.insertMany(docsToInsert, { ordered: false });
    }

    res.json({ summary, totalPosted: docsToInsert.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export {
  seedAccounts,
  getAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  getJournalEntries,
  createJournalEntry,
  voidJournalEntry,
  getTrialBalance,
  getProfitAndLoss,
  getBalanceSheet,
  getReceivables,
  getPayables,
  getPartyStatement,
  getAccountLedger,
  getAccountingSettings,
  updateAccountingSettings,
  getGstSettings,
  updateGstSettings,
  getGstSummary,
  getGstr1,
  backfillLedger,
};
