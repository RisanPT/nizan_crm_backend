// What the CEO's home screen asks the server for: the decisions waiting for the CEO, the approvals stuck with the team (and for how
// long), and a short watch list. The shaping is pure (tests/ceoInbox.test.js); the loaders only count and sum.
import Project from '../models/Project.js';
import CeoDecision from '../models/CeoDecision.js';
import AdminExpense from '../models/AdminExpense.js';
import Expense from '../models/Expense.js';
import FuelExpense from '../models/FuelExpense.js';
import Collection from '../models/Collection.js';
import Booking from '../models/Booking.js';
import ArtistPayout from '../models/ArtistPayout.js';
import ApprovalRequest from '../models/ApprovalRequest.js';
import HiringPlan from '../models/HiringPlan.js';
import Lead from '../models/Lead.js';
import SalesReturn from '../models/SalesReturn.js';
import TaxFiling from '../models/TaxFiling.js';
import OKR from '../models/OKR.js';
import StrategicVision from '../models/StrategicVision.js';
import InventoryProduct from '../models/InventoryProduct.js';
import Review from '../models/Review.js';
import DecisionRequest from '../models/DecisionRequest.js';
import { istMonthBounds } from '../utils/istDate.js';
import { deskSummary } from './decisions.js';

const DAY_MS = 86_400_000;

// One row per thing that can be waiting. `owner: 'you'` = the CEO's own decision; 'team' = waiting with someone else, shown so
// that a stuck approval is seen. `route` is only set where the CEO can actually open the screen.
export const INBOX_SOURCES = [
  { key: 'project_proposals', owner: 'you', label: 'Project proposals to decide', model: Project, match: { status: 'proposed' }, route: '/projects' },
  // Spends above the limit, hiring plans and budget increases the team has CHECKED and is waiting for the leaders to decide (a deferred
  // one is hidden until its date). Proposals are counted above, from the projects themselves.
  {
    key: 'decision_requests',
    owner: 'you',
    label: 'Checked by the team, waiting for your decision',
    model: DecisionRequest,
    match: (now) => ({ open: true, kind: { $ne: 'project_proposal' }, $or: [{ status: 'pending' }, { deferredUntil: null }, { deferredUntil: { $lte: now } }] }),
    amount: 'amount',
    route: '/ceo/decisions',
  },
  { key: 'ceo_decisions', owner: 'you', label: 'Open CEO decisions', model: CeoDecision, match: { status: { $in: ['pending', 'deferred'] }, deletedAt: null }, amount: 'amount', route: '/ceo/decisions' },
  // (an expense, payout or plan that is with the leaders is NOT also "waiting with the team")
  { key: 'admin_expenses', owner: 'team', label: 'Department expenses', withWhom: 'Accounts', model: AdminExpense, match: { status: 'pending', 'leadership.state': { $ne: 'awaiting' } }, amount: 'amount', route: '/accounts/dashboard' },
  { key: 'artist_expenses', owner: 'team', label: 'Artist expenses', withWhom: 'Accounts', model: Expense, match: { status: 'pending' }, amount: 'amount', route: '/accounts/dashboard' },
  { key: 'fuel_expenses', owner: 'team', label: 'Fuel / driver bills', withWhom: 'Accounts', model: FuelExpense, match: { status: 'pending' }, amount: 'totalAmount', route: '/accounts/dashboard' },
  { key: 'collections', owner: 'team', label: 'Collections to verify', withWhom: 'Accounts', model: Collection, match: { status: 'pending' }, amount: 'amount', route: '/accounts/dashboard' },
  { key: 'booking_advances', owner: 'team', label: 'Booking advances to verify', withWhom: 'Accounts', model: Booking, match: { advanceStatus: 'pending' }, amount: 'advanceAmount' },
  { key: 'artist_payouts', owner: 'team', label: 'Freelancer payouts to approve or pay', withWhom: 'Accounts', model: ArtistPayout, match: { status: { $in: ['pending', 'approved'] }, 'leadership.state': { $ne: 'awaiting' } }, amount: 'amount', route: '/accounts/dashboard' },
  { key: 'hr_approvals', owner: 'team', label: 'HR approvals (leave, claims, revisions)', withWhom: 'HR / managers', model: ApprovalRequest, match: { status: 'pending' } },
  { key: 'hiring_plans', owner: 'team', label: 'Hiring plans raised', withWhom: 'HR', model: HiringPlan, match: { status: 'raised', 'leadership.state': { $ne: 'awaiting' } } },
  { key: 'lost_leads', owner: 'team', label: 'Lost-lead reviews', withWhom: 'Sales managers', model: Lead, match: { status: 'Pending Lost Approval' } },
  { key: 'sales_returns', owner: 'team', label: 'Refunds / credit notes in draft', withWhom: 'Accounts', model: SalesReturn, match: { status: 'draft' }, amount: 'amount' },
];

