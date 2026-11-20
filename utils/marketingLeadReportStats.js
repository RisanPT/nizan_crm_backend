import { istDay, addDays, eachDay, previousRange, changePct, daysBetween } from './marketingTeamStats.js';
import {
  LEAD_STAGES,
  QUALITIES,
  NOT_RATED,
  SOURCES,
  leadBrand,
  leadDay,
  qualityOf,
  sourceKeyOf,
  sourceLabelOf,
  stageOfLead,
} from './marketingLeadStages.js';
import { DEAD_BOOKING, isLiveBooking, isBooked, isQualifiedLead, valuedBookingOf, bookingMoney, outcomeFigures, costPer } from './marketingOutcomes.js';

// What the Lead Report screens count — ONE definition of each number, used by Overview, All Leads, Lead Stages, Sources, Follow-ups,
// Conversion and Reports (and by the Marketing Weekly Report, which imports the functions at the bottom of this file).
// Pure — no database (tests/marketingLeadReportStats.test.js); controllers/marketingLeadReportController.js loads the CRM's own
// records (models/Lead.js, LeadActivity.js, Booking.js, Campaign.js — the Lead Report keeps no copy of them) and calls these.
// All days are IST day strings 'YYYY-MM-DD'.
//
// ── LEADS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//  • A lead COUNTS on its day: leadDate, else the day it was created (utils/marketingLeadStages.js leadDay), in India.
//  • Brand: leadBrand(lead) (an Instagram page names it; otherwise the region / district). "All" = no filter.
//  • STAGE / QUALITY / SOURCE: utils/marketingLeadStages.js — never re-derived here.
//      New · In Progress (Contacted, Qualified, Follow-up, Pending Lost Approval) · Not Converted (Lost) · Converted (the CRM status).
//  • BOOKINGS, BOOKING VALUE, ORDER VALUE, QUALIFIED, CONVERSION RATE, SPEND, COST PER LEAD / BOOKING and BRAND are the ones the
//    Campaigns hub and the Weekly Report use too: utils/marketingOutcomes.js. In short: a BOOKING is a lead linked to a LIVE booking (one
//    per lead); its VALUE is the booking after discount with GST backed out; QUALIFIED = Qualified / Follow-up / Converted status or
//    booked; CONVERSION RATE = bookings ÷ leads. The stage "Converted" stays the CRM status (a Converted lead whose booking was cancelled
//    is in the Converted stage but is not a booking). A booking whose creator does not count toward sales totals is UNVALUED.
//  • A conversion rate's change on the previous period is in percentage points; every count's change is a percentage (changePct).
//  • Everything is by the day the lead ARRIVED (a cohort): "of the leads that arrived in this range, so many are booked now".
//    The CRM keeps no history of when a status changed, so stage trends show the leads' CURRENT stage on their arrival day.
//
// ── COSTS ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
//  • A campaign's spend is the ad spend of the days IN the range (the Campaigns hub's daily records — imported from Meta Ads Manager or
//    typed for a day); cost per lead = that spend ÷ the campaign's leads that arrived in the range, cost per booking = ÷ their bookings.
//    The overall figures: the spend of ALL the brand's campaigns in the range ÷ all the campaign leads of the range — exactly the Campaigns
//    hub's cost per lead. null ("—") where nothing is known. The lifetime figure typed on the old Campaigns screen (Campaign.adSpend) has
//    no dates and is not used.
//  • A lead belongs to the campaign in Lead.campaignId.
//
// ── FOLLOW-UPS ───────────────────────────────────────────────────────────────────────────────────────────────────────────
//  • A FOLLOW-UP is (a) a LeadActivity of type 'followup' (not Cancelled) — Completed once marked Completed, otherwise Pending — or
//    (b) a lead that is in the Follow-up stage with a followUpDate and no logged follow-up carrying that same moment (the lead form
//    sets a date without logging an activity; Log Activity does both, and must not count twice). Calls and other activities are logged
//    contact, not follow-ups, and are not counted.
//  • Its DUE DAY is the IST day of its scheduled time. A follow-up counts in a range by its due day, and for the brand of its lead.
//  • Pending = not Completed. OVERDUE = Pending and due before today (IST). TODAY = Pending and due today. UPCOMING = Pending and due
//    after today. DUE = Pending in the range (= overdue + today + upcoming). COMPLETED = marked Completed, due in the range.
//    TOTAL = due + completed. `overdueBefore` = overdue follow-ups from before the range (so a short range does not hide them).
//  • The CRM also keeps a counter (Lead.followUpCompletedCount) bumped when a lead leaves the Follow-up stage; it has no date, so it
//    cannot be placed in a range and is NOT used here (the Leads screen's "Completed" is that lifetime counter).

