import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignDailyMetric from '../models/CampaignDailyMetric.js';
import CampaignAd from '../models/CampaignAd.js';
import CampaignAdDailyMetric from '../models/CampaignAdDailyMetric.js';
import CampaignBreakdownMetric from '../models/CampaignBreakdownMetric.js';
import MetaImportLog from '../models/MetaImportLog.js';
import MarketingActivity from '../models/MarketingActivity.js';
import { MarketingTeamMember } from '../models/MarketingEod.js';
import Lead from '../models/Lead.js';
import Booking from '../models/Booking.js';
import { makeCountsTowardSales } from '../utils/salesRules.js';
import { ensureGstConfig } from '../services/posting.js';
import { BOOKING_FIELDS } from '../services/marketingLeadReportData.js';
import { toDateStr, isManagerOrAdmin } from './marketingEodController.js';
import { isDay } from '../utils/marketingActivityInput.js';
import { cleanCampaignInput, cleanAdInput, cleanMetricInput, cleanImportInput, DEFAULT_CAMPAIGN_BRAND } from '../utils/marketingCampaignInput.js';
import { writeImportRows } from '../services/campaignMetricsImport.js';
import * as S from '../utils/marketingCampaignStats.js';
import { leadBrand } from '../utils/marketingLeadStages.js';
import * as T from '../utils/marketingTeamStats.js';
import { metaConfig } from '../utils/metaLeads.js';
import { adsConfig } from '../utils/metaAds.js';
import MetaAdsSync from '../models/MetaAdsSync.js';

// The Campaigns hub — Overview, All Campaigns, Performance, Creatives & Ads, Budget & Spend, Leads & Conversions, Reports & Insights (the
// marketing team's document, pages "Campaigns — Overview with Meta sync" and "Screens 02 to 07"). Routes: routes/marketingCampaignHubRoutes.js,
// /api/marketing/campaign-hub. The old /api/marketing/campaigns* endpoints and screen are untouched.
//
// Nothing here is typed twice. Paid-ads figures (spend, reach, impressions, clicks) are daily records brought in by the live Meta sync
// (services/metaAdsSync.js, when the server is set up for it), from a Meta Ads Manager export, or typed for a day; the Overview's Meta card
// says which. Leads, bookings and revenue are the CRM's
// (Lead.campaignId → Booking). The work members LOG against a campaign (Log Activity → Campaign) shows on the campaign. Every number is
// defined in utils/marketingCampaignStats.js; the ones the Lead Report and the Weekly Report show too (bookings, booking value, qualified,
// cost per lead, brand) come from utils/marketingOutcomes.js, so the screens agree.

const IST = 5.5 * 60 * 60 * 1000;
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const istEnd = (day) => istStart(T.addDays(day, 1));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const fail = (res, status, message, extra = {}) => res.status(status).json({ message, ...extra });
const fromInput = (res, v) => fail(res, 400, v.message, { field: v.field });
const validId = (id) => mongoose.isValidObjectId(String(id ?? ''));

const weekOf = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const monday = T.addDays(day, -((dow + 6) % 7));
  return { from: monday, to: T.addDays(monday, 6) };
};

/** ?from=&to=&brand= (this week, all brands by default) → the checked range, or null after answering 400. */
const readRange = (req, res) => {
  const today = toDateStr();
  const dflt = weekOf(today);
  const from = req.query.from ?? dflt.from;
  const to = req.query.to ?? dflt.to;
  if (!isDay(from) || !isDay(to)) return void fail(res, 400, 'The dates must be YYYY-MM-DD.');
  if (to < from) return void fail(res, 400, 'The end date is before the start date.');
  if (T.daysBetween(from, to) > 366) return void fail(res, 400, 'Choose a range of a year or less.');
  const brand = String(req.query.brand ?? 'all').toLowerCase();
  if (!['all', 'main', 'kerala'].includes(brand)) return void fail(res, 400, 'Choose All, Main or Kerala.');
  return { from, to, brand, today };
};

const pageOf = (req, dflt = 10) => ({ limit: Math.min(Math.max(parseInt(req.query.limit, 10) || dflt, 1), 50), page: Math.max(parseInt(req.query.page, 10) || 1, 1) });

