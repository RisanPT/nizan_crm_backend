import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import Campaign from '../models/Campaign.js';
import { toDateStr, canViewTeam, isManagerOrAdmin } from './marketingEodController.js';
import { isAutoLead, responseOf, responseStats, responseGroups, cleanResponseSettings } from '../utils/leadResponse.js';
import { loadResponseSettings, saveResponseSettings, firstActivities, checkWaitingLeads } from '../services/leadResponse.js';
import { LEAD_CAP, LEAD_FIELDS, bookingContext, campaignContext, leadScopeFor, loadFollowUps, loadLeadWindow, namesOf, withBrands } from '../services/marketingLeadReportData.js';
import { cleanRange, cleanLeadListQuery, cleanFollowUpQuery, cleanReportType } from '../utils/marketingLeadReportInput.js';
import { leadBrand, leadDay, qualityOf, sourceKeyOf, sourceLabelOf, stageOfLead } from '../utils/marketingLeadStages.js';
import { isQualifiedLead, linkedBookingOf, leadsByCampaignType } from '../utils/marketingOutcomes.js';
import * as R from '../utils/marketingLeadReportStats.js';
import * as T from '../utils/marketingTeamStats.js';

// The Lead Report — Overview, All Leads, Lead Stages, Sources, Follow-ups, Conversion, Reports. Routes: routes/marketingLeadReportRoutes.js,
// /api/marketing/lead-report. READ-ONLY: the leads are the CRM's own (Lead, LeadActivity, Booking, Campaign) — nothing is copied or edited
// here. Every number is defined in utils/marketingLeadReportStats.js (bookings, booking value, qualified, spend, cost per lead and brand
// in utils/marketingOutcomes.js, shared with the Campaigns hub and the Weekly Report); this file only loads the records and shapes the answers.
//
// Who sees what (the same visibility the CRM's lead list uses): a `sales` user only their own leads, a territory-scoped user only their
// regions (utils/geoScope.js). Contact details — phone numbers and the free-text notes on a lead — are shown only to a Marketing Manager,
// Admin or Management (canViewTeam); everyone else in Marketing sees the number masked (98••••••10), cannot search by it, gets no
// call / WhatsApp buttons and no phone column in an export. (The CRM's own /api/leads lists show numbers to every signed-in user; the
// older marketing leads report shows none. Marketing staff do not need a client's number to read a report, so it is withheld.)

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

const ROW_CAP = 20000;

/** ?from=&to=&brand= (this week, all brands by default) → the checked range. */
const readRange = (req, res) => {
  const today = toDateStr();
  const v = cleanRange(req.query, today);
  if (!v.ok) bad(res, v.message);
  return { ...v.value, today };
};

/**
 * The range's leads and everything the figures need, loaded once. `bookings` / `campaigns` switch the extra reads on (`campaigns`: every
 * campaign, and the ad spend of the range per campaign of the brand — the Campaigns hub's own daily records).
 */
const loadBase = async (req, res, { bookings = true, campaigns = false } = {}) => {
  const range = readRange(req, res);
  const scope = await leadScopeFor(req.user);
  const leads = await loadLeadWindow(range, scope);
  const list = R.leadsInRange(leads, range);
  const before = R.leadsInRange(leads, { ...T.previousRange(range), brand: range.brand });
  const ctx = bookings ? await bookingContext(leads) : {};
  const cc = campaigns ? await campaignContext(list, scope, range) : { campaigns: new Map(), spend: new Map() };
  return {
    range,
    scope,
    leads,
    list,
    before,
    ctx,
    ...cc,
    canContact: canViewTeam(req.user),
    // a territory-scoped viewer sees part of a campaign's leads but the whole of its spend: no cost figure would be fair
    showCost: Object.keys(scope).length === 0,
    capped: leads.length >= LEAD_CAP,
  };
};

const head = (b) => ({ from: b.range.from, to: b.range.to, brand: b.range.brand, capped: b.capped });

