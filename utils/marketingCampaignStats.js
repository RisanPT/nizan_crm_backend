import { istDay, addDays, eachDay, previousRange, changePct, daysBetween } from './marketingTeamStats.js';
import { isQualified, qualityOf, leadDay, sourceKeyOf, leadBrand, QUALITIES, NOT_RATED } from './marketingLeadStages.js';
import { DEAD_BOOKING, outcomeContext, bookingMoney, brandOfCampaign, costPer, leadsByCampaignType, CAMPAIGN_TYPES } from './marketingOutcomes.js';
import { metaStatusWord } from './metaAds.js';

// What the Campaigns hub counts — ONE definition of each number, used by every tab, so Overview, All Campaigns, Performance, Budget & Spend,
// Leads & Conversions, Reports and the Weekly Report agree. Pure (tests/marketingCampaignStats.test.js): the controller
// (controllers/marketingCampaignHubController.js) loads the records and calls these. Days are IST day strings 'YYYY-MM-DD'.
//
// WHERE EACH NUMBER COMES FROM (the document's rule: log once, store once, reflect everywhere)
//  • PAID-ADS FIGURES — spend, reach, impressions, clicks and the platform's own "results" — are CampaignDailyMetric records: one per
//    campaign per day, typed by hand or imported from a Meta Ads Manager export. There is NO live Meta sync. A range's figure is the sum of
//    its days. The legacy Campaign.adSpend is a LIFETIME total typed on the old Campaigns screen with no dates: it is never added to these
//    (that would count the same money twice) and no screen of the hub reads it.
//  • LEADS, BOOKINGS, REVENUE are the CRM's. A lead belongs to a campaign through Lead.campaignId. A BOOKING is a lead linked to a LIVE
//    booking (one per lead; a booking belongs to one lead) and its REVENUE (booking value) is the booking after discount with the GST backed
//    out, left out when the booking's creator is excluded from sales totals — the Lead Report's and the Weekly Report's definitions,
//    from ONE place: utils/marketingOutcomes.js (read it for the exact rules).
//  • Platform "results" (e.g. Meta's own lead count) are shown BESIDE the CRM's numbers and never mixed into them: cost per lead always
//    divides by CRM leads.
//
// THE DEFINITIONS
//  • Brand — the CAMPAIGN's brand (Campaign.brand; campaigns made before it existed count as Main). A lead, booking or day of spend counts
//    under the brand of the campaign it belongs to, so a brand's cost per lead divides that brand's spend by that brand's leads. The Lead
//    Report puts a campaign's lead under the campaign's brand too (utils/marketingOutcomes.js withCampaignBrand), so the two agree.
//  • Lead day — the day the enquiry arrived (marketingLeadStages.leadDay: leadDate, else created, IST). Everything about leads is by the
//    COHORT of leads that arrived in the range: its bookings are the bookings those leads made, whenever they were made.
//  • Spend / Reach / Impressions / Clicks / Results — sums of the daily records in the range. Reach is the sum of each day's reach (Meta's
//    day-by-day figure), so a person reached on two days counts twice: it is "reach added up over the days", and the screen says so.
//  • CTR % = clicks ÷ impressions × 100 (2 decimals). CPM = spend ÷ impressions × 1000. null when there is nothing to divide by.
//  • Cost per lead (CPL) = spend ÷ CRM leads attributed to the campaigns in the range. null when there are no leads or no spend (a cost of ₹0
//    would only mean "nothing imported").
//  • Qualified — the lead reached Qualified or beyond, or is booked (utils/marketingOutcomes.js isQualifiedLead).
//  • Booked leads = Bookings — leads linked to a live booking (one each). Conversion rate % = booked leads ÷ leads (1 decimal).
//    Booking value = revenue as above. ROAS = revenue ÷ spend.
//  • Quality — the CRM priority: Hot / Warm / Nurture / Cold, and "Not rated" for a lead with none.
//  • Change — "now" against the same-length period immediately before (changePct: null when there was nothing before to compare with).
//  • BUDGET — Campaign.budget is the campaign's TOTAL budget (0 = "no budget set": never invented). A campaign is IN THE PERIOD when it has
//    spend in the range, or it is not Completed and its dates (start → end; created day when no start, open-ended when no end) overlap the
//    range. Per campaign: spent to date = all its spend up to the end of the range; remaining = budget − spent (never below 0; "over budget" is
//    shown instead); utilisation % = spent to date ÷ budget. Total budget / spent / remaining / utilisation add up the BUDGETED campaigns
//    in the period only, so the percentage compares like with like; spend on campaigns with no budget is reported separately.
//    The utilisation change is the percentage points gained over the period (utilisation at the end of the range minus at the end of the
//    previous range, same campaigns).
//  • ADS (Creatives & Ads) — an ad imported from Ads Manager's AD-LEVEL export has a record per day (CampaignAdDailyMetric): its figures
//    are the days INSIDE the range, like the campaigns'. An ad typed by hand has only the cumulative figures typed on it (lifetime): those
//    are shown as they are, marked "lifetime", and the range does not narrow them. Cost per result = ad spend ÷ the ad's own results
//    (platform-reported). CRM LEADS of an ad = the CRM leads of the range whose "creative" (Lead.creative) names the ad (its name or its
//    Meta ad ID, any case) and whose campaign, when they have one, is the ad's; CPL = the ad's spend in the range ÷ those leads (only for
//    an ad with daily figures — a lifetime spend over a range's leads would mean nothing). An ad is judged against the AVERAGE of all the
//    ads of the brand (weighted: Σ clicks ÷ Σ impressions, Σ spend ÷ Σ results) — not just the ones a search or filter leaves on screen, so
//    an ad's verdict never flips when you filter — see adVerdict below.
//  • AUDIENCES & PLACEMENTS — from Ads Manager's BREAKDOWN exports (age, gender, age and gender, platform / placement), stored per campaign,
//    day and segment (CampaignBreakdownMetric). A segment's figures are the days inside the range. Results are the platform's (Meta's
//    leads / messages): the CRM does not record a lead's age or placement, so CRM leads cannot be split this way. See audienceSegments.

// ── the lists the forms and the filters use ─────────────────────────────────────────────────────────────────────────────────────

export const CAMPAIGN_STATUSES = [
  { key: 'planned', label: 'Planned' },
  { key: 'active', label: 'Active' },
  { key: 'paused', label: 'Paused' },
  { key: 'completed', label: 'Completed' },
];
export const OBJECTIVES = [
  { key: 'lead_generation', label: 'Lead Generation' },
  { key: 'messages', label: 'Messages' },
  { key: 'engagement', label: 'Engagement' },
  { key: 'reach', label: 'Reach' },
  { key: 'traffic', label: 'Traffic' },
  { key: 'conversions', label: 'Conversions' },
  { key: 'other', label: 'Other' },
];
export const PLATFORMS = [
  { key: 'meta', label: 'Meta' },
  { key: 'instagram', label: 'Instagram' },
  { key: 'facebook', label: 'Facebook' },
  { key: 'google', label: 'Google' },
  { key: 'youtube', label: 'YouTube' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'other', label: 'Other' },
];
export const AD_FORMATS = [
  { key: 'image', label: 'Image' },
  { key: 'video', label: 'Video' },
  { key: 'reel', label: 'Reel' },
  { key: 'carousel', label: 'Carousel' },
  { key: 'story', label: 'Story' },
  { key: 'other', label: 'Other' },
];