/// rows: [{ def, count, amount, oldest }] → the items the app shows: only what is waiting, the CEO's own first, then the
/// longest-waiting first.
export const shapeInbox = (rows, now = new Date()) => {
  const items = rows
    .filter((r) => (r.count ?? 0) > 0)
    .map((r) => ({
      key: r.def.key,
      label: r.def.label,
      owner: r.def.owner,
      withWhom: r.def.withWhom ?? null,
      count: r.count,
      amount: r.def.amount ? Math.round((Number(r.amount) || 0) * 100) / 100 : null,
      oldestDays: r.oldest ? Math.max(0, Math.floor((now.getTime() - new Date(r.oldest).getTime()) / DAY_MS)) : null,
      route: r.def.route ?? null,
    }));
  items.sort((a, b) => (a.owner === b.owner ? (b.oldestDays ?? -1) - (a.oldestDays ?? -1) : a.owner === 'you' ? -1 : 1));
  const total = (owner) => items.filter((i) => i.owner === owner).reduce((s, i) => s + i.count, 0);
  const stuck = items.filter((i) => i.owner === 'team');
  return {
    items,
    needsYou: total('you'),
    withTeam: total('team'),
    oldestTeamDays: stuck.reduce((m, i) => Math.max(m, i.oldestDays ?? 0), 0),
  };
};

