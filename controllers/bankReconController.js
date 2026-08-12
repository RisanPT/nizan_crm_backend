import mongoose from 'mongoose';
import ChartOfAccount from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import BankStatementLine from '../models/BankStatementLine.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManageFinance = (user) => FINANCE_ROLES.includes(user?.role);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const isId = (v) => mongoose.Types.ObjectId.isValid(v);

// Normalise a description for the dedupe key (case/space/punctuation-insensitive).
const normDesc = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);

const dayKey = (d) => new Date(d).toISOString().slice(0, 10); // yyyy-mm-dd

// Load the bank/cash account and guard access. Returns the lean account or null.
const loadBankAccount = async (accountId) => {
  if (!isId(accountId)) return null;
  const acc = await ChartOfAccount.findById(accountId).lean();
  if (!acc) return null;
  if (!acc.isBank && !acc.isCash) return null;
  return acc;
};

// Signed ledger movement per voucher that touches this account (debit − credit).
// Returns [{ entryId, date, voucherNo, voucherType, narration, amount }].
const ledgerMovements = async (accId, { from, to } = {}) => {
  const q = { status: 'posted', 'lines.account': accId };
  if (from || to) {
    q.date = {};
    if (from) q.date.$gte = new Date(from);
    if (to) q.date.$lte = new Date(to);
  }
  const entries = await JournalEntry.find(q).sort({ date: 1, createdAt: 1 }).limit(20000).lean();
  const moves = [];
  for (const e of entries) {
    let delta = 0;
    for (const l of e.lines) {
      if (String(l.account) !== String(accId)) continue;
      delta += (l.debit || 0) - (l.credit || 0);
    }
    if (round2(delta) === 0) continue; // voucher nets to nothing on this account
    moves.push({
      entryId: String(e._id),
      date: e.date,
      voucherNo: e.voucherNo,
      voucherType: e.voucherType,
      narration: e.narration || '',
      amount: round2(delta),
    });
  }
  return moves;
};

// Ledger closing balance (debit-positive) as of `to`: opening + all posted
// movements dated <= to.
const ledgerClosing = async (account, to) => {
  const accId = account._id;
  let running = account.openingType === 'cr' ? -(account.openingBalance || 0) : account.openingBalance || 0;
  const match = { status: 'posted', 'lines.account': accId };
  if (to) match.date = { $lte: new Date(to) };
  const agg = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account': accId } },
    { $group: { _id: null, dr: { $sum: '$lines.debit' }, cr: { $sum: '$lines.credit' } } },
  ]);
  running += (agg[0]?.dr || 0) - (agg[0]?.cr || 0);
  return round2(running);
};

