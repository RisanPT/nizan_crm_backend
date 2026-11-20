import mongoose from 'mongoose';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import Booking from '../models/Booking.js';
import Campaign from '../models/Campaign.js';
import CampaignDailyMetric from '../models/CampaignDailyMetric.js';
import User from '../models/User.js';
import { regionScopedMatch } from '../utils/geoScope.js';
import { ensureGstConfig } from './posting.js';
import { makeCountsTowardSales } from '../utils/salesRules.js';
import { istStart, istEnd } from '../utils/istDate.js';
import * as R from '../utils/marketingLeadReportStats.js';
import * as T from '../utils/marketingTeamStats.js';
import { outcomeContext, withCampaignBrand, spendByCampaign, brandOfCampaign } from '../utils/marketingOutcomes.js';

// The database half of the Lead Report — the loaders the screens (controllers/marketingLeadReportController.js) and the Marketing Weekly
// Report both use, so the same leads are counted the same way everywhere. The counting rules are in utils/marketingLeadReportStats.js.
//
// For the Weekly Report (range = { from, to, brand } in IST days; `user` = req.user):
//   const scope = await leadScopeFor(user);
//   const leads = await loadLeadWindow(range, scope);               // the range AND the period before it
//   const ctx = await bookingContext(leads);                        // each lead's linked live booking + GST + who counts toward sales
//   const period = R.leadPeriod({ leads, range, ctx });             // { now, before, change } — leads, converted, bookings, value, rate, quality, sources
//   const items = await loadFollowUps(range, scope);
//   const followUps = R.followUpPeriod(items, range, today);        // due / today / overdue / upcoming / completed + change

export const LEAD_CAP = 40000;
export const LEAD_FIELDS = 'name phone alternateNumber source campaignId status priority leadDate createdAt followUpDate followUpCount followUpCompletedCount bookingId assignedTo region district creative origin createdByName firstContactAt firstContactByName firstContactVia responseAlertAt';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/**
 * Which leads a viewer may see — the CRM's own rule (controllers/leadController.js getLeads): a `sales` user only their own, a
 * territory-scoped user only their regions (utils/geoScope.js). `{}` = every lead.
 */
export const leadScopeFor = async (user) => {
  const scope = {};
  if (user?.role === 'sales') scope.assignedTo = user._id;
  Object.assign(scope, await regionScopedMatch(user));
  return scope;
};

/**
 * The campaign of each of these leads put on the lead as `campaignBrand` (utils/marketingOutcomes.js withCampaignBrand), so a campaign's
 * lead counts under the campaign's brand — as on the Campaigns hub.
 */
export const withBrands = async (leads) => {
  const ids = [...new Set(leads.map((l) => idOf(l.campaignId)).filter((id) => mongoose.isValidObjectId(id)))];
  if (!ids.length) return leads;
  const docs = await Campaign.find({ _id: { $in: ids } }).select('brand').lean();
  return withCampaignBrand(leads, new Map(docs.map((c) => [idOf(c), c])));
};

/** The leads that arrived in the range or in the period before it (the change is read from that), as plain objects. */
export const loadLeadWindow = async (range, scope = {}) => {
  const prev = T.previousRange(range);
  const a = istStart(prev.from);
  const z = istEnd(range.to);
  const leads = await Lead.find({ ...scope, $or: [{ leadDate: { $gte: a, $lte: z } }, { leadDate: null, createdAt: { $gte: a, $lte: z } }] })
    .select(LEAD_FIELDS)
    .limit(LEAD_CAP)
    .lean();
  return withBrands(leads);
};

export const BOOKING_FIELDS = 'leadId status totalPrice discountAmount advanceAmount advanceStatus collectedAmount createdBy createdAt bookingNumber';

/**
 * What the booking figures need (utils/marketingOutcomes.js outcomeContext): the bookings these leads are linked to — their own
 * Lead.bookingId, or a booking whose Booking.leadId names one of them — each lead's linked LIVE booking, the GST setting, and who counts
 * toward sales totals. The Campaigns hub loads its bookings the same way (controllers/marketingCampaignHubController.js).
 */