/** The campaign table and the overall cost of the range (the Campaigns hub's figures for the same range and brand). */
const campaignsOf = (b) => R.campaignRows(b.list, { campaigns: b.campaigns, spend: b.spend, ctx: b.ctx, showCost: b.showCost });

const kpisOf = (f) => ({ total: f.total, new: f.new, inProgress: f.inProgress, notConverted: f.notConverted, converted: f.converted, qualified: f.qualified, hot: f.hot, conversionRate: f.conversionRate, bookings: f.bookings, bookingValue: f.bookingValue, orderValue: f.orderValue, unvalued: f.unvalued });

// ── Overview ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getOverview = asyncHandler(async (req, res) => {
  const b = await loadBase(req, res, { campaigns: true });
  const period = R.leadPeriod({ leads: b.leads, range: b.range, ctx: b.ctx });
  const camp = campaignsOf(b);
  const items = await loadFollowUps(b.range, b.scope);
  res.json({
    ...head(b),
    kpis: { ...kpisOf(period.now), change: period.change },
    funnel: R.funnel(b.list, b.ctx),
    sources: { total: b.list.length, groups: R.sourceGroups(b.list, b.before) },
    followUps: R.followUpPeriod(items, b.range, b.range.today),
    trend: R.leadTrend(b.leads, b.range, b.ctx),
    campaigns: { rows: camp.rows.slice(0, 5), untagged: camp.untagged, costs: camp.costs },
    campaignTypes: leadsByCampaignType(b.list, b.campaigns),
  });
});

// ── All Leads ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A lead as a table row (with the raw phone — `presentRow` decides what leaves the server). */
const leadRow = (l, { names, campaigns }) => {
  const key = sourceKeyOf(l.source);
  const campaign = campaigns.get(idOf(l.campaignId));
  return {
    id: idOf(l),
    shortId: R.shortLeadId(idOf(l)),
    name: l.name ?? '',
    phone: l.phone ?? '',
    sourceKey: key,
    sourceLabel: sourceLabelOf(key),
    campaign: l.campaignId ? (campaign?.title ?? 'Removed campaign') : '',
    campaignId: idOf(l.campaignId),
    assignedToId: idOf(l.assignedTo),
    assignedTo: names.get(idOf(l.assignedTo)) ?? '',
    status: l.status ?? 'New',
    stage: stageOfLead(l.status),
    priority: qualityOf(l),
    createdDay: leadDay(l),
    createdAt: new Date(l.leadDate ?? l.createdAt).getTime(),
  };
};

const presentRow = (r, canContact) => ({
  id: r.id,
  shortId: r.shortId,
  name: r.name,
  phone: canContact ? r.phone : '',
  phoneMasked: R.maskPhone(r.phone),
  source: r.sourceKey,
  sourceLabel: r.sourceLabel,
  campaign: r.campaign,
  campaignId: r.campaignId,
  assignedTo: r.assignedTo,
  assignedToId: r.assignedToId,
  status: r.status,
  stage: r.stage,
  priority: r.priority,
  createdDay: r.createdDay,
  createdAt: new Date(r.createdAt).toISOString(),
});

/** The names and campaign titles the rows of these leads need. */
const rowContext = async (leads) => {
  const campaignIds = [...new Set(leads.map((l) => idOf(l.campaignId)).filter((id) => mongoose.isValidObjectId(id)))];
  const [names, docs] = await Promise.all([namesOf(leads.map((l) => idOf(l.assignedTo))), campaignIds.length ? Campaign.find({ _id: { $in: campaignIds } }).select('title').lean() : []]);
  return { names, campaigns: new Map(docs.map((c) => [idOf(c), c])) };
};

