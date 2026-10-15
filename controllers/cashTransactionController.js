import mongoose from 'mongoose';
import CashTransaction, { CASH_TXN_TYPES } from '../models/CashTransaction.js';
import ChartOfAccount, { resolveAccountType } from '../models/ChartOfAccount.js';
import BankAccount from '../models/BankAccount.js';
import { applyMoneyAccount } from '../utils/moneyAccount.js';
import { postDoc, unpostDoc, ensureLockDate, isLocked } from '../services/posting.js';

// Accounts keys these in; finance roles, or any role granted the
// `payables.transactions` screen (or all of `payables`).
const FINANCE_ROLES = ['admin', 'manager', 'accounts', 'finance_head'];
const canUse = (u) =>
  FINANCE_ROLES.includes(String(u?.role || '').toLowerCase()) ||
  (u?.permissions || []).some((p) => p === 'payables' || p === 'payables.transactions');

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PAY_MODES = ['cash', 'upi', 'bank_transfer', 'card', 'cheque', 'other'];

const populate = [
  { path: 'account', select: 'code name nature accountType isCash isBank isParty group' },
  { path: 'moneyAccount', select: 'name kind bankName accountNumber' },
  { path: 'toMoneyAccount', select: 'name kind bankName accountNumber' },
];

// Accounts saved before Account Type existed carry it derived, like the COA list.
const shape = (t) => {
  const o = typeof t.toObject === 'function' ? t.toObject() : t;
  if (o.account && o.account.code) o.account = { ...o.account, accountType: resolveAccountType(o.account) };
  return o;
};

// 'YYYY-MM-DD' → IST day bounds.
const dayStart = (s) => new Date(`${s}T00:00:00.000+05:30`);
const dayEnd = (s) => new Date(`${s}T23:59:59.999+05:30`);