export const CRM_STATUSES = ['New', 'Contacted', 'Qualified', 'Follow-up', 'Pending Lost Approval', 'Lost', 'Converted'];

/** The sources the Sources screen groups into (the document's Instagram / Meta Ads / WhatsApp / … cards). */
export const SOURCE_GROUPS = [
  { key: 'instagram', label: 'Instagram', sources: ['ig_main', 'ig_kerala'] },
  { key: 'meta_ads', label: 'Meta Ads', sources: ['meta_ads'] },
  { key: 'whatsapp', label: 'WhatsApp', sources: ['whatsapp'] },
  { key: 'youtube', label: 'YouTube', sources: ['youtube'] },
  { key: 'website', label: 'Website', sources: ['website'] },
  { key: 'others', label: 'Others', sources: ['reference', 'walk_in', 'other'] },
];
export const groupKeyOfSource = (sourceKey) => (SOURCE_GROUPS.find((g) => g.sources.includes(sourceKey)) ?? SOURCE_GROUPS[SOURCE_GROUPS.length - 1]).key;

export const FOLLOWUP_FILTERS = ['all', 'today', 'overdue', 'upcoming', 'completed'];
export const LEAD_SORTS = ['created', 'name', 'status', 'source', 'assigned'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (n) => Math.round(n * 10) / 10;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const inRange = (day, from, to) => day >= from && day <= to;
const pct1 = (part, whole) => (whole > 0 ? round1((part / whole) * 100) : null);
const ms = (d) => (d ? new Date(d).getTime() : NaN);

export const brandOk = (lead, brand) => !brand || brand === 'all' || leadBrand(lead) === brand;

/** The leads that count in the range and brand (by arrival day). */
export const leadsInRange = (leads, { from, to, brand }) => leads.filter((l) => inRange(leadDay(l), from, to) && brandOk(l, brand));

/** The CRM stage Converted (the status) — the pipeline stage, NOT the booking count (see isBooked). */
export const isConverted = (lead) => stageOfLead(lead.status) === 'converted';

// ── bookings (the shared definitions — utils/marketingOutcomes.js) ──────────────────────────────────────────────────────

/** A booking counts as a sale unless it is cancelled / rejected / lost / draft / pending. */
export const isSaleBooking = isLiveBooking;
export { DEAD_BOOKING, isBooked, bookingMoney };

/**
 * The live booking a lead is linked to, when it counts toward value (its creator counts toward sales totals); null otherwise.
 * ctx: { bookings, linked, gst, countsTowardSales } (utils/marketingOutcomes.js outcomeContext).
 */
export const countedBooking = (lead, ctx = {}) => valuedBookingOf(lead, ctx);

// ── distributions ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const stageCounts = (list) => {
  const by = (k) => list.filter((l) => stageOfLead(l.status) === k).length;
  return { total: list.length, new: by('new'), inProgress: by('in_progress'), notConverted: by('not_converted'), converted: by('converted') };
};

/** The pipeline: each stage's leads and its share of the total. */
export const stageRows = (list) => {
  const total = list.length;
  return LEAD_STAGES.map((s) => {
    const count = list.filter((l) => stageOfLead(l.status) === s.key).length;
    return { key: s.key, label: s.label, count, pct: pct1(count, total) };
  });
};

/** The CRM's own seven statuses (the stages group them). */
export const statusRows = (list) => CRM_STATUSES.map((status) => { const count = list.filter((l) => l.status === status).length; return { status, count, pct: pct1(count, list.length) }; });

/** Hot / Warm / Nurture / Cold (the CRM's priority), and "Not rated" only when some lead has no priority — for the Weekly Report too. */
export const qualityDistribution = (list) => {
  const total = list.length;
  const row = (q) => { const count = list.filter((l) => qualityOf(l) === q).length; return { key: q, label: q, count, pct: pct1(count, total) }; };
  const rows = QUALITIES.map(row);
  const unrated = row(NOT_RATED);
  return { total, rows: unrated.count > 0 ? [...rows, unrated] : rows };
};