export const getLeads = asyncHandler(async (req, res) => {
  const q = cleanLeadListQuery(req.query);
  if (!q.ok) bad(res, q.message);
  const b = await loadBase(req, res, { bookings: false });
  const rc = await rowContext(b.list);
  const group = R.SOURCE_GROUPS.find((g) => g.key === q.value.group);
  const all = b.list.map((l) => leadRow(l, rc));
  const rows = all.filter((r) => (!group || R.groupKeyOfSource(r.sourceKey) === group.key) && R.matchesFilters(r, q.value) && R.matchesQuery(r, q.value.q, { phone: b.canContact }));
  const by = (stage) => rows.filter((r) => r.stage === stage).length;
  const shown = q.value.stage === 'all' ? rows : rows.filter((r) => r.stage === q.value.stage);
  const sorted = R.sortLeadRows(shown, q.value.sort, q.value.dir);
  res.json({
    ...head(b),
    canContact: b.canContact,
    counts: { all: rows.length, new: by('new'), in_progress: by('in_progress'), not_converted: by('not_converted'), converted: by('converted') },
    // the choices of the Assigned to and Campaign filters: the people and campaigns of the range's leads
    filters: R.leadFilterOptions(all),
    total: sorted.length,
    page: q.value.page,
    pageSize: q.value.limit,
    items: R.paginate(sorted, q.value.page, q.value.limit).map((r) => presentRow(r, b.canContact)),
  });
});

/** One lead, read-only: its facts, its booking and its follow-up history. */
export const getLead = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That lead was not found.', 404);
  const scope = await leadScopeFor(req.user);
  const found = await Lead.findOne({ ...scope, _id: req.params.id }).select(`${LEAD_FIELDS} remarks reason eventType`).lean();
  if (!found) bad(res, 'That lead was not found.', 404);
  const [lead] = await withBrands([found]);
  const canContact = canViewTeam(req.user);
  const [acts, ctx, campaign] = await Promise.all([
    LeadActivity.find({ leadId: lead._id }).sort({ scheduledDate: -1, createdAt: -1 }).limit(60).populate('createdBy', 'name').lean(),
    bookingContext([lead]),
    lead.campaignId ? Campaign.findById(lead.campaignId).select('title').lean() : null,
  ]);
  const [names, settings, firsts] = await Promise.all([namesOf([idOf(lead.assignedTo)]), loadResponseSettings(), firstActivities([lead._id])]);
  const response = responseOf(lead, firsts.get(idOf(lead)), new Date(), settings);
  // the booking shown: the live one the lead is linked to; else the one in Lead.bookingId (cancelled, pending…), shown as not counted
  const live = linkedBookingOf(lead, ctx);
  const booking = live ?? (lead.bookingId ? ctx.bookings.get(idOf(lead.bookingId)) ?? null : null);
  const counted = live ? R.countedBooking(lead, ctx) : null;
  const key = sourceKeyOf(lead.source);
  const now = R.followUpState({ done: false, dueDay: lead.followUpDate ? T.istDay(lead.followUpDate) : '' }, toDateStr());
  res.json({
    id: idOf(lead),
    shortId: R.shortLeadId(idOf(lead)),
    name: lead.name ?? '',
    phone: canContact ? lead.phone ?? '' : '',
    phoneMasked: R.maskPhone(lead.phone),
    canContact,
    source: key,
    sourceLabel: sourceLabelOf(key),
    brand: leadBrand(lead),
    campaign: lead.campaignId ? (campaign?.title ?? 'Removed campaign') : '',
    assignedTo: names.get(idOf(lead.assignedTo)) ?? '',
    status: lead.status ?? 'New',
    stage: stageOfLead(lead.status),
    priority: qualityOf(lead),
    qualified: isQualifiedLead(lead, ctx),
    createdDay: leadDay(lead),
    createdAt: new Date(lead.leadDate ?? lead.createdAt).toISOString(),
    eventType: lead.eventType ?? '',
    region: lead.region ?? '',
    district: lead.district ?? '',
    followUpDate: lead.followUpDate ?? null,
    followUpState: lead.status === 'Follow-up' && lead.followUpDate ? now : null,
    followUpCount: lead.followUpCount ?? 0,
    followUpCompletedCount: lead.followUpCompletedCount ?? 0,
    reason: canContact ? lead.reason ?? '' : '',
    remarks: canContact ? String(lead.remarks ?? '').slice(0, 1000) : '',
    booking: booking ? { number: booking.bookingNumber ?? '', status: booking.status ?? '', counted: !!counted, value: counted ? R.bookingMoney(counted, ctx.gst).value : null } : null,
    // speed to lead: its first contact (working minutes), or how long it has been waiting
    firstContact: { state: response.state, minutes: response.minutes, waitingMinutes: response.waitingMinutes, within: response.within, by: response.firstBy, via: response.firstVia, at: response.firstAt, cameOnItsOwn: isAutoLead(lead), targetMinutes: settings.targetMinutes },
    activities: acts.map((a) => ({ id: idOf(a), type: a.type, channel: a.channel ?? '', status: a.status, scheduledDate: a.scheduledDate, callResponse: a.callResponse ?? 'N/A', remark: canContact ? String(a.remark ?? '').slice(0, 500) : '', by: a.createdBy?.name ?? '' })),
  });
});

