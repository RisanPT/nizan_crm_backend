import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import User from '../models/User.js';
import SalesTarget from '../models/SalesTarget.js';
import { regionScopedMatch } from '../utils/geoScope.js';
import { salesCountMatch } from '../utils/salesRules.js';
import {
  istDayKey,
  istMonthKey,
  istWeekStart,
  rangeCondition,
  parseDayParam,
  todayIst,
  istStart,
  istEnd,
  addDays,
} from '../utils/istDate.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts', 'finance_head'];
const canManageFinance = (user) => FINANCE_ROLES.includes(user?.role);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A "sale" excludes the same non-revenue statuses as GST / P&L so these reports
// reconcile with the books.
const SALES_EXCLUDED = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const isSale = (b) => !SALES_EXCLUDED.includes(String(b.status || '').toLowerCase());

// from / to are IST calendar days (older app builds send local-midnight ISO
// strings; the date part is used). `to` includes its whole day.
const dateFilter = (field, from, to) => rangeCondition(field, from, to);

// All revenue bookings in the window.
const saleBookings = async (from, to, user) => {
  // Territory scoping: full-access sees all; a scoped user only their regions.
  const geo = await regionScopedMatch(user);
  // Bookings entered by users excluded from sales totals are left out.
  const bookings = await Booking.find({
    $and: [{ ...dateFilter('bookingDate', from, to), ...geo }, await salesCountMatch()],
  })
    .select('customerName phone service totalPrice collectedAmount bookingDate status leadId salesPersonId createdBy')
    .limit(50000)
    .lean();
  return bookings.filter(isSale);
};

// Roll a Map of rows into the uniform { rows, totals } payload (sorted by amount
// desc unless the caller pre-sorts).
const pack = (map, { sort = 'amount' } = {}) => {
  let rows = [...map.values()];
  if (sort === 'amount') rows.sort((a, b) => b.amount - a.amount);
  else if (sort === 'label') rows.sort((a, b) => String(a.label).localeCompare(String(b.label)));
  const totals = { count: 0, amount: 0, received: 0 };
  for (const r of rows) {
    totals.count += r.count;
    totals.amount += r.amount;
    totals.received += r.received;
    r.amount = round2(r.amount);
    r.received = round2(r.received);
    if (r.outstanding !== undefined) r.outstanding = round2(r.outstanding);
  }
  return {
    rows,
    totals: { count: totals.count, amount: round2(totals.amount), received: round2(totals.received) },
  };
};

const guard = (req, res) => {
  if (!canManageFinance(req.user)) {
    res.status(403).json({ message: 'No finance access' });
    return false;
  }
  return true;
};

