import Booking from '../models/Booking.js';
import Lead from '../models/Lead.js';
import Customer from '../models/Customer.js';
import Employee from '../models/Employee.js';
import Salary from '../models/Salary.js';
import InventoryProduct from '../models/InventoryProduct.js';
import Purchase from '../models/Purchase.js';
import Subscription from '../models/Subscription.js';
import AdminExpense from '../models/AdminExpense.js';
import ITTask from '../models/ITTask.js';
import DepartmentReport, { DEPARTMENT_KEYS } from '../models/DepartmentReport.js';
import { round2 } from './accountingController.js';

const FINANCE_ROLES = ['admin', 'manager', 'accounts'];
const canView = (u) => FINANCE_ROLES.includes(u?.role);

const DEAD_BOOKING = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];
const isLive = (st) => !DEAD_BOOKING.includes(String(st || '').toLowerCase());
const pct = (n, d) => (d ? round2((n / d) * 100) : 0);

// metric helper: [key, label, unit, auto?]  unit: inr|pct|count|days|ratio|text
const m = (key, label, unit, auto = false) => ({ key, label, unit, auto });

// ── Department framework config (mirrors the Month-End Reporting doc) ────────
const DEPARTMENTS = {
  sales: {
    label: 'Sales', reviewMinutes: 60, planningMinutes: 30,
    sections: [
      { title: 'Revenue & Booking Review', metrics: [
        m('bookingsConfirmed', 'Bookings confirmed', 'count', true),
        m('revenue', 'Revenue', 'inr', true),
        m('abv', 'Average Booking Value (ABV)', 'inr', true),
        m('abvGrowthPct', 'ABV growth vs last month', 'pct', true),
        m('revenueByServiceLine', 'Revenue by service line (notes)', 'text'),
      ]},
      { title: 'Lead & Conversion Performance', metrics: [
        m('leadsReceived', 'Leads received', 'count', true),
        m('leadsConverted', 'Leads converted', 'count', true),
        m('conversionRatePct', 'Conversion rate', 'pct', true),
        m('lostLeads', 'Lost leads', 'count', true),
      ]},
      { title: 'Sales Pipeline', metrics: [
        m('confirmedNextMonth', 'Confirmed bookings next month', 'count', true),
        m('tentativeBookings', 'Tentative / advance-paid bookings', 'count'),
        m('highValuePipeline', 'High-value client pipeline (notes)', 'text'),
      ]},
      { title: 'Team & Retention', metrics: [
        m('topPerformer', 'Top performer', 'text'),
        m('incentivePayout', 'Incentive payout', 'inr'),
        m('repeatClientPct', 'Repeat client %', 'pct'),
        m('cancellations', 'Cancellations / refunds', 'count', true),
      ]},
    ],
    kpis: [
      m('conversionRatePct', 'Booking Conversion Rate', 'pct', true),
      m('abv', 'Average Booking Value', 'inr', true),
      m('cancellationRatePct', 'Cancellation Rate', 'pct', true),
      m('cac', 'Customer Acquisition Cost', 'inr'),
      m('repeatClientRate', 'Repeat Client Rate', 'pct'),
      m('pipelineValue', 'Sales Pipeline Value', 'inr'),
    ],
    targets: [
      m('revenueTarget', 'Revenue target', 'inr'),
      m('newBookingsTarget', 'New bookings target', 'count'),
      m('newClientTarget', 'New client acquisition target', 'count'),
    ],
  },
  marketing: {
    label: 'Marketing', reviewMinutes: 60, planningMinutes: 30,
    sections: [
      { title: 'Campaign Performance', metrics: [
        m('adSpend', 'Ad / marketing spend', 'inr', true),
        m('leadsGenerated', 'Leads generated', 'count'),
        m('bookingsGenerated', 'Bookings generated', 'count'),
        m('roas', 'Return on Ad Spend (ROAS)', 'ratio'),
        m('cpl', 'Cost per lead', 'inr'),
      ]},
      { title: 'Content Performance', metrics: [
        m('topContent', 'Top-performing posts/formats', 'text'),
        m('followerGrowthPct', 'Follower growth', 'pct'),
        m('engagementRatePct', 'Engagement rate', 'pct'),
      ]},
      { title: 'Lead Gen & Influencer ROI', metrics: [
        m('marketingSourcedLeads', 'Marketing-sourced leads', 'count', true),
        m('influencerOutcome', 'Influencer collaboration outcome (notes)', 'text'),
      ]},
      { title: 'Brand Presence', metrics: [
        m('statesActive', 'States/cities active this month', 'count'),
        m('newStatePages', 'New state pages launched', 'count'),
      ]},
    ],
    kpis: [
      m('reach', 'Reach & Impressions', 'count'),
      m('engagementRatePct', 'Engagement Rate', 'pct'),
      m('cpl', 'Cost Per Lead (CPL)', 'inr'),
      m('followerGrowthPct', 'Follower Growth Rate', 'pct'),
      m('roas', 'Return on Ad Spend (ROAS)', 'ratio'),
      m('influencerRoi', 'Influencer ROI', 'ratio'),
    ],
    targets: [
      m('reachTarget', 'Reach & follower growth target', 'count'),
      m('leadGenTarget', 'Lead generation target', 'count'),
      m('engagementTarget', 'Engagement rate target', 'pct'),
    ],
  },
  hr: {
    label: 'HR', reviewMinutes: 60, planningMinutes: 30,
    sections: [
      { title: 'Headcount & Recruitment', metrics: [
        m('headcount', 'Headcount (active)', 'count', true),
        m('hires', 'Hires this month', 'count', true),
        m('attrition', 'Attrition this month', 'count'),
        m('openPositions', 'Open positions', 'count'),
        m('recruitmentFunnel', 'Recruitment funnel (apps→interviews→offers→joins)', 'text'),
      ]},
      { title: 'Performance & Discipline', metrics: [
        m('underperformers', 'Roles flagged (PIP)', 'count'),
        m('attendancePct', 'Attendance / punctuality %', 'pct'),
        m('warningLetters', 'Warning letters / actions', 'count'),
      ]},
      { title: 'Training & Relations', metrics: [
        m('trainingSessions', 'Training sessions conducted', 'count'),
        m('grievances', 'Grievances raised/resolved', 'text'),
      ]},
      { title: 'Payroll', metrics: [
        m('salaryProcessedCount', 'Salaries processed', 'count', true),
        m('salaryProcessedAmount', 'Payroll paid', 'inr', true),
        m('statutoryCompliance', 'Statutory compliance (PF/ESI)', 'text'),
      ]},
    ],
    kpis: [
      m('attritionRatePct', 'Attrition Rate', 'pct'),
      m('timeToHire', 'Time-to-Hire', 'days'),
      m('costPerHire', 'Cost-per-Hire', 'inr'),
      m('roe', 'Return on Employee', 'inr'),
      m('trainingCompletionPct', 'Training Completion Rate', 'pct'),
      m('absenteeismPct', 'Absenteeism Rate', 'pct'),
    ],
    targets: [
      m('hiringTarget', 'Hiring target by role', 'count'),
      m('trainingCompletionTarget', 'Training completion target', 'pct'),
      m('attritionControlTarget', 'Attrition control target', 'pct'),
    ],
  },
  operations: {
    label: 'Operations', reviewMinutes: 45, planningMinutes: 30,
    sections: [
      { title: 'Service Delivery', metrics: [
        m('bookingsFulfilled', 'Bookings fulfilled', 'count', true),
        m('bookingsScheduled', 'Bookings scheduled', 'count', true),
        m('onTimeDeliveryPct', 'On-time arrival/delivery %', 'pct'),
        m('complaints', 'Service delivery complaints', 'count'),
      ]},
      { title: 'Team Utilization', metrics: [
        m('utilizationPct', 'MUA / stylist / drapist utilization', 'pct'),
        m('overtimeHours', 'Overtime hours logged', 'count'),
      ]},
      { title: 'Quality & Client Experience', metrics: [
        m('csat', 'Client satisfaction (CSAT)', 'ratio'),
        m('reworkCases', 'Rework / redo cases', 'count'),
      ]},
      { title: 'Logistics & Readiness', metrics: [
        m('logisticsIssues', 'Travel/vendor coordination issues', 'text'),
        m('kitReadiness', 'Kit & equipment readiness', 'text'),
      ]},
    ],
    kpis: [
      m('utilizationPct', 'Utilization Rate', 'pct'),
      m('onTimeDeliveryPct', 'On-Time Delivery %', 'pct'),
      m('csat', 'Client Satisfaction (CSAT)', 'ratio'),
      m('reworkRatePct', 'Rework Rate', 'pct'),
      m('costPerService', 'Cost per Service Delivered', 'inr'),
    ],
    targets: [
      m('serviceCapacityTarget', 'Service capacity target (bookings/day)', 'count'),
      m('utilizationTarget', 'Utilization rate target', 'pct'),
      m('csatTarget', 'CSAT target', 'ratio'),
    ],
  },
  crm: {
    label: 'CRM', reviewMinutes: 45, planningMinutes: 30,
    sections: [
      { title: 'Client Database & Engagement', metrics: [
        m('newClients', 'New clients added', 'count', true),
        m('activeClients', 'Active clients', 'count'),
        m('inactiveClients', 'Inactive clients', 'count'),
        m('databaseHygiene', 'Database hygiene (duplicates cleaned)', 'text'),
      ]},
      { title: 'Query & Complaint Handling', metrics: [
        m('avgResponseTime', 'Average response time', 'days'),
        m('resolutionRatePct', 'Complaint resolution rate', 'pct'),
        m('pendingCases', 'Pending cases', 'count'),
      ]},
      { title: 'Booking Coordination & Feedback', metrics: [
        m('bookingsAssisted', 'Bookings assisted via follow-up', 'count'),
        m('followUpConversionPct', 'Follow-up-to-conversion rate', 'pct'),
        m('nps', 'NPS / CSAT collected', 'ratio'),
        m('testimonials', 'Testimonials/reviews gathered', 'count'),
      ]},
    ],
    kpis: [
      m('avgResponseTime', 'Response Time', 'days'),
      m('resolutionRatePct', 'Resolution Rate', 'pct'),
      m('nps', 'Net Promoter Score (NPS)', 'ratio'),
      m('clientRetentionPct', 'Client Retention Rate', 'pct'),
      m('followUpConversionPct', 'Follow-up Conversion Rate', 'pct'),
    ],
    targets: [
      m('responseSlaTarget', 'Response time SLA target', 'days'),
      m('resolutionTarget', 'Complaint resolution target', 'pct'),
      m('retentionTarget', 'Client retention/reactivation target', 'pct'),
    ],
  },
  it: {
    label: 'IT', reviewMinutes: 45, planningMinutes: 30,
    sections: [
      { title: 'Systems & Performance', metrics: [
        m('uptimePct', 'System/website/app uptime', 'pct'),
        m('performanceIssues', 'Page load / performance issues', 'text'),
      ]},
      { title: 'Support & Tickets', metrics: [
        m('ticketsRaised', 'Support tickets raised', 'count', true),
        m('ticketsResolved', 'Support tickets resolved', 'count', true),
        m('avgResolutionTime', 'Average ticket resolution time', 'days'),
      ]},
      { title: 'Data Security', metrics: [
        m('securityIncidents', 'Security incidents / breaches', 'count'),
        m('backupStatus', 'Backup completion status', 'text'),
      ]},
      { title: 'Tools & Development', metrics: [
        m('subscriptionCost', 'Software/tool subscription cost', 'inr', true),
        m('newReleases', 'New feature releases/updates', 'text'),
      ]},
    ],
    kpis: [
      m('uptimePct', 'System Uptime %', 'pct'),
      m('avgResolutionTime', 'Average Ticket Resolution Time', 'days'),
      m('securityIncidents', 'Security Incident Count', 'count'),
      m('itCostPerEmployee', 'IT Cost per Employee', 'inr', true),
    ],
    targets: [
      m('uptimeTarget', 'Uptime target', 'pct'),
      m('ticketSlaTarget', 'Ticket resolution SLA target', 'days'),
      m('softwareBudget', 'Software/subscription budget', 'inr'),
    ],
  },
  inventory: {
    label: 'Inventory', reviewMinutes: 45, planningMinutes: 30,
    sections: [
      { title: 'Stock Review', metrics: [
        m('stockItems', 'Current stock items (SKUs)', 'count', true),
        m('stockValue', 'Total stock value', 'inr', true),
        m('stockUsageVsPlanned', 'Stock usage vs planned (notes)', 'text'),
      ]},
      { title: 'Wastage & Loss', metrics: [
        m('wastageValue', 'Wastage/damage value', 'inr'),
        m('expiredWriteOffs', 'Expired product write-offs', 'inr'),
        m('expiringSoon', 'Expiring within 90 days', 'count', true),
      ]},
      { title: 'Reorder & Vendor Status', metrics: [
        m('lowStock', 'Low-stock items', 'count', true),
        m('pendingPurchases', 'Pending/unpaid purchase orders', 'count', true),
        m('vendorIssues', 'Vendor delivery/quality issues', 'text'),
      ]},
      { title: 'Valuation', metrics: [
        m('purchasesThisMonth', 'Purchases this month', 'inr', true),
      ]},
    ],
    kpis: [
      m('inventoryTurnover', 'Inventory Turnover Ratio', 'ratio'),
      m('stockoutRatePct', 'Stockout Rate', 'pct'),
      m('wastagePct', 'Wastage %', 'pct'),
      m('daysOfInventory', 'Days of Inventory on Hand', 'days'),
      m('vendorLeadTime', 'Vendor Lead Time', 'days'),
    ],
    targets: [
      m('stockTurnoverTarget', 'Stock turnover target', 'ratio'),
      m('wastageReductionTarget', 'Wastage reduction target', 'pct'),
      m('procurementBudget', 'Procurement budget', 'inr'),
    ],
  },
};

