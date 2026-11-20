import Collection from '../models/Collection.js';
import Expense from '../models/Expense.js';
import Booking from '../models/Booking.js';
import Lead from '../models/Lead.js';
import SalesReturn from '../models/SalesReturn.js';
import { makeCountsTowardSales } from '../utils/salesRules.js';
import { followingPeriod, resolveReportPeriod } from '../utils/reportPeriod.js';
import { computeAllocations } from '../services/mealAllocation.js';
import { buildFinanceRows } from '../utils/financeReportRows.js';
import { financeCsv, financeXlsx, newFinancePdf, writeFinancePdf } from '../services/financeReportFiles.js';

export const getFinanceReport = async (req, res) => {
  try {
    const { employeeId, format } = req.query;
    // the dates: from + to (IST days, both inclusive), or the older month + year
    const period = resolveReportPeriod(req.query);
    if (period.error) return res.status(400).json({ message: period.error, code: period.code });

    const filter = {
      date: { $gte: period.start, $lte: period.end },
    };

    if (employeeId && employeeId !== 'all') {
      filter.employeeId = employeeId;
    }

    const collections = await Collection.find(filter)
      .populate('employeeId', 'name')
      .populate('bookingId', 'bookingNumber customerName serviceStart')
      .populate('trialId', 'trialNumber clientName')
      .lean();

    const expenses = await Expense.find(filter)
      .populate('employeeId', 'name')
      .populate('bookingId', 'bookingNumber customerName service serviceStart serviceEnd travelDistanceKm bookingItems.travelDistanceKm')
      .lean();

    // Which work each expense belongs to — the artist's own pick, else placed by the time of the meal: the
    // same answer the By Work screen gives. If it cannot be worked out the report still comes, with the
    // works the artists tied their expenses to themselves.
    let allocation;
    try {
      allocation = await computeAllocations(expenses);
    } catch (err) {
      console.error('finance report: could not place expenses under works:', err.message);
    }
    const rows = buildFinanceRows({ collections, expenses, allocation });

    // what the file is called and says: the dates for a range, "month_year" as before for a month
    const named = period.custom ? { tag: period.tag, label: period.label } : { tag: `${period.month}_${period.year}`, label: `${period.month}/${period.year}` };
    if (format === 'csv') {
      res.header('Content-Type', 'text/csv');
      res.attachment(`Finance_Report_${named.tag}.csv`);
      return res.send(financeCsv(rows));
    }
    if (format === 'xlsx' || format === 'excel') {
      res.attachment(`Finance_Report_${named.tag}.xlsx`);
      return res.send(await financeXlsx(rows, named));
    }
    const doc = newFinancePdf();
    res.header('Content-Type', 'application/pdf');
    res.attachment(`Finance_Report_${named.tag}.pdf`);
    doc.pipe(res);
    writeFinancePdf(doc, rows, named);
    doc.end();
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Monthly Financial-Analyst Report ────────────────────────────────────────
// Consolidates the Sales + Customer-Relations + (CRM-owned) Finance data the
// Financial Analyst needs each month. Sourced entirely from bookings / leads /
// collections. Month cohort is by EVENT date (bookingDate), matching the app's
// existing month filters. Returns JSON; the client renders + exports it.
const CANCELLED_STATUSES = ['cancelled', 'rejected'];
const isCancelled = (s) => CANCELLED_STATUSES.includes(String(s ?? '').toLowerCase());
const last10 = (v) => String(v ?? '').replace(/\D/g, '').slice(-10);
const pkgOf = (b) => (String(b.service ?? '').trim() || 'Unspecified');
const balanceOf = (b) =>
  Math.max(0, (b.totalPrice || 0) - (b.advanceAmount || 0) - (b.discountAmount || 0));

export const getFinancialAnalystReport = async (req, res) => {
  try {
    // the dates: from + to (IST days, both inclusive), or `month=YYYY-MM` (this month when neither is given)
    const period = resolveReportPeriod(req.query, { monthIsText: true, defaultToThisMonth: true });
    if (period.error) return res.status(400).json({ message: period.error, code: period.code });
    const { start, end } = period;
    // "forward" bookings: the stretch of the same length that follows (next month, for a month)
    const { start: nextStart, end: nextEnd } = followingPeriod(period);
    const now = new Date();

    // ── Bookings whose event falls in the month ──
    const bookings = await Booking.find({ bookingDate: { $gte: start, $lte: end } })
      .select(
        'service customerName phone district totalPrice advanceAmount discountAmount status bookingDate serviceEnd internalRemarks createdBy'
      )
      .lean();

    const active = bookings.filter((b) => !isCancelled(b.status));
    // Bookings entered by users excluded from sales totals add no revenue.
    const countsTowardSales = await makeCountsTowardSales();
    const saleValue = (b) => (countsTowardSales(b) ? b.totalPrice || 0 : 0);
    const cancelled = bookings.filter((b) => isCancelled(b.status));

    // Package breakdown (dynamic — every package that appears).
    const pkgMap = new Map();
    for (const b of active) {
      const k = pkgOf(b);
      const e = pkgMap.get(k) || { package: k, count: 0, revenue: 0, advance: 0, balance: 0, cancellations: 0 };
      e.count += 1;
      e.revenue += saleValue(b);
      e.advance += b.advanceAmount || 0;
      e.balance += balanceOf(b);
      pkgMap.set(k, e);
    }
    for (const b of cancelled) {
      const k = pkgOf(b);
      const e = pkgMap.get(k) || { package: k, count: 0, revenue: 0, advance: 0, balance: 0, cancellations: 0 };
      e.cancellations += 1;
      pkgMap.set(k, e);
    }
    const packageBreakdown = [...pkgMap.values()].sort((a, b) => b.revenue - a.revenue);

    const salesTotals = {
      totalBookings: active.length,
      totalRevenue: active.reduce((s, b) => s + saleValue(b), 0),
      totalAdvance: active.reduce((s, b) => s + (b.advanceAmount || 0), 0),
      totalBalance: active.reduce((s, b) => s + balanceOf(b), 0),
      totalDiscounts: active.reduce((s, b) => s + (b.discountAmount || 0), 0),
      totalCancellations: cancelled.length,
    };

    // ── Leads (enquiries + source split + referrals) ──
    const leads = await Lead.find({
      $or: [
        { leadDate: { $gte: start, $lte: end } },
        { leadDate: { $exists: false }, createdAt: { $gte: start, $lte: end } },
        { leadDate: null, createdAt: { $gte: start, $lte: end } },
      ],
    })
      .select('source')
      .lean();
    const leadSource = {};
    for (const l of leads) {
      const k = String(l.source ?? '').trim() || 'Other';
      leadSource[k] = (leadSource[k] || 0) + 1;
    }
    const enquiries = leads.length;
    const referralLeads = leads.filter(
      (l) => String(l.source ?? '').toLowerCase() === 'reference'
    ).length;

    // ── Forward bookings (events next month) ──
    const forward = await Booking.find({
      bookingDate: { $gte: nextStart, $lte: nextEnd },
      status: { $nin: ['cancelled', 'rejected', 'Cancelled', 'Rejected'] },
    })
      .select('totalPrice createdBy')
      .lean();
    const forwardBookings = {
      count: forward.length,
      value: forward.reduce((s, b) => s + saleValue(b), 0),
    };

    // ── Customer Relations ──
    // District-wise (active bookings this month).
    const distMap = new Map();
    for (const b of active) {
      const k = String(b.district ?? '').trim() || 'Unspecified';
      const e = distMap.get(k) || { district: k, count: 0, revenue: 0 };
      e.count += 1;
      e.revenue += saleValue(b);
      distMap.set(k, e);
    }
    const districtBreakdown = [...distMap.values()].sort((a, b) => b.revenue - a.revenue);

    // New vs repeat — a client is "repeat" if their phone had a booking before this month.
    const phones = [...new Set(active.map((b) => last10(b.phone)).filter((p) => p.length === 10))];
    let newClients = 0;
    let repeatClients = 0;
    if (phones.length) {
      const priorRx = phones.map((p) => new RegExp(`${p}$`));
      const prior = await Booking.find({
        bookingDate: { $lt: start },
        phone: { $in: priorRx },
      })
        .select('phone')
        .lean();
      const priorSet = new Set(prior.map((p) => last10(p.phone)));
      for (const p of phones) {
        if (priorSet.has(p)) repeatClients += 1;
        else newClients += 1;
      }
    }

    // Cancellations with reason (internalRemarks is the closest field).
    const cancellations = cancelled.map((b) => ({
      customer: b.customerName || '—',
      package: pkgOf(b),
      reason: String(b.internalRemarks ?? '').trim() || '—',
    }));

    // ── Finance (CRM-owned slice) ──
    // Cash collected = verified collections dated in the month.
    const collections = await Collection.find({
      date: { $gte: start, $lte: end },
      status: 'verified',
    })
      .select('amount')
      .lean();
    const cashCollected = collections.reduce((s, c) => s + (c.amount || 0), 0);

    // Sales returns (credit notes) reduce revenue — count approved/processed
    // credit notes dated in this month (SRT-01, per the Expense-Heads doc).
    const salesReturnDocs = await SalesReturn.find({
      date: { $gte: start, $lte: end },
      status: { $in: ['approved', 'processed'] },
    })
      .select('amount')
      .lean();
    const salesReturnsTotal = salesReturnDocs.reduce((s, r) => s + (r.amount || 0), 0);

    // Receivables aging — outstanding balances on all non-cancelled bookings,
    // aged by event date (serviceEnd || bookingDate).
    const openBookings = await Booking.find({
      status: { $nin: ['cancelled', 'rejected', 'Cancelled', 'Rejected'] },
    })
      .select('totalPrice advanceAmount discountAmount serviceEnd bookingDate')
      .lean();
    const aging = { d0_30: 0, d31_90: 0, d90plus: 0 };
    for (const b of openBookings) {
      const bal = balanceOf(b);
      if (bal <= 0) continue;
      const due = b.serviceEnd || b.bookingDate || now;
      const ageDays = Math.floor((now - new Date(due)) / 86400000);
      if (ageDays <= 30) aging.d0_30 += bal;
      else if (ageDays <= 90) aging.d31_90 += bal;
      else aging.d90plus += bal;
    }

    res.json({
      month: period.from.slice(0, 7),
      // what the report covers: a month, or any days between two dates
      period: { from: period.from, to: period.to, days: period.days, label: period.label, custom: period.custom },
      generatedAt: now.toISOString(),
      sales: {
        packageBreakdown,
        totals: salesTotals,
        enquiries,
        leadSource,
        forwardBookings,
      },
      customerRelations: {
        activeClients: active.length,
        newClients,
        repeatClients,
        advanceCollected: salesTotals.totalAdvance,
        balanceOutstanding: salesTotals.totalBalance,
        districtBreakdown,
        referralLeads,
        cancellations,
      },
      finance: {
        cashCollected,
        salesReturns: salesReturnsTotal,
        grossRevenue: salesTotals.totalRevenue,
        netRevenue: Math.max(0, salesTotals.totalRevenue - salesReturnsTotal),
        receivablesAging: aging,
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