// ── loading ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_FIELDS = 'title channel status startDate endDate createdAt brand platform objective budget dailyBudget metaCampaignId audienceNote notes';
const LEAD_FIELDS = 'campaignId status priority source region district leadDate createdAt bookingId creative';

const leadWindow = (from, to) => ({ $or: [{ leadDate: { $gte: istStart(from), $lt: istEnd(to) } }, { leadDate: null, createdAt: { $gte: istStart(from), $lt: istEnd(to) } }] });

/** Leads tagged to a campaign that arrived in [from, to], and the bookings they are linked to (the Lead Report loads them the same way). */
const loadLeadsAndBookings = async (from, to, campaignId = null) => {
  const leads = await Lead.find({ campaignId: campaignId ?? { $ne: null }, ...leadWindow(from, to) }).select(LEAD_FIELDS).limit(30000).lean();
  const leadIds = leads.map((l) => l._id);
  const bookingIds = leads.map((l) => l.bookingId).filter(Boolean);
  const bookings = leadIds.length ? await Booking.find({ $or: [{ leadId: { $in: leadIds } }, { _id: { $in: bookingIds } }] }).select(BOOKING_FIELDS).limit(60000).lean() : [];
  return { leads, bookings };
};

/**
 * Everything the pure functions of utils/marketingCampaignStats.js need for [from, to] AND the period before it: campaigns, the daily paid-ads
 * records, the CRM leads attributed to a campaign, their bookings, the sales-totals rule and the GST setting (booking value is ex-GST).
 * EXPORTED for the Weekly Report:
 *   const i = await loadPaidAdsInputs({ from, to }); S.paidAdsTotals({ ...i, from, to, brand });   // pass `gst` too: i.gst
 */
export const loadPaidAdsInputs = async ({ from, to }) => {
  const prev = T.previousRange({ from, to });
  const [campaigns, metrics, lb, countsTowardSales, gst] = await Promise.all([
    Campaign.find().select(CAMPAIGN_FIELDS).limit(2000).lean(),
    CampaignDailyMetric.find({ day: { $gte: prev.from, $lte: to } }).select('campaignId day spend reach impressions clicks results').limit(60000).lean(),
    loadLeadsAndBookings(prev.from, to),
    makeCountsTowardSales(),
    ensureGstConfig(),
  ]);
  return { campaigns, metrics, leads: lb.leads, bookings: lb.bookings, countsTowardSales, gst };
};

/** Lifetime spend per campaign up to the end of the range and up to the end of the period before it: Map(campaignId → { toEnd, toPrevEnd }). */
const loadSpentTo = async (range) => {
  const prev = T.previousRange(range);
  const rows = await CampaignDailyMetric.aggregate([
    { $match: { day: { $lte: range.to } } },
    { $group: { _id: '$campaignId', toEnd: { $sum: '$spend' }, toPrevEnd: { $sum: { $cond: [{ $lte: ['$day', prev.to] }, '$spend', 0] } } } },
  ]);
  return new Map(rows.map((r) => [idOf(r._id), { toEnd: r.toEnd, toPrevEnd: r.toPrevEnd }]));
};

/** Minutes and entries logged against campaigns in the range (Log Activity → Campaign): Map(campaignId → { minutes, entries }). */
const loadWork = async ({ from, to }) => S.workByCampaign(await MarketingActivity.find({ campaignId: { $ne: null }, entryDate: { $gte: from, $lte: to } }).select('campaignId timeSpentMinutes').limit(50000).lean());

/** Ads of the campaigns of the brand. */
const loadAds = async (campaigns, brand) => {
  const ids = campaigns.filter((c) => brand === 'all' || S.brandOfCampaign(c) === brand).map((c) => c._id);
  return ids.length ? CampaignAd.find({ campaignId: { $in: ids } }).sort({ createdAt: -1 }).limit(3000).lean() : [];
};

/**
 * The ads of the brand with what the Creatives & Ads screen needs for the range: each imported ad's days in the range, and the CRM leads
 * of the range that name a creative (matched to an ad by utils/marketingCampaignStats.js leadsByAd). → [rows] (adRows)
 */