// ── Auto-metric computation per department ──────────────────────────────────
async function computeAuto(dept, from, to, prevFrom, prevTo) {
  const inP = (d) => d && new Date(d) >= from && new Date(d) <= to;
  const out = {};

  if (dept === 'sales') {
    const bookings = await Booking.find({}).select('totalPrice bookingDate serviceStart createdAt status').limit(50000).lean();
    const live = bookings.filter((b) => isLive(b.status));
    const cur = live.filter((b) => inP(b.bookingDate || b.createdAt));
    const prev = live.filter((b) => b.bookingDate && new Date(b.bookingDate) >= prevFrom && new Date(b.bookingDate) <= prevTo);
    const rev = round2(cur.reduce((s, b) => s + (b.totalPrice || 0), 0));
    out.bookingsConfirmed = cur.length;
    out.revenue = rev;
    out.abv = cur.length ? round2(rev / cur.length) : 0;
    const prevAbv = prev.length ? prev.reduce((s, b) => s + (b.totalPrice || 0), 0) / prev.length : 0;
    out.abvGrowthPct = prevAbv ? pct(out.abv - prevAbv, prevAbv) : 0;
    out.cancellations = bookings.filter((b) => ['cancelled', 'canceled'].includes(String(b.status || '').toLowerCase()) && inP(b.bookingDate || b.createdAt)).length;
    out.cancellationRatePct = cur.length + out.cancellations ? pct(out.cancellations, cur.length + out.cancellations) : 0;
    // next month confirmed = events falling in next month
    out.confirmedNextMonth = live.filter((b) => b.serviceStart && new Date(b.serviceStart) > to && new Date(b.serviceStart) <= new Date(to.getFullYear(), to.getMonth() + 2, 0)).length;

    const leads = await Lead.find({}).select('leadDate enquiryDate bookingId status source createdAt').limit(50000).lean();
    const curLeads = leads.filter((l) => inP(l.leadDate || l.enquiryDate || l.createdAt));
    out.leadsReceived = curLeads.length;
    out.leadsConverted = curLeads.filter((l) => l.bookingId).length;
    out.conversionRatePct = pct(out.leadsConverted, curLeads.length);
    out.lostLeads = curLeads.filter((l) => /lost|reject/i.test(String(l.status || ''))).length;
  }

  if (dept === 'marketing') {
    const expenses = await AdminExpense.find({ source: { $ne: 'hra' } }).select('amount category department date').lean();
    out.adSpend = round2(expenses.filter((e) => inP(e.date) && /market/i.test(`${e.category || ''} ${e.department || ''}`)).reduce((s, e) => s + (e.amount || 0), 0));
    const leads = await Lead.find({}).select('leadDate enquiryDate source createdAt').limit(50000).lean();
    out.marketingSourcedLeads = leads.filter((l) => inP(l.leadDate || l.enquiryDate || l.createdAt) && /instagram|facebook|google|youtube|social|ad|website/i.test(String(l.source || ''))).length;
  }

  if (dept === 'hr') {
    out.headcount = await Employee.countDocuments({ status: 'active' });
    out.hires = await Employee.countDocuments({ createdAt: { $gte: from, $lte: to } });
    const paid = await Salary.find({ status: 'paid', month: from.getMonth() + 1, year: from.getFullYear() }).select('netAmount').lean();
    out.salaryProcessedCount = paid.length;
    out.salaryProcessedAmount = round2(paid.reduce((s, x) => s + (x.netAmount || 0), 0));
  }

  if (dept === 'operations') {
    const bookings = await Booking.find({}).select('serviceStart bookingDate status').limit(50000).lean();
    out.bookingsScheduled = bookings.filter((b) => isLive(b.status) && inP(b.serviceStart || b.bookingDate)).length;
    out.bookingsFulfilled = bookings.filter((b) => String(b.status || '').toLowerCase() === 'completed' && inP(b.serviceStart || b.bookingDate)).length;
  }

  if (dept === 'crm') {
    out.newClients = await Customer.countDocuments({ createdAt: { $gte: from, $lte: to } });
  }

  if (dept === 'it') {
    const subs = await Subscription.find({ status: { $ne: 'cancelled' } }).select('cost').lean();
    out.subscriptionCost = round2(subs.reduce((s, x) => s + (x.cost || 0), 0));
    out.ticketsRaised = await ITTask.countDocuments({ createdAt: { $gte: from, $lte: to } });
    out.ticketsResolved = await ITTask.countDocuments({ status: { $in: ['done', 'completed', 'resolved', 'closed'] }, updatedAt: { $gte: from, $lte: to } });
    const headcount = await Employee.countDocuments({ status: 'active' });
    out.itCostPerEmployee = headcount ? round2(out.subscriptionCost / headcount) : 0;
  }

  if (dept === 'inventory') {
    const products = await InventoryProduct.find({}).select('quantity price expiry lowStockThreshold').lean();
    out.stockItems = products.length;
    out.stockValue = round2(products.reduce((s, p) => s + (p.quantity || 0) * (p.price || 0), 0));
    const soon = new Date(to.getTime() + 90 * 86400000);
    out.expiringSoon = products.filter((p) => p.expiry && new Date(p.expiry) <= soon && (p.quantity || 0) > 0).length;
    out.lowStock = products.filter((p) => (p.lowStockThreshold || 0) > 0 && (p.quantity || 0) <= p.lowStockThreshold).length;
    out.pendingPurchases = await Purchase.countDocuments({ paid: { $ne: true } });
    const purch = await Purchase.find({ date: { $gte: from, $lte: to } }).select('total gstAmount').lean();
    out.purchasesThisMonth = round2(purch.reduce((s, p) => s + (p.total || 0) + (p.gstAmount || 0), 0));
  }

  return out;
}