/** The bookings that do not count (utils/marketingOutcomes.js — the dashboards' isSale list). */
export { DEAD_BOOKING, CAMPAIGN_TYPES };

/** An ad needs this much delivery (impressions) OR spend before it is judged; before that it is "Too early". */
export const MIN_IMPRESSIONS_FOR_VERDICT = 1000;
export const MIN_SPEND_FOR_VERDICT = 500;

export const AD_VERDICTS = [
  { key: 'top', label: 'Top performing' },
  { key: 'under', label: 'Underperforming' },
  { key: 'needs_attention', label: 'Needs attention' },
  { key: 'ok', label: 'Average' },
  { key: 'early', label: 'Too early' },
];

// ── small helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (n) => Math.round(n * 10) / 10;
export const round2 = (n) => Math.round(n * 100) / 100;
const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const labelOf = (list, key, fallback = '') => list.find((x) => x.key === key)?.label ?? fallback;
const inRange = (day, from, to) => day >= from && day <= to;

export const objectiveLabel = (key) => labelOf(OBJECTIVES, key, 'Not set');
export const platformLabel = (key) => labelOf(PLATFORMS, key, 'Not set');
export const statusLabel = (key) => labelOf(CAMPAIGN_STATUSES, key, 'Active');
export const adVerdictLabel = (key) => labelOf(AD_VERDICTS, key, 'Average');

/** The campaign's brand: Kerala or Main (campaigns made before the field existed are Main). */
export { brandOfCampaign };
const brandOk = (c, brand) => !brand || brand === 'all' || brandOfCampaign(c) === brand;

/** The campaign's platform: the normalised field; for older campaigns the typed `channel` is read ("Instagram", "Meta Ads"…); '' = not set. */
export const platformOfCampaign = (c) => {
  if (PLATFORMS.some((p) => p.key === c?.platform)) return c.platform;
  const ch = String(c?.channel ?? '').toLowerCase().trim();
  if (!ch) return '';
  if (/instagram|\big\b/.test(ch)) return 'instagram';
  if (/facebook|\bfb\b/.test(ch)) return 'facebook';
  if (/\bmeta\b/.test(ch)) return 'meta';
  if (/google|adwords/.test(ch)) return 'google';
  if (/youtube/.test(ch)) return 'youtube';
  if (/whatsapp/.test(ch)) return 'whatsapp';
  return 'other';
};
export const objectiveOfCampaign = (c) => (OBJECTIVES.some((o) => o.key === c?.objective) ? c.objective : '');
export const statusOfCampaign = (c) => (CAMPAIGN_STATUSES.some((s) => s.key === c?.status) ? c.status : 'active');

export const ctrPct = (clicks, impressions) => (num(impressions) > 0 ? round2((num(clicks) / num(impressions)) * 100) : null);
export const cpmOf = (spend, impressions) => (num(impressions) > 0 ? round2((num(spend) / num(impressions)) * 1000) : null);
/** Cost per lead: null with no leads, or with no spend (₹0 would only mean "nothing imported"). */
export const cplOf = costPer;
export const roasOf = (revenue, spend) => (num(spend) > 0 ? round2(num(revenue) / num(spend)) : null);
const pct1 = (a, b) => (num(b) > 0 ? round1((num(a) / num(b)) * 100) : null);
const pct0 = (a, b) => (num(b) > 0 ? Math.round((num(a) / num(b)) * 100) : null);

/** The change of a figure that may be missing: null unless both exist. */
const change = (now, before) => (now == null || before == null ? null : changePct(now, before));

const byId = (campaigns) => new Map(campaigns.map((c) => [idOf(c), c]));

// ── paid-ads figures (daily records) ────────────────────────────────────────────────────────────────────────────────────────────

/** The daily records inside [from, to] that belong to a campaign of the brand. */
export const metricRowsIn = (metrics, campaignsById, { from, to, brand = 'all' }) =>
  metrics.filter((m) => inRange(m.day, from, to) && campaignsById.has(idOf(m.campaignId)) && brandOk(campaignsById.get(idOf(m.campaignId)), brand));

export const emptyTotals = () => ({ spend: 0, reach: 0, impressions: 0, clicks: 0, results: 0, days: 0 });

/** Sum of daily records; `days` = how many different days have a record. */
export const sumMetrics = (rows) => {
  const t = emptyTotals();
  const days = new Set();
  for (const m of rows) {
    t.spend += num(m.spend);
    t.reach += num(m.reach);
    t.impressions += num(m.impressions);
    t.clicks += num(m.clicks);
    t.results += num(m.results);
    days.add(m.day);
  }
  t.spend = round2(t.spend);
  t.days = days.size;
  return t;
};

// ── CRM leads, bookings and revenue ─────────────────────────────────────────────────────────────────────────────────────────────

/** The leads (attributed to a campaign of the brand) that arrived inside [from, to]. */
export const leadsIn = (leads, campaignsById, { from, to, brand = 'all' }) =>
  leads.filter((l) => l.campaignId && campaignsById.has(idOf(l.campaignId)) && brandOk(campaignsById.get(idOf(l.campaignId)), brand) && inRange(leadDay(l), from, to));

/**
 * Each booked lead's booking and revenue: Map(leadId → { bookings: 1, revenue, order, valued }) — utils/marketingOutcomes.js: a lead linked
 * to a live booking is ONE booking; revenue = that booking after discount with GST backed out (`gst` = the GST setting; without it nothing
 * is backed out), 0 when its creator does not count toward sales totals (`countsTowardSales`).
 */
export const leadOutcomes = ({ leads = [], bookings = [], countsTowardSales = () => true, gst = {} }) => {
  const ctx = outcomeContext({ leads, bookings, gst, countsTowardSales });
  const out = new Map();
  for (const [leadId, b] of ctx.linked) {
    const valued = countsTowardSales(b);
    const m = valued ? bookingMoney(b, gst) : { value: 0, order: 0 };
    out.set(leadId, { bookings: 1, revenue: round2(m.value), order: round2(m.order), valued });
  }
  return out;
};

const emptyFunnel = () => ({ leads: 0, qualified: 0, hot: 0, warm: 0, nurture: 0, cold: 0, notRated: 0, bookedLeads: 0, bookings: 0, revenue: 0 });
const QUALITY_KEY = { Hot: 'hot', Warm: 'warm', Nurture: 'nurture', Cold: 'cold', [NOT_RATED]: 'notRated' };