const loadAdRows = async (campaigns, range) => {
  const ads = await loadAds(campaigns, range.brand);
  const cById = campaignMap(campaigns);
  const daily = ads.filter((a) => a.dailyFigures).map((a) => a._id);
  const [days, leads] = await Promise.all([
    daily.length ? CampaignAdDailyMetric.find({ adId: { $in: daily }, day: { $gte: range.from, $lte: range.to } }).select('adId day spend reach impressions clicks results').limit(100000).lean() : [],
    Lead.find({ creative: { $nin: [null, ''] }, ...leadWindow(range.from, range.to) }).select('campaignId creative leadDate createdAt source region district').limit(30000).lean(),
  ]);
  const adDays = new Map();
  for (const d of days) {
    const k = idOf(d.adId);
    if (!adDays.has(k)) adDays.set(k, []);
    adDays.get(k).push(d);
  }
  // the range's leads, under the brand of their campaign (or their own when they have none) — as everywhere else
  const inBrand = leads.filter((l) => {
    if (T.istDay(l.leadDate ?? l.createdAt) < range.from || T.istDay(l.leadDate ?? l.createdAt) > range.to) return false;
    if (range.brand === 'all') return true;
    const c = l.campaignId ? cById.get(idOf(l.campaignId)) : null;
    return c ? S.brandOfCampaign(c) === range.brand : leadBrand(l) === range.brand;
  });
  return S.adRows(ads, cById, { adDays, range, leads: inBrand });
};

/** The breakdown rows (audiences & placements) of the range. */
const loadBreakdowns = (range) => CampaignBreakdownMetric.find({ day: { $gte: range.from, $lte: range.to } }).select('campaignId day dimension age gender placement spend impressions reach clicks results').limit(100000).lean();

const lastImportOf = async () => {
  const log = await MetaImportLog.findOne().sort({ createdAt: -1 }).lean();
  return log ? importShape(log) : null;
};

// ── shapes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const dayOfDate = (d) => (d ? T.istDay(d) : null);

const campaignShape = (c) => ({
  id: idOf(c),
  title: c.title,
  brand: S.brandOfCampaign(c),
  platform: S.platformOfCampaign(c),
  channel: c.channel ?? '',
  objective: S.objectiveOfCampaign(c),
  status: S.statusOfCampaign(c),
  startDate: dayOfDate(c.startDate),
  endDate: dayOfDate(c.endDate),
  budget: c.budget ?? 0,
  dailyBudget: c.dailyBudget ?? 0,
  metaCampaignId: c.metaCampaignId ?? '',
  audienceNote: c.audienceNote ?? '',
  notes: c.notes ?? '',
  createdAt: c.createdAt ?? null,
});

const importShape = (l) => ({
  id: idOf(l),
  at: l.createdAt,
  source: l.source,
  byName: l.byName ?? '',
  fileName: l.fileName ?? '',
  level: l.level ?? 'campaign',
  rows: l.rows ?? 0,
  matched: l.matched ?? 0,
  unmatched: l.unmatched ?? 0,
  unmatchedNames: l.unmatchedNames ?? [],
  created: l.created ?? 0,
  written: l.written ?? 0,
  adsCreated: l.adsCreated ?? 0,
  skipped: l.skipped ?? 0,
  from: l.from ?? '',
  to: l.to ?? '',
});

/** The Meta card: honest. `connected` = the live ad spend sync is set up AND has brought figures in (services/metaAdsSync.js); `sync`
 *  says when it last ran and why it failed, if it did; `lastImport` is the latest figures brought in by any road (sync, file or typed);
 *  `leadAds` says whether Lead Ads forms reach the CRM on their own. */
const metaCard = async (lastImport) => {
  const ready = adsConfig().ready;
  const s = ready ? await MetaAdsSync.findOne({ key: 'ads' }).select('lastRun lastOkAt autoSync unlinked').lean() : null;
  const failed = !!s?.lastRun?.at && s.lastRun.ok === false;
  const connected = ready && !!s?.lastOkAt;
  return {
    connected,
    status: !ready ? 'not_connected' : failed ? 'error' : connected ? 'connected' : 'not_synced',
    lastImport,
    leadAds: metaConfig().ready,
    sync: ready
      ? { lastOkAt: s?.lastOkAt ?? null, lastRunAt: s?.lastRun?.at ?? null, ok: !failed, problem: failed ? s.lastRun.problem || '' : '', unlinked: s?.unlinked?.length ?? 0, autoSync: s?.autoSync !== false }
      : null,
  };
};

