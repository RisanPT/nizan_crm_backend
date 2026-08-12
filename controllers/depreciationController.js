import mongoose from 'mongoose';
import Asset from '../models/Asset.js';
import ChartOfAccount from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import DepreciationRun from '../models/DepreciationRun.js';
import { fyLabelFor, nextVoucherNo, ensureLockDate, isLocked } from '../services/posting.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canManageFinance = (user) => FINANCE_ROLES.includes(user?.role);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Ledger accounts the run posts to (seeded in the core Chart of Accounts).
const DEP_EXPENSE_CODE = '5900'; // Depreciation (expense)
const ACCUM_DEP_CODE = '1590'; // Accumulated Depreciation (contra-asset)

const ensureAccount = async (code, name, nature, group) => {
  let acc = await ChartOfAccount.findOne({ code });
  if (!acc) acc = await ChartOfAccount.create({ code, name, nature, group, isSystem: true });
  return acc;
};

// Fractional months between two dates (approximate day fraction is fine here).
const monthsBetween = (start, end) => {
  const s = new Date(start);
  const e = new Date(end);
  if (e <= s) return 0;
  let months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
  months += (e.getDate() - s.getDate()) / 30;
  return Math.max(0, months);
};

// Target accumulated depreciation for an asset as-of `asOf`, capped so book
// value never falls below salvage.
const accumulatedAsOf = (asset, asOf) => {
  const cost = round2((Number(asset.value) || 0) * (Number(asset.quantity) || 1));
  const salvage = Math.min(Number(asset.salvageValue) || 0, cost);
  const base = Math.max(0, cost - salvage);
  const start = asset.depreciationStart || asset.purchaseDate;
  if (!start || base <= 0) return 0;
  const at = new Date(asOf);
  if (at <= new Date(start)) return 0;
  const months = monthsBetween(start, at);
  if (months <= 0) return 0;

  if ((asset.depreciationMethod || 'straight_line') === 'wdv') {
    const rate = Number(asset.depreciationRate) || 0;
    if (rate <= 0) return 0;
    const monthly = rate / 100 / 12;
    let book = cost;
    let accum = 0;
    const whole = Math.floor(months);
    const frac = months - whole;
    for (let i = 0; i < whole; i++) {
      const room = book - salvage;
      if (room <= 0) break;
      const dep = Math.min(book * monthly, room);
      accum += dep;
      book -= dep;
    }
    if (frac > 0 && book - salvage > 0) {
      accum += Math.min(book * monthly * frac, book - salvage);
    }
    return round2(Math.min(accum, base));
  }

  // Straight-line: annual = base / life, or base × rate%.
  let annual = 0;
  if ((Number(asset.usefulLifeYears) || 0) > 0) annual = base / Number(asset.usefulLifeYears);
  else if ((Number(asset.depreciationRate) || 0) > 0) annual = (base * Number(asset.depreciationRate)) / 100;
  else return 0;
  return round2(Math.min(annual * (months / 12), base));
};

// Build a per-asset schedule as-of `asOf`. `periodDepreciation` is the amount a
// run would post now (target minus what's already accumulated; never negative).
const buildSchedule = (assets, asOf) => {
  const rows = [];
  const totals = {
    count: 0,
    totalCost: 0,
    totalAccumulated: 0,
    totalPeriodDepreciation: 0,
    totalBookValue: 0,
  };
  for (const a of assets) {
    const cost = round2((Number(a.value) || 0) * (Number(a.quantity) || 1));
    const current = round2(a.accumulatedDepreciation || 0);
    const target = accumulatedAsOf(a, asOf);
    const period = round2(Math.max(0, target - current));
    const bookValue = round2(cost - target);
    rows.push({
      assetId: a._id,
      name: a.name,
      assetType: a.assetType,
      category: a.category,
      method: a.depreciationMethod || 'straight_line',
      rate: Number(a.depreciationRate) || 0,
      usefulLifeYears: Number(a.usefulLifeYears) || 0,
      cost,
      salvageValue: Math.min(Number(a.salvageValue) || 0, cost),
      currentAccumulated: current,
      targetAccumulated: target,
      periodDepreciation: period,
      bookValue,
      depreciationStart: a.depreciationStart || a.purchaseDate || null,
      fullyDepreciated: target >= cost - Math.min(Number(a.salvageValue) || 0, cost) - 0.01,
    });
    totals.count += 1;
    totals.totalCost = round2(totals.totalCost + cost);
    totals.totalAccumulated = round2(totals.totalAccumulated + target);
    totals.totalPeriodDepreciation = round2(totals.totalPeriodDepreciation + period);
    totals.totalBookValue = round2(totals.totalBookValue + bookValue);
  }
  return { rows, totals };
};

