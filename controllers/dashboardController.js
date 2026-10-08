import mongoose from 'mongoose';
import Booking from '../models/Booking.js';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import Collection from '../models/Collection.js';
import AdminExpense from '../models/AdminExpense.js';
import Expense from '../models/Expense.js';
import FuelExpense from '../models/FuelExpense.js';
import ArtistPayout from '../models/ArtistPayout.js';
import Salary from '../models/Salary.js';
import SalesReturn from '../models/SalesReturn.js';
import Campaign from '../models/Campaign.js';
import ContentItem from '../models/ContentItem.js';
import Review from '../models/Review.js';
import { regionScopedMatch } from '../utils/geoScope.js';
import { makeCountsTowardSales, salesCountMatch } from '../utils/salesRules.js';
import { serviceTypeOf } from './bookingMapController.js';
import { SALES_TARGET_ROLES } from '../utils/salesAchievement.js';

// ── Main dashboard analytics ─────────────────────────────────────────────────
// Server-side aggregates for the dashboard's Sales, Sales Team, Work Completed
// and Finance tabs, so the app downloads summaries instead of every booking.
//
// Shared rules (kept in line with the sales reports / targets / P&L):
//  • Dates are IST calendar days; `from`/`to` are inclusive YYYY-MM-DD.
//  • basis=event filters on bookingDate (event date), basis=added on createdAt.
//  • A "sale" excludes cancelled/rejected/lost/draft/pending bookings and
//    bookings entered by users excluded from sales totals.
//  • Value    = totalPrice − discountAmount (net).
//  • Received = advanceAmount + collectedAmount (verified collections).
//  • Outstanding = max(0, value − received).
//  • Credit   = booking.salesPersonId, else the converted lead's assignedTo.
//  • Territory scoping via regionScopedMatch; sales/sales_executive users only
//    ever see their own figures.

const NOT_A_SALE = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const FINANCE_ROLES = ['admin', 'manager', 'accounts', 'finance_head'];
const SELF_SCOPED_ROLES = ['sales', 'sales_executive'];
const NO_DASHBOARD_ROLES = ['artist', 'driver'];
const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 86400000;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const lc = (v) => String(v ?? '').trim().toLowerCase();
const idOf = (v) => (v == null ? null : String(v._id ?? v));
const isObjectId = (v) => mongoose.Types.ObjectId.isValid(String(v ?? ''));
const oid = (v) => new mongoose.Types.ObjectId(String(v));

export const isSale = (b) => !NOT_A_SALE.includes(lc(b.status));
export const netValue = (b) =>
  Math.max(0, (Number(b.totalPrice) || 0) - (Number(b.discountAmount) || 0));
export const receivedOf = (b) =>
  (Number(b.advanceAmount) || 0) + (Number(b.collectedAmount) || 0);
export const outstandingOf = (b) => Math.max(0, netValue(b) - receivedOf(b));

// ── Date helpers ──────────────────────────────────────────────────────────────

const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ''));
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const istEnd = (day) => new Date(`${day}T23:59:59.999+05:30`);
/// IST calendar day (YYYY-MM-DD) for an instant.
export const istDayKey = (d) => new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const istMonthKey = (d) => istDayKey(d).slice(0, 7);
const todayIst = () => istDayKey(new Date());
const addDays = (day, n) => istDayKey(new Date(istStart(day).getTime() + n * DAY_MS));

/// The requested window (default: last 30 days) plus the equal-length window
/// right before it, for period-over-period comparison.
/// The client may pass its own comparison window (prevFrom/prevTo) — e.g. the
/// previous calendar month, or the same days of it for a month in progress.
export const resolveRange = (query) => {
  const to = isDay(query.to) ? query.to : todayIst();
  const from = isDay(query.from) ? query.from : addDays(to, -29);
  const days = Math.max(1, Math.round((istStart(to) - istStart(from)) / DAY_MS) + 1);
  if (isDay(query.prevFrom) && isDay(query.prevTo) && query.prevFrom <= query.prevTo) {
    return { from, to, days, prevFrom: query.prevFrom, prevTo: query.prevTo };
  }
  const prevTo = addDays(from, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from, to, days, prevFrom, prevTo };
};

