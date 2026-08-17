import ChartOfAccount from '../models/ChartOfAccount.js';
import JournalEntry from '../models/JournalEntry.js';
import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import AdminExpense from '../models/AdminExpense.js';
import Salary from '../models/Salary.js';
import HraRecord from '../models/HraRecord.js';
import FuelExpense from '../models/FuelExpense.js';
import Subscription from '../models/Subscription.js';
import Purchase from '../models/Purchase.js';
import InventoryProduct from '../models/InventoryProduct.js';
import Employee from '../models/Employee.js';
import Budget from '../models/Budget.js';
import MonthlyTarget from '../models/MonthlyTarget.js';
import Region from '../models/Region.js';
import CeoDecision from '../models/CeoDecision.js';
import { accountMovements, round2 } from './accountingController.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canView = (u) => FINANCE_ROLES.includes(u?.role);

const DEAD_BOOKING = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const isLiveBooking = (st) => !DEAD_BOOKING.includes(String(st || '').toLowerCase());

const pct = (num, den) => (den ? round2((num / den) * 100) : 0);
const monthLabel = (m, y) =>
  `${['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m]} ${y}`;

// Period movement of income/expense accounts from the posted ledger — the same
// basis as the Profit & Loss report, so figures reconcile.
async function pnlFor(accounts, from, to) {
  const mv = await accountMovements({ from, to });
  let income = 0;
  let expense = 0;
  let depreciation = 0;
  let interest = 0;
  let tax = 0;
  let cogs = 0;
  for (const a of accounts) {
    const m = mv.get(String(a._id)) || { debit: 0, credit: 0 };
    if (a.nature === 'income') {
      income += m.credit - m.debit;
    } else if (a.nature === 'expense') {
      const amt = m.debit - m.credit;
      expense += amt;
      const name = String(a.name || '');
      const group = String(a.group || '');
      if (a.code === '5900' || /depreciat/i.test(name)) depreciation += amt;
      if (/interest/i.test(name)) interest += amt;
      if (/income tax|\btds\b/i.test(name)) tax += amt;
      // Direct cost of delivering the service (best-effort classification).
      if (/cost of|direct|material|consumable|artist payout|freelanc|product/i.test(`${name} ${group}`)) {
        cogs += amt;
      }
    }
  }
  return {
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
    depreciation: round2(depreciation),
    interest: round2(interest),
    tax: round2(tax),
    cogs: round2(cogs),
  };
}

// Aging of a set of {amount, days} obligations vs the as-on date.
function bucketise(items) {
  const b = { current: 0, days30: 0, days60: 0, days90: 0, notYetDue: 0 };
  let total = 0;
  for (const it of items) {
    if (it.amount <= 0.5) continue;
    total += it.amount;
    if (it.days < 0) b.notYetDue += it.amount;
    else if (it.days <= 30) b.current += it.amount;
    else if (it.days <= 60) b.days30 += it.amount;
    else if (it.days <= 90) b.days60 += it.amount;
    else b.days90 += it.amount;
  }
  for (const k of Object.keys(b)) b[k] = round2(b[k]);
  const overdue = round2(b.current + b.days30 + b.days60 + b.days90);
  return { total: round2(total), overdue, notYetDue: b.notYetDue, buckets: b };
}
const daysBetween = (due, asOf) =>
  Math.floor((asOf.getTime() - new Date(due).getTime()) / 86400000);