const kpiPayload = (block) => ({ now: block.now, before: block.before, change: block.change });

/** The common context of a screen: the inputs, the outcomes and the arguments the pure functions take. */
const contextFor = async (range) => {
  const inputs = await loadPaidAdsInputs(range);
  const outcomes = S.leadOutcomes({ leads: inputs.leads, bookings: inputs.bookings, countsTowardSales: inputs.countsTowardSales, gst: inputs.gst });
  return { ...inputs, outcomes, range, args: { campaigns: inputs.campaigns, metrics: inputs.metrics, leads: inputs.leads, outcomes, range } };
};

const campaignMap = (campaigns) => new Map(campaigns.map((c) => [idOf(c), c]));

// ── Setup (the pickers of the forms) ──────────────────────────────────────────────────────────────────────────────────────────────

export const getSetup = asyncHandler(async (_req, res) => {
  const campaigns = await Campaign.find().sort({ title: 1 }).limit(500).select('title status brand').lean();
  res.json({ campaigns: campaigns.map((c) => ({ id: idOf(c), title: c.title, status: S.statusOfCampaign(c), brand: S.brandOfCampaign(c) })) });
});

// ── Overview ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getOverview = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const ctx = await contextFor(range);
  const { campaigns, args } = ctx;
  const [adList, spentTo, lastImport, anyMetric, untaggedRaw, breakdowns] = await Promise.all([
    loadAdRows(campaigns, range),
    loadSpentTo(range),
    lastImportOf(),
    CampaignDailyMetric.exists({}),
    Lead.find({ campaignId: null, source: /paid|\bads?\b|meta|facebook|trial|instagram|\big\b/i, ...leadWindow(range.from, range.to) }).select('source region district leadDate createdAt').limit(5000).lean(),
    loadBreakdowns(range),
  ]);
  const block = S.kpiBlock(args);
  const rows = S.campaignRows(args);
  const sorted = S.sortCampaignRows(rows);
  const budgets = S.budgetRows({ campaigns, metrics: ctx.metrics, spentTo, range });
  const thumbOf = new Map();
  for (const a of adList) if (a.thumbUrl && !thumbOf.has(a.campaignId)) thumbOf.set(a.campaignId, a.thumbUrl);
  const shapeRow = (r) => ({ ...r, thumbUrl: thumbOf.get(r.id) ?? '' });
  const byStatus = (status) => sorted.filter((r) => r.status === status).slice(0, 5).map(shapeRow);

  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    kpis: kpiPayload(block),
    trend: S.trendSeries(args),
    leadsByType: S.leadsByType({ campaigns, leads: ctx.leads, range }),
    meta: await metaCard(lastImport),
    counts: S.statusCounts(campaigns, range.brand),
    campaigns: { active: byStatus('active'), paused: byStatus('paused'), completed: byStatus('completed') },
    topAds: S.topAds(adList, 3),
    audiences: S.audienceSegments({ rows: breakdowns, campaigns, range, top: 3 }),
    insights: S.insights({
      now: block.now,
      before: block.before,
      rows: rows.filter((r) => r.spend > 0 || r.leads > 0),
      budgets,
      ads: adList,
      untaggedPaidLeads: S.untaggedPaidLeads(untaggedRaw, range),
      lastImport: lastImport ? { day: T.istDay(lastImport.at) } : null,
      today: range.today,
      hasAnyMetric: !!anyMetric,
    }),
  });
});

// ── All Campaigns ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const listCampaigns = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const ctx = await contextFor(range);
  const work = await loadWork(range);
  const all = S.sortCampaignRows(S.campaignRows({ ...ctx.args, work }));
  const filtered = S.filterCampaignRows(all, { q: req.query.q, status: req.query.status ?? 'all', platform: req.query.platform ?? 'all', objective: req.query.objective ?? 'all' });
  const { limit, page } = pageOf(req);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    counts: S.statusCounts(ctx.campaigns, range.brand),
    total: filtered.length,
    page,
    pageSize: limit,
    items: filtered.slice((page - 1) * limit, page * limit),
  });
});