// ── Lead Stages ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getStages = asyncHandler(async (req, res) => {
  const b = await loadBase(req, res);
  const period = R.leadPeriod({ leads: b.leads, range: b.range, ctx: b.ctx });
  const changeOf = { new: period.change.new, in_progress: period.change.inProgress, not_converted: period.change.notConverted, converted: period.change.converted };
  res.json({
    ...head(b),
    kpis: { ...kpisOf(period.now), change: period.change },
    stages: R.stageRows(b.list).map((s) => ({ ...s, change: changeOf[s.key] ?? null })),
    statuses: R.statusRows(b.list),
    quality: R.qualityDistribution(b.list),
    trend: R.leadTrend(b.leads, b.range, b.ctx),
  });
});

// ── Sources ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getSources = asyncHandler(async (req, res) => {
  const b = await loadBase(req, res, { campaigns: true });
  const camp = campaignsOf(b);
  res.json({
    ...head(b),
    total: b.list.length,
    groups: R.sourceGroups(b.list, b.before),
    sources: R.sourceRows(b.list, b.ctx),
    campaigns: { rows: camp.rows.slice(0, 8), untagged: camp.untagged, costs: camp.costs },
    campaignTypes: leadsByCampaignType(b.list, b.campaigns),
  });
});

// ── Follow-ups ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A follow-up as a table row (raw phone — presentFollowUp decides what leaves the server). */
const followUpRow = (i, { names, campaigns }, today) => ({
  id: i.id,
  leadId: i.leadId,
  shortId: R.shortLeadId(i.leadId),
  name: i.lead.name ?? '',
  phone: i.lead.phone ?? '',
  campaign: i.lead.campaignId ? (campaigns.get(idOf(i.lead.campaignId))?.title ?? 'Removed campaign') : '',
  assignedTo: names.get(i.assignedTo) ?? '',
  assignedToId: i.assignedTo,
  kind: i.kind,
  channel: i.channel ?? '',
  channelLabel: R.followUpChannelLabel(i.channel),
  dueDay: i.dueDay,
  due: i.due.toISOString(),
  state: R.followUpState(i, today),
  remark: i.remark,
});

const presentFollowUp = (r, canContact) => ({ ...r, phone: canContact ? r.phone : '', phoneMasked: R.maskPhone(r.phone), remark: canContact ? r.remark : '' });