// @desc    Bank/cash accounts eligible for reconciliation.
// @route   GET /api/accounting/bank/accounts
const getBankAccounts = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const accounts = await ChartOfAccount.find({
      status: 'active',
      $or: [{ isBank: true }, { isCash: true }],
    })
      .sort({ code: 1 })
      .lean();
    res.json(
      accounts.map((a) => ({
        id: a._id,
        code: a.code,
        name: a.name,
        isBank: a.isBank,
        isCash: a.isCash,
      }))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Import parsed statement lines for an account. Idempotent per line.
// @route   POST /api/accounting/bank/import
// @body    { bankAccountId, batchLabel, lines: [{ date, description, refNo, amount, balance }] }
const importStatement = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { bankAccountId, batchLabel = '', lines } = req.body || {};
    const account = await loadBankAccount(bankAccountId);
    if (!account) return res.status(400).json({ message: 'Pick a valid bank or cash account' });
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: 'No statement lines to import' });
    }

    // Build deterministic dedupe keys: occurrence index disambiguates lines
    // that share date+amount+description within the same statement.
    const seen = new Map();
    const docs = [];
    let invalid = 0;
    for (const raw of lines) {
      const amount = round2(raw.amount);
      const date = raw.date ? new Date(raw.date) : null;
      if (!date || Number.isNaN(date.getTime()) || !Number.isFinite(amount) || amount === 0) {
        invalid++;
        continue;
      }
      const base = `${dayKey(date)}|${amount}|${normDesc(raw.description)}`;
      const occ = seen.get(base) || 0;
      seen.set(base, occ + 1);
      docs.push({
        bankAccount: account._id,
        txnDate: date,
        description: String(raw.description || '').trim(),
        refNo: String(raw.refNo || '').trim(),
        amount,
        runningBalance:
          raw.balance === null || raw.balance === undefined ? null : round2(raw.balance),
        importBatch: batchLabel,
        dedupeKey: `${base}#${occ}`,
        createdBy: req.user?._id || null,
      });
    }

    if (docs.length === 0) {
      return res.status(400).json({ message: 'No valid statement lines found', invalid });
    }

    // Skip lines already imported (same account + dedupeKey).
    const keys = docs.map((d) => d.dedupeKey);
    const existing = await BankStatementLine.find({
      bankAccount: account._id,
      dedupeKey: { $in: keys },
    })
      .select('dedupeKey')
      .lean();
    const have = new Set(existing.map((e) => e.dedupeKey));
    const fresh = docs.filter((d) => !have.has(d.dedupeKey));

    if (fresh.length > 0) await BankStatementLine.insertMany(fresh, { ordered: false });

    res.json({
      imported: fresh.length,
      duplicates: docs.length - fresh.length,
      invalid,
      total: lines.length,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Reconciliation view: matched pairs + unmatched on both sides + BRS.
// @route   GET /api/accounting/bank/reconciliation?bankAccountId&from&to
const getReconciliation = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { bankAccountId, from, to } = req.query;
    const account = await loadBankAccount(bankAccountId);
    if (!account) return res.status(400).json({ message: 'Pick a valid bank or cash account' });
    const accId = account._id;

    const stmtQuery = { bankAccount: accId };
    if (from || to) {
      stmtQuery.txnDate = {};
      if (from) stmtQuery.txnDate.$gte = new Date(from);
      if (to) stmtQuery.txnDate.$lte = new Date(to);
    }

    const [stmtLines, moves, bookClosing] = await Promise.all([
      BankStatementLine.find(stmtQuery).sort({ txnDate: 1, createdAt: 1 }).lean(),
      ledgerMovements(accId, { from, to }),
      ledgerClosing(account, to),
    ]);

    const moveById = new Map(moves.map((m) => [m.entryId, m]));
    const matchedEntryIds = new Set(
      stmtLines.filter((s) => s.matchedEntry).map((s) => String(s.matchedEntry))
    );

    const matched = [];
    const unmatchedStatement = [];
    for (const s of stmtLines) {
      if (s.matchedEntry) {
        const mv = moveById.get(String(s.matchedEntry));
        matched.push({
          statementLineId: s._id,
          entryId: String(s.matchedEntry),
          txnDate: s.txnDate,
          description: s.description,
          refNo: s.refNo,
          amount: round2(s.amount),
          voucherNo: mv?.voucherNo || '',
          voucherDate: mv?.date || null,
        });
      } else {
        unmatchedStatement.push({
          id: s._id,
          txnDate: s.txnDate,
          description: s.description,
          refNo: s.refNo,
          amount: round2(s.amount),
          runningBalance: s.runningBalance,
        });
      }
    }

    const unmatchedLedger = moves.filter((m) => !matchedEntryIds.has(m.entryId));

    const unmatchedStatementNet = round2(
      unmatchedStatement.reduce((a, s) => a + s.amount, 0)
    );
    const unmatchedLedgerNet = round2(unmatchedLedger.reduce((a, m) => a + m.amount, 0));

    // Latest statement running balance in the window = statement closing.
    let statementClosing = null;
    for (const s of stmtLines) {
      if (s.runningBalance !== null && s.runningBalance !== undefined) {
        statementClosing = round2(s.runningBalance);
      }
    }

    // BRS: money in the books but not yet on the statement (in-transit) and
    // money on the statement but not yet in the books (bank charges/interest).
    //   expectedStatement = bookClosing − unmatchedLedgerNet + unmatchedStatementNet
    const expectedStatementClosing = round2(
      bookClosing - unmatchedLedgerNet + unmatchedStatementNet
    );
    const difference =
      statementClosing === null ? null : round2(statementClosing - expectedStatementClosing);

    res.json({
      account: { id: account._id, code: account.code, name: account.name },
      bookClosing,
      statementClosing,
      matched,
      unmatchedStatement,
      unmatchedLedger,
      totals: {
        statementCount: stmtLines.length,
        ledgerCount: moves.length,
        matchedCount: matched.length,
        unmatchedStatementCount: unmatchedStatement.length,
        unmatchedLedgerCount: unmatchedLedger.length,
        unmatchedStatementNet,
        unmatchedLedgerNet,
        expectedStatementClosing,
        difference,
        reconciled:
          matched.length > 0 &&
          unmatchedStatement.length === 0 &&
          unmatchedLedger.length === 0,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Auto-match unmatched statement lines to unmatched ledger movements
//          by equal signed amount within a date window (nearest date wins).
// @route   POST /api/accounting/bank/auto-match
// @body    { bankAccountId, dateWindowDays }
const autoMatch = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { bankAccountId, dateWindowDays = 4 } = req.body || {};
    const account = await loadBankAccount(bankAccountId);
    if (!account) return res.status(400).json({ message: 'Pick a valid bank or cash account' });
    const accId = account._id;
    const windowMs = Math.max(0, Number(dateWindowDays) || 0) * 86400000;

    const [stmtLines, moves] = await Promise.all([
      BankStatementLine.find({ bankAccount: accId, status: 'unmatched', matchedEntry: null })
        .sort({ txnDate: 1 })
        .lean(),
      ledgerMovements(accId),
    ]);

    // Ledger movements not already claimed by a matched statement line.
    const claimed = new Set(
      (
        await BankStatementLine.find({ bankAccount: accId, matchedEntry: { $ne: null } })
          .select('matchedEntry')
          .lean()
      ).map((s) => String(s.matchedEntry))
    );
    const available = moves.filter((m) => !claimed.has(m.entryId));

    const ops = [];
    for (const s of stmtLines) {
      const st = new Date(s.txnDate).getTime();
      let best = null;
      let bestDist = Infinity;
      for (const m of available) {
        if (m._used) continue;
        if (round2(m.amount) !== round2(s.amount)) continue;
        const dist = Math.abs(new Date(m.date).getTime() - st);
        if (dist > windowMs) continue;
        if (dist < bestDist) {
          best = m;
          bestDist = dist;
        }
      }
      if (best) {
        best._used = true;
        ops.push({
          updateOne: {
            filter: { _id: s._id },
            update: { $set: { status: 'matched', matchedEntry: best.entryId, matchedAt: new Date() } },
          },
        });
      }
    }

    if (ops.length > 0) await BankStatementLine.bulkWrite(ops);
    res.json({ matched: ops.length, statementUnmatched: stmtLines.length - ops.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Manually link a statement line to a ledger voucher.
// @route   POST /api/accounting/bank/match
// @body    { statementLineId, entryId }
const matchManual = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { statementLineId, entryId } = req.body || {};
    if (!isId(statementLineId) || !isId(entryId)) {
      return res.status(400).json({ message: 'Invalid line or voucher' });
    }
    const line = await BankStatementLine.findById(statementLineId);
    if (!line) return res.status(404).json({ message: 'Statement line not found' });

    const entry = await JournalEntry.findById(entryId).lean();
    if (!entry) return res.status(404).json({ message: 'Voucher not found' });
    const touches = (entry.lines || []).some((l) => String(l.account) === String(line.bankAccount));
    if (!touches) {
      return res.status(400).json({ message: "That voucher doesn't touch this account" });
    }

    // Don't let one voucher be claimed by two statement lines.
    const clash = await BankStatementLine.findOne({
      bankAccount: line.bankAccount,
      matchedEntry: entry._id,
      _id: { $ne: line._id },
    }).lean();
    if (clash) return res.status(400).json({ message: 'That voucher is already matched' });

    line.status = 'matched';
    line.matchedEntry = entry._id;
    line.matchedAt = new Date();
    await line.save();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Undo a match on a statement line.
// @route   POST /api/accounting/bank/unmatch
// @body    { statementLineId }
const unmatch = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { statementLineId } = req.body || {};
    if (!isId(statementLineId)) return res.status(400).json({ message: 'Invalid line' });
    const line = await BankStatementLine.findById(statementLineId);
    if (!line) return res.status(404).json({ message: 'Statement line not found' });
    line.status = 'unmatched';
    line.matchedEntry = null;
    line.matchedAt = null;
    await line.save();
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Delete imported statement lines for an account (optionally a batch).
// @route   DELETE /api/accounting/bank/statement?bankAccountId&batch
const clearStatement = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { bankAccountId, batch } = req.query;
    const account = await loadBankAccount(bankAccountId);
    if (!account) return res.status(400).json({ message: 'Pick a valid bank or cash account' });
    const filter = { bankAccount: account._id };
    if (batch) filter.importBatch = batch;
    const r = await BankStatementLine.deleteMany(filter);
    res.json({ deleted: r.deletedCount || 0 });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export {
  getBankAccounts,
  importStatement,
  getReconciliation,
  autoMatch,
  matchManual,
  unmatch,
  clearStatement,
};