// @desc    Sales grouped by customer.
// @route   GET /api/sales-reports/by-customer?from&to
export const salesByCustomer = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const bookings = await saleBookings(from, to, req.user);
    const map = new Map();
    for (const b of bookings) {
      const key = `${b.customerName || 'Unknown'}|${b.phone || ''}`;
      if (!map.has(key)) {
        map.set(key, { label: b.customerName || 'Unknown', sublabel: b.phone || '', id: b.phone || '', count: 0, amount: 0, received: 0, outstanding: 0 });
      }
      const r = map.get(key);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
      r.outstanding += (b.totalPrice || 0) - (b.collectedAmount || 0);
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Sales grouped by package / service.
// @route   GET /api/sales-reports/by-package?from&to
export const salesByPackage = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const bookings = await saleBookings(from, to, req.user);
    const map = new Map();
    for (const b of bookings) {
      const key = (b.service && b.service.trim()) || 'Unspecified';
      if (!map.has(key)) map.set(key, { label: key, sublabel: '', id: key, count: 0, amount: 0, received: 0 });
      const r = map.get(key);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Sales grouped by salesperson (via the lead the booking converted).
// @route   GET /api/sales-reports/by-salesperson?from&to
export const salesBySalesperson = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const bookings = await saleBookings(from, to, req.user);

    const leadIds = [...new Set(bookings.filter((b) => b.leadId).map((b) => String(b.leadId)))];
    const leads = await Lead.find({ _id: { $in: leadIds } }).select('assignedTo').lean();
    const leadToUser = new Map(leads.map((l) => [String(l._id), l.assignedTo ? String(l.assignedTo) : null]));
    // The salesperson credited: the booking's own salesPersonId, else the
    // converted lead's owner.
    const uidFor = (b) =>
      (b.salesPersonId ? String(b.salesPersonId) : null) ||
      (b.leadId ? leadToUser.get(String(b.leadId)) : null);
    const userIds = [...new Set(bookings.map(uidFor).filter(Boolean))];
    const users = await User.find({ _id: { $in: userIds } }).select('name').lean();
    const userName = new Map(users.map((u) => [String(u._id), u.name || 'Unknown']));

    const map = new Map();
    for (const b of bookings) {
      const uid = uidFor(b);
      const name = uid ? userName.get(uid) || 'Unknown' : 'Direct / Unassigned';
      if (!map.has(name)) map.set(name, { label: name, sublabel: '', id: uid || '', count: 0, amount: 0, received: 0 });
      const r = map.get(name);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Sales summary by day, week (Monday start) or month — IST calendar.
//          A week row is labelled with its Monday ('YYYY-MM-DD').
// @route   GET /api/sales-reports/summary?from&to&groupBy=day|week|month
export const salesSummary = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const groupBy = ['month', 'week'].includes(req.query.groupBy) ? req.query.groupBy : 'day';
    const bookings = await saleBookings(from, to, req.user);
    const map = new Map();
    for (const b of bookings) {
      const d = new Date(b.bookingDate || Date.now());
      const key =
        groupBy === 'month'
          ? istMonthKey(d)
          : groupBy === 'week'
            ? istWeekStart(d)
            : istDayKey(d);
      if (!map.has(key)) map.set(key, { label: key, sublabel: '', count: 0, amount: 0, received: 0 });
      const r = map.get(key);
      r.count += 1;
      r.amount += b.totalPrice || 0;
      r.received += b.collectedAmount || 0;
    }
    res.json({ ...pack(map, { sort: 'label' }), groupBy });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const MODE_LABEL = { cash: 'Cash', upi: 'UPI', bank_transfer: 'Bank Transfer', other: 'Other' };

// @desc    Payments received grouped by mode (cash / bank / UPI …).
// @route   GET /api/sales-reports/by-payment-mode?from&to
export const paymentsByMode = async (req, res) => {
  if (!guard(req, res)) return;
  try {
    const { from, to } = req.query;
    const collections = await Collection.find({
      ...dateFilter('date', from, to),
      status: { $ne: 'rejected' },
    })
      .select('paymentMode amount')
      .limit(100000)
      .lean();
    const map = new Map();
    for (const c of collections) {
      const key = c.paymentMode || 'other';
      if (!map.has(key)) map.set(key, { label: MODE_LABEL[key] || key, sublabel: '', count: 0, amount: 0, received: 0 });
      const r = map.get(key);
      r.count += 1;
      r.amount += c.amount || 0;
    }
    res.json(pack(map));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const SALES_EOD_ROLES = [
  'admin',
  'manager',
  'sales_manager',
  'sales',
  'sales_executive',
  'finance_head',
  'accounts',
];

// @desc    Get Sales End of Day (EOD) Report (Daily calls, leads, closed bookings, revenue)
// @route   GET /api/sales-reports/eod?date=YYYY-MM-DD&salesPersonId=...
// @access  Private (Sales, Sales Executive, Sales Manager, Manager, Admin, Finance)
export const salesEodReport = async (req, res) => {
  try {
    const user = req.user;
    const role = String(user?.role || '').toLowerCase();
    if (!SALES_EOD_ROLES.includes(role)) {
      return res.status(403).json({ message: 'Access denied to Sales EOD report' });
    }

    const fromParam = parseDayParam(req.query.from);
    const toParam = parseDayParam(req.query.to);
    const isRange = Boolean(fromParam && toParam);

    let fromDateStr;
    let toDateStr;
    let dateStr;

    if (isRange) {
      if (fromParam <= toParam) {
        fromDateStr = fromParam;
        toDateStr = toParam;
      } else {
        fromDateStr = toParam;
        toDateStr = fromParam;
      }
      dateStr = `${fromDateStr} to ${toDateStr}`;
    } else {
      dateStr = parseDayParam(req.query.date) || todayIst();
      fromDateStr = dateStr;
      toDateStr = dateStr;
    }

    const dayStart = istStart(fromDateStr);
    const dayEnd = istEnd(toDateStr);
    const dayRange = { $gte: dayStart, $lte: dayEnd };

    // Month & Year parsing (based on toDateStr) for Month-to-Date (MTD)
    const [yearStr, monthStr, dayStr] = toDateStr.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const day = parseInt(dayStr, 10);

    const mtdStartStr = `${yearStr}-${String(month).padStart(2, '0')}-01`;
    const mtdStart = istStart(mtdStartStr);
    const mtdEnd = dayEnd;
    const mtdRange = { $gte: mtdStart, $lte: mtdEnd };

    // Working days in month (excluding Sundays, exactly matches business sheet calculation)
    const totalDaysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let workingDaysInMonth = 0;
    for (let d = 1; d <= totalDaysInMonth; d++) {
      const dayOfWeek = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
      if (dayOfWeek !== 0) workingDaysInMonth++;
    }
    if (workingDaysInMonth <= 0) workingDaysInMonth = 26;

    // Working days elapsed from 1st of month till report date (toDateStr)
    let workingDaysMtd = 0;
    for (let d = 1; d <= day; d++) {
      const dayOfWeek = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
      if (dayOfWeek !== 0) workingDaysMtd++;
    }
    if (workingDaysMtd <= 0) workingDaysMtd = 1;

    const monthNames = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'
    ];
    const shortMonthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
    ];
    const monthName = `${monthNames[month - 1] || 'Month'} ${year}`;

    const formatIstDateKey = (dStr) => {
      const [y, m, d] = dStr.split('-');
      return `${String(parseInt(d, 10)).padStart(2, '0')}-${shortMonthNames[parseInt(m, 10) - 1] || 'M'}-${y.slice(-2)}`;
    };

    const reportDateFormatted = isRange
      ? (fromDateStr === toDateStr
          ? formatIstDateKey(fromDateStr)
          : `${formatIstDateKey(fromDateStr)} to ${formatIstDateKey(toDateStr)}`)
      : formatIstDateKey(dateStr);

    // Days in selected window & working days in selected window
    const daysInRange = [];
    let curr = fromDateStr;
    let workingDaysInWindow = 0;
    while (curr <= toDateStr) {
      daysInRange.push(curr);
      const [cy, cm, cd] = curr.split('-').map(Number);
      const dow = new Date(Date.UTC(cy, cm - 1, cd)).getUTCDay();
      if (dow !== 0) workingDaysInWindow++;
      curr = addDays(curr, 1);
      if (daysInRange.length > 366) break;
    }
    if (workingDaysInWindow <= 0) workingDaysInWindow = 1;

    const isSalesExec = ['sales', 'sales_executive'].includes(role);
    let targetUserId = null;
    if (isSalesExec) {
      targetUserId = String(user._id);
    } else if (req.query.salesPersonId && req.query.salesPersonId !== 'all') {
      targetUserId = String(req.query.salesPersonId);
    }

    const isTeam = !targetUserId;

    // 1. Get Target User info or Sales Team Users
    let salesPersonInfo = null;
    let salesUsers = [];
    if (targetUserId) {
      salesPersonInfo = await User.findById(targetUserId).select('name email phone role').lean();
    } else {
      salesUsers = await User.find({
        role: { $in: ['sales', 'sales_executive', 'sales_manager'] },
      }).select('name email phone role').lean();
    }

    // Helper: Source category classification
    const classifySource = (sourceStr) => {
      const s = String(sourceStr || '').toLowerCase().trim();
      if (s.includes('whatsapp') || s === 'wa') return 'whatsapp';
      if (s.includes('kerala')) return 'ig_kerala';
      if (s.includes('trial')) return 'trial_campaign';
      if (s.includes('paid') || s.includes('ad')) return 'paid_ads';
      if (s.includes('main') || s === 'instagram' || s === 'ig') return 'ig_main';
      return 'other';
    };

    // 2. Fetch Lead Activities for Today & MTD
    const activityQueryToday = {
      createdAt: dayRange,
      ...(targetUserId ? { createdBy: targetUserId } : {}),
    };
    const activitiesToday = await LeadActivity.find(activityQueryToday)
      .populate('leadId', 'name customerName phone status source')
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .lean();

    const activityQueryMtd = {
      createdAt: mtdRange,
      ...(targetUserId ? { createdBy: targetUserId } : {}),
    };
    const activitiesMtd = await LeadActivity.find(activityQueryMtd)
      .select('type status callResponse createdBy leadId createdAt')
      .lean();

    // 3. Fetch Leads for Today & MTD
    const leadsCreatedToday = await Lead.find({
      createdAt: dayRange,
      ...(targetUserId ? { assignedTo: targetUserId } : {}),
    }).select('name customerName phone status source assignedTo createdAt').lean();

    const leadsCreatedMtd = await Lead.find({
      createdAt: mtdRange,
      ...(targetUserId ? { assignedTo: targetUserId } : {}),
    }).select('name customerName phone status source assignedTo createdAt').lean();

    const leadsConvertedToday = await Lead.find({
      status: 'Converted',
      updatedAt: dayRange,
      ...(targetUserId ? { assignedTo: targetUserId } : {}),
    }).select('name customerName phone status source assignedTo updatedAt').lean();

    // 4. Fetch Bookings for Today & MTD
    const bookingQueryToday = {
      createdAt: dayRange,
      status: { $nin: SALES_EXCLUDED },
    };
    const bookingQueryMtd = {
      createdAt: mtdRange,
      status: { $nin: SALES_EXCLUDED },
    };

    if (targetUserId) {
      const targetLeadIds = (await Lead.find({ assignedTo: targetUserId }).select('_id').lean()).map((l) => l._id);
      const orCondition = [
        { salesPersonId: targetUserId },
        { createdBy: targetUserId },
        { leadId: { $in: targetLeadIds } },
      ];
      bookingQueryToday.$or = orCondition;
      bookingQueryMtd.$or = orCondition;
    }

    const bookingsToday = await Booking.find(bookingQueryToday)
      .populate('leadId', 'source')
      .select('bookingNumber customerName phone service totalPrice discountAmount advanceAmount collectedAmount status bookingDate createdAt salesPersonId createdBy leadId')
      .sort({ createdAt: -1 })
      .lean();

    const bookingsMtd = await Booking.find(bookingQueryMtd)
      .populate('leadId', 'source')
      .select('bookingNumber customerName phone service totalPrice discountAmount advanceAmount collectedAmount status bookingDate createdAt salesPersonId createdBy leadId')
      .lean();

    // 5. Fetch Targets
    let monthlyTargetBookings = 0;
    let monthlyTargetValue = 0;
    if (targetUserId) {
      const targetDoc = await SalesTarget.findOne({
        userId: targetUserId,
        month,
        year,
      }).lean();
      monthlyTargetBookings = targetDoc?.bookingsTarget || 0;
      monthlyTargetValue = targetDoc?.salesTarget || 0;
    } else {
      const allTargets = await SalesTarget.find({ month, year }).lean();
      monthlyTargetBookings = allTargets.reduce((sum, t) => sum + (t.bookingsTarget || 0), 0);
      monthlyTargetValue = allTargets.reduce((sum, t) => sum + (t.salesTarget || 0), 0);
    }

    const dailyTargetBookings = workingDaysInMonth > 0 ? (monthlyTargetBookings / workingDaysInMonth) : 0;
    const dailyTargetValue = workingDaysInMonth > 0 ? (monthlyTargetValue / workingDaysInMonth) : 0;
    const targetMultiplier = isRange ? workingDaysInWindow : 1;
    const achievableTargetBookings = round2(dailyTargetBookings * targetMultiplier);
    const achievableTargetValue = round2(dailyTargetValue * targetMultiplier);

    // MTD Target: target accumulated from 1st of month till report date
    const mtdTargetBookings = round2(dailyTargetBookings * workingDaysMtd);
    const mtdTargetValue = round2(dailyTargetValue * workingDaysMtd);

    // 6. Compute Leads & Follow-ups Logged (Table 4)
    const countBySource = (leadsList, cat) => leadsList.filter((l) => classifySource(l.source) === cat).length;

    const whatsappLeadsToday = countBySource(leadsCreatedToday, 'whatsapp');
    const whatsappLeadsMtd = countBySource(leadsCreatedMtd, 'whatsapp');

    const igMainLeadsToday = countBySource(leadsCreatedToday, 'ig_main');
    const igMainLeadsMtd = countBySource(leadsCreatedMtd, 'ig_main');

    const igKeralaLeadsToday = countBySource(leadsCreatedToday, 'ig_kerala');
    const igKeralaLeadsMtd = countBySource(leadsCreatedMtd, 'ig_kerala');

    const paidAdsLeadsToday = countBySource(leadsCreatedToday, 'paid_ads');
    const paidAdsLeadsMtd = countBySource(leadsCreatedMtd, 'paid_ads');

    const trialCampaignLeadsToday = countBySource(leadsCreatedToday, 'trial_campaign');
    const trialCampaignLeadsMtd = countBySource(leadsCreatedMtd, 'trial_campaign');

    // Leads Contacted: Distinct leads with call or connected outcome, or total connected calls
    let leadsContactedToday = 0;
    let followUpsDoneToday = 0;
    let callsMadeToday = 0;
    let callsConnectedToday = 0;
    let callsNoAnswerToday = 0;
    let callsBusyToday = 0;
    let followUpsPendingToday = 0;

    for (const a of activitiesToday) {
      if (a.type === 'call') callsMadeToday++;
      const resp = String(a.callResponse || '').toLowerCase();
      if (resp === 'connected') {
        callsConnectedToday++;
      } else if (resp === 'no answer') {
        callsNoAnswerToday++;
      } else if (resp === 'busy' || resp === 'switched off') {
        callsBusyToday++;
      }

      if (a.status === 'Completed' || a.type === 'follow_up') {
        followUpsDoneToday++;
      } else if (a.status === 'Pending') {
        followUpsPendingToday++;
      }
    }
    // Number of leads contacted: connected calls or non-empty distinct contacts
    leadsContactedToday = callsConnectedToday > 0 ? callsConnectedToday : callsMadeToday;

    let leadsContactedMtd = 0;
    let followUpsDoneMtd = 0;
    for (const a of activitiesMtd) {
      const resp = String(a.callResponse || '').toLowerCase();
      if (resp === 'connected' || a.type === 'call') leadsContactedMtd++;
      if (a.status === 'Completed' || a.type === 'follow_up') followUpsDoneMtd++;
    }

    // Team Missed Leads (IG - WhatsApp)
    const teamMissedLeadsToday = Math.max(0, (whatsappLeadsToday + igMainLeadsToday + igKeralaLeadsToday + paidAdsLeadsToday) - leadsContactedToday);
    const teamMissedLeadsMtd = Math.max(0, (whatsappLeadsMtd + igMainLeadsMtd + igKeralaLeadsMtd + paidAdsLeadsMtd) - leadsContactedMtd);

    // 7. Compute Bookings by Source (Table 3)
    const classifyBooking = (b) => {
      const src = classifySource(b.leadId?.source || b.source);
      if (src === 'trial_campaign') return 'trial';
      if (src === 'paid_ads' || src === 'ig_kerala') return 'paid_ads';
      return 'organic'; // whatsapp, ig_main, youtube, reference, walk-in
    };

    let todayOrganicBookings = 0;
    let todayPaidAdsBookings = 0;
    let todayTrialBookings = 0;
    let todayOrderValue = 0;
    let todayAdvancePaid = 0;

    for (const b of bookingsToday) {
      const cat = classifyBooking(b);
      if (cat === 'organic') todayOrganicBookings++;
      else if (cat === 'paid_ads') todayPaidAdsBookings++;
      else if (cat === 'trial') todayTrialBookings++;

      const net = (b.totalPrice || 0) - (b.discountAmount || 0);
      todayOrderValue += net > 0 ? net : (b.totalPrice || 0);
      todayAdvancePaid += (b.advanceAmount || b.collectedAmount || 0);
    }
    const totalBookingsToday = bookingsToday.length;

    let mtdOrganicBookings = 0;
    let mtdPaidAdsBookings = 0;
    let mtdTrialBookings = 0;
    let mtdOrderValue = 0;
    let mtdAdvancePaid = 0;

    for (const b of bookingsMtd) {
      const cat = classifyBooking(b);
      if (cat === 'organic') mtdOrganicBookings++;
      else if (cat === 'paid_ads') mtdPaidAdsBookings++;
      else if (cat === 'trial') mtdTrialBookings++;

      const net = (b.totalPrice || 0) - (b.discountAmount || 0);
      mtdOrderValue += net > 0 ? net : (b.totalPrice || 0);
      mtdAdvancePaid += (b.advanceAmount || b.collectedAmount || 0);
    }
    const totalBookingsMtd = bookingsMtd.length;

    // Contacted -> Booking %
    const contactedToBookingPctToday = leadsContactedToday > 0 ? round2((totalBookingsToday / leadsContactedToday) * 100) : 0;
    const contactedToBookingPctMtd = leadsContactedMtd > 0 ? round2((totalBookingsMtd / leadsContactedMtd) * 100) : 0;

    // Trial Conversion %
    const trialConversionPctToday = trialCampaignLeadsToday > 0 ? round2((todayTrialBookings / trialCampaignLeadsToday) * 100) : 0;
    const trialConversionPctMtd = trialCampaignLeadsMtd > 0 ? round2((mtdTrialBookings / trialCampaignLeadsMtd) * 100) : 0;

    // Pending Follow-ups Due
    const pendingFollowUps = await Lead.find({
      status: 'Follow-up',
      followUpDate: { $lte: dayEnd },
      ...(targetUserId ? { assignedTo: targetUserId } : {}),
    })
      .select('name customerName phone status followUpDate notes assignedTo')
      .sort({ followUpDate: 1 })
      .limit(50)
      .lean();

    // 8. Team Ledger Rows (Screenshot 1)
    let ledgerRows = [];
    let ledgerTotals = {
      whatsappLeads: 0,
      igMainLeads: 0,
      igKeralaLeads: 0,
      paidAdsLeads: 0,
      trialCampaignLeads: 0,
      leadsContacted: 0,
      followUpsDone: 0,
      organicBookings: 0,
      paidAdsBookings: 0,
      trialBookings: 0,
      totalOrderValue: 0,
      advancePaid: 0,
    };

    // Find all users who are in sales roles or have sales activity
    const repsForLedger = await User.find({
      role: { $in: ['sales', 'sales_executive', 'sales_manager', 'manager', 'admin'] },
    }).select('name email phone role').lean();

    // Iterate day-by-day across the selected window (matching Screenshot 1 ledger structure)
    for (const curDay of daysInRange) {
      const curDayFormatted = formatIstDateKey(curDay);

      // Leads, activities, and bookings for this specific calendar day
      const dayLeads = leadsCreatedToday.filter((l) => istDayKey(l.createdAt) === curDay);
      const dayActs = activitiesToday.filter((a) => istDayKey(a.createdAt) === curDay);
      const dayBookings = bookingsToday.filter((b) => istDayKey(b.createdAt) === curDay);

      for (const rep of repsForLedger) {
        const repIdStr = String(rep._id);

        // Rep's leads on curDay
        const repLeads = dayLeads.filter((l) => String(l.assignedTo || '') === repIdStr);
        const repWa = repLeads.filter((l) => classifySource(l.source) === 'whatsapp').length;
        const repIgMain = repLeads.filter((l) => classifySource(l.source) === 'ig_main').length;
        const repIgKerala = repLeads.filter((l) => classifySource(l.source) === 'ig_kerala').length;
        const repPaid = repLeads.filter((l) => classifySource(l.source) === 'paid_ads').length;
        const repTrial = repLeads.filter((l) => classifySource(l.source) === 'trial_campaign').length;

        // Rep's activities on curDay
        const repActs = dayActs.filter((a) => String(a.createdBy?._id || a.createdBy || '') === repIdStr);
        let repContacted = 0;
        let repFollowUps = 0;
        for (const a of repActs) {
          if (a.type === 'call' || String(a.callResponse || '').toLowerCase() === 'connected') repContacted++;
          if (a.status === 'Completed' || a.type === 'follow_up') repFollowUps++;
        }

        // Rep's bookings on curDay
        const repBookings = dayBookings.filter((b) =>
          String(b.salesPersonId || '') === repIdStr || String(b.createdBy || '') === repIdStr
        );
        let repOrganicB = 0;
        let repPaidB = 0;
        let repTrialB = 0;
        let repOrderVal = 0;
        let repAdvPaid = 0;

        for (const b of repBookings) {
          const cat = classifyBooking(b);
          if (cat === 'organic') repOrganicB++;
          else if (cat === 'paid_ads') repPaidB++;
          else if (cat === 'trial') repTrialB++;

          const net = (b.totalPrice || 0) - (b.discountAmount || 0);
          repOrderVal += net > 0 ? net : (b.totalPrice || 0);
          repAdvPaid += (b.advanceAmount || b.collectedAmount || 0);
        }

        // In single-day mode: include reps with activity or role in sales/sales_executive.
        // In range mode: include reps with activity on this day (or target salesperson).
        const hasActivity = repLeads.length > 0 || repActs.length > 0 || repBookings.length > 0;
        const shouldInclude = isRange
          ? (hasActivity || (targetUserId && repIdStr === targetUserId))
          : (hasActivity || ['sales', 'sales_executive'].includes(rep.role));

        if (shouldInclude) {
          const row = {
            userId: repIdStr,
            date: curDayFormatted,
            salesPersonName: rep.name || 'Unknown',
            role: rep.role,
            whatsappLeads: repWa,
            igMainLeads: repIgMain,
            igKeralaLeads: repIgKerala,
            paidAdsLeads: repPaid,
            trialCampaignLeads: repTrial,
            leadsContacted: repContacted,
            followUpsDone: repFollowUps,
            organicBookings: repOrganicB,
            paidAdsBookings: repPaidB,
            trialBookings: repTrialB,
            totalOrderValue: round2(repOrderVal),
            advancePaid: round2(repAdvPaid),
            comment: '',
          };
          ledgerRows.push(row);

          ledgerTotals.whatsappLeads += repWa;
          ledgerTotals.igMainLeads += repIgMain;
          ledgerTotals.igKeralaLeads += repIgKerala;
          ledgerTotals.paidAdsLeads += repPaid;
          ledgerTotals.trialCampaignLeads += repTrial;
          ledgerTotals.leadsContacted += repContacted;
          ledgerTotals.followUpsDone += repFollowUps;
          ledgerTotals.organicBookings += repOrganicB;
          ledgerTotals.paidAdsBookings += repPaidB;
          ledgerTotals.trialBookings += repTrialB;
          ledgerTotals.totalOrderValue += repOrderVal;
          ledgerTotals.advancePaid += repAdvPaid;
        }
      }
    }
    ledgerTotals.totalOrderValue = round2(ledgerTotals.totalOrderValue);
    ledgerTotals.advancePaid = round2(ledgerTotals.advancePaid);

    // If individual salesperson is chosen, ensure that individual row is reflected
    if (!isTeam && salesPersonInfo) {
      ledgerRows = ledgerRows.filter((r) => r.userId === targetUserId);
    }

    // Default primary lead-count task: WhatsApp or Instagram
    const leadCountTask = whatsappLeadsToday >= igMainLeadsToday ? 'WhatsApp' : 'Instagram';

    res.json({
      date: dateStr,
      reportDateFormatted,
      monthName,
      leadCountTask,
      isTeam,
      salesPerson: salesPersonInfo
        ? {
            id: String(salesPersonInfo._id),
            name: salesPersonInfo.name,
            email: salesPersonInfo.email,
            phone: salesPersonInfo.phone,
            role: salesPersonInfo.role,
          }
        : null,

      // Screenshot 2 Table 1: TODAY — ACHIEVABLE TARGET vs ACHIEVED
      todayTargetVsAchieved: {
        bookings: {
          metric: 'Bookings (Nos)',
          achievableTarget: achievableTargetBookings,
          achieved: totalBookingsToday,
          achievementPct: achievableTargetBookings > 0 ? round2((totalBookingsToday / achievableTargetBookings) * 100) : (totalBookingsToday > 0 ? 100 : 0),
          shortExcess: round2(achievableTargetBookings - totalBookingsToday),
        },
        bookingValue: {
          metric: 'Booking Value (₹)',
          achievableTarget: achievableTargetValue,
          achieved: round2(todayOrderValue),
          achievementPct: achievableTargetValue > 0 ? round2((todayOrderValue / achievableTargetValue) * 100) : (todayOrderValue > 0 ? 100 : 0),
          shortExcess: round2(achievableTargetValue - todayOrderValue),
        },
      },

      // Screenshot 2 Table 2: MONTH-TO-DATE (1st of month → report date)
      mtdTargetVsAchieved: {
        workingDaysMtd,
        workingDaysInMonth,
        bookings: {
          metric: 'Bookings (Nos)',
          mtdTarget: mtdTargetBookings,
          monthlyTarget: monthlyTargetBookings,
          mtdAchieved: totalBookingsMtd,
          mtdAchievementPct: mtdTargetBookings > 0 ? round2((totalBookingsMtd / mtdTargetBookings) * 100) : (totalBookingsMtd > 0 ? 100 : 0),
          fullMonthAchievementPct: monthlyTargetBookings > 0 ? round2((totalBookingsMtd / monthlyTargetBookings) * 100) : (totalBookingsMtd > 0 ? 100 : 0),
          balanceToTarget: round2(Math.max(0, monthlyTargetBookings - totalBookingsMtd)),
          shortExcessMtd: round2(mtdTargetBookings - totalBookingsMtd),
        },
        bookingValue: {
          metric: 'Booking Value (₹)',
          mtdTarget: mtdTargetValue,
          monthlyTarget: monthlyTargetValue,
          mtdAchieved: round2(mtdOrderValue),
          mtdAchievementPct: mtdTargetValue > 0 ? round2((mtdOrderValue / mtdTargetValue) * 100) : (mtdOrderValue > 0 ? 100 : 0),
          fullMonthAchievementPct: monthlyTargetValue > 0 ? round2((mtdOrderValue / monthlyTargetValue) * 100) : (mtdOrderValue > 0 ? 100 : 0),
          balanceToTarget: round2(Math.max(0, monthlyTargetValue - mtdOrderValue)),
          shortExcessMtd: round2(mtdTargetValue - mtdOrderValue),
        },
      },

      // Screenshot 2 Table 3: BOOKINGS BY SOURCE
      bookingsBySource: {
        organic: {
          source: 'Organic',
          today: todayOrganicBookings,
          mtd: mtdOrganicBookings,
          shareOfMtd: totalBookingsMtd > 0 ? round2((mtdOrganicBookings / totalBookingsMtd) * 100) : 0,
        },
        paidAds: {
          source: 'Paid Ads (Kerala page)',
          today: todayPaidAdsBookings,
          mtd: mtdPaidAdsBookings,
          shareOfMtd: totalBookingsMtd > 0 ? round2((mtdPaidAdsBookings / totalBookingsMtd) * 100) : 0,
        },
        trialBookings: {
          source: 'Trial Bookings',
          today: todayTrialBookings,
          mtd: mtdTrialBookings,
          shareOfMtd: totalBookingsMtd > 0 ? round2((mtdTrialBookings / totalBookingsMtd) * 100) : 0,
        },
        totalBookings: {
          source: 'Total Bookings',
          today: totalBookingsToday,
          mtd: totalBookingsMtd,
          shareOfMtd: 100,
        },
      },

      // Screenshot 3 Table 4: LEADS & FOLLOW-UPS LOGGED
      leadsAndFollowUps: {
        whatsappLeads: { label: 'WhatsApp Leads (Organic)', today: whatsappLeadsToday, mtd: whatsappLeadsMtd },
        igMainLeads: { label: 'IG Leads — Main Page', today: igMainLeadsToday, mtd: igMainLeadsMtd },
        igKeralaLeads: { label: 'IG Leads — Kerala Page', today: igKeralaLeadsToday, mtd: igKeralaLeadsMtd },
        paidAdsLeads: { label: 'Paid Ads Leads', today: paidAdsLeadsToday, mtd: paidAdsLeadsMtd },
        trialCampaignLeads: { label: 'Trial Campaign Leads', today: trialCampaignLeadsToday, mtd: trialCampaignLeadsMtd },
        leadsContacted: { label: 'Leads Contacted', today: leadsContactedToday, mtd: leadsContactedMtd },
        followUpsDone: { label: 'Follow-ups Done', today: followUpsDoneToday, mtd: followUpsDoneMtd },
        contactedToBookingPct: { label: 'Contacted → Booking %', today: contactedToBookingPctToday, mtd: contactedToBookingPctMtd },
        teamMissedLeads: { label: 'Team Missed Leads (IG – WhatsApp)', today: teamMissedLeadsToday, mtd: teamMissedLeadsMtd },
      },

      // Screenshot 3 Table 5: TRIAL BOOKING CAMPAIGN
      trialCampaign: {
        trialCampaignLeads: { metric: 'Trial Campaign Leads', today: trialCampaignLeadsToday, mtd: trialCampaignLeadsMtd },
        trialBookings: { metric: 'Trial Bookings', today: todayTrialBookings, mtd: mtdTrialBookings },
        trialConversionPct: { metric: 'Trial Conversion %', today: trialConversionPctToday, mtd: trialConversionPctMtd },
      },

      // Screenshot 3 Table 6: ORDER VALUE & PAYMENTS
      orderValueAndPayments: {
        totalOrderValue: { metric: 'Total Order Value (₹)', today: round2(todayOrderValue), mtd: round2(mtdOrderValue) },
        advancePaid: { metric: 'Advance Paid (₹)', today: round2(todayAdvancePaid), mtd: round2(mtdAdvancePaid) },
        balanceDue: { metric: 'Balance Due (₹)', today: round2(Math.max(0, todayOrderValue - todayAdvancePaid)), mtd: round2(Math.max(0, mtdOrderValue - mtdAdvancePaid)) },
      },

      // Screenshot 1: Team Daily Ledger Rows & Totals
      ledgerRows,
      ledgerTotals,

      // Summary backward-compatibility
      summary: {
        callsMade: callsMadeToday,
        callsConnected: callsConnectedToday,
        callsNoAnswer: callsNoAnswerToday,
        callsBusy: callsBusyToday,
        followUpsCompleted: followUpsDoneToday,
        followUpsPending: followUpsPendingToday,
        newLeadsAssigned: leadsCreatedToday.length,
        leadsConverted: leadsConvertedToday.length,
        bookingsCount: totalBookingsToday,
        totalRevenue: round2(todayOrderValue),
        totalAdvance: round2(todayAdvancePaid),
        pendingFollowUpsCount: pendingFollowUps.length,
      },
      bookings: bookingsToday.map((b) => ({
        id: String(b._id),
        bookingNumber: b.bookingNumber || '',
        customerName: b.customerName || 'Unknown',
        phone: b.phone || '',
        service: b.service || 'Service',
        totalPrice: round2((b.totalPrice || 0) - (b.discountAmount || 0)),
        advanceAmount: round2(b.advanceAmount || b.collectedAmount || 0),
        status: b.status || 'confirmed',
        source: b.leadId?.source || 'WhatsApp (Organic)',
        time: b.createdAt
          ? new Date(b.createdAt).toLocaleTimeString('en-IN', {
              timeZone: 'Asia/Kolkata',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
      })),
      activities: activitiesToday.slice(0, 50).map((a) => ({
        id: String(a._id),
        leadName: a.leadId?.customerName || a.leadId?.name || 'Lead',
        leadPhone: a.leadId?.phone || '',
        type: a.type || 'activity',
        status: a.status || 'Completed',
        callResponse: a.callResponse || 'N/A',
        remark: a.remark || '',
        userName: a.createdBy?.name || '',
        time: a.createdAt
          ? new Date(a.createdAt).toLocaleTimeString('en-IN', {
              timeZone: 'Asia/Kolkata',
              hour: '2-digit',
              minute: '2-digit',
            })
          : '',
      })),
      pendingFollowUps: pendingFollowUps.slice(0, 20).map((l) => ({
        id: String(l._id),
        customerName: l.customerName || l.name || 'Lead',
        phone: l.phone || '',
        followUpDate: l.followUpDate ? new Date(l.followUpDate).toISOString().slice(0, 10) : '',
        notes: l.notes || '',
      })),
      teamBreakdown: ledgerRows.map((r) => ({
        id: r.userId,
        name: r.salesPersonName,
        role: r.role,
        callsMade: r.leadsContacted,
        callsConnected: r.leadsContacted,
        newLeads: r.whatsappLeads + r.igMainLeads + r.igKeralaLeads + r.paidAdsLeads + r.trialCampaignLeads,
        bookingsCount: r.organicBookings + r.paidAdsBookings + r.trialBookings,
        revenue: r.totalOrderValue,
        advance: r.advancePaid,
      })),
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
