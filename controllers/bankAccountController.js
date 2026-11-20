import mongoose from 'mongoose';
import BankAccount from '../models/BankAccount.js';
import ChartOfAccount, { resolveAccountType, nextAccountCode } from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import { anchorAt, anchorsOf, balanceAt, facetsOf, matchesRow, pageOf, parseStatementQuery, rangeOf, totalsOf, withRunningBalance } from '../utils/bankStatement.js';
import { describeTransactions } from '../services/bankTransactionDetails.js';
import { addDays, istEnd, todayIst } from '../utils/istDate.js';

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

// What the account held at instant [at]: the manual balance in force then, plus the ledger's receipts and
// payments since its day. Null when no balance had been entered by then (nothing to compare with).
const balanceAtInstant = async (obj, at) => {
  const anchor = anchorAt(anchorsOf(obj), at);
  if (!anchor) return null;
  const ledgerId = obj.ledger && obj.ledger._id ? obj.ledger._id : obj.ledger;
  if (!ledgerId) return round2(anchor.balance);
  const id = new mongoose.Types.ObjectId(String(ledgerId));
  const [m] = await JournalEntry.aggregate([
    { $match: { status: 'posted', 'lines.account': id, date: { $gt: anchor.cutoff, $lte: at } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': id } },
    { $group: { _id: null, in: { $sum: '$lines.debit' }, out: { $sum: '$lines.credit' } } },
  ]);
  return round2(anchor.balance + (m?.in || 0) - (m?.out || 0));
};

/// The last day of the month before this one (IST): 'YYYY-MM-DD'.
const lastDayOfPreviousMonth = () => addDays(`${todayIst().slice(0, 7)}-01`, -1);

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
    // …and what each held at the end of last month, for "vs last month" (null = no balance entered by then)
    const previousDay = lastDayOfPreviousMonth();
    const previousAt = istEnd(previousDay);
    const accounts = await Promise.all(
      raw.map(async (a) => ({ ...(await withLiveBalance(a)), previousBalance: await balanceAtInstant(a, previousAt) })),
    );
    const active = accounts.filter((a) => a.active);
    const sum = (list) => round2(list.reduce((s, a) => s + (a.currentBalance || 0), 0));
    // a total can only be compared when every account in it has a figure for that day
    const previousSum = (list) => (list.length > 0 && list.every((a) => a.previousBalance !== null) ? round2(list.reduce((s, a) => s + a.previousBalance, 0)) : null);
    res.json({
      accounts,
      totalBalance: sum(active),
      bankTotal: sum(active.filter((a) => a.kind !== 'cash')),
      cashTotal: sum(active.filter((a) => a.kind === 'cash')),
      previous: {
        asOf: previousDay,
        total: previousSum(active),
        bank: previousSum(active.filter((a) => a.kind !== 'cash')),
        cash: previousSum(active.filter((a) => a.kind === 'cash')),
      },
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

/// How many vouchers one statement reads at most.
const STATEMENT_CAP = 5000;

// @route GET /api/bank-accounts/:id/transactions
// The account's statement: every receipt and payment on its ledger, each with the balance after it and
// WHAT IT WAS FOR (who, which work, category, notes… — services/bankTransactionDetails.js).
//   ?from= &to=      IST days, inclusive. Neither = since the last manual balance (what the live balance is made of).
//   ?direction=in|out  ?group=  ?person=  ?search=      (the keys of group / person come from `facets`)
//   ?page= &limit=   a page, newest first:  { rows, page, limit, totalItems, totalPages, totals, facets, … }
//   ?export=1        every match, newest first
//   (no page / export: every row, OLDEST first — the shape older apps expect)
// Always: since, opening (the balance before the first row), closing (after the last), range, truncated.
export const getTransactions = async (req, res) => {
  if (!canManage(req.user)) return res.status(403).json({ message: 'Only finance staff can view this' });
  try {
    const query = parseStatementQuery(req.query);
    const doc = await BankAccount.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ message: 'Account not found' });

    const anchors = anchorsOf(doc);
    const current = anchors[anchors.length - 1];
    const { start, end } = rangeOf(query);
    // what is shown starts at the chosen day, else just after the balance in force now
    const viewStart = start ?? new Date(current.cutoff.getTime() + 1);
    const before = new Date(viewStart.getTime() - 1);
    const range = query.from || query.to ? { from: query.from, to: query.to } : null;

    let lines = [];
    let truncated = false;
    if (doc.ledger) {
      const id = String(doc.ledger);
      // read from the manual balance in force at the start, so every row's balance can be worked out
      const base = anchorAt(anchors, before);
      const entries = await JournalEntry.find({
        status: 'posted',
        'lines.account': new mongoose.Types.ObjectId(id),
        date: { $gt: base ? base.cutoff : before, ...(end ? { $lte: end } : {}) },
      })
        .select('date voucherNo voucherType narration lines source')
        .sort({ date: 1, createdAt: 1 })
        .limit(STATEMENT_CAP + 1)
        .lean();
      truncated = entries.length > STATEMENT_CAP;
      for (const e of entries.slice(0, STATEMENT_CAP)) {
        e.lines.forEach((l, i) => {
          if (String(l.account) !== id) return;
          lines.push({
            id: `${e._id}:${i}`,
            date: e.date,
            voucherNo: e.voucherNo,
            voucherType: e.voucherType,
            narration: l.narration || e.narration || '',
            source: e.source?.model || '',
            sourceId: e.source?.id ? String(e.source.id) : '',
            against: e.lines.filter((x) => String(x.account) !== id).map((x) => String(x.account)),
            in: round2(l.debit),
            out: round2(l.credit),
          });
        });
      }
      lines = withRunningBalance(anchors, lines);
    }

    const opening = doc.ledger ? balanceAt(anchors, lines, before) : anchorAt(anchors, before)?.balance ?? null;
    const shown = lines.filter((l) => l.date >= viewStart);
    const closing = shown.length > 0 ? shown[shown.length - 1].balance : opening;
    const described = await describeTransactions(shown);
    const head = { since: range ? null : doc.asOf || null, opening, closing, range, truncated };

    if (query.legacy) return res.json({ ...head, rows: described });

    const matched = described.filter((r) => matchesRow(r, query)).reverse(); // newest first
    const extra = { totals: totalsOf(matched), allTotals: totalsOf(described), facets: facetsOf(described) };
    if (query.export) return res.json({ ...head, ...extra, rows: matched, totalItems: matched.length });
    const page = pageOf(matched, query.page, query.limit);
    res.json({ ...head, ...extra, rows: page.items, page: page.page, limit: page.limit, totalItems: page.totalItems, totalPages: page.totalPages });
  } catch (error) {
    res.status(error.status ?? 500).json({ message: error.message });
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