export const getCampaign = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  if (!validId(req.params.id)) return fail(res, 404, 'That campaign was not found.');
  const c = await Campaign.findById(req.params.id).select(CAMPAIGN_FIELDS).lean();
  if (!c) return fail(res, 404, 'That campaign was not found.');
  const prev = T.previousRange(range);
  const [metrics, lb, countsTowardSales, gst, ads, spentTo, logs] = await Promise.all([
    CampaignDailyMetric.find({ campaignId: c._id, day: { $gte: prev.from, $lte: range.to } }).sort({ day: -1 }).limit(800).lean(),
    loadLeadsAndBookings(prev.from, range.to, c._id),
    makeCountsTowardSales(),
    ensureGstConfig(),
    loadAdRows([c], { ...range, brand: 'all' }),
    loadSpentTo(range),
    MarketingActivity.find({ campaignId: c._id }).sort({ loggedAt: -1 }).limit(2000).select('memberId workedOn status timeSpentMinutes entryDate loggedAt').lean(),
  ]);
  const one = [c];
  const outcomes = S.leadOutcomes({ leads: lb.leads, bookings: lb.bookings, countsTowardSales, gst });
  // looking at ONE campaign: the brand filter does not hide it
  const r = { from: range.from, to: range.to, brand: 'all' };
  const args = { campaigns: one, metrics, leads: lb.leads, outcomes, range: r };
  const block = S.kpiBlock(args);
  const row = S.campaignRows(args)[0];
  const budget = S.budgetRows({ campaigns: one, metrics, spentTo, range: r })[0] ?? null;

  const memberIds = [...new Set(logs.map((l) => idOf(l.memberId)))].filter(validId);
  const members = memberIds.length ? await MarketingTeamMember.find({ _id: { $in: memberIds } }).select('name').lean() : [];
  const nameOf = new Map(members.map((m) => [idOf(m), m.name]));
  const byMember = new Map();
  for (const l of logs) {
    const k = idOf(l.memberId);
    const e = byMember.get(k) ?? { memberId: k, name: nameOf.get(k) ?? '', minutes: 0, entries: 0 };
    e.minutes += l.timeSpentMinutes ?? 0;
    e.entries += 1;
    byMember.set(k, e);
  }
  res.json({
    campaign: campaignShape(c),
    from: range.from,
    to: range.to,
    row,
    kpis: kpiPayload(block),
    trend: S.trendSeries(args),
    days: metrics
      .filter((m) => m.day >= range.from && m.day <= range.to)
      .slice(0, 62)
      .map((m) => ({ id: idOf(m), day: m.day, spend: m.spend, reach: m.reach, impressions: m.impressions, clicks: m.clicks, results: m.results, source: m.source })),
    budget,
    ads,
    work: {
      minutes: logs.reduce((t, l) => t + (l.timeSpentMinutes ?? 0), 0),
      entries: logs.length,
      members: [...byMember.values()].sort((a, b) => b.minutes - a.minutes),
      recent: logs.slice(0, 10).map((l) => ({ id: idOf(l), member: nameOf.get(idOf(l.memberId)) ?? '', workedOn: l.workedOn, status: l.status, minutes: l.timeSpentMinutes ?? 0, day: l.entryDate })),
    },
  });
});

/** The Meta ID is how an import finds the campaign: two campaigns cannot share one. */
const metaIdTaken = async (metaCampaignId, exceptId) => !!metaCampaignId && !!(await Campaign.exists({ metaCampaignId, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }));

export const createCampaign = asyncHandler(async (req, res) => {
  const v = cleanCampaignInput(req.body);
  if (!v.ok) return fromInput(res, v);
  if (await metaIdTaken(v.value.metaCampaignId)) return fail(res, 409, 'Another campaign already has that Meta campaign ID.', { field: 'metaCampaignId' });
  try {
    const c = await Campaign.create({ ...v.value, createdBy: req.user._id });
    res.status(201).json(campaignShape(c.toObject()));
  } catch (e) {
    if (e?.code === 11000) return fail(res, 409, 'Another campaign already has that Meta campaign ID.', { field: 'metaCampaignId' });
    throw e;
  }
});