/** Leads by source (sourceKeyOf), biggest first (ties in the CRM's own order); sources with no leads are left out. */
export const sourceDistribution = (list) => {
  const total = list.length;
  const counts = new Map();
  for (const l of list) counts.set(sourceKeyOf(l.source), (counts.get(sourceKeyOf(l.source)) ?? 0) + 1);
  const rows = SOURCES.filter((s) => counts.has(s.key)).map((s) => ({ key: s.key, label: s.label, count: counts.get(s.key), pct: pct1(counts.get(s.key), total) }));
  rows.sort((a, b) => b.count - a.count);
  return { total, rows };
};

/** The source groups (all of them, even at 0) with the change on the period before: `now` and `before` are lead lists. */
export const sourceGroups = (now, before = []) => {
  const count = (list, g) => list.filter((l) => g.sources.includes(sourceKeyOf(l.source))).length;
  return SOURCE_GROUPS.map((g) => {
    const c = count(now, g);
    return { key: g.key, label: g.label, count: c, pct: pct1(c, now.length), change: changePct(c, count(before, g)) };
  });
};

/** Per source: leads, qualified, hot, bookings and conversion rate, biggest first. */
export const sourceRows = (list, ctx = {}) => {
  const rows = SOURCES.map((s) => {
    const mine = list.filter((l) => sourceKeyOf(l.source) === s.key);
    return { key: s.key, label: s.label, ...figuresOf(mine, ctx), share: pct1(mine.length, list.length) };
  }).filter((r) => r.leads > 0);
  rows.sort((a, b) => b.leads - a.leads);
  return rows;
};

/** The numbers every grouped table shows for a set of leads (bookings, value and qualified: utils/marketingOutcomes.js). */
export const figuresOf = (mine, ctx = {}) => {
  const o = outcomeFigures(mine, ctx);
  return {
    leads: o.leads,
    qualified: o.qualified,
    hot: mine.filter((l) => qualityOf(l) === 'Hot').length,
    bookings: o.booked,
    rate: o.rate,
    bookingValue: o.value,
    unvalued: o.unvalued,
  };
};

// ── headline figures and the period before ──────────────────────────────────────────────────────────────────────────────

/**
 * The headline figures of a range and brand. `leads` = any list of CRM leads (the range is cut here); ctx = { bookings: Map, gst,
 * countsTowardSales }. Used by Overview, Stages, Conversion and the Weekly Report.
 *  → { total, new, inProgress, notConverted, converted (the CRM stage), qualified, hot, conversionRate, bookings, bookingValue,
 *      orderValue, unvalued, quality: {total, rows}, sources: {total, rows} }
 */
export const leadFigures = (leads, range, ctx = {}) => {
  const list = leadsInRange(leads, range);
  const s = stageCounts(list);
  const o = outcomeFigures(list, ctx);
  return {
    total: s.total,
    new: s.new,
    inProgress: s.inProgress,
    notConverted: s.notConverted,
    converted: s.converted,
    qualified: o.qualified,
    hot: list.filter((l) => qualityOf(l) === 'Hot').length,
    conversionRate: o.rate,
    bookings: o.booked,
    bookingValue: o.value,
    orderValue: o.order,
    unvalued: o.unvalued,
    quality: qualityDistribution(list),
    sources: sourceDistribution(list),
  };
};

/**
 * A range and the period of the same length right before it, side by side — what the Weekly Report reads.
 *  → { range, previous, now, before, change: { total, new, inProgress, notConverted, converted, bookings, bookingValue, conversionRate } }
 * Counts and value change in percent (null with nothing to compare); conversionRate changes in percentage points.
 */
export const leadPeriod = ({ leads, range, ctx = {} }) => {
  const previous = { ...previousRange(range), brand: range.brand };
  const now = leadFigures(leads, range, ctx);
  const before = leadFigures(leads, previous, ctx);
  return {
    range,
    previous,
    now,
    before,
    change: {
      total: changePct(now.total, before.total),
      new: changePct(now.new, before.new),
      inProgress: changePct(now.inProgress, before.inProgress),
      notConverted: changePct(now.notConverted, before.notConverted),
      converted: changePct(now.converted, before.converted),
      bookings: changePct(now.bookings, before.bookings),
      bookingValue: changePct(now.bookingValue, before.bookingValue),
      conversionRate: now.conversionRate !== null && before.conversionRate !== null ? round1(now.conversionRate - before.conversionRate) : null,
    },
  };
};