const rangeMatch = (field, from, to) => ({ [field]: { $gte: istStart(from), $lte: istEnd(to) } });
const basisField = (query) => (query.basis === 'added' ? 'createdAt' : 'bookingDate');

/// Chart buckets: daily up to ~2 months, weekly up to ~6 months, else monthly.
const bucketUnit = (days) => (days <= 62 ? 'day' : days <= 186 ? 'week' : 'month');
const bucketKey = (date, unit) => {
  if (unit === 'month') return istMonthKey(date);
  const day = istDayKey(date);
  if (unit === 'day') return day;
  const dow = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -dow);
};
const bucketKeys = (from, to, unit) => {
  const keys = [];
  const seen = new Set();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const k = bucketKey(istStart(d), unit);
    if (!seen.has(k)) {
      seen.add(k);
      keys.push(k);
    }
  }
  return keys;
};

// ── Access helpers ────────────────────────────────────────────────────────────

const isSelfScoped = (user) => SELF_SCOPED_ROLES.includes(lc(user?.role));

const denyNonDashboard = (req, res) => {
  if (NO_DASHBOARD_ROLES.includes(lc(req.user?.role))) {
    res.status(403).json({ message: 'No dashboard access' });
    return true;
  }
  return false;
};

/// Lead ids assigned to a salesperson — used to credit bookings with no
/// salesPersonId of their own.
const leadIdsAssignedTo = async (userId) =>
  (await Lead.find({ assignedTo: oid(userId) }).select('_id').lean()).map((l) => l._id);

/// Mongo filter for bookings credited to [userId].
const creditedToMatch = async (userId) => ({
  $or: [
    { salesPersonId: oid(userId) },
    { salesPersonId: null, leadId: { $in: await leadIdsAssignedTo(userId) } },
  ],
});

/// Booking filter for the Sales tab: territory + salesperson. Date range is
/// added by the caller (it differs between current and previous windows).
const bookingFilters = async (req) => {
  const and = [await regionScopedMatch(req.user)];
  const sp = isSelfScoped(req.user) ? String(req.user._id) : req.query.salesPersonId;
  if (sp && sp !== 'all' && isObjectId(sp)) and.push(await creditedToMatch(sp));
  return and;
};

/// Active salespeople (sales roles only — not every user / staff member).
const salespeople = async () =>
  (await User.find({ role: { $in: SALES_TARGET_ROLES }, active: { $ne: false } }).select('name role').sort({ name: 1 }).lean())
    .map((u) => ({ id: String(u._id), name: u.name || 'Unnamed', role: u.role }));

const BOOKING_FIELDS =
  'bookingNumber customerName service bookingItems.service totalPrice discountAmount advanceAmount ' +
  'collectedAmount bookingDate createdAt status leadId salesPersonId createdBy pincode address ' +
  'district region districtId regionId serviceEnd';

/// Bookings matching [and] + date window, with the package family and the
/// sales-count flag attached.
const loadBookings = async (and, field, from, to) => {
  const [rows, counts] = await Promise.all([
    Booking.find({ $and: [...and, rangeMatch(field, from, to)] })
      .select(BOOKING_FIELDS)
      .limit(50000)
      .lean(),
    makeCountsTowardSales(),
  ]);
  return rows.map((b) => ({
    ...b,
    serviceType: serviceTypeOf(b.bookingItems?.[0]?.service || b.service),
    counts: counts(b),
  }));
};

/// Resolve each booking's credited salesperson id (salesPersonId → lead owner).
const attachCredit = async (bookings) => {
  const leadIds = [...new Set(bookings.filter((b) => !b.salesPersonId && b.leadId).map((b) => String(b.leadId)))];
  const leads = leadIds.length
    ? await Lead.find({ _id: { $in: leadIds } }).select('assignedTo').lean()
    : [];
  const owner = new Map(leads.map((l) => [String(l._id), idOf(l.assignedTo)]));
  for (const b of bookings) {
    b.creditId = idOf(b.salesPersonId) ?? (b.leadId ? owner.get(String(b.leadId)) ?? null : null);
  }
  return bookings;
};