// ── Endpoints ───────────────────────────────────────────────────────────────

// @route GET /api/reports/departments
export const listDepartments = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  res.json(DEPARTMENT_KEYS.map((k) => ({ key: k, label: DEPARTMENTS[k].label, reviewMinutes: DEPARTMENTS[k].reviewMinutes, planningMinutes: DEPARTMENTS[k].planningMinutes })));
};

// @route GET /api/reports/department/:dept?month=&year=
export const getDepartmentReport = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const dept = req.params.dept;
    const cfg = DEPARTMENTS[dept];
    if (!cfg) return res.status(404).json({ message: 'Unknown department' });

    const now = new Date();
    const month = Number(req.query.month) || now.getMonth() + 1;
    const year = Number(req.query.year) || now.getFullYear();
    const from = new Date(year, month - 1, 1);
    const to = new Date(year, month, 0, 23, 59, 59, 999);
    const prevFrom = new Date(year, month - 2, 1);
    const prevTo = new Date(year, month - 1, 0, 23, 59, 59, 999);

    const [auto, saved] = await Promise.all([
      computeAuto(dept, from, to, prevFrom, prevTo),
      DepartmentReport.findOne({ department: dept, month, year }).lean(),
    ]);
    const manual = saved?.values || {};
    const savedTargets = saved?.targets || {};

    const resolve = (metric) => ({
      ...metric,
      value: metric.auto ? (auto[metric.key] ?? null) : (manual[metric.key] ?? null),
    });

    res.json({
      department: dept,
      label: cfg.label,
      month, year,
      reviewMinutes: cfg.reviewMinutes,
      planningMinutes: cfg.planningMinutes,
      sections: cfg.sections.map((s) => ({ title: s.title, metrics: s.metrics.map(resolve) })),
      kpis: cfg.kpis.map(resolve),
      targetsConfig: cfg.targets,
      targets: cfg.targets.reduce((acc, t) => ({ ...acc, [t.key]: savedTargets[t.key] ?? null }), {}),
      allocations: saved?.allocations || [],
      actionItems: saved?.actionItems || [],
      notes: saved?.notes || '',
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @route PUT /api/reports/department/:dept  (upsert manual values + planning)
export const saveDepartmentReport = async (req, res) => {
  if (!canView(req.user)) return res.status(403).json({ message: 'No finance access' });
  try {
    const dept = req.params.dept;
    if (!DEPARTMENTS[dept]) return res.status(404).json({ message: 'Unknown department' });
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ message: 'month and year are required' });

    const update = {
      values: req.body.values && typeof req.body.values === 'object' ? req.body.values : {},
      targets: req.body.targets && typeof req.body.targets === 'object' ? req.body.targets : {},
      allocations: Array.isArray(req.body.allocations)
        ? req.body.allocations.filter((a) => a && a.name).map((a) => ({ name: String(a.name), amount: Number(a.amount) || 0 }))
        : [],
      actionItems: Array.isArray(req.body.actionItems)
        ? req.body.actionItems.filter((a) => a && a.text).map((a) => ({ text: String(a.text), owner: a.owner || '', dueDate: a.dueDate ? new Date(a.dueDate) : null, done: !!a.done }))
        : [],
      notes: req.body.notes || '',
      updatedBy: req.user?._id || null,
    };
    const doc = await DepartmentReport.findOneAndUpdate(
      { department: dept, month: Number(month), year: Number(year) },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    res.json(doc);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