/** The funnel: Total leads → Qualified → Hot → Bookings; each step's share of ALL the leads. */
export const funnel = (list, ctx = {}) => {
  const total = list.length;
  const steps = [
    { key: 'leads', label: 'Total Leads', count: total },
    { key: 'qualified', label: 'Qualified', count: list.filter((l) => isQualifiedLead(l, ctx)).length },
    { key: 'hot', label: 'Hot', count: list.filter((l) => qualityOf(l) === 'Hot').length },
    { key: 'bookings', label: 'Bookings', count: list.filter((l) => isBooked(l, ctx)).length },
  ];
  return { total, steps: steps.map((s) => ({ ...s, pct: pct1(s.count, total) })) };
};

// ── trends ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The trend's buckets: one per day for up to 31 days, else one per week (Monday–Sunday, clipped to the range). */
export const trendBuckets = ({ from, to }) => {
  const days = eachDay(from, to, 400);
  if (days.length <= 31) return { granularity: 'day', buckets: days.map((d) => ({ from: d, to: d })) };
  const buckets = [];
  let start = from;
  while (start <= to && buckets.length < 60) {
    const dow = (new Date(Date.parse(`${start}T00:00:00Z`)).getUTCDay() + 6) % 7;
    const end = addDays(start, 6 - dow);
    buckets.push({ from: start, to: end < to ? end : to });
    start = addDays(end, 1);
  }
  return { granularity: 'week', buckets };
};

/**
 * Leads that arrived in each bucket, by their stage now: { from, to, leads, new, inProgress, notConverted, converted (stage), qualified,
 * bookings }.
 */
export const leadTrend = (leads, range, ctx = {}) => {
  const list = leadsInRange(leads, range);
  const { granularity, buckets } = trendBuckets(range);
  const rows = buckets.map((b) => ({ from: b.from, to: b.to, leads: 0, new: 0, inProgress: 0, notConverted: 0, converted: 0, qualified: 0, bookings: 0 }));
  const at = new Map();
  buckets.forEach((b, i) => { for (const d of eachDay(b.from, b.to, 8)) at.set(d, i); });
  for (const l of list) {
    const r = rows[at.get(leadDay(l))];
    if (!r) continue;
    r.leads += 1;
    const k = stageOfLead(l.status);
    if (k === 'new') r.new += 1;
    else if (k === 'in_progress') r.inProgress += 1;
    else if (k === 'not_converted') r.notConverted += 1;
    else r.converted += 1;
    if (isQualifiedLead(l, ctx)) r.qualified += 1;
    if (isBooked(l, ctx)) r.bookings += 1;
  }
  return { granularity, rows };
};

// ── campaigns and cost ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The campaigns of the leads in the list, most leads first, and the overall cost figures — the same numbers as the Campaigns hub for the
 * same range and brand (utils/marketingOutcomes.js).
 *  • `campaigns`: Map<id, { title, channel, brand, objective }> — every campaign (a lead of one that no longer exists shows as "Removed
 *    campaign" and has no spend); `spend`: Map<campaignId, spend in the range> over ALL the brand's campaigns (the overall spend includes
 *    campaigns that brought no lead); `showCost` false hides every cost (a territory-scoped viewer sees part of the leads, not the whole
 *    spend).
 *  → { rows: [{ id, title, channel, brand, objective, leads, qualified, bookings, rate, bookingValue, spend, costPerLead, costPerBooking }],
 *      untagged, costs: { campaignsWithSpend, campaignsTotal, adSpend, leads, bookings, costPerLead, costPerBooking } }
 */