/// Pure: KPI block for a set of bookings.
export const salesKpis = (bookings) => {
  const sales = bookings.filter((b) => isSale(b) && b.counts !== false);
  const revenue = sales.reduce((s, b) => s + netValue(b), 0);
  const received = sales.reduce((s, b) => s + receivedOf(b), 0);
  const outstanding = sales.reduce((s, b) => s + outstandingOf(b), 0);
  const discount = sales.reduce((s, b) => s + (Number(b.discountAmount) || 0), 0);
  return {
    revenue: round2(revenue),
    orders: sales.length,
    avgOrder: round2(sales.length ? revenue / sales.length : 0),
    received: round2(received),
    outstanding: round2(outstanding),
    discount: round2(discount),
    completed: bookings.filter((b) => lc(b.status) === 'completed').length,
    cancelled: bookings.filter((b) => ['cancelled', 'canceled'].includes(lc(b.status))).length,
    allBookings: bookings.length,
  };
};

/// Pure: group rows by key into { label, count, amount }.
const groupBy = (items, keyFn, valueFn) => {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it) || 'Unspecified';
    const r = map.get(k) ?? { label: k, count: 0, amount: 0 };
    r.count += 1;
    r.amount += valueFn(it);
    map.set(k, r);
  }
  return [...map.values()]
    .map((r) => ({ ...r, amount: round2(r.amount) }))
    .sort((a, b) => b.amount - a.amount || b.count - a.count);
};

/// Lead counts for the window, honouring the same salesperson/geo filters.
const leadMatch = async (req, from, to) => {
  const and = [await regionScopedMatch(req.user)];
  const created = { $gte: istStart(from), $lte: istEnd(to) };
  and.push({ $or: [{ leadDate: created }, { leadDate: null, createdAt: created }] });
  const sp = isSelfScoped(req.user) ? String(req.user._id) : req.query.salesPersonId;
  if (sp && sp !== 'all' && isObjectId(sp)) and.push({ assignedTo: oid(sp) });
  return { $and: and };
};

const sendError = (res, error) => res.status(500).json({ message: error.message });

