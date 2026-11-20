import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import CampaignAd from '../models/CampaignAd.js';
import Campaign from '../models/Campaign.js';
import ContentItem from '../models/ContentItem.js';
import MarketingActivity from '../models/MarketingActivity.js';
import MarketingShoot from '../models/MarketingShoot.js';
import { MarketingTeamMember, MarketingMemberRole, MarketingMetric } from '../models/MarketingEod.js';
import { toDateStr, canViewTeam, findOwnMember } from './marketingEodController.js';
import { loadPaidAdsInputs } from './marketingCampaignHubController.js';
import { bookingContext, campaignContext, leadScopeFor, loadLeadWindow, LEAD_CAP } from '../services/marketingLeadReportData.js';
import { cleanRange } from '../utils/marketingLeadReportInput.js';
import { sourceKeyOf, sourceLabelOf } from '../utils/marketingLeadStages.js';
import * as R from '../utils/marketingLeadReportStats.js';
import * as C from '../utils/marketingCampaignStats.js';
import * as T from '../utils/marketingTeamStats.js';
import * as W from '../utils/marketingWeeklyStats.js';

// The Marketing Weekly Report — ONE page rolling up the chosen range (a week by default): leads, bookings, revenue, ad spend and conversion
// with their trend lines, the day-by-day performance against the period before, lead quality and sources, each member's key result from
// their logs, campaign and paid performance, the newest activity, shoots done against planned, revenue and collection, and plain-language
// insights. Route: routes/marketingWeeklyRoutes.js, /api/marketing/weekly. READ-ONLY — it adds no record and no counting rule of its own:
// leads / bookings / revenue / quality / sources are the Lead Report's (utils/marketingLeadReportStats.js), ad spend and the campaign table
// are the Campaigns module's (utils/marketingCampaignStats.js), shoots are the Creative Portfolio's, members' counts are their Log Activity
// entries. Every definition is in utils/marketingWeeklyStats.js.
//
// Visibility: the same as the screens it summarises. A `sales` user sees only their own leads and a territory-scoped user only their
// regions (leadScopeFor); a Marketing Manager / Admin / Management sees every member's key result, anyone else only their own. No phone
// numbers or notes are shown anywhere on this page.

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const memberInRange = (m, from, to) => {
  const a = m.activeFrom ? T.istDay(m.activeFrom) : null;
  const z = m.activeTo ? T.istDay(m.activeTo) : null;
  if (m.isActive === false && (!z || z < from)) return false;
  return (!a || a <= to) && (!z || z >= from);
};

/** Each member's key result, from the logs of the range and the period before. */
const loadMemberInsights = async (req, range, prev) => {
  const viewer = canViewTeam(req.user);
  const own = await findOwnMember(req.user);
  let members = [];
  if (viewer) members = (await MarketingTeamMember.find().sort({ sortOrder: 1, name: 1 }).lean()).filter((m) => memberInRange(m, range.from, range.to));
  else if (own) members = [own.toObject ? own.toObject() : own];
  if (!members.length) return { viewer, rows: [], silent: 0 };
  const ids = members.map((m) => m._id);
  const brandCut = range.brand === 'all' ? {} : { brand: range.brand };
  const [acts, roles] = await Promise.all([
    MarketingActivity.find({ memberId: { $in: ids }, entryDate: { $gte: prev.from, $lte: range.to }, ...brandCut }).select('memberId entryDate timeSpentMinutes values').limit(60000).lean(),
    MarketingMemberRole.find({ memberId: { $in: ids }, fromMonth: { $lte: range.to.slice(0, 7) } }).sort({ fromMonth: -1 }).populate('roleId').lean(),
  ]);
  const roleOf = new Map();
  for (const r of roles) if (!roleOf.has(idOf(r.memberId))) roleOf.set(idOf(r.memberId), r.roleId?.name ?? '');
  const metricIds = [...new Set(acts.flatMap((a) => (a.values ?? []).map((v) => idOf(v.metricId))))].filter((id) => mongoose.isValidObjectId(id));
  const names = new Map((metricIds.length ? await MarketingMetric.find({ _id: { $in: metricIds } }).select('name').lean() : []).map((m) => [idOf(m), m.name]));
  const mine = acts.filter((a) => a.entryDate >= range.from);
  const before = acts.filter((a) => a.entryDate < range.from);
  const out = W.memberInsights({
    activities: mine,
    before,
    members: members.map((m) => ({ id: idOf(m), name: m.name, role: roleOf.get(idOf(m)) ?? '' })),
    metricName: (id) => names.get(id) ?? 'Activity',
  });
  return { viewer, ...out };
};