export const campaignRows = (list, { campaigns = new Map(), spend = new Map(), ctx = {}, showCost = true } = {}) => {
  const by = new Map();
  let untagged = 0;
  for (const l of list) {
    const id = idOf(l.campaignId);
    if (!id) {
      untagged += 1;
      continue;
    }
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(l);
  }
  const rows = [...by.entries()].map(([id, mine]) => {
    const c = campaigns.get(id);
    const f = figuresOf(mine, ctx);
    const spent = showCost && c ? num(spend.get(id)) : 0;
    return {
      id,
      title: c?.title ?? 'Removed campaign',
      channel: c?.channel ?? '',
      brand: c ? (c.brand === 'kerala' ? 'kerala' : 'main') : '',
      objective: c?.objective ?? '',
      leads: f.leads,
      qualified: f.qualified,
      bookings: f.bookings,
      rate: f.rate,
      bookingValue: f.bookingValue,
      spend: showCost ? (spent > 0 ? spent : null) : null,
      costPerLead: showCost ? costPer(spent, f.leads) : null,
      costPerBooking: showCost ? costPer(spent, f.bookings) : null,
    };
  });
  rows.sort((a, b) => b.leads - a.leads || a.title.localeCompare(b.title));
  // overall: every campaign of the brand that spent in the range, against every lead of an existing campaign
  const known = list.filter((l) => l.campaignId && campaigns.has(idOf(l.campaignId)));
  const o = outcomeFigures(known, ctx);
  const total = Math.round([...spend.values()].reduce((t, v) => t + num(v), 0) * 100) / 100;
  const costs = {
    campaignsWithSpend: showCost ? [...spend.values()].filter((v) => num(v) > 0).length : 0,
    campaignsTotal: rows.length,
    adSpend: showCost && total > 0 ? total : null,
    leads: known.length,
    bookings: o.booked,
    costPerLead: showCost ? costPer(total, known.length) : null,
    costPerBooking: showCost ? costPer(total, o.booked) : null,
  };
  return { rows, untagged, costs };
};

/** The overall cost figures of a campaignRows() answer (kept for callers that only want them). */
export const campaignCosts = (camp) => camp.costs;

/** Conversion by source: leads, bookings and rate for each source that has leads. */
export const conversionBySource = (list, ctx = {}) => sourceRows(list, ctx).map((r) => ({ key: r.key, label: r.label, leads: r.leads, bookings: r.bookings, rate: r.rate }));

// ── follow-ups ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every follow-up we know of (see the definition above), one item each. `activities`: LeadActivity-like { _id, leadId, type, status,
 * scheduledDate, remark }; `leads`: Lead-like { _id, status, followUpDate, assignedTo, source, region, district, … } — only the leads
 * the viewer may see; an activity of any other lead is dropped.
 * → [{ id, kind: 'activity' | 'lead', leadId, lead, due: Date, dueDay, done, remark, channel, assignedTo, brand }]
 * `channel` is how the follow-up is done (LeadActivity.channel: call / WhatsApp / visit / meeting / other); '' when it was not given
 * (older follow-ups, and a date set on the lead itself).
 */
export const buildFollowUps = ({ activities = [], leads = [] }) => {
  const byId = new Map(leads.map((l) => [idOf(l), l]));
  const items = [];
  const logged = new Set(); // "leadId|ms" of every logged follow-up that is not cancelled
  for (const a of activities) {
    if (a.type !== 'followup' || a.status === 'Cancelled' || !a.scheduledDate) continue;
    logged.add(`${idOf(a.leadId)}|${ms(a.scheduledDate)}`);
    const lead = byId.get(idOf(a.leadId));
    if (!lead) continue;
    items.push({ id: idOf(a), kind: 'activity', leadId: idOf(lead), lead, due: new Date(a.scheduledDate), dueDay: istDay(a.scheduledDate), done: a.status === 'Completed', remark: a.remark ?? '', channel: FOLLOWUP_CHANNELS.some((c) => c.key === a.channel) ? a.channel : '', assignedTo: idOf(lead.assignedTo), brand: leadBrand(lead) });
  }
  for (const l of leads) {
    if (l.status !== 'Follow-up' || !l.followUpDate) continue;
    if (logged.has(`${idOf(l)}|${ms(l.followUpDate)}`)) continue;
    items.push({ id: `lead:${idOf(l)}`, kind: 'lead', leadId: idOf(l), lead: l, due: new Date(l.followUpDate), dueDay: istDay(l.followUpDate), done: false, remark: '', channel: '', assignedTo: idOf(l.assignedTo), brand: leadBrand(l) });
  }
  return items;
};

/** How a follow-up is done (LeadActivity.channel). */
export const FOLLOWUP_CHANNELS = [
  { key: 'call', label: 'Call' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'visit', label: 'Visit' },
  { key: 'meeting', label: 'Meeting' },
  { key: 'other', label: 'Other' },
];
/** The label of a follow-up's channel; '' (not given) reads "Follow-up". */
export const followUpChannelLabel = (key) => FOLLOWUP_CHANNELS.find((c) => c.key === key)?.label ?? 'Follow-up';

