import mongoose from 'mongoose';
import BankAccount from '../models/BankAccount.js';
import ChartOfAccount, { resolveAccountType, nextAccountCode } from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';

// Finance staff manage bank balances.
const FINANCE_ROLES = ['admin', 'manager', 'accounts', 'finance_head'];
const canManage = (u) => FINANCE_ROLES.includes(String(u?.role || '').toLowerCase());

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── Live balance from the linked ledger ──────────────────────────────────────
// A manual balance is the CLOSING balance on its as-of day (IST), so ledger
// movements count from the next day on. No as-of → every movement counts.
const cutoffAfter = (asOf) => {
  if (!asOf) return null;
  const day = new Date(new Date(asOf).getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
  return new Date(`${day}T23:59:59.999+05:30`);
};

const movementMatch = (ledgerId, asOf) => {
  const cutoff = cutoffAfter(asOf);
  return {
    status: 'posted',
    'lines.account': new mongoose.Types.ObjectId(String(ledgerId)),
    ...(cutoff ? { date: { $gt: cutoff } } : {}),
  };
};

// Receipts (debit) and payments (credit) on the ledger after the checkpoint.
const ledgerMovement = async (ledgerId, asOf) => {
  const id = new mongoose.Types.ObjectId(String(ledgerId));
  const [m] = await JournalEntry.aggregate([
    { $match: movementMatch(ledgerId, asOf) },
    { $unwind: '$lines' },
    { $match: { 'lines.account': id } },
    { $group: { _id: null, in: { $sum: '$lines.debit' }, out: { $sum: '$lines.credit' }, count: { $sum: 1 } } },
  ]);
  return { in: round2(m?.in), out: round2(m?.out), count: m?.count || 0 };
};

// Add ledger link details + the live balance to an account for the API.
const withLiveBalance = async (a) => {
  const obj = typeof a.toObject === 'function' ? a.toObject() : a;
  // `ledger` is either populated ({_id, code, name}) or a bare ObjectId (which
  // also exposes `_id`, so test for `code` to tell them apart).
  const populated = !!obj.ledger && obj.ledger.code !== undefined;
  const ledgerId = populated ? obj.ledger._id : obj.ledger;
  if (!ledgerId) {
    return { ...obj, kind: obj.kind || 'bank', ledger: null, movement: null, currentBalance: round2(obj.balance) };
  }
  const ledger = populated
    ? obj.ledger
    : await ChartOfAccount.findById(ledgerId).select('code name').lean();
  const movement = await ledgerMovement(ledgerId, obj.asOf);
  return {
    ...obj,
    kind: obj.kind || 'bank',
    ledger: ledger ? { _id: ledger._id, code: ledger.code, name: ledger.name } : null,
    movement: { ...movement, since: obj.asOf || null },
    currentBalance: round2((obj.balance || 0) + movement.in - movement.out),
  };
};

// A ledger can back a bank/cash account when it is an active Cash or Bank type
// and isn't already linked to a different account.
const checkLinkable = async (ledgerId, selfId = null) => {
  if (!mongoose.Types.ObjectId.isValid(String(ledgerId))) return 'Invalid ledger account';
  const ledger = await ChartOfAccount.findById(ledgerId).lean();
  if (!ledger) return 'Ledger account not found';
  if (ledger.status === 'archived') return 'That ledger account is archived';
  if (!['cash', 'bank'].includes(resolveAccountType(ledger))) {
    return 'Only a Cash or Bank type account can be linked';
  }
  const taken = await BankAccount.findOne({ ledger: ledger._id, ...(selfId ? { _id: { $ne: selfId } } : {}) })
    .select('name')
    .lean();
  if (taken) return `That ledger is already linked to "${taken.name}"`;
  return null;
};

// New Cash / Bank ledger for an account (opening balance stays on the
// BankAccount checkpoint, so the ledger opens at zero).
const createLedgerFor = async ({ name, kind }, user) => {
  const accountType = kind === 'cash' ? 'cash' : 'bank';
  return ChartOfAccount.create({
    code: await nextAccountCode(accountType),
    name,
    nature: 'asset',
    accountType,
    group: 'Current Assets',
    isCash: accountType === 'cash',
    isBank: accountType === 'bank',
    createdBy: user?._id || null,
  });
};

// Live Bank / Cash totals across active accounts — shared with the Combined
// Accounts Dashboard so both show the same figure.
export const liveCashBankTotals = async () => {
  const raw = await BankAccount.find({ active: true }).populate('ledger', 'code name').lean();
  const accounts = await Promise.all(raw.map(withLiveBalance));
  const sum = (list) => round2(list.reduce((s, a) => s + (a.currentBalance || 0), 0));
  return {
    total: sum(accounts),
    bank: sum(accounts.filter((a) => a.kind !== 'cash')),
    cash: sum(accounts.filter((a) => a.kind === 'cash')),
    unlinked: accounts.filter((a) => !a.ledger).length,
    count: accounts.length,
  };
};

// @route GET /api/bank-accounts  — list accounts + live balances
export const getBankAccounts = async (req, res) => {
  try {
    const includeInactive = req.query.all === 'true';
    const filter = includeInactive ? {} : { active: true };
    const raw = await BankAccount.find(filter)
      .populate('ledger', 'code name')
      .sort({ kind: 1, name: 1 })
      .lean();
    const accounts = await Promise.all(raw.map(withLiveBalance));
    const active = accounts.filter((a) => a.active);
    const sum = (list) => round2(list.reduce((s, a) => s + (a.currentBalance || 0), 0));
    res.json({
      accounts,
      totalBalance: sum(active),
      bankTotal: sum(active.filter((a) => a.kind !== 'cash')),
      cashTotal: sum(active.filter((a) => a.kind === 'cash')),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/bank-accounts  — add an account (with an opening balance)
// Body: name, kind ('bank'|'cash'), bankName, accountNumber, balance, asOf,
// note, and ledgerId to link an existing Cash/Bank ledger — otherwise a new
// ledger is created for it.
export const createBankAccount = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ message: 'An account name is required' });
    const kind = req.body.kind === 'cash' ? 'cash' : 'bank';

    let ledgerId = req.body.ledgerId || null;
    if (ledgerId) {
      const err = await checkLinkable(ledgerId);
      if (err) return res.status(400).json({ message: err });
    } else {
      ledgerId = (await createLedgerFor({ name, kind }, req.user))._id;
    }

    const balance = num(req.body.balance);
    const asOf = req.body.asOf ? new Date(req.body.asOf) : new Date();
    const doc = await BankAccount.create({
      name,
      kind,
      ledger: ledgerId,
      bankName: String(req.body.bankName || '').trim(),
      accountNumber: String(req.body.accountNumber || '').trim(),
      balance,
      asOf,
      note: String(req.body.note || ''),
      history: [{
        balance,
        asOf,
        note: 'Opening balance',
        byId: req.user?._id ?? null,
        byName: req.user?.name ?? '',
      }],
    });
    res.status(201).json(await withLiveBalance(doc));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/bank-accounts/:id  — edit the account's details (not balance)
export const updateBankAccount = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    const b = req.body;
    if (b.name !== undefined) doc.name = String(b.name).trim() || doc.name;
    if (b.bankName !== undefined) doc.bankName = String(b.bankName).trim();
    if (b.accountNumber !== undefined) doc.accountNumber = String(b.accountNumber).trim();
    if (b.note !== undefined) doc.note = String(b.note);
    if (b.active !== undefined) doc.active = !!b.active;
    await doc.save();
    res.json(await withLiveBalance(doc));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/bank-accounts/:id/ledger  — link / unlink the ledger
// Body: { ledgerId } to link an existing Cash/Bank ledger, { create: true } to
// create a new one, or { ledgerId: null } to unlink.
export const linkLedger = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    if (req.body.create === true) {
      doc.ledger = (await createLedgerFor({ name: doc.name, kind: doc.kind }, req.user))._id;
    } else if (req.body.ledgerId) {
      const err = await checkLinkable(req.body.ledgerId, doc._id);
      if (err) return res.status(400).json({ message: err });
      doc.ledger = req.body.ledgerId;
    } else {
      doc.ledger = null;
    }
    await doc.save();
    res.json(await withLiveBalance(doc));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/bank-accounts/ledger-options  — Cash/Bank ledgers that can
// still be linked (not linked to another account).
export const getLedgerOptions = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can view this' });
  try {
    const [ledgers, linked] = await Promise.all([
      ChartOfAccount.find({ status: { $ne: 'archived' }, nature: 'asset' }).sort({ code: 1 }).lean(),
      BankAccount.find({ ledger: { $ne: null } }).select('ledger name').lean(),
    ]);
    const linkedTo = new Map(linked.map((b) => [String(b.ledger), b.name]));
    res.json(
      ledgers
        .filter((l) => ['cash', 'bank'].includes(resolveAccountType(l)))
        .map((l) => ({
          _id: l._id,
          code: l.code,
          name: l.name,
          accountType: resolveAccountType(l),
          linkedTo: linkedTo.get(String(l._id)) || '',
        }))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route GET /api/bank-accounts/:id/transactions  — ledger receipts and
// payments since the last manual balance, with a running balance.
export const getTransactions = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can view this' });
  try {
    const doc = await BankAccount.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    if (!doc.ledger) return res.json({ since: doc.asOf || null, opening: round2(doc.balance), rows: [], closing: round2(doc.balance) });

    const id = String(doc.ledger);
    const entries = await JournalEntry.find(movementMatch(id, doc.asOf))
      .select('date voucherNo voucherType narration lines source')
      .sort({ date: 1, createdAt: 1 })
      .limit(1000)
      .lean();
    let running = round2(doc.balance);
    const rows = [];
    for (const e of entries) {
      for (const l of e.lines) {
        if (String(l.account) !== id) continue;
        const inAmt = round2(l.debit);
        const outAmt = round2(l.credit);
        running = round2(running + inAmt - outAmt);
        rows.push({
          date: e.date,
          voucherNo: e.voucherNo,
          voucherType: e.voucherType,
          narration: l.narration || e.narration || '',
          source: e.source?.model || '',
          in: inAmt,
          out: outAmt,
          balance: running,
        });
      }
    }
    res.json({ since: doc.asOf || null, opening: round2(doc.balance), rows, closing: running });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route POST /api/bank-accounts/:id/balance  — record a new manual balance
export const recordBalance = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    if (req.body.balance === undefined || req.body.balance === null || req.body.balance === '') {
      return res.status(400).json({ message: 'A balance amount is required' });
    }
    const balance = num(req.body.balance);
    const asOf = req.body.asOf ? new Date(req.body.asOf) : new Date();
    doc.balance = balance;
    doc.asOf = asOf;
    doc.history.push({
      balance,
      asOf,
      note: String(req.body.note || ''),
      byId: req.user?._id ?? null,
      byName: req.user?.name ?? '',
    });
    await doc.save();
    res.json(await withLiveBalance(doc));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route DELETE /api/bank-accounts/:id
// The linked ledger stays in the Chart of Accounts (it may carry postings).
export const deleteBankAccount = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can manage bank balances' });
  try {
    const doc = await BankAccount.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Account not found' });
    res.json({ message: 'Account deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