export const updateCampaign = asyncHandler(async (req, res) => {
  if (!validId(req.params.id)) return fail(res, 404, 'That campaign was not found.');
  const c = await Campaign.findById(req.params.id);
  if (!c) return fail(res, 404, 'That campaign was not found.');
  const v = cleanCampaignInput(req.body, c);
  if (!v.ok) return fromInput(res, v);
  if (v.value.metaCampaignId && (await metaIdTaken(v.value.metaCampaignId, c._id))) return fail(res, 409, 'Another campaign already has that Meta campaign ID.', { field: 'metaCampaignId' });
  Object.assign(c, v.value);
  try {
    await c.save();
  } catch (e) {
    if (e?.code === 11000) return fail(res, 409, 'Another campaign already has that Meta campaign ID.', { field: 'metaCampaignId' });
    throw e;
  }
  res.json(campaignShape(c.toObject()));
});

export const deleteCampaign = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) return fail(res, 403, 'Only a Marketing Manager can delete a campaign.');
  if (!validId(req.params.id)) return fail(res, 404, 'That campaign was not found.');
  const c = await Campaign.findById(req.params.id);
  if (!c) return fail(res, 404, 'That campaign was not found.');
  const [leads, logs] = await Promise.all([Lead.countDocuments({ campaignId: c._id }), MarketingActivity.countDocuments({ campaignId: c._id })]);
  if (leads || logs) {
    const parts = [leads ? `${leads} lead${leads === 1 ? '' : 's'}` : '', logs ? `${logs} logged ${logs === 1 ? 'entry' : 'entries'}` : ''].filter(Boolean).join(' and ');
    return fail(res, 409, `This campaign has ${parts} attached. Mark it Completed instead, so the record stays.`);
  }
  // nothing else points at it: its own daily figures and ads go with it
  await Promise.all([CampaignDailyMetric.deleteMany({ campaignId: c._id }), CampaignAd.deleteMany({ campaignId: c._id })]);
  await c.deleteOne();
  res.json({ message: 'Campaign deleted' });
});

// ── Performance ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getPerformance = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const ctx = await contextFor(range);
  const block = S.kpiBlock(ctx.args);
  const rows = S.campaignRows(ctx.args).filter((r) => r.spend > 0 || r.leads > 0 || r.results > 0 || r.impressions > 0);
  res.json({ from: range.from, to: range.to, brand: range.brand, kpis: kpiPayload(block), trend: S.trendSeries(ctx.args), objectives: S.objectiveRows(rows) });
});

// ── Creatives & Ads ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const listAds = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const { brand } = range;
  const campaigns = await Campaign.find().select(CAMPAIGN_FIELDS).limit(2000).lean();
  const all = await loadAdRows(campaigns, range); // judged against ALL the brand's ads of the range, so a filter never changes an ad's verdict
  const avg = S.adAverages(all);
  const filter = String(req.query.filter ?? 'all');
  const text = String(req.query.q ?? '').trim().toLowerCase();
  const campaignId = validId(req.query.campaignId) ? String(req.query.campaignId) : null;
  const shown = all.filter((a) => (filter === 'all' || a.verdict === filter) && (!campaignId || a.campaignId === campaignId) && (!text || `${a.name} ${a.adSetName} ${a.campaign}`.toLowerCase().includes(text)));
  const { limit, page } = pageOf(req);
  const crmLeads = all.reduce((t, a) => t + (a.leads ?? 0), 0);
  const rangedSpend = all.filter((a) => a.figures === 'range').reduce((t, a) => t + a.spend, 0);
  const rangedLeads = all.filter((a) => a.figures === 'range').reduce((t, a) => t + (a.leads ?? 0), 0);
  res.json({
    from: range.from,
    to: range.to,
    brand,
    kpis: { total: all.length, top: S.adCounts(all).top, ctr: avg.ctr, cpm: avg.cpm, costPerResult: avg.costPerResult, spend: avg.spend, results: avg.results, leads: crmLeads, cpl: S.cplOf(rangedSpend, rangedLeads), lifetimeAds: all.filter((a) => a.figures === 'lifetime').length },
    counts: S.adCounts(all),
    total: shown.length,
    page,
    pageSize: limit,
    items: shown.slice((page - 1) * limit, page * limit),
  });
});

const adResponse = async (ad) => {
  const c = await Campaign.findById(ad.campaignId).select('title').lean();
  return S.adRows([ad], new Map([[idOf(ad.campaignId), c ?? { title: '' }]]))[0];
};