/** completed / overdue / today / upcoming for one item, as of `today`. */
export const followUpState = (item, today = istDay()) => (item.done ? 'completed' : item.dueDay < today ? 'overdue' : item.dueDay === today ? 'today' : 'upcoming');

const brandOfItem = (i, brand) => !brand || brand === 'all' || i.brand === brand;

/** The Follow-ups cards for a range and brand — see the definition above. */
export const followUpCounts = (items, { from, to, brand }, today = istDay()) => {
  const mine = items.filter((i) => brandOfItem(i, brand) && inRange(i.dueDay, from, to));
  const pending = mine.filter((i) => !i.done);
  const count = (state) => pending.filter((i) => followUpState(i, today) === state).length;
  return {
    due: pending.length,
    today: count('today'),
    overdue: count('overdue'),
    upcoming: count('upcoming'),
    completed: mine.length - pending.length,
    total: mine.length,
    overdueBefore: items.filter((i) => brandOfItem(i, brand) && !i.done && i.dueDay < from && i.dueDay < today).length,
  };
};

/** The follow-up counts of a range and of the period before it, and how Completed and the total moved. */
export const followUpPeriod = (items, range, today = istDay()) => {
  const now = followUpCounts(items, range, today);
  const before = followUpCounts(items, { ...previousRange(range), brand: range.brand }, today);
  return { ...now, change: { completed: changePct(now.completed, before.completed), total: changePct(now.total, before.total) } };
};

/** The follow-ups of a range and brand for one chip (all / today / overdue / upcoming / completed), by due time. */
export const followUpList = (items, { from, to, brand, filter = 'all' }, today = istDay()) => {
  const list = items.filter((i) => brandOfItem(i, brand) && inRange(i.dueDay, from, to) && (filter === 'all' || followUpState(i, today) === filter));
  list.sort((a, b) => (filter === 'completed' ? b.due - a.due : a.due - b.due) || (a.id < b.id ? -1 : 1));
  return list;
};

// ── team ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Per person a lead is assigned to ('' = unassigned): leads, qualified, hot, bookings, rate, value, and their follow-ups in range. */
export const teamRows = (list, followItems, { nameOf = () => '', ctx = {}, range, today = istDay() } = {}) => {
  const keys = new Set([...list.map((l) => idOf(l.assignedTo)), ...followItems.map((i) => i.assignedTo)]);
  const rows = [...keys].map((k) => {
    const mine = list.filter((l) => idOf(l.assignedTo) === k);
    const fu = followUpCounts(followItems.filter((i) => i.assignedTo === k), { from: range.from, to: range.to, brand: range.brand }, today);
    return { id: k, name: k ? nameOf(k) || 'Unknown user' : 'Unassigned', ...figuresOf(mine, ctx), followUpsDue: fu.due, followUpsOverdue: fu.overdue, followUpsCompleted: fu.completed };
  });
  return rows.filter((r) => r.leads > 0 || r.followUpsDue > 0 || r.followUpsCompleted > 0).sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name));
};

// ── the All Leads list ───────────────────────────────────────────────────────────────────────────────────────────────────

const digitsOf = (s) => String(s ?? '').replace(/\D/g, '');

/**
 * Does a lead row match the search text? Name, campaign, assignee, source and the lead's short id always; the phone number (digits, so
 * "98765 43210" and "+91 98765-43210" match) only when `phone` is true — a viewer who cannot see numbers must not be able to probe them.
 */
export const matchesQuery = (row, q, { phone = false } = {}) => {
  const text = String(q ?? '').trim().toLowerCase().slice(0, 100);
  if (!text) return true;
  if ([row.name, row.campaign, row.assignedTo, row.sourceLabel, row.shortId].some((v) => String(v ?? '').toLowerCase().includes(text))) return true;
  const d = digitsOf(text);
  return phone && d.length >= 3 && digitsOf(row.phone).includes(d.length > 10 ? d.slice(-10) : d);
};

/**
 * The All Leads list's Assigned to and Campaign filters: `assignee` = 'all' | 'unassigned' | a user id; `campaign` = 'all' | 'none' (no
 * campaign) | a campaign id. Rows carry assignedToId and campaignId.
 */