/** The newest things that happened in the range, from the records the other screens own. */
const loadRecentEvents = async ({ range, list, ctx }) => {
  const a = new Date(`${range.from}T00:00:00+05:30`);
  const z = new Date(`${range.to}T23:59:59.999+05:30`);
  const [campaigns, shoots, posts] = await Promise.all([
    Campaign.find({ createdAt: { $gte: a, $lte: z } }).sort({ createdAt: -1 }).select('title brand createdAt').limit(8).lean(),
    MarketingShoot.find({ status: 'completed', shootDate: { $gte: range.from, $lte: range.to } }).sort({ updatedAt: -1 }).select('title brand updatedAt shootDate').limit(8).lean(),
    ContentItem.find({ status: 'published', publishedDate: { $gte: a, $lte: z } }).sort({ publishedDate: -1 }).select('title platform brand publishedDate').limit(8).lean(),
  ]);
  const events = [];
  const newest = [...list].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, 8);
  for (const l of newest) events.push({ at: l.createdAt, kind: 'lead', text: `New lead from ${sourceLabelOf(sourceKeyOf(l.source))}` });
  for (const l of list) {
    const b = R.countedBooking(l, ctx);
    if (b?.createdAt) events.push({ at: b.createdAt, kind: 'booking', text: `Booking confirmed — ₹${Math.round(R.bookingMoney(b, ctx.gst).order).toLocaleString('en-IN')}` });
  }
  for (const c of campaigns) if (range.brand === 'all' || C.brandOfCampaign(c) === range.brand) events.push({ at: c.createdAt, kind: 'campaign', text: `New campaign “${c.title}”` });
  for (const s of shoots) if (range.brand === 'all' || (s.brand ?? 'main') === range.brand) events.push({ at: s.updatedAt, kind: 'shoot', text: `Shoot completed — ${s.title}` });
  for (const p of posts) if (range.brand === 'all' || (p.brand ?? 'main') === range.brand) events.push({ at: p.publishedDate, kind: 'post', text: `Published on ${p.platform ?? 'social'} — ${p.title}` });
  return W.recentActivities(events, 8);
};

// GET /api/marketing/weekly?from=&to=&brand=   (this week, all brands by default)
export const getWeeklyReport = asyncHandler(async (req, res) => {
  const today = toDateStr();
  const v = cleanRange(req.query, today);
  if (!v.ok) {
    res.status(400);
    throw new Error(v.message);
  }
  const range = v.value;
  const prev = T.previousRange(range);
  const scope = await leadScopeFor(req.user);
  const leads = await loadLeadWindow(range, scope);
  const list = R.leadsInRange(leads, range);
  const [ctx, paid, shoots, members] = await Promise.all([bookingContext(leads), loadPaidAdsInputs(range), MarketingShoot.find({ shootDate: { $gte: range.from, $lte: range.to } }).select('shootDate status category brand').lean(), loadMemberInsights(req, range, prev)]);

  const period = R.leadPeriod({ leads, range, ctx });
  const trend = W.dayTrend(leads, range, ctx);

  // ad spend — only when a daily spend record exists in the range or the period before; otherwise "not recorded", never a made-up zero
  const hasSpend = paid.metrics.length > 0;
  const spendCmp = C.adSpendForRange({ campaigns: paid.campaigns, metrics: paid.metrics, from: range.from, to: range.to, brand: range.brand });
  const spend = hasSpend ? { now: spendCmp.spend, before: spendCmp.previousSpend } : null;
  const spendDays = hasSpend ? C.spendByDay({ campaigns: paid.campaigns, metrics: paid.metrics, from: range.from, to: range.to, brand: range.brand }) : null;

  // gst: campaign revenue is the bookings' value with the GST backed out — the same figure as the Lead Report and the Campaigns hub
  const campaignRowsAll = C.campaignsTable({ campaigns: paid.campaigns, metrics: paid.metrics, leads: paid.leads, bookings: paid.bookings, countsTowardSales: paid.countsTowardSales, gst: paid.gst, from: range.from, to: range.to, brand: range.brand });
  const cById = new Map(paid.campaigns.map((c) => [idOf(c), c]));
  const adCampaignIds = paid.campaigns.filter((c) => range.brand === 'all' || C.brandOfCampaign(c) === range.brand).map((c) => c._id);
  const ads = adCampaignIds.length ? await CampaignAd.find({ campaignId: { $in: adCampaignIds } }).sort({ createdAt: -1 }).limit(3000).lean() : [];
  const topAds = C.topAds(C.adRows(ads, cById), 5);

  const topSource = period.now.sources.rows[0] ?? null;
  const recent = await loadRecentEvents({ range, list, ctx });

  res.json({
    range,
    previous: { from: prev.from, to: prev.to },
    today,
    headline: W.headline({ period, spend }),
    sparks: W.sparklines(trend, spendDays),
    trend,
    quality: period.now.quality,
    sources: period.now.sources,
    members,
    campaigns: { rows: campaignRowsAll.slice(0, 6), total: campaignRowsAll.length },
    ads: topAds,
    recent,
    production: W.productionWeek(shoots, range),
    revenueCollection: W.revenueCollection(leads, range, ctx),
    insights: W.keyInsights({ period, topSource, spend }),
    status: {
      adSpendRecorded: hasSpend,
      adSpendNote: hasSpend ? null : 'No ad spend has been recorded for this period — import a Meta Ads export in Campaigns.',
      leadsCapped: leads.length >= LEAD_CAP,
    },
  });
});