const loadRow = async (def, now = new Date()) => {
  const match = typeof def.match === 'function' ? def.match(now) : def.match;
  const [count, sum, oldest] = await Promise.all([
    def.model.countDocuments(match),
    def.amount
      ? def.model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${def.amount}` } } }])
      : Promise.resolve([]),
    def.model.findOne(match).sort({ createdAt: 1 }).select('createdAt').lean(),
  ]);
  return { def, count, amount: sum[0]?.total ?? 0, oldest: oldest?.createdAt ?? null };
};

/// The unfiltered counts: they do not depend on who asks (the CEO, admin and manager all see every proposal).
/// `items`, `needsYou`, `withTeam`, `oldestTeamDays` are what older apps read; `decisions` (the desk: counts + the first few requests),
/// `recent` (the last decided) and `log` (the manual log) are what the new home reads.
export const loadCeoInbox = async (now = new Date()) => {
  const rows = await Promise.all(INBOX_SOURCES.map((def) => loadRow(def, now)));
  // A GST/TDS filing that is still pending past its due date
  const overdueFilings = await TaxFiling.countDocuments({ status: 'pending', dueDate: { $lt: now } });
  if (overdueFilings > 0) {
    rows.push({ def: { key: 'tax_filings', owner: 'team', label: 'Tax filings overdue', withWhom: 'Accounts' }, count: overdueFilings, amount: 0, oldest: null });
  }
  const inbox = shapeInbox(rows, now);
  const desk = await deskSummary(now);
  return {
    ...inbox,
    ...desk,
    log: { open: inbox.items.find((i) => i.key === 'ceo_decisions')?.count ?? 0 },
  };
};

// ── the watch list ──────────────────────────────────────────────────────────

/// "How much worse is it than it should be": more than one is a watch, three or more (or a clear jump) an alert.
const level = (n, { watch = 1, alert = 3 } = {}) => (n >= alert ? 'alert' : n >= watch ? 'watch' : 'ok');

/// NPS from 0–10 scores: promoters (9–10) minus detractors (0–6), as a percentage of those who answered. Null if nobody did.
export const npsOf = (scores) => {
  const s = scores.filter((n) => typeof n === 'number');
  if (!s.length) return null;
  const promoters = s.filter((n) => n >= 9).length;
  const detractors = s.filter((n) => n <= 6).length;
  return Math.round(((promoters - detractors) / s.length) * 100);
};

/// raw: { overdueProjects, blockedOkrs, atRiskMilestones, lowStock, cancelledThisMonth, cancelledLastMonth, npsNow, npsBefore }
export const shapeSignals = (raw) => {
  const out = [];
  const add = (s) => out.push(s);

  add({ key: 'overdue_projects', label: 'Projects past their end date', value: raw.overdueProjects, severity: level(raw.overdueProjects), route: '/projects' });
  add({ key: 'blocked_okrs', label: 'Blocked objectives', value: raw.blockedOkrs, severity: level(raw.blockedOkrs), route: '/projects' });
  add({ key: 'at_risk_milestones', label: 'Strategic milestones at risk', value: raw.atRiskMilestones, severity: level(raw.atRiskMilestones, { alert: 2 }), route: '/projects' });
  add({ key: 'low_stock', label: 'Products at or below their stock threshold', value: raw.lowStock, severity: level(raw.lowStock, { watch: 1, alert: 10 }), route: null });

  const jump = raw.cancelledThisMonth >= 3 && raw.cancelledThisMonth > raw.cancelledLastMonth * 1.25;
  add({
    key: 'cancellations',
    label: 'Cancelled works this month',
    value: raw.cancelledThisMonth,
    previous: raw.cancelledLastMonth,
    severity: jump ? 'alert' : raw.cancelledThisMonth > raw.cancelledLastMonth ? 'watch' : 'ok',
    route: null,
  });

  if (raw.npsNow != null) {
    const drop = raw.npsBefore != null ? raw.npsBefore - raw.npsNow : 0;
    add({
      key: 'nps',
      label: 'Client NPS, last 30 days',
      value: raw.npsNow,
      previous: raw.npsBefore,
      severity: raw.npsNow < 0 || drop >= 10 ? 'alert' : drop >= 5 ? 'watch' : 'ok',
      route: '/marketing/insights',
    });
  }
  const order = { alert: 0, watch: 1, ok: 2 };
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
};

export const loadCeoSignals = async (now = new Date()) => {
  const thisMonth = istMonthBounds(now.getFullYear(), now.getMonth() + 1);
  const prev = now.getMonth() === 0 ? istMonthBounds(now.getFullYear() - 1, 12) : istMonthBounds(now.getFullYear(), now.getMonth());
  const cancelled = /^\s*(cancelled|canceled)\s*$/i;
  const d30 = new Date(now.getTime() - 30 * DAY_MS);
  const d60 = new Date(now.getTime() - 60 * DAY_MS);

  const [overdueProjects, blockedOkrs, vision, lowStock, cancelledThisMonth, cancelledLastMonth, recent, before] = await Promise.all([
    Project.countDocuments({ status: { $in: ['planning', 'active'] }, endDate: { $lt: now } }),
    OKR.countDocuments({ status: 'blocked' }),
    StrategicVision.findOne().select('milestones').lean(),
    InventoryProduct.countDocuments({ $expr: { $lte: ['$quantity', '$lowStockThreshold'] } }),
    Booking.countDocuments({ status: cancelled, bookingDate: { $gte: thisMonth.start, $lte: thisMonth.end } }),
    Booking.countDocuments({ status: cancelled, bookingDate: { $gte: prev.start, $lte: prev.end } }),
    Review.find({ submittedAt: { $gte: d30 }, nps: { $ne: null } }).select('nps').lean(),
    Review.find({ submittedAt: { $gte: d60, $lt: d30 }, nps: { $ne: null } }).select('nps').lean(),
  ]);

  return shapeSignals({
    overdueProjects,
    blockedOkrs,
    atRiskMilestones: (vision?.milestones ?? []).filter((m) => m.status === 'at-risk').length,
    lowStock,
    cancelledThisMonth,
    cancelledLastMonth,
    npsNow: npsOf(recent.map((r) => r.nps)),
    npsBefore: npsOf(before.map((r) => r.nps)),
  });
};

/// The one-line daily digest ("3 need you · 5 waiting with the team, oldest 6 days"), or null when there is nothing to say.
export const digestText = (inbox) => {
  if (!inbox.needsYou && !inbox.withTeam) return null;
  const parts = [];
  if (inbox.needsYou) parts.push(`${inbox.needsYou} ${inbox.needsYou === 1 ? 'thing needs' : 'things need'} your decision`);
  if (inbox.withTeam) {
    const old = inbox.oldestTeamDays >= 2 ? `, the oldest ${inbox.oldestTeamDays} days` : '';
    parts.push(`${inbox.withTeam} ${inbox.withTeam === 1 ? 'approval is' : 'approvals are'} waiting with the team${old}`);
  }
  return parts.join(' · ');
};