export const getFollowUps = asyncHandler(async (req, res) => {
  const q = cleanFollowUpQuery(req.query);
  if (!q.ok) bad(res, q.message);
  const range = readRange(req, res);
  const scope = await leadScopeFor(req.user);
  const canContact = canViewTeam(req.user);
  const items = await loadFollowUps(range, scope);
  const list = R.followUpList(items, { ...range, filter: q.value.filter }, range.today);
  const page = R.paginate(list, q.value.page, q.value.limit);
  const rc = await rowContext(page.map((i) => i.lead));
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    today: range.today,
    canContact,
    counts: R.followUpPeriod(items, range, range.today),
    filter: q.value.filter,
    total: list.length,
    page: q.value.page,
    pageSize: q.value.limit,
    items: page.map((i) => presentFollowUp(followUpRow(i, rc, range.today), canContact)),
  });
});

// ── Conversion ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const getConversion = asyncHandler(async (req, res) => {
  const b = await loadBase(req, res, { campaigns: true });
  const period = R.leadPeriod({ leads: b.leads, range: b.range, ctx: b.ctx });
  const camp = campaignsOf(b);
  res.json({
    ...head(b),
    kpis: { ...kpisOf(period.now), change: period.change },
    costs: camp.costs,
    funnel: R.funnel(b.list, b.ctx),
    trend: R.leadTrend(b.leads, b.range, b.ctx),
    bySource: R.conversionBySource(b.list, b.ctx),
    campaignTypes: leadsByCampaignType(b.list, b.campaigns),
  });
});

// ── Reports ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** GET /reports/:type — a report as a table (columns + rows) the screen previews and downloads as CSV. */
export const getReport = asyncHandler(async (req, res) => {
  const t = cleanReportType(req.params.type);
  if (!t.ok) bad(res, t.message, 404);
  const type = t.value;
  const b = await loadBase(req, res, { campaigns: ['campaigns', 'conversion'].includes(type) });
  const { range } = b;
  const today = range.today;
  const needFollow = ['summary', 'team', 'followups'].includes(type);
  const items = needFollow ? await loadFollowUps(range, b.scope) : [];
  const figures = R.leadFigures(b.leads, range, b.ctx);
  let table;
  let truncated = false;
  if (type === 'summary') {
    table = R.summaryTable({ figures, statuses: R.statusRows(b.list), quality: figures.quality, groups: R.sourceGroups(b.list, b.before), followUps: R.followUpCounts(items, range, today) });
  } else if (type === 'sources') {
    table = R.sourceTable(R.sourceRows(b.list, b.ctx));
  } else if (type === 'campaigns') {
    table = R.campaignTable(campaignsOf(b).rows);
  } else if (type === 'team') {
    const names = await namesOf([...b.list.map((l) => idOf(l.assignedTo)), ...items.map((i) => i.assignedTo)]);
    table = R.teamTable(R.teamRows(b.list, items, { nameOf: (id) => names.get(id) ?? '', ctx: b.ctx, range, today }));
  } else if (type === 'conversion') {
    const camp = campaignsOf(b);
    table = R.conversionTable({ figures, funnel: R.funnel(b.list, b.ctx), bySource: R.conversionBySource(b.list, b.ctx), trend: R.leadTrend(b.leads, range, b.ctx), costs: camp.costs, types: leadsByCampaignType(b.list, b.campaigns) });
  } else if (type === 'leads') {
    const lookups = await rowContext(b.list);
    const sorted = R.sortLeadRows(b.list.map((l) => leadRow(l, lookups)), 'created', 'desc');
    truncated = sorted.length > ROW_CAP;
    table = R.leadsTable(sorted.slice(0, ROW_CAP), { canContact: b.canContact });
  } else {
    const list = R.followUpList(items, { ...range, filter: 'all' }, today);
    truncated = list.length > ROW_CAP;
    const part = list.slice(0, ROW_CAP);
    const rc = await rowContext(part.map((i) => i.lead));
    table = R.followUpsTable(part.map((i) => presentFollowUp(followUpRow(i, rc, today), b.canContact)), { canContact: b.canContact });
  }
  res.json({ type, title: R.REPORTS.find((r) => r.key === type).title, from: range.from, to: range.to, brand: range.brand, generatedAt: new Date().toISOString(), truncated, canContact: b.canContact, ...table });
});