// @desc    Sales tab — KPIs vs the comparison window, sales trend, and
//          breakdowns by package / salesperson / district / status / source.
// @route   GET /api/dashboard/sales?from&to&prevFrom&prevTo&basis=event|added
//          &salesPersonId
export const getSalesDashboard = async (req, res) => {
  if (denyNonDashboard(req, res)) return;
  try {
    const range = resolveRange(req.query);
    const field = basisField(req.query);
    const and = await bookingFilters(req);

    const [current, previous, leadsNow, leadsPrev, leadSources, team] = await Promise.all([
      loadBookings(and, field, range.from, range.to),
      loadBookings(and, field, range.prevFrom, range.prevTo),
      leadMatch(req, range.from, range.to).then((m) => Lead.countDocuments(m)),
      leadMatch(req, range.prevFrom, range.prevTo).then((m) => Lead.countDocuments(m)),
      leadMatch(req, range.from, range.to).then((m) =>
        Lead.aggregate([
          { $match: m },
          { $group: { _id: '$source', count: { $sum: 1 }, converted: { $sum: { $cond: [{ $eq: ['$status', 'Converted'] }, 1, 0] } } } },
          { $sort: { count: -1 } },
        ])
      ),
      salespeople(),
    ]);
    await attachCredit(current);

    const kpis = { ...salesKpis(current), enquiries: leadsNow };
    kpis.conversion = round2(leadsNow ? (kpis.orders / leadsNow) * 100 : 0);
    const prev = { ...salesKpis(previous), enquiries: leadsPrev };
    prev.conversion = round2(leadsPrev ? (prev.orders / leadsPrev) * 100 : 0);

    // Trend, current vs previous aligned by bucket index.
    const unit = bucketUnit(range.days);
    const curKeys = bucketKeys(range.from, range.to, unit);
    const prevKeys = bucketKeys(range.prevFrom, range.prevTo, unit);
    const sumByBucket = (list) => {
      const m = new Map();
      for (const b of list) {
        if (!isSale(b) || b.counts === false) continue;
        const k = bucketKey(b[field], unit);
        const r = m.get(k) ?? { amount: 0, count: 0 };
        r.amount += netValue(b);
        r.count += 1;
        m.set(k, r);
      }
      return m;
    };
    const curMap = sumByBucket(current);
    const prevMap = sumByBucket(previous);
    const trend = curKeys.map((k, i) => ({
      key: k,
      amount: round2(curMap.get(k)?.amount ?? 0),
      count: curMap.get(k)?.count ?? 0,
      prevAmount: round2(prevMap.get(prevKeys[i])?.amount ?? 0),
      prevCount: prevMap.get(prevKeys[i])?.count ?? 0,
    }));

    // Salesperson split: only real salespeople get their own bar; sales
    // credited to anyone else (admin, CRM, staff) or no one is pooled.
    const sales = current.filter((b) => isSale(b) && b.counts !== false);
    const teamName = new Map(team.map((t) => [t.id, t.name]));
    const spMap = new Map();
    for (const b of sales) {
      const id = b.creditId && teamName.has(b.creditId) ? b.creditId : '';
      const r = spMap.get(id) ?? { id, label: id ? teamName.get(id) : 'Direct / Others', count: 0, amount: 0 };
      r.count += 1;
      r.amount += netValue(b);
      spMap.set(id, r);
    }

    res.json({
      range,
      basis: field === 'createdAt' ? 'added' : 'event',
      unit,
      kpis,
      previous: prev,
      trend,
      byStatus: groupBy(current, (b) => lc(b.status) || 'pending', netValue),
      byPackage: groupBy(sales, (b) => b.serviceType, netValue),
      byDistrict: groupBy(sales, (b) => titleCase(b.district || b.region), netValue),
      bySalesperson: [...spMap.values()]
        .map((r) => ({ ...r, amount: round2(r.amount) }))
        .sort((a, b) => b.amount - a.amount),
      leadSources: leadSources.map((s) => ({
        label: titleCase(s._id) || 'Unspecified',
        count: s.count,
        converted: s.converted,
      })),
      // Filter options — a self-scoped salesperson only ever sees themselves.
      salespeople: isSelfScoped(req.user) ? [] : team.map(({ id, name }) => ({ id, name })),
    });
  } catch (error) {
    sendError(res, error);
  }
};

/// Months (1-12, year) touched by an IST date window.
const monthsIn = (from, to) => {
  const out = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const [ty, tm] = to.slice(0, 7).split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
};

const LEAD_STAGES = ['New', 'Contacted', 'Qualified', 'Follow-up', 'Pending Lost Approval', 'Lost', 'Converted'];
const leadDay = (l) => l.leadDate || l.createdAt;
const titleCase = (s) =>
  String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\b([a-z])/g, (m) => m.toUpperCase());

/// Campaigns running at any point in [from, to] (open-ended dates count).
const campaignsIn = (from, to) => ({
  $and: [
    { $or: [{ startDate: null }, { startDate: { $lte: istEnd(to) } }] },
    { $or: [{ endDate: null }, { endDate: { $gte: istStart(from) } }] },
    { status: { $ne: 'planned' } },
  ],
});
const campaignCost = (c) => (Number(c.adSpend) || 0) + (Number(c.productionCost) || 0);