const listFilter = (q) => {
  const f = {};
  if (q.from || q.to) {
    f.date = {};
    if (q.from) f.date.$gte = dayStart(q.from);
    if (q.to) f.date.$lte = dayEnd(q.to);
  }
  if (CASH_TXN_TYPES.includes(q.type)) f.type = q.type;
  if (q.department) f.department = q.department;
  for (const [key, field] of [['account', 'account'], ['moneyAccount', 'moneyAccount']]) {
    if (q[key] && mongoose.Types.ObjectId.isValid(q[key])) f[field] = new mongoose.Types.ObjectId(String(q[key]));
  }
  if (q.moneyAccount && f.moneyAccount) {
    // A transfer touches the account on either side.
    const id = f.moneyAccount;
    delete f.moneyAccount;
    f.$or = [{ moneyAccount: id }, { toMoneyAccount: id }];
  }
  if (q.search) {
    const rx = new RegExp(String(q.search).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    f.$and = [{ $or: [{ party: rx }, { notes: rx }, { reference: rx }, { paymentRef: rx }] }];
  }
  return f;
};

// @route GET /api/cash-transactions?from&to&type&department&account&moneyAccount&search
export const getCashTransactions = async (req, res) => {
  if (!canUse(req.user)) return res.status(403).json({ message: 'No access to cash transactions' });
  try {
    const filter = listFilter(req.query);
    const [rows, sums] = await Promise.all([
      CashTransaction.find(filter).populate(populate).sort({ date: -1, createdAt: -1 }).limit(1000).lean(),
      CashTransaction.aggregate([
        { $match: filter },
        {
          $group: {
            _id: '$type',
            amount: {
              $sum: {
                $add: [
                  '$amount',
                  { $cond: [{ $and: [{ $eq: ['$type', 'out'] }, { $eq: ['$gstType', 'gst'] }] }, '$gstAmount', 0] },
                ],
              },
            },
            count: { $sum: 1 },
          },
        },
      ]),
    ]);
    const by = Object.fromEntries(sums.map((s) => [s._id, s]));
    const moneyIn = round2(by.in?.amount);
    const moneyOut = round2(by.out?.amount);
    res.json({
      rows: rows.map(shape),
      totals: {
        in: moneyIn,
        out: moneyOut,
        net: round2(moneyIn - moneyOut),
        transfer: round2(by.transfer?.amount),
        count: sums.reduce((s, x) => s + x.count, 0),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Validate the form body and apply it onto [doc]. Returns an error message or null.
const applyBody = async (doc, b) => {
  const type = CASH_TXN_TYPES.includes(b.type) ? b.type : doc.type;
  if (!type) return 'Choose Cash In, Cash Out or Transfer';
  const date = b.date ? new Date(b.date) : doc.date;
  if (!date || Number.isNaN(new Date(date).getTime())) return 'A valid date is required';
  const amount = round2(b.amount ?? doc.amount);
  if (!(amount > 0)) return 'Amount must be greater than zero';

  // Paid through / deposited to (and the "from" side of a transfer).
  if (!b.moneyAccountId && !doc.ledgerAccount) return 'Choose the bank / cash account';
  if (b.moneyAccountId) {
    const err = await applyMoneyAccount(doc, { ...b, paymentMode: undefined });
    if (err) return err;
  }

  doc.type = type;
  doc.date = date;
  doc.amount = amount;
  doc.department = String(b.department ?? doc.department ?? '').trim();
  doc.party = String(b.party ?? doc.party ?? '').trim();
  doc.reference = String(b.reference ?? doc.reference ?? '').trim();
  doc.notes = String(b.notes ?? doc.notes ?? '').trim();
  if (b.attachmentUrl !== undefined) doc.attachmentUrl = String(b.attachmentUrl || '');
  if (b.paymentRef !== undefined) doc.paymentRef = String(b.paymentRef || '').trim();
  if (b.paymentMode !== undefined) doc.paymentMode = PAY_MODES.includes(b.paymentMode) ? b.paymentMode : '';

  if (type === 'transfer') {
    const toId = b.toMoneyAccountId || doc.toMoneyAccount;
    if (!toId || !mongoose.Types.ObjectId.isValid(String(toId))) return 'Choose the account to transfer to';
    const to = await BankAccount.findById(toId).select('name active ledger').lean();
    if (!to || to.active === false) return 'Transfer-to account not found';
    if (!to.ledger) return `"${to.name}" is not linked to a ledger yet`;
    if (String(to.ledger) === String(doc.ledgerAccount)) return 'Transfer needs two different accounts';
    doc.toMoneyAccount = to._id;
    doc.toLedgerAccount = to.ledger;
    doc.account = null;
    doc.gstType = 'none';
    doc.gstAmount = 0;
    return null;
  }

  // In / Out: the income / expense / … side (Account Type → Account Name).
  const accountId = b.accountId || doc.account;
  if (!accountId || !mongoose.Types.ObjectId.isValid(String(accountId))) return 'Choose the account name';
  const acc = await ChartOfAccount.findById(accountId).lean();
  if (!acc || acc.status === 'archived') return 'That account was not found or is archived';
  if (['cash', 'bank'].includes(resolveAccountType(acc))) {
    return 'Money between bank and cash accounts is a Transfer, not Cash In / Out';
  }
  doc.account = acc._id;
  doc.toMoneyAccount = null;
  doc.toLedgerAccount = null;

  if (type === 'out') {
    const gstType = ['none', 'gst', 'rcm'].includes(b.gstType) ? b.gstType : doc.gstType || 'none';
    doc.gstType = gstType;
    doc.gstAmount = gstType === 'none' ? 0 : round2(b.gstAmount ?? doc.gstAmount);
    if (gstType === 'gst' && doc.gstAmount > 0) {
      const itc = await ChartOfAccount.exists({ code: '1300' });
      if (!itc) return 'GST Input Credit ledger (1300) is missing from the Chart of Accounts';
    }
  } else {
    doc.gstType = 'none';
    doc.gstAmount = 0;
  }
  return null;
};

const lockedMessage = 'That date is in a closed (locked) period.';

// @route GET /api/cash-transactions/accounts
// Accounts the form can book against (everything except Cash / Bank, which are
// picked as "paid through"), with their Account Type.
export const getTransactionAccounts = async (req, res) => {
  if (!canUse(req.user)) return res.status(403).json({ message: 'No access to cash transactions' });
  try {
    const all = await ChartOfAccount.find({ status: { $ne: 'archived' } })
      .select('code name nature accountType isCash isBank isParty group')
      .sort({ code: 1 })
      .lean();
    res.json(
      all
        .map((a) => ({ ...a, accountType: resolveAccountType(a) }))
        .filter((a) => !['cash', 'bank'].includes(a.accountType))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/cash-transactions
export const createCashTransaction = async (req, res) => {
  if (!canUse(req.user)) return res.status(403).json({ message: 'No access to cash transactions' });
  try {
    const doc = new CashTransaction({
      createdBy: req.user?._id || null,
      createdByName: req.user?.name || '',
    });
    const err = await applyBody(doc, req.body);
    if (err) return res.status(400).json({ message: err });
    await ensureLockDate();
    if (isLocked(doc.date)) return res.status(400).json({ message: lockedMessage });

    await doc.save();
    // Posting is the point of the entry — if it can't post, don't keep it.
    const posted = await postDoc('CashTransaction', doc.toObject(), req.user?._id || null);
    if (posted.status !== 'posted') {
      await doc.deleteOne();
      return res.status(400).json({ message: `Could not post to the ledger (${posted.reason}).` });
    }
    const full = await CashTransaction.findById(doc._id).populate(populate).lean();
    res.status(201).json(shape(full));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/cash-transactions/:id
export const updateCashTransaction = async (req, res) => {
  if (!canUse(req.user)) return res.status(403).json({ message: 'No access to cash transactions' });
  try {
    const doc = await CashTransaction.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Transaction not found' });
    await ensureLockDate();
    if (isLocked(doc.date)) return res.status(400).json({ message: lockedMessage });
    const before = doc.toObject();

    const err = await applyBody(doc, req.body);
    if (err) return res.status(400).json({ message: err });
    if (isLocked(doc.date)) return res.status(400).json({ message: lockedMessage });

    await doc.save();
    const posted = await postDoc('CashTransaction', doc.toObject(), req.user?._id || null);
    if (posted.status !== 'posted') {
      // Put the previous version (and its voucher) back.
      await CashTransaction.replaceOne({ _id: doc._id }, before);
      await postDoc('CashTransaction', before, req.user?._id || null);
      return res.status(400).json({ message: `Could not post to the ledger (${posted.reason}).` });
    }
    const full = await CashTransaction.findById(doc._id).populate(populate).lean();
    res.json(shape(full));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/cash-transactions/:id
export const deleteCashTransaction = async (req, res) => {
  if (!canUse(req.user)) return res.status(403).json({ message: 'No access to cash transactions' });
  try {
    const doc = await CashTransaction.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Transaction not found' });
    await ensureLockDate();
    if (isLocked(doc.date)) return res.status(400).json({ message: lockedMessage });
    await unpostDoc('CashTransaction', doc._id);
    await doc.deleteOne();
    res.json({ message: 'Transaction deleted', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