export const matchesFilters = (row, { assignee = 'all', campaign = 'all' } = {}) =>
  (assignee === 'all' || (assignee === 'unassigned' ? !row.assignedToId : row.assignedToId === assignee)) &&
  (campaign === 'all' || (campaign === 'none' ? !row.campaignId : row.campaignId === campaign));

/** The choices of those two filters, from the range's lead rows: the people and campaigns that have leads, A–Z, with their counts. */
export const leadFilterOptions = (rows) => {
  const people = new Map();
  const camps = new Map();
  let unassigned = 0;
  let untagged = 0;
  for (const r of rows) {
    if (r.assignedToId) people.set(r.assignedToId, { id: r.assignedToId, name: r.assignedTo || 'Unknown user', count: (people.get(r.assignedToId)?.count ?? 0) + 1 });
    else unassigned += 1;
    if (r.campaignId) camps.set(r.campaignId, { id: r.campaignId, title: r.campaign || 'Removed campaign', count: (camps.get(r.campaignId)?.count ?? 0) + 1 });
    else untagged += 1;
  }
  const az = (k) => (a, b) => String(a[k]).localeCompare(String(b[k]));
  return { assignees: [...people.values()].sort(az('name')), unassigned, campaigns: [...camps.values()].sort(az('title')), untagged };
};

/** Sorts lead rows: created (newest first by default), name, status, source, assigned. dir 'asc' | 'desc'. */
export const sortLeadRows = (rows, sortBy = 'created', dir) => {
  const sort = LEAD_SORTS.includes(sortBy) ? sortBy : 'created';
  const want = dir === 'asc' || dir === 'desc' ? dir : sort === 'created' ? 'desc' : 'asc';
  const key = {
    created: (r) => r.createdAt,
    name: (r) => String(r.name ?? '').toLowerCase(),
    status: (r) => String(r.status ?? '').toLowerCase(),
    source: (r) => String(r.sourceLabel ?? '').toLowerCase(),
    assigned: (r) => String(r.assignedTo ?? '').toLowerCase(),
  }[sort];
  const sign = want === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    const c = x < y ? -1 : x > y ? 1 : 0;
    return c !== 0 ? c * sign : a.id < b.id ? -1 : 1;
  });
};

export const paginate = (list, page, size) => list.slice((page - 1) * size, page * size);

/** A lead's short reference, from its own id (the CRM has no lead number). */
export const shortLeadId = (id) => `#${String(id).slice(-6).toUpperCase()}`;

/** 98••••••10 — the first two and last two digits. '' when there is no number. */
export const maskPhone = (phone) => {
  const d = digitsOf(phone);
  if (d.length < 5) return d ? '•'.repeat(d.length) : '';
  return `${d.slice(0, 2)}${'•'.repeat(d.length - 4)}${d.slice(-2)}`;
};

// ── report tables (what Reports and every Export download) ──────────────────────────────────────────────────────────────

export const REPORTS = [
  { key: 'summary', title: 'Lead Summary', blurb: 'Overall lead performance' },
  { key: 'sources', title: 'Source Report', blurb: 'Channel-wise results' },
  { key: 'campaigns', title: 'Campaign Report', blurb: 'Campaign-wise leads and cost' },
  { key: 'team', title: 'Team Performance', blurb: 'Leads and follow-ups by person' },
  { key: 'conversion', title: 'Conversion Report', blurb: 'Funnel and booking value' },
  { key: 'leads', title: 'All Leads', blurb: 'Every lead in the range' },
  { key: 'followups', title: 'Follow-ups', blurb: 'Follow-ups due in the range' },
];

const rate = (v) => (v === null || v === undefined ? '' : v);
const money = (v) => (v === null || v === undefined ? '' : v);

export const summaryTable = ({ figures, statuses, quality, groups, followUps }) => ({
  columns: ['Measure', 'Value', 'Share of leads %'],
  rows: [
    ['Total leads', figures.total, ''],
    ['New', figures.new, rate(pct1(figures.new, figures.total))],
    ['In progress', figures.inProgress, rate(pct1(figures.inProgress, figures.total))],
    ['Not converted', figures.notConverted, rate(pct1(figures.notConverted, figures.total))],
    ['Converted (CRM stage)', figures.converted, rate(pct1(figures.converted, figures.total))],
    ['Bookings', figures.bookings, rate(figures.conversionRate)],
    ['Qualified', figures.qualified, rate(pct1(figures.qualified, figures.total))],
    ['Booking value (ex-GST)', figures.bookingValue, ''],
    ...statuses.map((s) => [`CRM status: ${s.status}`, s.count, rate(pct1(s.count, figures.total))]),
    ...quality.rows.map((q) => [`Quality: ${q.label}`, q.count, rate(q.pct)]),
    ...groups.map((g) => [`Source: ${g.label}`, g.count, rate(g.pct)]),
    ['Follow-ups due', followUps.due, ''],
    ['Follow-ups overdue', followUps.overdue, ''],
    ['Follow-ups completed', followUps.completed, ''],
  ],
});