/** Leads → funnel counts. */
export const leadFunnel = (leads, outcomes) => {
  const f = emptyFunnel();
  for (const l of leads) {
    const o = outcomes.get(idOf(l));
    f.leads += 1;
    f[QUALITY_KEY[qualityOf(l)]] += 1;
    if (isQualified(l.status) || (o?.bookings ?? 0) > 0) f.qualified += 1;
    if ((o?.bookings ?? 0) > 0) {
      f.bookedLeads += 1;
      f.bookings += o.bookings;
      f.revenue += o.revenue;
    }
  }
  f.revenue = round2(f.revenue);
  return f;
};

// ── a period in one block (the KPI strips) ──────────────────────────────────────────────────────────────────────────────────────

/** Every headline figure of one period: paid-ads sums + CRM leads / bookings / revenue + the ratios. */
export const periodTotals = ({ campaigns, metrics, leads, outcomes, range }) => {
  const cById = byId(campaigns);
  const m = sumMetrics(metricRowsIn(metrics, cById, range));
  const f = leadFunnel(leadsIn(leads, cById, range), outcomes);
  return {
    spend: m.spend,
    reach: m.reach,
    impressions: m.impressions,
    clicks: m.clicks,
    results: m.results,
    daysWithData: m.days,
    leads: f.leads,
    qualified: f.qualified,
    hot: f.hot,
    bookedLeads: f.bookedLeads,
    bookings: f.bookings,
    revenue: f.revenue,
    ctr: ctrPct(m.clicks, m.impressions),
    cpm: cpmOf(m.spend, m.impressions),
    cpl: cplOf(m.spend, f.leads),
    conversionRate: pct1(f.bookedLeads, f.leads),
    roas: roasOf(f.revenue, m.spend),
  };
};

const CHANGE_KEYS = ['spend', 'reach', 'impressions', 'clicks', 'results', 'leads', 'qualified', 'bookedLeads', 'bookings', 'revenue', 'ctr', 'cpm', 'cpl', 'roas'];

/** { now, before, change } — the period, the same-length period before it, and the % change of each figure (null when no comparison). */
export const kpiBlock = (args) => {
  const now = periodTotals(args);
  const before = periodTotals({ ...args, range: { ...previousRange(args.range), brand: args.range.brand } });
  const ch = {};
  for (const k of CHANGE_KEYS) ch[k] = change(now[k], before[k]);
  // a conversion rate moves in percentage POINTS, not percent of a percent
  ch.conversionRate = now.conversionRate == null || before.conversionRate == null ? null : round1(now.conversionRate - before.conversionRate);
  return { now, before, change: ch };
};

// ── the trend chart ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Up to this many days a trend is drawn day by day; longer ranges are drawn week by week (Monday to Sunday). */
export const DAILY_TREND_MAX_DAYS = 92;

const mondayOf = (day) => {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
};

/** Points of the performance trend: { day, days, spend, reach, impressions, clicks, results, leads, qualified, bookings, cpl } per day (or per week). */
export const trendSeries = ({ campaigns, metrics, leads, outcomes, range }) => {
  const cById = byId(campaigns);
  const { from, to } = range;
  const weekly = daysBetween(from, to) + 1 > DAILY_TREND_MAX_DAYS;
  const keyOf = (day) => (weekly ? (mondayOf(day) < from ? from : mondayOf(day)) : day);
  const pts = new Map();
  for (const d of eachDay(from, to)) {
    const k = keyOf(d);
    if (!pts.has(k)) pts.set(k, { day: k, days: 0, spend: 0, reach: 0, impressions: 0, clicks: 0, results: 0, leads: 0, qualified: 0, bookings: 0 });
    pts.get(k).days += 1;
  }
  for (const m of metricRowsIn(metrics, cById, range)) {
    const p = pts.get(keyOf(m.day));
    if (!p) continue;
    p.spend += num(m.spend);
    p.reach += num(m.reach);
    p.impressions += num(m.impressions);
    p.clicks += num(m.clicks);
    p.results += num(m.results);
  }
  for (const l of leadsIn(leads, cById, range)) {
    const p = pts.get(keyOf(leadDay(l)));
    if (!p) continue;
    const o = outcomes.get(idOf(l));
    p.leads += 1;
    if (isQualified(l.status) || (o?.bookings ?? 0) > 0) p.qualified += 1;
    p.bookings += o?.bookings ?? 0; // placed on the day the LEAD arrived, so a day's bookings never exceed what that day's leads made
  }
  return [...pts.values()].map((p) => ({ ...p, spend: round2(p.spend), cpl: cplOf(p.spend, p.leads) }));
};

/**
 * Leads of the range by campaign type ("Leads by Campaign Type": lead gen / WhatsApp / website form / calls / others — from the campaign's
 * objective and the lead's source; utils/marketingOutcomes.js campaignTypeOf). [{ key, label, leads, pct }], biggest first. The Lead Report
 * shows the same split from the same function.
 */
export const leadsByType = ({ campaigns, leads, range }) => {
  const cById = byId(campaigns);
  return leadsByCampaignType(leadsIn(leads, cById, range), cById);
};

// ── campaign rows (All Campaigns, Overview's Active Campaigns, reports) ─────────────────────────────────────────────────────────

/** Work logged against campaigns: Map(campaignId → { minutes, entries }) from MarketingActivity records. */
export const workByCampaign = (activities) => {
  const out = new Map();
  for (const a of activities) {
    if (!a.campaignId) continue;
    const k = idOf(a.campaignId);
    const w = out.get(k) ?? { minutes: 0, entries: 0 };
    w.minutes += num(a.timeSpentMinutes);
    w.entries += 1;
    out.set(k, w);
  }
  return out;
};

/** One row per campaign (of the brand): its settings and its figures for the range. */
export const campaignRows = ({ campaigns, metrics, leads, outcomes, work = new Map(), range }) => {
  const cById = byId(campaigns);
  const mine = new Map();
  for (const m of metricRowsIn(metrics, cById, range)) {
    const k = idOf(m.campaignId);
    if (!mine.has(k)) mine.set(k, []);
    mine.get(k).push(m);
  }
  const leadsBy = new Map();
  for (const l of leadsIn(leads, cById, range)) {
    const k = idOf(l.campaignId);
    if (!leadsBy.has(k)) leadsBy.set(k, []);
    leadsBy.get(k).push(l);
  }
  return campaigns
    .filter((c) => brandOk(c, range.brand))
    .map((c) => {
      const id = idOf(c);
      const m = sumMetrics(mine.get(id) ?? []);
      const f = leadFunnel(leadsBy.get(id) ?? [], outcomes);
      return {
        id,
        title: c.title,
        brand: brandOfCampaign(c),
        platform: platformOfCampaign(c),
        objective: objectiveOfCampaign(c),
        status: statusOfCampaign(c),
        // the status read from Meta by the live sync, in words ("Paused", "Ended"…); '' = the status is the team's own
        metaStatus: metaStatusWord(c.metaStatus ?? ''),
        budget: num(c.budget),
        metaCampaignId: c.metaCampaignId ?? '',
        spend: m.spend,
        reach: m.reach,
        impressions: m.impressions,
        clicks: m.clicks,
        results: m.results,
        ctr: ctrPct(m.clicks, m.impressions),
        leads: f.leads,
        qualified: f.qualified,
        hot: f.hot,
        warm: f.warm,
        nurture: f.nurture,
        cold: f.cold,
        notRated: f.notRated,
        bookedLeads: f.bookedLeads,
        bookings: f.bookings,
        revenue: f.revenue,
        cpl: cplOf(m.spend, f.leads),
        conversionRate: pct1(f.bookedLeads, f.leads),
        roas: roasOf(f.revenue, m.spend),
        workMinutes: work.get(id)?.minutes ?? 0,
        workEntries: work.get(id)?.entries ?? 0,
      };
    });
};