export const bookingContext = async (leads) => {
  const bookingIds = [...new Set(leads.map((l) => idOf(l.bookingId)).filter((id) => mongoose.isValidObjectId(id)))];
  const leadIds = leads.map((l) => l._id).filter((id) => mongoose.isValidObjectId(String(id)));
  const or = [...(bookingIds.length ? [{ _id: { $in: bookingIds } }] : []), ...(leadIds.length ? [{ leadId: { $in: leadIds } }] : [])];
  const [bookings, gst, countsTowardSales] = await Promise.all([
    or.length ? Booking.find({ $or: or }).select(BOOKING_FIELDS).limit(LEAD_CAP * 2).lean() : [],
    ensureGstConfig(),
    makeCountsTowardSales(),
  ]);
  return outcomeContext({ leads, bookings, gst, countsTowardSales });
};

/**
 * Every campaign (title, channel, brand, objective — a lead's campaign is named even when it is not the brand's), and the ad spend of the
 * range per campaign of the brand: the daily records of the Campaigns hub (typed or imported from Meta) — the same money its screens show.
 * → { campaigns: Map(id → campaign), spend: Map(campaignId → spend in the range) }
 */
export const campaignContext = async (_list, _scope = {}, range = null) => {
  const docs = await Campaign.find().select('title channel brand objective').limit(2000).lean();
  const campaigns = new Map(docs.map((c) => [idOf(c), c]));
  if (!range) return { campaigns, spend: new Map() };
  const metrics = await CampaignDailyMetric.find({ day: { $gte: range.from, $lte: range.to } }).select('campaignId day spend').limit(60000).lean();
  const spend = new Map();
  for (const [id, v] of spendByCampaign(metrics, range)) {
    const c = campaigns.get(id);
    if (c && (!range.brand || range.brand === 'all' || brandOfCampaign(c) === range.brand)) spend.set(id, v);
  }
  return { campaigns, spend };
};

/** Map<userId, name>. */
export const namesOf = async (ids) => {
  const clean = [...new Set(ids.filter((id) => mongoose.isValidObjectId(id)))];
  if (!clean.length) return new Map();
  const users = await User.find({ _id: { $in: clean } }).select('name').lean();
  return new Map(users.map((u) => [idOf(u), u.name ?? '']));
};

/**
 * Every follow-up that can matter for the range and the period before it, plus the overdue ones from before them: the follow-ups
 * logged on leads (LeadActivity type 'followup') and the date on a lead in the Follow-up stage, one item each (see
 * utils/marketingLeadReportStats.js buildFollowUps).
 */
export const loadFollowUps = async (range, scope = {}) => {
  const prev = T.previousRange(range);
  const a = istStart(prev.from);
  const z = istEnd(range.to);
  const [dated, acts] = await Promise.all([
    Lead.find({ ...scope, status: 'Follow-up', followUpDate: { $ne: null, $lte: z } }).select(LEAD_FIELDS).limit(LEAD_CAP).lean(),
    LeadActivity.find({ type: 'followup', status: { $ne: 'Cancelled' }, $or: [{ scheduledDate: { $gte: a, $lte: z } }, { status: 'Pending', scheduledDate: { $lt: a } }] })
      .select('leadId type status scheduledDate remark channel')
      .limit(LEAD_CAP)
      .lean(),
  ]);
  // a follow-up date on a lead is not a second follow-up when one was logged for that same moment — even an old, completed one
  const dupes = dated.length
    ? await LeadActivity.find({ type: 'followup', status: { $ne: 'Cancelled' }, leadId: { $in: dated.map((l) => l._id) }, scheduledDate: { $in: dated.map((l) => l.followUpDate) } }).select('leadId type status scheduledDate remark channel').lean()
    : [];
  const activities = [...new Map([...acts, ...dupes].map((x) => [idOf(x), x])).values()];
  const have = new Set(dated.map(idOf));
  const more = [...new Set(activities.map((x) => idOf(x.leadId)))].filter((id) => !have.has(id) && mongoose.isValidObjectId(id));
  const extra = more.length ? await Lead.find({ ...scope, _id: { $in: more } }).select(LEAD_FIELDS).lean() : [];
  return R.buildFollowUps({ activities, leads: await withBrands([...dated, ...extra]) });
};