export const sourceTable = (rows) => ({
  columns: ['Source', 'Leads', 'Share of leads %', 'Qualified', 'Hot', 'Bookings', 'Conversion rate %', 'Booking value (ex-GST)'],
  rows: rows.map((r) => [r.label, r.leads, rate(r.share), r.qualified, r.hot, r.bookings, rate(r.rate), r.bookingValue]),
});

export const campaignTable = (rows) => ({
  columns: ['Campaign', 'Channel', 'Brand', 'Leads', 'Qualified', 'Bookings', 'Conversion rate %', 'Booking value (ex-GST)', 'Ad spend in range', 'Cost per lead', 'Cost per booking'],
  rows: rows.map((r) => [r.title, r.channel, r.brand, r.leads, r.qualified, r.bookings, rate(r.rate), r.bookingValue, money(r.spend), money(r.costPerLead), money(r.costPerBooking)]),
});

export const teamTable = (rows) => ({
  columns: ['Assigned to', 'Leads', 'Qualified', 'Hot', 'Bookings', 'Conversion rate %', 'Booking value (ex-GST)', 'Follow-ups due', 'Follow-ups overdue', 'Follow-ups completed'],
  rows: rows.map((r) => [r.name, r.leads, r.qualified, r.hot, r.bookings, rate(r.rate), r.bookingValue, r.followUpsDue, r.followUpsOverdue, r.followUpsCompleted]),
});

export const conversionTable = ({ figures, funnel: f, bySource, trend, costs, types = [] }) => ({
  columns: ['Part', 'Item', 'Leads', 'Bookings', 'Rate %', 'Value (ex-GST)'],
  rows: [
    ['Headline', 'Conversion rate', figures.total, figures.bookings, rate(figures.conversionRate), ''],
    ['Headline', 'Booking value (ex-GST)', figures.total, figures.bookings, rate(figures.conversionRate), figures.bookingValue],
    ['Headline', 'Order value (customers pay, GST included)', figures.total, figures.bookings, rate(figures.conversionRate), figures.orderValue],
    ['Headline', 'Cost per booking (ad spend in range ÷ campaign bookings)', '', costs.bookings, '', money(costs.costPerBooking)],
    ...f.steps.map((s) => ['Funnel', s.label, s.count, '', rate(s.pct), '']),
    ...bySource.map((s) => ['By source', s.label, s.leads, s.bookings, rate(s.rate), '']),
    ...types.map((t) => ['By campaign type', t.label, t.leads, '', rate(t.pct), '']),
    ...trend.rows.map((r) => [`Trend (by ${trend.granularity})`, r.from === r.to ? r.from : `${r.from} to ${r.to}`, r.leads, r.bookings, rate(pct1(r.bookings, r.leads)), '']),
  ],
});

/** All Leads as a table. A viewer who may not see contact numbers gets no phone column at all. */
export const leadsTable = (rows, { canContact = false } = {}) => ({
  columns: ['Lead ID', 'Name', ...(canContact ? ['Phone'] : []), 'Source', 'Campaign', 'Assigned to', 'Status', 'Quality', 'Created'],
  rows: rows.map((r) => [r.shortId, r.name, ...(canContact ? [r.phone] : []), r.sourceLabel, r.campaign, r.assignedTo, r.status, r.priority, r.createdDay]),
});

export const followUpsTable = (rows, { canContact = false } = {}) => ({
  columns: ['Lead ID', 'Lead', ...(canContact ? ['Phone'] : []), 'Campaign', 'Assigned to', 'Type', 'Due', 'Status', 'Remark'],
  rows: rows.map((r) => [r.shortId, r.name, ...(canContact ? [r.phone] : []), r.campaign, r.assignedTo, followUpChannelLabel(r.channel), r.dueDay, r.state, r.remark]),
});