// @desc   Composite Month-End Review — all 10 sections in one payload.
// @route  GET /api/reports/month-end?month=&year=
export const getMonthEndReview = async (req, res) => {
  if (!canView(req.user)) {
    return res.status(403).json({ message: 'No finance access' });
  }
  try {
    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();

    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59, 999);
    const prevFrom = new Date(year, month - 2, 1);
    const prevTo = new Date(year, month - 1, 0, 23, 59, 59, 999);
    const inPeriod = (d) => d && new Date(d) >= from && new Date(d) <= to;

    const [
      accounts, bookings, collections, adminExpenses, salaries, hras, fuels,
      subscriptions, purchases, products, employeeCount, budgets, target, regions,
      mvToDate,
    ] = await Promise.all([
      ChartOfAccount.find({}).lean(),
      Booking.find({}).select('customerName phone totalPrice collectedAmount bookingDate serviceStart createdAt status regionId').limit(50000).lean(),
      Collection.find({ status: 'verified' }).select('amount date').lean(),
      AdminExpense.find({ source: { $ne: 'hra' } }).select('amount category department date').lean(),
      Salary.find({ status: 'paid', month, year }).select('netAmount department').lean(),
      HraRecord.find({}).select('amount date department').lean(),
      FuelExpense.find({}).select('totalAmount date').lean(),
      Subscription.find({ status: { $ne: 'cancelled' } }).select('name cost renewalDate department billingCycle').lean(),
      Purchase.find({ paid: { $ne: true } }).select('supplier vendor total gstAmount amountPaid date dueDate').populate('vendor', 'name').lean(),
      InventoryProduct.find({}).select('quantity price').lean(),
      Employee.countDocuments({ status: 'active' }),
      Budget.find({ month, year }).lean(),
      MonthlyTarget.findOne({ month, year }).lean(),
      Region.find({}).select('name').lean(),
      accountMovements({ to }), // cumulative balances as of period end
    ]);

    const regionName = new Map(regions.map((r) => [String(r._id), r.name]));

    // ── 1 & 2. Revenue + Profitability (ledger basis) ──────────────────────
    const cur = await pnlFor(accounts, from, to);
    const prev = await pnlFor(accounts, prevFrom, prevTo);
    const ebitda = round2(cur.net + cur.depreciation + cur.interest + cur.tax);
    const grossProfit = round2(cur.income - cur.cogs);

    const liveBookings = bookings.filter((b) => isLiveBooking(b.status));
    const periodBookings = liveBookings.filter((b) => inPeriod(b.bookingDate || b.createdAt));
    const orders = periodBookings.length;
    const bookedValue = round2(periodBookings.reduce((s, b) => s + (b.totalPrice || 0), 0));

    const byUnitMap = new Map();
    for (const b of periodBookings) {
      const key = b.regionId ? regionName.get(String(b.regionId)) || 'Other' : 'Unassigned';
      byUnitMap.set(key, round2((byUnitMap.get(key) || 0) + (b.totalPrice || 0)));
    }
    const byUnit = [...byUnitMap.entries()]
      .map(([label, amount]) => ({ label, amount }))
      .sort((a, b) => b.amount - a.amount);

    // ── 3. Cash flow ───────────────────────────────────────────────────────
    const cashReceived = round2(
      collections.filter((c) => inPeriod(c.date)).reduce((s, c) => s + (c.amount || 0), 0),
    );
    const cashPaid = round2(
      adminExpenses.filter((e) => inPeriod(e.date)).reduce((s, e) => s + (e.amount || 0), 0) +
        salaries.reduce((s, x) => s + (x.netAmount || 0), 0) +
        hras.filter((h) => inPeriod(h.date)).reduce((s, h) => s + (h.amount || 0), 0) +
        fuels.filter((f) => inPeriod(f.date)).reduce((s, f) => s + (f.totalAmount || 0), 0),
    );

    // Bank + cash closing balances from the ledger (opening + movement to date).
    let bankBalance = 0;
    let cashBalance = 0;
    for (const a of accounts) {
      if (!a.isBank && !a.isCash) continue;
      const m = mvToDate.get(String(a._id)) || { debit: 0, credit: 0 };
      const openDr = a.openingType === 'dr' ? a.openingBalance || 0 : 0;
      const openCr = a.openingType === 'cr' ? a.openingBalance || 0 : 0;
      const net = openDr + m.debit - openCr - m.credit;
      if (a.isBank) bankBalance += net;
      else cashBalance += net;
    }
    bankBalance = round2(bankBalance);
    cashBalance = round2(cashBalance);

    // ── 4. Receivables aging (as on period end) ────────────────────────────
    const arItems = [];
    const arParties = [];
    for (const b of liveBookings) {
      const bal = round2((b.totalPrice || 0) - (b.collectedAmount || 0));
      if (bal <= 0.5) continue;
      const days = daysBetween(b.serviceStart || b.bookingDate || b.createdAt, to);
      arItems.push({ amount: bal, days });
      arParties.push({ name: b.customerName || 'Unknown', amount: bal, days });
    }
    const ar = bucketise(arItems);
    const highRisk = arParties
      .filter((p) => p.days > 90)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 8)
      .map((p) => ({ name: p.name, amount: round2(p.amount), daysOverdue: p.days }));
    const periodInvoiced = bookedValue;
    const collectionEfficiency = Math.min(100, pct(cashReceived, periodInvoiced));

    // ── 5. Payables aging + upcoming commitments ───────────────────────────
    const apItems = [];
    for (const p of purchases) {
      const bal = round2((p.total || 0) + (p.gstAmount || 0) - (p.amountPaid || 0));
      if (bal <= 0.5) continue;
      apItems.push({ amount: bal, days: daysBetween(p.dueDate || p.date, to) });
    }
    const ap = bucketise(apItems);
    const soon = new Date(to.getTime() + 30 * 86400000);
    const upcoming = [];
    for (const s of subscriptions) {
      if (s.renewalDate && new Date(s.renewalDate) >= to && new Date(s.renewalDate) <= soon) {
        upcoming.push({ label: `${s.name} (subscription)`, amount: round2(s.cost || 0), dueDate: s.renewalDate });
      }
    }
    for (const p of purchases) {
      const bal = round2((p.total || 0) + (p.gstAmount || 0) - (p.amountPaid || 0));
      if (bal > 0.5 && p.dueDate && new Date(p.dueDate) >= to && new Date(p.dueDate) <= soon) {
        upcoming.push({ label: (p.vendor && p.vendor.name) || p.supplier || 'Vendor bill', amount: bal, dueDate: p.dueDate });
      }
    }
    upcoming.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

    // ── 6. Budget vs Actual (by expense category) ──────────────────────────
    const actualByCat = new Map();
    for (const e of adminExpenses) {
      if (!inPeriod(e.date)) continue;
      const c = e.category || 'General';
      actualByCat.set(c, round2((actualByCat.get(c) || 0) + (e.amount || 0)));
    }
    const budgetCats = new Set([...budgets.map((b) => b.category), ...actualByCat.keys()]);
    const budgetMap = new Map(budgets.map((b) => [b.category, b.amount || 0]));
    const budgetRows = [...budgetCats]
      .map((cat) => {
        const budget = round2(budgetMap.get(cat) || 0);
        const actual = round2(actualByCat.get(cat) || 0);
        return { category: cat, budget, actual, variance: round2(budget - actual), variancePct: pct(budget - actual, budget) };
      })
      .sort((a, b) => b.actual - a.actual);
    const totalBudget = round2(budgetRows.reduce((s, r) => s + r.budget, 0));
    const totalActual = round2(budgetRows.reduce((s, r) => s + r.actual, 0));

    // ── 7. Working capital ─────────────────────────────────────────────────
    const inventoryValue = round2(products.reduce((s, p) => s + (p.quantity || 0) * (p.price || 0), 0));
    // GST net payable this period (output − input) — a current liability.
    const codeMv = (code, side) => {
      const acc = accounts.find((a) => a.code === code);
      if (!acc) return 0;
      const m = mvToDate.get(String(acc._id)) || { debit: 0, credit: 0 };
      return side === 'cr' ? m.credit - m.debit : m.debit - m.credit;
    };
    const gstNetPayable = round2(
      codeMv('2100', 'cr') + codeMv('2110', 'cr') + codeMv('2120', 'cr') - codeMv('1300', 'dr'),
    );
    const currentAssets = round2(bankBalance + cashBalance + ar.total + inventoryValue);
    const currentLiabilities = round2(ap.total + Math.max(0, gstNetPayable));
    const workingCapital = round2(currentAssets - currentLiabilities);
    const currentRatio = currentLiabilities > 0 ? round2(currentAssets / currentLiabilities) : null;

    // ── 8. KPIs ────────────────────────────────────────────────────────────
    const burnRate = cur.net < 0 ? round2(-cur.net) : 0;
    const cashRunwayMonths = burnRate > 0 ? round2((bankBalance + cashBalance) / burnRate) : null;
    const kpis = {
      employeeCount,
      revenuePerEmployee: employeeCount ? round2(cur.income / employeeCount) : 0,
      ebitdaMarginPct: pct(ebitda, cur.income),
      netMarginPct: pct(cur.net, cur.income),
      burnRate,
      cashRunwayMonths,
    };

    // ── 9. Risk review ─────────────────────────────────────────────────────
    // Unusual transactions: the largest hand-keyed (non-auto) or voided vouchers
    // this period — worth a CEO glance.
    const manualEntries = await JournalEntry.aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $addFields: { amount: { $sum: '$lines.debit' }, auto: { $ifNull: ['$source.model', null] } } },
      { $match: { $or: [{ auto: null }, { status: 'void' }] } },
      { $sort: { amount: -1 } },
      { $limit: 6 },
      { $project: { voucherNo: 1, narration: 1, amount: 1, date: 1, status: 1, auto: 1 } },
    ]);
    const unusual = manualEntries.map((e) => ({
      voucherNo: e.voucherNo,
      narration: e.narration || '',
      amount: round2(e.amount),
      date: e.date,
      reason: e.status === 'void' ? 'Voided voucher' : 'Manual (hand-keyed) entry',
    }));

    // ── Cash-flow forecast: next 3 months (60–90 days) ─────────────────────
    // Inflow = receivables coming due (by event date); outflow = the current
    // expense run-rate plus subscription renewals landing in that month.
    const forecast = [];
    let runningCash = round2(bankBalance + cashBalance);
    const runRateOpex = cashPaid; // this month's operating cash-out as the baseline
    for (let k = 1; k <= 3; k++) {
      const total = year * 12 + (month - 1) + k;
      const fy = Math.floor(total / 12);
      const fm = (total % 12) + 1;
      const fFrom = new Date(fy, fm - 1, 1);
      const fTo = new Date(fy, fm, 0, 23, 59, 59, 999);
      const within = (d) => d && new Date(d) >= fFrom && new Date(d) <= fTo;
      let inflow = 0;
      for (const b of liveBookings) {
        const bal = round2((b.totalPrice || 0) - (b.collectedAmount || 0));
        if (bal > 0.5 && within(b.serviceStart || b.bookingDate)) inflow += bal;
      }
      let subOut = 0;
      for (const s of subscriptions) if (within(s.renewalDate)) subOut += s.cost || 0;
      const outflow = round2(runRateOpex + subOut);
      const net = round2(inflow - outflow);
      runningCash = round2(runningCash + net);
      forecast.push({ label: monthLabel(fm, fy), inflow: round2(inflow), outflow, net, closingCash: runningCash });
    }

    // ── CAC / LTV ──────────────────────────────────────────────────────────
    const firstSeen = new Map();
    for (const b of liveBookings) {
      const key = `${b.customerName || ''}|${b.phone || ''}`;
      const d = new Date(b.bookingDate || b.createdAt);
      if (!firstSeen.has(key) || d < firstSeen.get(key)) firstSeen.set(key, d);
    }
    let newCustomers = 0;
    for (const d of firstSeen.values()) if (d >= from && d <= to) newCustomers++;
    const distinctCustomers = firstSeen.size;
    const lifetimeRevenue = round2(liveBookings.reduce((s, b) => s + (b.totalPrice || 0), 0));
    const marketingSpend = round2(
      adminExpenses
        .filter((e) => inPeriod(e.date) && /market/i.test(`${e.category || ''} ${e.department || ''}`))
        .reduce((s, e) => s + (e.amount || 0), 0) +
        subscriptions.filter((s) => /market/i.test(s.department || '')).reduce((s, x) => s + (x.cost || 0), 0),
    );
    kpis.customerAcquisitionCost = newCustomers ? round2(marketingSpend / newCustomers) : 0;
    kpis.customerLifetimeValue = distinctCustomers ? round2(lifetimeRevenue / distinctCustomers) : 0;
    kpis.newCustomers = newCustomers;
    kpis.marketingSpend = marketingSpend;

    const openDecisions = await CeoDecision.countDocuments({ status: { $in: ['pending', 'deferred'] } });

    // ── Targets (vs actual) ────────────────────────────────────────────────
    const targets = target
      ? {
          revenue: round2(target.revenueTarget || 0),
          profit: round2(target.profitTarget || 0),
          collection: round2(target.collectionTarget || 0),
          expenseLimit: round2(target.expenseLimit || 0),
          allocations: (target.allocations || []).map((a) => ({ name: a.name, amount: round2(a.amount || 0) })),
          notes: target.notes || '',
        }
      : null;

    res.json({
      period: { month, year, label: monthLabel(month, year), from, to },
      targets,
      revenue: {
        total: cur.income,
        previous: prev.income,
        growthPct: pct(cur.income - prev.income, prev.income),
        target: targets?.revenue ?? null,
        targetAchievedPct: targets?.revenue ? pct(cur.income, targets.revenue) : null,
        orders,
        avgOrderValue: orders ? round2(bookedValue / orders) : 0,
        byUnit,
      },
      profitability: {
        revenue: cur.income,
        grossProfit,
        grossMarginPct: pct(grossProfit, cur.income),
        ebitda,
        ebitdaMarginPct: pct(ebitda, cur.income),
        netProfit: cur.net,
        netMarginPct: pct(cur.net, cur.income),
        depreciation: cur.depreciation,
        totalExpense: cur.expense,
        target: targets?.profit ?? null,
        targetAchievedPct: targets?.profit ? pct(cur.net, targets.profit) : null,
        note: cur.cogs > 0
          ? 'Gross profit uses expense accounts classified as direct/cost-of-service.'
          : 'No direct-cost accounts classified, so gross profit ≈ revenue. Tag cost-of-service accounts to refine.',
      },
      cashFlow: {
        received: cashReceived,
        paid: cashPaid,
        net: round2(cashReceived - cashPaid),
        bankBalance,
        cashBalance,
        totalLiquid: round2(bankBalance + cashBalance),
        forecast,
      },
      receivables: {
        outstanding: ar.total,
        overdue: ar.overdue,
        notYetDue: ar.notYetDue,
        buckets: ar.buckets,
        collectionEfficiencyPct: collectionEfficiency,
        highRisk,
      },
      payables: {
        outstanding: ap.total,
        overdue: ap.overdue,
        buckets: ap.buckets,
        upcoming: upcoming.slice(0, 10),
      },
      budgetVsActual: {
        rows: budgetRows,
        totalBudget,
        totalActual,
        totalVariance: round2(totalBudget - totalActual),
      },
      workingCapital: {
        inventoryValue,
        receivables: ar.total,
        payables: ap.total,
        currentAssets,
        currentLiabilities,
        workingCapital,
        currentRatio,
      },
      kpis,
      risk: {
        gstNetPayable,
        gstOutput: round2(codeMv('2100', 'cr') + codeMv('2110', 'cr') + codeMv('2120', 'cr')),
        gstInputCredit: round2(codeMv('1300', 'dr')),
        unusualTransactions: unusual,
      },
      openDecisions,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Monthly planning targets ──────────────────────────────────────────────

// @route  GET /api/reports/targets?month=&year=
export const getMonthlyTarget = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();
    const doc = await MonthlyTarget.findOne({ month, year }).lean();
    res.json(doc || { month, year, revenueTarget: 0, profitTarget: 0, collectionTarget: 0, expenseLimit: 0, allocations: [], notes: '' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route  PUT /api/reports/targets  (upsert by month+year)
export const saveMonthlyTarget = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ message: 'month and year are required' });
    const update = {
      revenueTarget: Number(req.body.revenueTarget) || 0,
      profitTarget: Number(req.body.profitTarget) || 0,
      collectionTarget: Number(req.body.collectionTarget) || 0,
      expenseLimit: Number(req.body.expenseLimit) || 0,
      allocations: Array.isArray(req.body.allocations)
        ? req.body.allocations
            .filter((a) => a && a.name)
            .map((a) => ({ name: String(a.name), amount: Number(a.amount) || 0 }))
        : [],
      notes: req.body.notes || '',
      setBy: req.user?._id || null,
    };
    const doc = await MonthlyTarget.findOneAndUpdate(
      { month: Number(month), year: Number(year) },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