const STATUS_ORDER = { active: 0, paused: 1, planned: 2, completed: 3 };

/** Active first, then paused / planned / completed; inside a status the biggest spend (then leads) first, then A–Z. */
export const sortCampaignRows = (rows) =>
  [...rows].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.spend - a.spend || b.leads - a.leads || (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));

/** How many campaigns (of the brand) are in each status — the KPI strip of All Campaigns and the chips of the Overview table. */
export const statusCounts = (campaigns, brand = 'all') => {
  const out = { total: 0, planned: 0, active: 0, paused: 0, completed: 0 };
  for (const c of campaigns) {
    if (!brandOk(c, brand)) continue;
    out.total += 1;
    out[statusOfCampaign(c)] += 1;
  }
  return out;
};

/** The All Campaigns table's search and filters (text in the title, Meta ID or objective; status; platform; objective). */
export const filterCampaignRows = (rows, { q = '', status = 'all', platform = 'all', objective = 'all' } = {}) => {
  const text = String(q).trim().toLowerCase();
  return rows.filter(
    (r) =>
      (status === 'all' || r.status === status) &&
      (platform === 'all' || r.platform === platform) &&
      (objective === 'all' || r.objective === objective) &&
      (!text || r.title.toLowerCase().includes(text) || r.metaCampaignId.toLowerCase().includes(text) || objectiveLabel(r.objective).toLowerCase().includes(text)),
  );
};

// ── Performance (objective-wise results) ──────────────────────────────────────────────────────────────────────────────────────

/** The objective-wise table: campaigns, spend, CRM leads, cost per lead and platform results per objective. */
export const objectiveRows = (rows) => {
  const by = new Map();
  for (const r of rows) {
    const k = r.objective || 'not_set';
    const o = by.get(k) ?? { key: k, label: k === 'not_set' ? 'Not set' : objectiveLabel(k), campaigns: 0, spend: 0, leads: 0, results: 0 };
    o.campaigns += 1;
    o.spend += r.spend;
    o.leads += r.leads;
    o.results += r.results;
    by.set(k, o);
  }
  return [...by.values()].map((o) => ({ ...o, spend: round2(o.spend), cpl: cplOf(o.spend, o.leads) })).sort((a, b) => b.spend - a.spend || (a.label < b.label ? -1 : 1));
};

// ── Budget & Spend ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Is the campaign part of this period's budget picture? It has spend in the range, or it is not Completed and its dates overlap the range
 * (start → end; the created day when no start; open-ended when no end).
 */
export const campaignInPeriod = (c, hasSpendInRange, { from, to }) => {
  if (hasSpendInRange) return true;
  if (statusOfCampaign(c) === 'completed') return false;
  const start = c.startDate ? istDay(c.startDate) : c.createdAt ? istDay(c.createdAt) : null;
  const end = c.endDate ? istDay(c.endDate) : null;
  if (start && start > to) return false;
  if (end && end < from) return false;
  return true;
};

/**
 * One row per campaign in the period: budget (0 = none set), spent to date (to the end of the range), spent to the end of the previous
 * range, remaining, utilisation %, the spend inside the range. `spentTo`: Map(campaignId → { toEnd, toPrevEnd }) — lifetime sums.
 */