// ── Speed to lead ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How long leads waited for their first contact (utils/leadResponse.js): the range's leads that came in on their own (?scope=auto, the
 * default — a lead typed in by staff was already spoken to) or all of them (?scope=all). Working minutes, median, share inside the
 * target, who is waiting right now, by salesperson and by source, and the same figures for the period before.
 */
export const getSpeed = asyncHandler(async (req, res) => {
  const b = await loadBase(req, res, { bookings: false });
  const scopeAll = req.query.scope === 'all';
  const settings = await loadResponseSettings();
  // the alert check runs here too (at most once a minute), so alerts go out even where the timer does not run
  await checkWaitingLeads({ throttleMs: 60 * 1000 }).catch(() => 0);
  const pick = (list) => (scopeAll ? list : list.filter(isAutoLead));
  const list = pick(b.list);
  const before = pick(b.before);
  const now = new Date();
  const firsts = await firstActivities([...list, ...before].map((l) => l._id));
  const names = await namesOf([...list, ...before].map((l) => idOf(l.assignedTo)));
  const rowsOf = (leads) =>
    leads.map((l) => ({ lead: l, assignee: names.get(idOf(l.assignedTo)) || 'Unassigned', source: sourceLabelOf(sourceKeyOf(l.source)), ...responseOf(l, firsts.get(idOf(l)), now, settings) }));
  const rows = rowsOf(list);
  const prev = rowsOf(before);
  const kpis = responseStats(rows, settings);
  const shape = (g) => ({ name: g.key, leads: g.leads, contacted: g.contacted, medianMinutes: g.medianMinutes, withinPct: g.withinPct, waiting: g.waiting, late: g.late, unrecorded: g.unrecorded });
  res.json({
    ...head(b),
    scope: scopeAll ? 'all' : 'auto',
    settings,
    canEdit: isManagerOrAdmin(req.user),
    kpis,
    previous: responseStats(prev, settings),
    byPerson: responseGroups(rows, (r) => r.assignee, settings).map(shape),
    bySource: responseGroups(rows, (r) => r.source, settings).map(shape),
    // who is waiting now, the longest first (names only — no numbers on this tab)
    waiting: rows
      .filter((r) => r.state === 'waiting')
      .sort((x, y) => y.waitingMinutes - x.waitingMinutes)
      .slice(0, 50)
      .map((r) => ({ id: idOf(r.lead), name: r.lead.name ?? '', source: r.source, assignee: r.assignee, arrivedAt: r.lead.createdAt, waitingMinutes: r.waitingMinutes, late: r.waitingMinutes > settings.targetMinutes, alerted: !!r.lead.responseAlertAt })),
    // the slowest first contacts of the range
    slowest: rows
      .filter((r) => r.state === 'contacted')
      .sort((x, y) => y.minutes - x.minutes)
      .slice(0, 10)
      .map((r) => ({ id: idOf(r.lead), name: r.lead.name ?? '', source: r.source, assignee: r.assignee, arrivedAt: r.lead.createdAt, minutes: r.minutes, firstBy: r.firstBy, firstVia: r.firstVia })),
  });
});

export const getSpeedSettings = asyncHandler(async (req, res) => {
  res.json({ ...(await loadResponseSettings()), canEdit: isManagerOrAdmin(req.user) });
});

/** The target, the alert time, the working hours and the alert switch. Marketing Manager / Admin. */
export const saveSpeedSettings = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can change the speed-to-lead settings.', 403);
  const current = await loadResponseSettings();
  const v = cleanResponseSettings(req.body ?? {}, current);
  if (!v.ok) {
    res.status(400);
    return res.json({ message: v.message, field: v.field });
  }
  await saveResponseSettings(v.value, req.user?.name ?? '');
  res.json({ ...(await loadResponseSettings()), canEdit: true });
});