// ── Audiences & placements ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getAudiences = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const [campaigns, rows] = await Promise.all([Campaign.find().select(CAMPAIGN_FIELDS).limit(2000).lean(), loadBreakdowns(range)]);
  res.json({ from: range.from, to: range.to, brand: range.brand, ...S.audienceSegments({ rows, campaigns, range, top: 12 }) });
});

export const createAd = asyncHandler(async (req, res) => {
  const v = cleanAdInput(req.body);
  if (!v.ok) return fromInput(res, v);
  if (!(await Campaign.exists({ _id: v.value.campaignId }))) return fail(res, 400, 'That campaign no longer exists.', { field: 'campaignId' });
  const ad = await CampaignAd.create({ ...v.value, createdBy: req.user._id });
  res.status(201).json(await adResponse(ad.toObject()));
});

export const updateAd = asyncHandler(async (req, res) => {
  if (!validId(req.params.id)) return fail(res, 404, 'That ad was not found.');
  const ad = await CampaignAd.findById(req.params.id);
  if (!ad) return fail(res, 404, 'That ad was not found.');
  const v = cleanAdInput(req.body, ad);
  if (!v.ok) return fromInput(res, v);
  if (v.value.campaignId && !(await Campaign.exists({ _id: v.value.campaignId }))) return fail(res, 400, 'That campaign no longer exists.', { field: 'campaignId' });
  Object.assign(ad, v.value);
  await ad.save();
  res.json(await adResponse(ad.toObject()));
});

export const deleteAd = asyncHandler(async (req, res) => {
  if (!validId(req.params.id)) return fail(res, 404, 'That ad was not found.');
  const ad = await CampaignAd.findByIdAndDelete(req.params.id);
  if (!ad) return fail(res, 404, 'That ad was not found.');
  res.json({ message: 'Ad deleted' });
});

// ── Budget & Spend ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getBudget = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const ctx = await contextFor(range);
  const spentTo = await loadSpentTo(range);
  const rows = S.budgetRows({ campaigns: ctx.campaigns, metrics: ctx.metrics, spentTo, range });
  const inPeriod = S.metricRowsIn(ctx.metrics, campaignMap(ctx.campaigns), range);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    summary: S.budgetSummary(rows),
    daily: S.spendByDay({ campaigns: ctx.campaigns, metrics: ctx.metrics, from: range.from, to: range.to, brand: range.brand }),
    split: S.spendSplit(rows),
    rows,
    hasSpend: inPeriod.length > 0,
  });
});

// ── Leads & Conversions ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getLeads = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const ctx = await contextFor(range);
  const block = S.kpiBlock(ctx.args);
  const cById = campaignMap(ctx.campaigns);
  const inRange = S.leadsIn(ctx.leads, cById, range);
  const rows = S.sortCampaignRows(S.campaignRows(ctx.args)).filter((r) => r.leads > 0 || r.spend > 0);
  const f = S.leadFunnel(inRange, ctx.outcomes);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    kpis: kpiPayload(block),
    funnel: S.funnelSteps(f),
    quality: S.qualitySplit(inRange),
    trend: S.trendSeries(ctx.args),
    rows,
  });
});

// ── Reports & Insights ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const reportData = async (range) => {
  const ctx = await contextFor(range);
  const [spentTo, ads, breakdowns] = await Promise.all([loadSpentTo(range), loadAdRows(ctx.campaigns, range), loadBreakdowns(range)]);
  return {
    ctx,
    data: {
      rows: S.campaignRows(ctx.args),
      budgets: S.budgetRows({ campaigns: ctx.campaigns, metrics: ctx.metrics, spentTo, range }),
      ads,
      audiences: S.audienceSegments({ rows: breakdowns, campaigns: ctx.campaigns, range, top: 50 }),
      kpis: S.kpiBlock(ctx.args),
      types: S.leadsByType({ campaigns: ctx.campaigns, leads: ctx.leads, range }),
      trend: S.trendSeries(ctx.args),
    },
  };
};