// Default as-of date = today (end of day) when the caller doesn't pass one.
const resolveAsOf = (v) => {
  if (v) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
};

// @desc    Preview depreciation for all depreciable assets as-of a date.
// @route   GET /api/assets/depreciation/schedule?asOf
const getSchedule = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const asOf = resolveAsOf(req.query.asOf);
    const assets = await Asset.find({ depreciable: true, status: { $ne: 'disposed' } }).lean();
    const { rows, totals } = buildSchedule(assets, asOf);
    res.json({ asOf, rows, totals });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Post depreciation up to `asOf`: one Dr Depreciation / Cr Accumulated
//          Depreciation voucher, and update each asset's accumulated total.
// @route   POST /api/assets/depreciation/run
// @body    { asOf }
const runDepreciation = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const asOf = resolveAsOf(req.body?.asOf);
    await ensureLockDate();
    if (isLocked(asOf)) {
      return res.status(400).json({ message: 'That date is in a closed period. Reopen the books to post depreciation.' });
    }

    const assets = await Asset.find({ depreciable: true, status: { $ne: 'disposed' } }).lean();
    const { rows } = buildSchedule(assets, asOf);
    const charged = rows.filter((r) => r.periodDepreciation > 0.005);
    const total = round2(charged.reduce((a, r) => a + r.periodDepreciation, 0));

    if (total < 0.01 || charged.length === 0) {
      return res.json({
        posted: false,
        total: 0,
        assetsAffected: 0,
        message: 'All depreciable assets are already up to date as of this date.',
      });
    }

    const [depExpense, accumDep] = await Promise.all([
      ensureAccount(DEP_EXPENSE_CODE, 'Depreciation', 'expense', 'Non-cash'),
      ensureAccount(ACCUM_DEP_CODE, 'Accumulated Depreciation', 'asset', 'Fixed Assets'),
    ]);

    const run = await DepreciationRun.create({
      periodEnd: asOf,
      totalAmount: total,
      lines: charged.map((r) => ({
        asset: r.assetId,
        assetName: r.name,
        method: r.method,
        amount: r.periodDepreciation,
        accumulatedAfter: r.targetAccumulated,
        bookValueAfter: r.bookValue,
      })),
      createdBy: req.user?._id || null,
    });

    const fyLabel = fyLabelFor(asOf);
    const voucherNo = await nextVoucherNo('journal', fyLabel);
    const entry = await JournalEntry.create({
      date: asOf,
      voucherNo,
      voucherType: 'journal',
      narration: `Depreciation for ${charged.length} asset${charged.length === 1 ? '' : 's'} as of ${new Date(asOf).toISOString().slice(0, 10)}`,
      lines: [
        { account: depExpense._id, debit: total, credit: 0, narration: 'Depreciation expense' },
        { account: accumDep._id, debit: 0, credit: total, narration: 'Accumulated depreciation' },
      ],
      source: { model: 'DepreciationRun', id: run._id },
      status: 'posted',
      fyLabel,
      postedAt: new Date(),
      createdBy: req.user?._id || null,
    });

    run.journalEntry = entry._id;
    await run.save();

    // Update each asset's accumulated depreciation to the new target.
    await Asset.bulkWrite(
      charged.map((r) => ({
        updateOne: {
          filter: { _id: r.assetId },
          update: { $set: { accumulatedDepreciation: r.targetAccumulated, lastDepreciatedOn: asOf } },
        },
      }))
    );

    res.json({
      posted: true,
      total,
      assetsAffected: charged.length,
      voucherNo,
      runId: run._id,
      asOf,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    History of posted depreciation runs.
// @route   GET /api/assets/depreciation/runs
const getRuns = async (req, res) => {
  if (!canManageFinance(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const runs = await DepreciationRun.find({})
      .populate('journalEntry', 'voucherNo')
      .sort({ periodEnd: -1, createdAt: -1 })
      .limit(100)
      .lean();
    res.json(
      runs.map((r) => ({
        id: r._id,
        periodEnd: r.periodEnd,
        totalAmount: round2(r.totalAmount),
        assetsAffected: (r.lines || []).length,
        voucherNo: r.journalEntry?.voucherNo || '',
        createdAt: r.createdAt,
      }))
    );
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export { getSchedule, runDepreciation, getRuns };