export const budgetRows = ({ campaigns, metrics, spentTo = new Map(), range }) => {
  const cById = byId(campaigns);
  const inSpend = new Map();
  for (const m of metricRowsIn(metrics, cById, range)) inSpend.set(idOf(m.campaignId), (inSpend.get(idOf(m.campaignId)) ?? 0) + num(m.spend));
  return campaigns
    .filter((c) => brandOk(c, range.brand) && campaignInPeriod(c, (inSpend.get(idOf(c)) ?? 0) > 0, range))
    .map((c) => {
      const id = idOf(c);
      const budget = num(c.budget);
      const toEnd = round2(spentTo.get(id)?.toEnd ?? inSpend.get(id) ?? 0);
      const toPrev = round2(spentTo.get(id)?.toPrevEnd ?? 0);
      return {
        id,
        title: c.title,
        brand: brandOfCampaign(c),
        status: statusOfCampaign(c),
        hasBudget: budget > 0,
        budget,
        spentToDate: toEnd,
        spentToPrevEnd: toPrev,
        remaining: budget > 0 ? round2(Math.max(0, budget - toEnd)) : null,
        overBy: budget > 0 && toEnd > budget ? round2(toEnd - budget) : 0,
        utilisationPct: budget > 0 ? pct1(toEnd, budget) : null,
        spendInPeriod: round2(inSpend.get(id) ?? 0),
      };
    })
    .sort((a, b) => b.spendInPeriod - a.spendInPeriod || b.budget - a.budget || (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
};

/** The Budget & Spend KPI strip from the rows: only budgeted campaigns count toward budget / spent / remaining / utilisation. */
export const budgetSummary = (rows) => {
  const budgeted = rows.filter((r) => r.hasBudget);
  const totalBudget = round2(budgeted.reduce((s, r) => s + r.budget, 0));
  const spent = round2(budgeted.reduce((s, r) => s + r.spentToDate, 0));
  const spentBefore = round2(budgeted.reduce((s, r) => s + r.spentToPrevEnd, 0));
  const utilisation = pct1(spent, totalBudget);
  const before = pct1(spentBefore, totalBudget);
  return {
    budgetedCampaigns: budgeted.length,
    unbudgetedCampaigns: rows.length - budgeted.length,
    totalBudget,
    spentToDate: spent,
    remaining: round2(Math.max(0, totalBudget - spent)),
    overBy: spent > totalBudget ? round2(spent - totalBudget) : 0,
    utilisationPct: utilisation,
    remainingPct: totalBudget > 0 ? round1(Math.max(0, 100 - utilisation)) : null,
    utilisationChangePts: utilisation == null || before == null ? null : round1(utilisation - before),
    spendInPeriod: round2(rows.reduce((s, r) => s + r.spendInPeriod, 0)),
    unbudgetedSpendInPeriod: round2(rows.filter((r) => !r.hasBudget).reduce((s, r) => s + r.spendInPeriod, 0)),
  };
};

/** Daily spend bars: every day of the range (0 when nothing was spent), brand-filtered. */
export const spendByDay = ({ campaigns, metrics, from, to, brand = 'all' }) => {
  const cById = byId(campaigns);
  const by = new Map();
  for (const m of metricRowsIn(metrics, cById, { from, to, brand })) by.set(m.day, (by.get(m.day) ?? 0) + num(m.spend));
  return eachDay(from, to).map((day) => ({ day, spend: round2(by.get(day) ?? 0) }));
};

/** The spend donut: the biggest `top` campaigns, the rest as "Others"; shares to 1 decimal. */
export const spendSplit = (rows, top = 4) => {
  const spenders = rows.filter((r) => r.spendInPeriod > 0).sort((a, b) => b.spendInPeriod - a.spendInPeriod);
  const total = round2(spenders.reduce((s, r) => s + r.spendInPeriod, 0));
  const head = spenders.slice(0, top).map((r) => ({ id: r.id, label: r.title, spend: r.spendInPeriod }));
  const rest = round2(spenders.slice(top).reduce((s, r) => s + r.spendInPeriod, 0));
  const slices = rest > 0 ? [...head, { id: null, label: 'Others', spend: rest }] : head;
  return { total, slices: slices.map((s) => ({ ...s, pct: pct1(s.spend, total) ?? 0 })) };
};

// ── Creatives & Ads ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The average the ads are judged against: Σ clicks ÷ Σ impressions and Σ spend ÷ Σ results over all the brand's ads (null when undefined). */
export const adAverages = (ads) => {
  let impressions = 0;
  let clicks = 0;
  let spend = 0;
  let results = 0;
  for (const a of ads) {
    impressions += num(a.impressions);
    clicks += num(a.clicks);
    spend += num(a.spend);
    results += num(a.results);
  }
  return { impressions, clicks, spend: round2(spend), results, ctr: ctrPct(clicks, impressions), cpm: cpmOf(spend, impressions), costPerResult: results > 0 && spend > 0 ? round2(spend / results) : null };
};

/**
 * Where an ad stands against the average of the brand's ads:
 *  • Too early — fewer than 1,000 impressions AND less than ₹500 spent: not enough to judge.
 *  • CTR signal — good at ≥ 110% of the average CTR, poor below 70% of it.
 *  • Cost-per-result signal (only when some ad has results, i.e. results are being tracked) — good at ≤ 90% of the average cost per result,
 *    poor above 130% of it, and poor when ≥ ₹500 was spent for no result at all.
 *  • Needs attention — both signals poor, or ₹500+ spent with no result while others do get results.
 *  • Underperforming — exactly one signal poor and neither good.
 *  • Top performing — at least one signal good and none poor.   • Average — anything else.
 */
export const adVerdict = (ad, avg) => {
  const impressions = num(ad.impressions);
  const spend = num(ad.spend);
  const results = num(ad.results);
  if (impressions < MIN_IMPRESSIONS_FOR_VERDICT && spend < MIN_SPEND_FOR_VERDICT) return 'early';
  const ctr = ctrPct(ad.clicks, impressions);
  let ctrSignal = 'ok';
  if (ctr != null && avg.ctr != null) ctrSignal = ctr >= avg.ctr * 1.1 ? 'good' : ctr < avg.ctr * 0.7 ? 'poor' : 'ok';
  let costSignal = 'ok';
  const tracking = avg.costPerResult != null;
  if (tracking && results === 0 && spend >= MIN_SPEND_FOR_VERDICT) return 'needs_attention';
  if (tracking && results > 0 && spend > 0) {
    const cost = spend / results;
    costSignal = cost <= avg.costPerResult * 0.9 ? 'good' : cost > avg.costPerResult * 1.3 ? 'poor' : 'ok';
  }
  const signals = [ctrSignal, costSignal];
  const poor = signals.filter((s) => s === 'poor').length;
  const good = signals.filter((s) => s === 'good').length;
  if (poor === 2) return 'needs_attention';
  if (poor === 1 && good === 0) return 'under';
  if (good >= 1 && poor === 0) return 'top';
  return 'ok';
};

/** A creative name as the CRM's lead form and Ads Manager write it, for matching: lower case, letters and digits only. */
export const creativeKey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The CRM leads of each ad: a lead whose `creative` names the ad (its name or its Meta ad ID — creativeKey, so "Reel #17" and "reel 17"
 * match) and whose campaign, when it has one, is the ad's. A name shared by ads of two campaigns is ambiguous for a lead with no campaign,
 * and is not guessed. `leads` must already be cut to the range and brand. → Map(adId → leads)
 */
export const leadsByAd = (ads, leads) => {
  const byKey = new Map(); // key → [ads]
  for (const a of ads) {
    for (const k of new Set([creativeKey(a.name), creativeKey(a.metaAdId)].filter(Boolean))) byKey.set(k, [...(byKey.get(k) ?? []), a]);
  }
  const out = new Map();
  for (const l of leads) {
    const k = creativeKey(l.creative);
    if (!k) continue;
    let cands = byKey.get(k) ?? [];
    if (l.campaignId) cands = cands.filter((a) => idOf(a.campaignId) === idOf(l.campaignId));
    const ids = [...new Set(cands.map(idOf))];
    if (ids.length !== 1) continue;
    out.set(ids[0], (out.get(ids[0]) ?? 0) + 1);
  }
  return out;
};

/**
 * An ad's figures for the screen: an ad with daily records (imported from the ad-level export: `dailyFigures`) → the sum of its days in
 * [from, to]; an ad typed by hand → the lifetime figures typed on it. → { figures: 'range' | 'lifetime', impressions, reach, clicks, spend,
 * results, days }
 */
export const adFigures = (ad, days = [], range = null) => {
  if (!ad.dailyFigures || !range) return { figures: 'lifetime', impressions: num(ad.impressions), reach: 0, clicks: num(ad.clicks), spend: round2(num(ad.spend)), results: num(ad.results), days: 0 };
  const t = sumMetrics(days.filter((d) => inRange(d.day, range.from, range.to)));
  return { figures: 'range', impressions: t.impressions, reach: t.reach, clicks: t.clicks, spend: t.spend, results: t.results, days: t.days };
};

/**
 * One row per ad with its ratios, its CRM leads and its verdict. `campaignsById` names the campaign. Without `opts` (the Weekly Report's
 * call) every ad shows the cumulative figures stored on it. `opts`: { adDays: Map(adId → daily records), range, leads (CRM leads of the
 * range and brand) } — then an imported ad shows its days in the range, and an imported ad with no day in the range is left out (it did
 * not run then); an ad typed by hand always shows, with its lifetime figures.
 */
export const adRows = (ads, campaignsById, opts = null) => {
  const fig = new Map(ads.map((a) => [idOf(a), opts ? adFigures(a, opts.adDays?.get(idOf(a)) ?? [], opts.range) : adFigures(a)]));
  const shown = ads.filter((a) => !opts || fig.get(idOf(a)).figures === 'lifetime' || fig.get(idOf(a)).days > 0);
  const avg = adAverages(shown.map((a) => fig.get(idOf(a))));
  const crm = opts?.leads ? leadsByAd(shown, opts.leads) : null;
  return shown.map((a) => {
    const f = fig.get(idOf(a));
    const leads = crm ? crm.get(idOf(a)) ?? 0 : null;
    return {
      id: idOf(a),
      campaignId: idOf(a.campaignId),
      campaign: campaignsById.get(idOf(a.campaignId))?.title ?? '',
      name: a.name,
      adSetName: a.adSetName ?? '',
      metaAdId: a.metaAdId ?? '',
      format: a.format ?? 'image',
      status: a.status ?? 'active',
      metaStatus: metaStatusWord(a.metaStatus ?? ''), // Meta's own word ("Ad set paused", "Rejected by Meta"…); '' = not read from Meta
      creativeUrl: a.creativeUrl ?? '',
      thumbUrl: a.thumbUrl ?? '',
      thumbFromMeta: a.thumbSource === 'meta', // the picture is the ad's own on Meta (refreshed by every sync)
      figures: f.figures === 'range' ? 'range' : 'lifetime',
      impressions: f.impressions,
      reach: f.reach,
      clicks: f.clicks,
      spend: f.spend,
      results: f.results,
      ctr: ctrPct(f.clicks, f.impressions),
      cpm: cpmOf(f.spend, f.impressions),
      costPerResult: f.results > 0 && f.spend > 0 ? round2(f.spend / f.results) : null,
      leads,
      cpl: leads != null && f.figures === 'range' ? cplOf(f.spend, leads) : null,
      verdict: adVerdict(f, avg),
    };
  });
};

/** The chips of the Creatives & Ads table: how many ads in each group. */
export const adCounts = (rows) => ({
  all: rows.length,
  top: rows.filter((r) => r.verdict === 'top').length,
  under: rows.filter((r) => r.verdict === 'under').length,
  needs_attention: rows.filter((r) => r.verdict === 'needs_attention').length,
});

/** The best ads first (Overview's "Top Performing Creatives"): top performers, then most results, then best CTR; ads with no delivery are left out. */
export const topAds = (rows, n = 3) =>
  [...rows]
    .filter((r) => r.impressions > 0)
    .sort((a, b) => (b.verdict === 'top') - (a.verdict === 'top') || b.results - a.results || (b.ctr ?? -1) - (a.ctr ?? -1) || (a.name < b.name ? -1 : 1))
    .slice(0, n);

// ── Audiences & placements (breakdown exports) ───────────────────────────────────────────────────────────────────────────────

/** The breakdowns an Ads Manager export can carry, and how they are shown. */
export const AUDIENCE_FIELDS = [
  { key: 'age', label: 'Age' },
  { key: 'gender', label: 'Gender' },
  { key: 'placement', label: 'Placement' },
];

/** The dimension a breakdown row was exported with: the breakdown fields it carries, joined ('age', 'age+gender', 'placement'…). */
export const dimensionOf = (r) => AUDIENCE_FIELDS.map((f) => f.key).filter((k) => String(r?.[k] ?? '').trim()).join('+');

/**
 * The top segments of each breakdown for the range and brand: by age, gender and placement — spend, impressions, clicks, CTR, the
 * platform's results, cost per result and share of the spend, biggest spend first (at most `top`).
 * A file exported "by age" and another "by age and gender" both describe the same money, so a field is read from ONE dimension: the
 * dimension that is exactly that field when the range has it (e.g. 'age'), else the smallest one that contains it ('age+gender').
 * `rows`: CampaignBreakdownMetric-like { campaignId, day, dimension, age, gender, placement, spend, impressions, reach, clicks, results }.
 * → { hasData, age: { dimension, rows }, gender: {…}, placement: {…} }
 */
export const audienceSegments = ({ rows = [], campaigns = [], range, top = 8 }) => {
  const cById = byId(campaigns);
  const mine = rows.filter((r) => inRange(r.day, range.from, range.to) && cById.has(idOf(r.campaignId)) && brandOk(cById.get(idOf(r.campaignId)), range.brand));
  const out = { hasData: mine.length > 0 };
  for (const { key } of AUDIENCE_FIELDS) {
    const dims = [...new Set(mine.map((r) => r.dimension || dimensionOf(r)).filter((d) => d.split('+').includes(key)))];
    if (!dims.length) {
      out[key] = { dimension: '', rows: [] };
      continue;
    }
    const dim = dims.includes(key) ? key : dims.sort((a, b) => a.split('+').length - b.split('+').length || (a < b ? -1 : 1))[0];
    const by = new Map();
    for (const r of mine) {
      if ((r.dimension || dimensionOf(r)) !== dim) continue;
      const seg = String(r[key] ?? '').trim() || 'Unknown';
      const e = by.get(seg) ?? { segment: seg, spend: 0, impressions: 0, clicks: 0, results: 0 };
      e.spend += num(r.spend);
      e.impressions += num(r.impressions);
      e.clicks += num(r.clicks);
      e.results += num(r.results);
      by.set(seg, e);
    }
    const total = [...by.values()].reduce((t, e) => t + e.spend, 0);
    out[key] = {
      dimension: dim,
      rows: [...by.values()]
        .map((e) => ({ ...e, spend: round2(e.spend), ctr: ctrPct(e.clicks, e.impressions), costPerResult: e.results > 0 && e.spend > 0 ? round2(e.spend / e.results) : null, spendPct: pct1(e.spend, total) }))
        .sort((a, b) => b.spend - a.spend || b.results - a.results || (a.segment < b.segment ? -1 : 1))
        .slice(0, top),
    };
  }
  return out;
};

// ── Leads & Conversions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The funnel steps: Total Leads → Qualified → Booked, each with its share of the leads (every step is a subset of the one above). */
export const funnelSteps = (f) => [
  { key: 'leads', label: 'Total Leads', count: f.leads, pct: f.leads > 0 ? 100 : null },
  { key: 'qualified', label: 'Qualified', count: f.qualified, pct: pct1(f.qualified, f.leads) },
  { key: 'booked', label: 'Booked', count: f.bookedLeads, pct: pct1(f.bookedLeads, f.leads) },
];

/** The lead-quality split of the range: Hot / Warm / Nurture / Cold, and "Not rated" only when some lead has no priority. */
export const qualitySplit = (leads) => {
  const out = Object.fromEntries(QUALITIES.map((q) => [q, 0]));
  let unrated = 0;
  for (const l of leads) {
    const q = qualityOf(l);
    if (q === NOT_RATED) unrated += 1;
    else out[q] += 1;
  }
  return unrated > 0 ? { ...out, [NOT_RATED]: unrated } : out;
};

// ── report tables (the CSV of Reports & Insights) ─────────────────────────────────────────────────────────────────────────────

export const REPORT_TYPES = [
  { key: 'campaign', title: 'Campaign Report', description: 'Performance by campaign' },
  { key: 'creative', title: 'Creative Report', description: 'Ad and creative performance, with CRM leads per ad' },
  { key: 'lead', title: 'Lead Report', description: 'Leads, lead quality, bookings and cost per lead' },
  { key: 'conversion', title: 'Conversion Report', description: 'Bookings and revenue by campaign' },
  { key: 'spend', title: 'Spend Report', description: 'Budget against spend' },
  { key: 'audience', title: 'Audience Report', description: 'Spend and results by age, gender and placement' },
  { key: 'overview', title: 'Overview Report', description: 'The headline figures against the period before' },
  { key: 'performance', title: 'Performance Report', description: 'Day-by-day trend and results by objective' },
];

const cell = (v) => (v == null ? '' : v);

/**
 * One report as a table — { title, columns, rows } — the same numbers the screens show (each tab's Export downloads one of these).
 * `data`: { rows: campaignRows (all brand campaigns), budgets: budgetRows, ads: adRows, audiences: audienceSegments, kpis: kpiBlock,
 * types: leadsByType, trend: trendSeries }. Campaigns with nothing in the period are left out of the figures reports.
 */
export const reportTable = (type, { rows = [], budgets = [], ads = [], audiences = null, kpis = null, types = [], trend = [] } = {}) => {
  const meta = REPORT_TYPES.find((t) => t.key === type);
  if (!meta) return null;
  const active = sortCampaignRows(rows).filter((r) => r.spend > 0 || r.leads > 0 || r.impressions > 0 || r.results > 0);
  switch (type) {
    case 'campaign':
      return {
        title: meta.title,
        columns: ['Campaign', 'Brand', 'Platform', 'Objective', 'Status', 'Budget (INR)', 'Spend (INR)', 'Reach', 'Impressions', 'Clicks', 'CTR %', 'Platform results', 'CRM leads', 'Cost per lead (INR)'],
        rows: active.map((r) => [r.title, r.brand, platformLabel(r.platform), objectiveLabel(r.objective), statusLabel(r.status), r.budget > 0 ? r.budget : 'No budget set', r.spend, r.reach, r.impressions, r.clicks, cell(r.ctr), r.results, r.leads, cell(r.cpl)]),
      };
    case 'creative':
      return {
        title: meta.title,
        columns: ['Ad', 'Campaign', 'Ad set', 'Format', 'Status', 'Figures', 'Impressions', 'Clicks', 'CTR %', 'CPM (INR)', 'Spend (INR)', 'Platform results', 'Cost per result (INR)', 'CRM leads', 'Cost per CRM lead (INR)', 'Verdict'],
        rows: [...ads].sort((a, b) => b.spend - a.spend || (a.name < b.name ? -1 : 1)).map((a) => [a.name, a.campaign, a.adSetName, labelOf(AD_FORMATS, a.format, a.format), a.status, a.figures === 'range' ? 'In the period' : 'Lifetime (typed)', a.impressions, a.clicks, cell(a.ctr), cell(a.cpm), a.spend, a.results, cell(a.costPerResult), cell(a.leads), cell(a.cpl), adVerdictLabel(a.verdict)]),
      };
    case 'lead':
      return {
        title: meta.title,
        columns: ['Campaign', 'Leads', 'Hot', 'Warm', 'Nurture', 'Cold', 'Not rated', 'Qualified', 'Qualified %', 'Bookings', 'Conversion %', 'Booking value (INR, ex-GST)', 'Spend (INR)', 'Cost per lead (INR)'],
        rows: active.filter((r) => r.leads > 0 || r.spend > 0).map((r) => [r.title, r.leads, r.hot, r.warm, r.nurture, r.cold, r.notRated, r.qualified, cell(pct1(r.qualified, r.leads)), r.bookings, cell(r.conversionRate), r.revenue, r.spend, cell(r.cpl)]),
      };
    case 'conversion':
      return {
        title: meta.title,
        columns: ['Campaign', 'Leads', 'Qualified', 'Bookings', 'Conversion %', 'Booking value (INR, ex-GST)', 'Spend (INR)', 'Cost per booking (INR)', 'ROAS'],
        rows: active.filter((r) => r.leads > 0 || r.spend > 0).map((r) => [r.title, r.leads, r.qualified, r.bookings, cell(r.conversionRate), r.revenue, r.spend, cell(cplOf(r.spend, r.bookings)), cell(r.roas)]),
      };
    case 'audience': {
      const out = [];
      for (const f of AUDIENCE_FIELDS) for (const r of audiences?.[f.key]?.rows ?? []) out.push([f.label, r.segment, r.spend, r.impressions, r.clicks, cell(r.ctr), r.results, cell(r.costPerResult), cell(r.spendPct)]);
      return { title: meta.title, columns: ['Breakdown', 'Segment', 'Spend (INR)', 'Impressions', 'Clicks', 'CTR %', 'Platform results', 'Cost per result (INR)', 'Share of spend %'], rows: out };
    }
    case 'overview': {
      const k = kpis ?? { now: {}, before: {}, change: {} };
      const line = (label, key) => [label, cell(k.now[key]), cell(k.before[key]), cell(k.change[key])];
      return {
        title: meta.title,
        columns: ['Measure', 'This period', 'Period before', 'Change'],
        rows: [
          line('Spend (INR)', 'spend'),
          line('Reach (added up over the days)', 'reach'),
          line('Impressions', 'impressions'),
          line('Clicks', 'clicks'),
          line('CTR %', 'ctr'),
          line('CPM (INR)', 'cpm'),
          line('Platform results', 'results'),
          line('CRM leads', 'leads'),
          line('Qualified', 'qualified'),
          line('Bookings', 'bookings'),
          line('Booking value (INR, ex-GST)', 'revenue'),
          line('Cost per lead (INR)', 'cpl'),
          ['Conversion rate %', cell(k.now.conversionRate), cell(k.before.conversionRate), cell(k.change.conversionRate) === '' ? '' : `${k.change.conversionRate} pts`],
          line('ROAS', 'roas'),
          ...types.map((t) => [`Leads by campaign type: ${t.label}`, t.leads, '', '']),
        ],
      };
    }
    case 'performance':
      return {
        title: meta.title,
        columns: ['Part', 'Item', 'Campaigns', 'Spend (INR)', 'Reach', 'Impressions', 'Clicks', 'Platform results', 'CRM leads', 'Qualified', 'Bookings', 'Cost per lead (INR)'],
        rows: [
          ...trend.map((p) => [p.days > 1 ? 'Week from' : 'Day', p.day, '', p.spend, p.reach, p.impressions, p.clicks, p.results, p.leads, p.qualified, p.bookings, cell(p.cpl)]),
          ...objectiveRows(active).map((o) => ['Objective', o.label, o.campaigns, o.spend, '', '', '', o.results, o.leads, '', '', cell(o.cpl)]),
        ],
      };
    default:
      return {
        title: meta.title,
        columns: ['Campaign', 'Brand', 'Status', 'Budget (INR)', 'Spent to date (INR)', 'Remaining (INR)', 'Budget used %', 'Spend in period (INR)'],
        rows: budgets.map((b) => [b.title, b.brand, statusLabel(b.status), b.hasBudget ? b.budget : 'No budget set', b.spentToDate, b.hasBudget ? (b.overBy > 0 ? `Over by ${b.overBy}` : b.remaining) : '', cell(b.utilisationPct), b.spendInPeriod]),
      };
  }
};

// ── insights: plain-language lines the numbers support ───────────────────────────────────────────────────────────────────────────

const inr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pctWord = (p) => `${Math.abs(p)}%`;

/**
 * Lines the data supports — nothing is said that the numbers do not show. [{ kind: 'good' | 'warn' | 'info', text }], at most `max`.
 * `untaggedPaidLeads`: leads that came from Meta Ads but are not tagged to a campaign. `lastImport`: { day } of the last import, or null.
 */
export const insights = ({ now, before, rows = [], budgets = [], ads = [], untaggedPaidLeads = 0, lastImport = null, today, hasAnyMetric = true, max = 6 }) => {
  const out = [];
  if (!hasAnyMetric) {
    out.push({ kind: 'info', text: 'No ad spend has been imported yet. Import from Meta Ads Manager (or type a day\'s figures) to see spend, reach and cost per lead.' });
  } else if (now.spend === 0) {
    out.push({ kind: 'info', text: 'No ad spend is recorded for this period.' });
  }
  if (now.cpl != null && before.cpl != null) {
    const p = changePct(now.cpl, before.cpl);
    if (p != null && p !== 0) out.push({ kind: p < 0 ? 'good' : 'warn', text: `Cost per lead is ${inr(now.cpl)}, ${pctWord(p)} ${p < 0 ? 'lower' : 'higher'} than the period before (${inr(before.cpl)}).` });
  }
  const spendP = changePct(now.spend, before.spend);
  const leadsP = changePct(now.leads, before.leads);
  if (spendP != null && leadsP != null && spendP > 0 && leadsP < 0) out.push({ kind: 'warn', text: `Spend is up ${pctWord(spendP)} while leads are down ${pctWord(leadsP)}.` });
  const withLeads = rows.filter((r) => r.leads > 0);
  if (withLeads.length) {
    const top = [...withLeads].sort((a, b) => b.leads - a.leads || (a.title < b.title ? -1 : 1))[0];
    out.push({ kind: 'good', text: `${top.title} brought the most leads: ${top.leads} of ${now.leads} (${pct0(top.leads, now.leads)}%).` });
  }
  const withCpl = rows.filter((r) => r.cpl != null && r.leads >= 3);
  if (withCpl.length >= 2) {
    const best = [...withCpl].sort((a, b) => a.cpl - b.cpl || (a.title < b.title ? -1 : 1))[0];
    out.push({ kind: 'good', text: `${best.title} has the lowest cost per lead: ${inr(best.cpl)}.` });
  }
  for (const b of budgets) {
    if (!b.hasBudget) continue;
    if (b.overBy > 0) out.push({ kind: 'warn', text: `${b.title} is over its budget by ${inr(b.overBy)}.` });
    else if (b.utilisationPct != null && b.utilisationPct >= 90) out.push({ kind: 'warn', text: `${b.title} has used ${Math.round(b.utilisationPct)}% of its ${inr(b.budget)} budget.` });
  }
  const attention = ads.filter((a) => a.verdict === 'needs_attention').length;
  if (attention) out.push({ kind: 'warn', text: `${attention} ad${attention === 1 ? '' : 's'} need${attention === 1 ? 's' : ''} attention: money spent with no results, or well below the average.` });
  if (untaggedPaidLeads > 0) out.push({ kind: 'info', text: `${untaggedPaidLeads} lead${untaggedPaidLeads === 1 ? '' : 's'} from Meta Ads ${untaggedPaidLeads === 1 ? 'is' : 'are'} not tagged to a campaign, so ${untaggedPaidLeads === 1 ? 'its' : 'their'} cost cannot be counted.` });
  if (lastImport?.day && today) {
    const age = daysBetween(lastImport.day, today);
    if (age >= 7) out.push({ kind: 'info', text: `The last Meta import was ${age} days ago, so recent spend may be missing.` });
  }
  return out.slice(0, max);
};

/** Leads that came from Meta Ads (the lead's source) but carry no campaign, inside the range and brand (by the lead's own region). */
export const untaggedPaidLeads = (leads, { from, to, brand = 'all' }) =>
  leads.filter((l) => !l.campaignId && sourceKeyOf(l.source) === 'meta_ads' && inRange(leadDay(l), from, to) && (brand === 'all' || leadBrand(l) === brand)).length;

// ── exports the Weekly Report imports ─────────────────────────────────────────────────────────────────────────────────────────────
// Plain arrays in, plain numbers out. Load the inputs with loadPaidAdsInputs() (controllers/marketingCampaignHubController.js).

/** Ad spend for a range and brand, and for the same-length period before it: { spend, previousSpend, change }. */
export const adSpendForRange = ({ campaigns, metrics, from, to, brand = 'all' }) => {
  const cById = byId(campaigns);
  const prev = previousRange({ from, to });
  const spend = sumMetrics(metricRowsIn(metrics, cById, { from, to, brand })).spend;
  const previousSpend = sumMetrics(metricRowsIn(metrics, cById, { ...prev, brand })).spend;
  return { spend, previousSpend, change: changePct(spend, previousSpend) };
};

/**
 * Paid-ads totals of a range and brand with the period before: spend, reach, impressions, clicks, leads, bookings, revenue, CPL, ROAS,
 * conversion rate. Pass `gst` (loadPaidAdsInputs gives it) so revenue is ex-GST like everywhere else; without it nothing is backed out.
 */
export const paidAdsTotals = ({ campaigns, metrics, leads, bookings = [], countsTowardSales = () => true, gst = {}, from, to, brand = 'all' }) => {
  const outcomes = leadOutcomes({ leads, bookings, countsTowardSales, gst });
  return kpiBlock({ campaigns, metrics, leads, outcomes, range: { from, to, brand } });
};

/**
 * The campaigns table of a range: one row per campaign that had spend or leads in it — { id, title, brand, status, spend, leads, bookings,
 * revenue, cpl, roas }. Pass `gst` (loadPaidAdsInputs gives it) so revenue is ex-GST; without it nothing is backed out.
 */
export const campaignsTable = ({ campaigns, metrics, leads, bookings = [], countsTowardSales = () => true, gst = {}, from, to, brand = 'all' }) => {
  const outcomes = leadOutcomes({ leads, bookings, countsTowardSales, gst });
  return sortCampaignRows(campaignRows({ campaigns, metrics, leads, outcomes, range: { from, to, brand } }))
    .filter((r) => r.spend > 0 || r.leads > 0)
    .map((r) => ({ id: r.id, title: r.title, brand: r.brand, status: r.status, spend: r.spend, leads: r.leads, bookings: r.bookings, revenue: r.revenue, cpl: r.cpl, roas: r.roas }));
};

export { istDay, previousRange, changePct, eachDay, addDays };