export const getReports = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  const { data } = await reportData(range);
  const block = data.kpis;
  const [lastImport, anyMetric, untaggedRaw, imports] = await Promise.all([
    lastImportOf(),
    CampaignDailyMetric.exists({}),
    Lead.find({ campaignId: null, source: /paid|\bads?\b|meta|facebook|trial|instagram|\big\b/i, ...leadWindow(range.from, range.to) }).select('source region district leadDate createdAt').limit(5000).lean(),
    MetaImportLog.find().sort({ createdAt: -1 }).limit(8).lean(),
  ]);
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    kpis: kpiPayload(block),
    cards: S.REPORT_TYPES.map((t) => ({ type: t.key, title: t.title, description: t.description, rows: S.reportTable(t.key, data).rows.length })),
    insights: S.insights({
      now: block.now,
      before: block.before,
      rows: data.rows.filter((r) => r.spend > 0 || r.leads > 0),
      budgets: data.budgets,
      ads: data.ads,
      untaggedPaidLeads: S.untaggedPaidLeads(untaggedRaw, range),
      lastImport: lastImport ? { day: T.istDay(lastImport.at) } : null,
      today: range.today,
      hasAnyMetric: !!anyMetric,
      max: 8,
    }),
    imports: imports.map(importShape),
    meta: await metaCard(lastImport),
    scheduledReports: false, // reports are made on demand: nothing is scheduled or e-mailed
  });
});

export const getReport = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  if (!range) return;
  if (!S.REPORT_TYPES.some((t) => t.key === req.params.type)) return fail(res, 404, 'That report does not exist.');
  const { data } = await reportData(range);
  const table = S.reportTable(req.params.type, data);
  res.json({ type: req.params.type, ...table, from: range.from, to: range.to, brand: range.brand, filename: `campaign-${req.params.type}-report-${range.from}_${range.to}${range.brand === 'all' ? '' : `-${range.brand}`}.csv` });
});

// ── Daily figures typed by hand ───────────────────────────────────────────────────────────────────────────────────────────────────

const writeLog = (req, fields) => MetaImportLog.create({ by: req.user._id, byName: req.user.name ?? '', ...fields });

export const saveMetric = asyncHandler(async (req, res) => {
  const v = cleanMetricInput(req.body, { today: toDateStr() });
  if (!v.ok) return fromInput(res, v);
  if (!(await Campaign.exists({ _id: v.value.campaignId }))) return fail(res, 400, 'That campaign no longer exists.', { field: 'campaignId' });
  const { campaignId, day, ...figures } = v.value;
  const doc = await CampaignDailyMetric.findOneAndUpdate({ campaignId, day }, { $set: { ...figures, source: 'manual', importId: null, updatedBy: req.user._id } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();
  await writeLog(req, { source: 'manual', rows: 1, matched: 1, written: 1, from: day, to: day });
  res.status(201).json({ id: idOf(doc), campaignId: idOf(doc.campaignId), day: doc.day, spend: doc.spend, reach: doc.reach, impressions: doc.impressions, clicks: doc.clicks, results: doc.results, source: doc.source });
});

export const deleteMetric = asyncHandler(async (req, res) => {
  if (!validId(req.params.id)) return fail(res, 404, 'That day was not found.');
  const m = await CampaignDailyMetric.findByIdAndDelete(req.params.id);
  if (!m) return fail(res, 404, 'That day was not found.');
  res.json({ message: 'Day removed' });
});

// ── Import from Meta Ads Manager (the file is read in the app; these are its rows) ───────────────────────────────────────────────

/**
 * POST /import — rows of a Meta Ads Manager export, read in the app. `level` says what one row is (campaign / ad / breakdown, per day).
 * The writing — matching campaigns and ads, replacing days, adding up ads and segments — is services/campaignMetricsImport.js, the
 * same code the live Meta sync uses.
 */
export const importMetrics = asyncHandler(async (req, res) => {
  const v = cleanImportInput(req.body, { today: toDateStr() });
  if (!v.ok) return fromInput(res, v);
  res.json(await writeImportRows({ ...v.value, actor: req.user, source: 'csv' }));
});

export const listImports = asyncHandler(async (_req, res) => {
  const logs = await MetaImportLog.find().sort({ createdAt: -1 }).limit(20).lean();
  res.json({ items: logs.map(importShape), meta: await metaCard(logs[0] ? importShape(logs[0]) : null) });
});