// @desc    Marketing tab — enquiry volume and trend, sources and their
//          conversion, pipeline stages, campaign spend vs return, content
//          output and client review ratings.
// @route   GET /api/dashboard/marketing?from&to&prevFrom&prevTo
export const getMarketingDashboard = async (req, res) => {
  if (denyNonDashboard(req, res)) return;
  try {
    const range = resolveRange(req.query);

    const [nowMatch, prevMatch] = await Promise.all([
      leadMatch(req, range.from, range.to),
      leadMatch(req, range.prevFrom, range.prevTo),
    ]);
    const [leads, prevLeads, campaigns, prevCampaigns, content, reviews] = await Promise.all([
      Lead.find(nowMatch).select('source status priority district location leadDate createdAt campaignId').lean(),
      Lead.find(prevMatch).select('status leadDate createdAt').lean(),
      Campaign.find(campaignsIn(range.from, range.to)).select('title channel adSpend productionCost status').lean(),
      Campaign.find(campaignsIn(range.prevFrom, range.prevTo)).select('adSpend productionCost').lean(),
      ContentItem.find({ scheduledDate: { $gte: istStart(range.from), $lte: istEnd(range.to) } })
        .select('platform contentType status')
        .lean(),
      Review.find({ status: 'submitted', submittedAt: { $gte: istStart(range.from), $lte: istEnd(range.to) } })
        .select('overall')
        .lean(),
    ]);

    // Revenue from enquiries made in the window that became bookings.
    const [bookings, counts] = await Promise.all([
      Booking.find({ leadId: { $in: leads.map((l) => l._id) } })
        .select('leadId status totalPrice discountAmount createdBy')
        .lean(),
      makeCountsTowardSales(),
    ]);
    const revenueByLead = new Map();
    for (const b of bookings) {
      if (!isSale(b) || !counts(b)) continue;
      const k = String(b.leadId);
      revenueByLead.set(k, (revenueByLead.get(k) ?? 0) + netValue(b));
    }

    const converted = (l) => l.status === 'Converted';
    const revenue = [...revenueByLead.values()].reduce((s, v) => s + v, 0);
    const spend = campaigns.reduce((s, c) => s + campaignCost(c), 0);
    const prevSpend = prevCampaigns.reduce((s, c) => s + campaignCost(c), 0);
    const nConverted = leads.filter(converted).length;
    const nPrevConverted = prevLeads.filter(converted).length;

    // Trend: enquiries and conversions per bucket, previous window aligned.
    const unit = bucketUnit(range.days);
    const curKeys = bucketKeys(range.from, range.to, unit);
    const prevKeys = bucketKeys(range.prevFrom, range.prevTo, unit);
    const tally = (list) => {
      const m = new Map();
      for (const l of list) {
        const k = bucketKey(leadDay(l), unit);
        const r = m.get(k) ?? { count: 0, converted: 0 };
        r.count += 1;
        if (converted(l)) r.converted += 1;
        m.set(k, r);
      }
      return m;
    };
    const cur = tally(leads);
    const prev = tally(prevLeads);

    const sources = new Map();
    for (const l of leads) {
      const k = titleCase(l.source) || 'Unspecified';
      const r = sources.get(k) ?? { label: k, count: 0, converted: 0, revenue: 0 };
      r.count += 1;
      if (converted(l)) r.converted += 1;
      r.revenue += revenueByLead.get(String(l._id)) ?? 0;
      sources.set(k, r);
    }

    const byCampaign = new Map();
    for (const l of leads) {
      if (!l.campaignId) continue;
      const k = String(l.campaignId);
      const r = byCampaign.get(k) ?? { leads: 0, converted: 0, revenue: 0 };
      r.leads += 1;
      if (converted(l)) r.converted += 1;
      r.revenue += revenueByLead.get(String(l._id)) ?? 0;
      byCampaign.set(k, r);
    }

    const contentByPlatform = new Map();
    for (const c of content) {
      if (c.status === 'cancelled') continue;
      const k = titleCase(c.platform) || 'Other';
      const r = contentByPlatform.get(k) ?? { label: k, published: 0, planned: 0 };
      if (c.status === 'published') r.published += 1;
      else r.planned += 1;
      contentByPlatform.set(k, r);
    }

    // 1–5 stars; 0 = unanswered.
    const rated = reviews.map((r) => Number(r.overall) || 0).filter((v) => v > 0);
    const stars = [1, 2, 3, 4, 5].map((s) => ({ label: `${s} star${s === 1 ? '' : 's'}`, count: rated.filter((v) => Math.round(v) === s).length }));

    const count = (list, key, order) => {
      const m = new Map();
      for (const l of list) {
        const k = key(l);
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      const rows = [...m.entries()].map(([label, c]) => ({ label, count: c }));
      return order
        ? order.map((o) => rows.find((r) => r.label === o) ?? { label: o, count: 0 })
        : rows.sort((a, b) => b.count - a.count);
    };

    res.json({
      range,
      unit,
      kpis: {
        enquiries: leads.length,
        prevEnquiries: prevLeads.length,
        converted: nConverted,
        prevConverted: nPrevConverted,
        conversion: round2(leads.length ? (nConverted / leads.length) * 100 : 0),
        prevConversion: round2(prevLeads.length ? (nPrevConverted / prevLeads.length) * 100 : 0),
        open: leads.filter((l) => ['New', 'Contacted', 'Qualified', 'Follow-up'].includes(l.status)).length,
        lost: leads.filter((l) => l.status === 'Lost').length,
        revenue: round2(revenue),
        spend: round2(spend),
        prevSpend: round2(prevSpend),
        costPerEnquiry: leads.length && spend ? round2(spend / leads.length) : null,
        returnOnSpend: spend ? round2(revenue / spend) : null,
        published: content.filter((c) => c.status === 'published').length,
        reviews: rated.length,
        avgRating: rated.length ? round2(rated.reduce((s, v) => s + v, 0) / rated.length) : null,
      },
      trend: curKeys.map((k, i) => ({
        key: k,
        count: cur.get(k)?.count ?? 0,
        converted: cur.get(k)?.converted ?? 0,
        prevCount: prev.get(prevKeys[i])?.count ?? 0,
      })),
      sources: [...sources.values()]
        .map((s) => ({ ...s, revenue: round2(s.revenue) }))
        .sort((a, b) => b.count - a.count),
      pipeline: count(leads, (l) => l.status || 'New', LEAD_STAGES),
      priority: count(leads, (l) => l.priority || 'Warm', ['Hot', 'Warm', 'Cold']),
      districts: count(leads, (l) => titleCase(l.district || l.location) || 'Unspecified').slice(0, 10),
      campaigns: campaigns
        .map((c) => {
          const a = byCampaign.get(String(c._id)) ?? { leads: 0, converted: 0, revenue: 0 };
          return {
            label: c.title,
            channel: c.channel || '',
            spend: round2(campaignCost(c)),
            leads: a.leads,
            converted: a.converted,
            revenue: round2(a.revenue),
          };
        })
        .sort((a, b) => b.spend - a.spend || b.leads - a.leads),
      content: [...contentByPlatform.values()].sort((a, b) => b.published + b.planned - (a.published + a.planned)),
      ratings: stars,
    });
  } catch (error) {
    sendError(res, error);
  }
};

const sumField = async (Model, match, field = 'amount') => {
  const [r] = await Model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` }, count: { $sum: 1 } } }]);
  return { total: round2(r?.total ?? 0), count: r?.count ?? 0 };
};

const monthlySum = async (Model, match, dateField, field = 'amount') =>
  Model.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: `$${dateField}`, timezone: '+05:30' } },
        total: { $sum: `$${field}` },
      },
    },
  ]);

// @desc    Finance tab — billed vs received, receivables, expenses and net
//          cash position, with a monthly income/expense trend.
// @route   GET /api/dashboard/finance?from&to
export const getFinanceDashboard = async (req, res) => {
  if (!FINANCE_ROLES.includes(lc(req.user?.role))) {
    res.status(403).json({ message: 'No finance access' });
    return;
  }
  try {
    const range = resolveRange(req.query);
    const win = (f) => rangeMatch(f, range.from, range.to);
    const prevWin = (f) => rangeMatch(f, range.prevFrom, range.prevTo);

    const geo = await regionScopedMatch(req.user);
    const [billedNow, billedPrev] = await Promise.all([
      loadBookings([geo], 'bookingDate', range.from, range.to, {}),
      loadBookings([geo], 'bookingDate', range.prevFrom, range.prevTo, {}),
    ]);
    const billed = salesKpis(billedNow);
    const billedPrevK = salesKpis(billedPrev);

    // Cash in: booking advances (by booked date) + collections (by payment date).
    const advMatch = (w) => ({ ...w('createdAt'), advanceAmount: { $gt: 0 }, status: { $nin: ['cancelled', 'rejected'] } });
    const colMatch = (w, status) => ({ ...w('date'), status });

    const expenseSources = [
      { key: 'admin', label: 'Admin expenses', Model: AdminExpense, match: { status: 'approved' }, date: 'date', field: 'amount' },
      { key: 'artist', label: 'Artist expenses', Model: Expense, match: { status: 'verified' }, date: 'date', field: 'amount' },
      { key: 'fuel', label: 'Fuel & vehicle', Model: FuelExpense, match: { status: 'approved' }, date: 'date', field: 'totalAmount' },
      { key: 'payouts', label: 'Artist payouts', Model: ArtistPayout, match: { status: 'paid' }, date: 'date', field: 'amount' },
      { key: 'salaries', label: 'Salaries', Model: Salary, match: { status: 'paid' }, date: 'paymentDate', field: 'netAmount' },
      { key: 'refunds', label: 'Sales returns', Model: SalesReturn, match: { status: { $in: ['approved', 'processed'] } }, date: 'date', field: 'amount' },
    ];

    const [advNow, advPrev, colVerified, colPending, colPrev, byMode, ...expenseTotals] = await Promise.all([
      sumField(Booking, advMatch(win), 'advanceAmount'),
      sumField(Booking, advMatch(prevWin), 'advanceAmount'),
      sumField(Collection, colMatch(win, 'verified')),
      sumField(Collection, colMatch(win, 'pending')),
      sumField(Collection, colMatch(prevWin, 'verified')),
      Collection.aggregate([
        { $match: colMatch(win, 'verified') },
        { $group: { _id: '$paymentMode', total: { $sum: '$amount' }, count: { $sum: 1 } } },
        { $sort: { total: -1 } },
      ]),
      ...expenseSources.flatMap((s) => [
        sumField(s.Model, { ...s.match, ...win(s.date) }, s.field),
        sumField(s.Model, { ...s.match, ...prevWin(s.date) }, s.field),
      ]),
    ]);

    const expenses = expenseSources.map((s, i) => ({
      key: s.key,
      label: s.label,
      amount: expenseTotals[i * 2].total,
      count: expenseTotals[i * 2].count,
      prevAmount: expenseTotals[i * 2 + 1].total,
    }));
    const expenseNow = round2(expenses.reduce((s, e) => s + e.amount, 0));
    const expensePrev = round2(expenses.reduce((s, e) => s + e.prevAmount, 0));
    const cashInNow = round2(advNow.total + colVerified.total);
    const cashInPrev = round2(advPrev.total + colPrev.total);

    // Pending approvals — money waiting on someone.
    const [pendingAdmin, pendingArtist, pendingFuel, pendingPayouts] = await Promise.all([
      sumField(AdminExpense, { status: 'pending' }),
      sumField(Expense, { status: 'pending' }),
      sumField(FuelExpense, { status: 'pending' }, 'totalAmount'),
      sumField(ArtistPayout, { status: { $in: ['pending', 'approved'] } }),
    ]);

    // Receivables across all open bookings, aged by event date.
    const open = await Booking.find({ $and: [geo, { status: { $nin: ['cancelled', 'canceled', 'rejected', 'Cancelled', 'Rejected'] } }] })
      .select('totalPrice discountAmount advanceAmount collectedAmount bookingDate serviceEnd status')
      .limit(100000)
      .lean();
    const now = Date.now();
    const aging = { upcoming: 0, d0_30: 0, d31_90: 0, d90plus: 0 };
    for (const b of open) {
      const bal = outstandingOf(b);
      if (bal <= 0) continue;
      const due = new Date(b.serviceEnd || b.bookingDate || now).getTime();
      const age = Math.floor((now - due) / DAY_MS);
      if (age < 0) aging.upcoming += bal;
      else if (age <= 30) aging.d0_30 += bal;
      else if (age <= 90) aging.d31_90 += bal;
      else aging.d90plus += bal;
    }
    for (const k of Object.keys(aging)) aging[k] = round2(aging[k]);

    // Monthly trend: last 12 IST months ending at `to` (independent of window
    // length so the chart is always readable).
    const [ty, tm] = range.to.slice(0, 7).split('-').map(Number);
    const trendFrom = `${new Date(Date.UTC(ty, tm - 12, 1)).toISOString().slice(0, 7)}-01`;
    const trendWin = (f) => rangeMatch(f, trendFrom, range.to);
    const [tAdv, tCol, tBilled, ...tExp] = await Promise.all([
      monthlySum(Booking, advMatch(trendWin), 'createdAt', 'advanceAmount'),
      monthlySum(Collection, colMatch(trendWin, 'verified'), 'date'),
      Booking.aggregate([
        { $match: { $and: [geo, trendWin('bookingDate'), { status: { $nin: NOT_A_SALE } }, await salesCountMatch()] } },
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m', date: '$bookingDate', timezone: '+05:30' } },
            total: { $sum: { $max: [0, { $subtract: [{ $ifNull: ['$totalPrice', 0] }, { $ifNull: ['$discountAmount', 0] }] }] } },
          },
        },
      ]),
      ...expenseSources.map((s) => monthlySum(s.Model, { ...s.match, ...trendWin(s.date) }, s.date, s.field)),
    ]);
    const months = monthsIn(trendFrom, range.to).map((m) => `${m.year}-${String(m.month).padStart(2, '0')}`);
    const pick = (rows) => new Map(rows.map((r) => [r._id, r.total]));
    const adv = pick(tAdv);
    const col = pick(tCol);
    const bil = pick(tBilled);
    const exp = tExp.map(pick);
    const trend = months.map((m) => {
      const income = (adv.get(m) ?? 0) + (col.get(m) ?? 0);
      const expense = exp.reduce((s, e) => s + (e.get(m) ?? 0), 0);
      return { key: m, billed: round2(bil.get(m) ?? 0), income: round2(income), expense: round2(expense), net: round2(income - expense) };
    });

    const MODE = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank Transfer', other: 'Other' };
    res.json({
      range,
      kpis: {
        billed: billed.revenue,
        billedPrev: billedPrevK.revenue,
        orders: billed.orders,
        cashIn: cashInNow,
        cashInPrev,
        advances: advNow.total,
        collections: colVerified.total,
        collectionsPending: colPending.total,
        collectionsPendingCount: colPending.count,
        expenses: expenseNow,
        expensesPrev: expensePrev,
        net: round2(cashInNow - expenseNow),
        netPrev: round2(cashInPrev - expensePrev),
        receivables: round2(Object.values(aging).reduce((s, v) => s + v, 0)),
        collectionRate: round2(billed.revenue ? (billed.received / billed.revenue) * 100 : 0),
      },
      expenses: expenses.sort((a, b) => b.amount - a.amount),
      paymentModes: byMode.map((m) => ({ label: MODE[m._id] || m._id || 'Other', amount: round2(m.total), count: m.count })),
      pendingApprovals: [
        { label: 'Admin expenses', amount: pendingAdmin.total, count: pendingAdmin.count },
        { label: 'Artist expenses', amount: pendingArtist.total, count: pendingArtist.count },
        { label: 'Fuel bills', amount: pendingFuel.total, count: pendingFuel.count },
        { label: 'Artist payouts', amount: pendingPayouts.total, count: pendingPayouts.count },
        { label: 'Collections to verify', amount: colPending.total, count: colPending.count },
      ],
      aging,
      trend,
    });
  } catch (error) {
    sendError(res, error);
  }
};
