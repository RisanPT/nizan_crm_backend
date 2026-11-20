import { revenueOf } from './workProfit.js';
import { isQualified, sourceKeyOf } from './marketingLeadStages.js';

// The figures the Lead Report, the Campaigns hub and the Marketing Weekly Report SHARE — one definition each, so the three screens agree
// (the marketing document: "live data must reconcile across screens; build from one source"). Pure (tests/marketingOutcomes.test.js).
// utils/marketingLeadReportStats.js and utils/marketingCampaignStats.js both count with these; neither has a rule of its own for them.
//
//  • BOOKED LEAD — a lead is booked when it is LINKED TO A LIVE BOOKING: the booking in Lead.bookingId (the CRM sets it, together with the
//    status Converted, when a booking is made for the lead or for its phone number), else a booking whose Booking.leadId names the lead
//    (the oldest such). LIVE = not cancelled / canceled / rejected / lost / draft / pending — the dashboards' isSale list.
//    A lead is ONE booking however many bookings it has, and a booking belongs to ONE lead — the lead it names in Booking.leadId, else the
//    earliest-arriving lead that points at it — so nothing is counted twice.
//    BOOKINGS = booked leads. CONVERSION RATE = booked leads ÷ leads × 100, one decimal (null with no leads).
//    The CRM's stage "Converted" (the status) is still shown as a pipeline stage, but it is not the booking count: a Converted lead whose
//    booking was cancelled is not a booking.
//  • BOOKING VALUE — the linked booking's revenue: its price after discount with the GST backed out when prices include it
//    (utils/workProfit.js revenueOf().taxable — the Work Profit / Weekly Report figure). ORDER VALUE = after discount, GST included.
//    A booking entered by a user who does not count toward sales totals (User.countInSalesTotals) is still a booking, but adds no value:
//    it is UNVALUED.
//  • QUALIFIED — the CRM status is Qualified, Follow-up or Converted, OR the lead is booked (a booked lead is qualified by definition, so a
//    funnel never grows going down).
//  • SPEND and COST PER LEAD — spend is the sum of the daily ad records (CampaignDailyMetric) of the days INSIDE the range. Cost per lead =
//    that spend ÷ the CRM leads tagged to the same campaigns that arrived in the range; cost per booking = that spend ÷ their booked leads.
//    null ("—") when either side is 0 (₹0 would only mean "nothing imported"). The lifetime "ad spend" typed on the old Campaigns screen
//    (Campaign.adSpend) has no dates, so no Marketing figure uses it.
//  • BRAND — a lead tagged to a campaign belongs to the CAMPAIGN's brand (the ad account it came through); any other lead to the Instagram
//    page it came from, else its region / district (utils/marketingLeadStages.js leadBrand reads `campaignBrand`, set by withCampaignBrand).
//  • CAMPAIGN TYPE (Leads by Campaign Type) — see campaignTypeOf below.

/** The bookings that are not a sale (the dashboards' isSale — controllers/dashboardController.js). */
export const DEAD_BOOKING = ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending'];

export const isLiveBooking = (b) => !!b && !DEAD_BOOKING.includes(String(b.status ?? '').trim().toLowerCase());

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
const ms = (d) => (d ? new Date(d).getTime() : Number.POSITIVE_INFINITY);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The day a lead arrived, as a sortable time (leadDate, else created). */
const arrivedAt = (l) => ms(l.leadDate ?? l.createdAt);

/**
 * Each lead's linked LIVE booking — see BOOKED LEAD above. `leads`: Lead-like { _id, bookingId, leadDate, createdAt };
 * `bookings`: Booking-like { _id, leadId, status, createdAt, … } (any status; the dead ones are dropped here).
 * → Map(leadId → booking)
 */
export const linkBookings = (leads = [], bookings = []) => {
  const live = bookings.filter(isLiveBooking);
  const byId = new Map(live.map((b) => [idOf(b), b]));
  const byLead = new Map(); // leadId → its live bookings by Booking.leadId, oldest first
  for (const b of live) {
    const k = idOf(b.leadId);
    if (!k) continue;
    if (!byLead.has(k)) byLead.set(k, []);
    byLead.get(k).push(b);
  }
  for (const list of byLead.values()) list.sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || (idOf(a) < idOf(b) ? -1 : 1));
  const claimed = new Map(); // bookingId → the lead that has it
  const out = new Map();
  const ordered = [...leads].sort((a, b) => arrivedAt(a) - arrivedAt(b) || (idOf(a) < idOf(b) ? -1 : 1));
  for (const l of ordered) {
    const me = idOf(l);
    const own = l.bookingId ? byId.get(idOf(l.bookingId)) : null;
    for (const b of [...(own ? [own] : []), ...(byLead.get(me) ?? [])]) {
      const named = idOf(b.leadId);
      if (named && named !== me) continue; // the booking names another lead: it is that lead's
      const holder = claimed.get(idOf(b));
      if (holder && holder !== me) continue; // an earlier lead already has it
      claimed.set(idOf(b), me);
      out.set(me, b);
      break;
    }
  }
  return out;
};

/**
 * What the figures need about bookings, in one object (the Lead Report's and the Weekly Report's `ctx`):
 * { bookings: Map(bookingId → booking), linked: Map(leadId → live booking), gst, countsTowardSales }.
 */
export const outcomeContext = ({ leads = [], bookings = [], gst = {}, countsTowardSales = () => true } = {}) => ({
  bookings: new Map(bookings.map((b) => [idOf(b), b])),
  linked: linkBookings(leads, bookings),
  gst,
  countsTowardSales,
});

/**
 * The live booking a lead is linked to, or null. With a context that has no `linked` map (an older caller), the lead's own bookingId is
 * read from ctx.bookings.
 */
export const linkedBookingOf = (lead, ctx = {}) => {
  if (ctx.linked) return ctx.linked.get(idOf(lead)) ?? null;
  const b = lead?.bookingId ? ctx.bookings?.get(idOf(lead.bookingId)) : null;
  return isLiveBooking(b) ? b : null;
};

export const isBooked = (lead, ctx = {}) => !!linkedBookingOf(lead, ctx);

/** The linked booking when it counts toward value (its creator counts toward sales totals); null otherwise. */
export const valuedBookingOf = (lead, ctx = {}) => {
  const b = linkedBookingOf(lead, ctx);
  if (!b) return null;
  if (ctx.countsTowardSales && !ctx.countsTowardSales(b)) return null;
  return b;
};

/** { value, order } in rupees: after discount with GST backed out, and after discount with GST included. */
export const bookingMoney = (booking, gst = {}) => {
  const r = revenueOf(booking, gst);
  return { value: r.taxable, order: r.net };
};

/** Qualified: the status says so, or the lead is booked. */
export const isQualifiedLead = (lead, ctx = {}) => isQualified(lead?.status) || isBooked(lead, ctx);

/** The booking figures of a set of leads: { leads, qualified, booked, value, order, unvalued, rate }. */
export const outcomeFigures = (leads, ctx = {}) => {
  let qualified = 0;
  let booked = 0;
  let valued = 0;
  let value = 0;
  let order = 0;
  for (const l of leads) {
    const b = linkedBookingOf(l, ctx);
    if (isQualified(l.status) || b) qualified += 1;
    if (!b) continue;
    booked += 1;
    if (ctx.countsTowardSales && !ctx.countsTowardSales(b)) continue;
    const m = bookingMoney(b, ctx.gst);
    valued += 1;
    value += m.value;
    order += m.order;
  }
  return { leads: leads.length, qualified, booked, value: round2(value), order: round2(order), unvalued: booked - valued, rate: leads.length > 0 ? round1((booked / leads.length) * 100) : null };
};

// ── cost ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Cost per lead / per booking: null with nothing to divide by, or with no spend. */
export const costPer = (spend, count) => (num(count) > 0 && num(spend) > 0 ? round2(num(spend) / num(count)) : null);

/** Spend of each campaign over the daily records of [from, to]: Map(campaignId → spend). */
export const spendByCampaign = (metrics = [], { from, to }) => {
  const out = new Map();
  for (const m of metrics) {
    if (m.day < from || m.day > to) continue;
    const k = idOf(m.campaignId);
    out.set(k, round2((out.get(k) ?? 0) + num(m.spend)));
  }
  return out;
};

// ── brand ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The campaign's brand: Kerala or Main (campaigns made before the field existed are Main). */
export const brandOfCampaign = (c) => (c?.brand === 'kerala' ? 'kerala' : 'main');

/**
 * The leads with the brand of their campaign written on them (`campaignBrand`), so utils/marketingLeadStages.js leadBrand puts a campaign's
 * lead under the campaign's brand on every screen. A lead of a campaign that no longer exists keeps the lead's own rule. Returns new objects.
 */
export const withCampaignBrand = (leads = [], campaignsById = new Map()) =>
  leads.map((l) => {
    const c = l.campaignId ? campaignsById.get(idOf(l.campaignId)) : null;
    return c ? { ...l, campaignBrand: brandOfCampaign(c) } : l;
  });

// ── Leads by Campaign Type ─────────────────────────────────────────────────────────────────────────────────────────────

/** The campaign types the Campaigns Overview and the Lead Report show (the marketing document's lead gen / WhatsApp / form / calls / others). */
export const CAMPAIGN_TYPES = [
  { key: 'lead_gen', label: 'Lead gen (Meta form)' },
  { key: 'whatsapp', label: 'WhatsApp / messages' },
  { key: 'form', label: 'Website form' },
  { key: 'calls', label: 'Calls' },
  { key: 'others', label: 'Others' },
];
export const campaignTypeLabel = (key) => CAMPAIGN_TYPES.find((t) => t.key === key)?.label ?? 'Others';

const CALL_RX = /\b(call|calls|phone|telephone|missed call)\b/i;

/**
 * The type of a campaign lead, from the campaign's objective and the lead's own source:
 *  • the lead came on WhatsApp (its source) → WhatsApp; from the website → Website form; by phone ("call" in the source) → Calls;
 *  • otherwise the objective decides: Lead Generation → Lead gen (the ad's instant form); Messages → WhatsApp / messages;
 *    Traffic / Conversions → Website form; anything else (Engagement, Reach, Other, not set) → Others.
 * The source goes first because it says how the lead actually reached the team; the objective covers the leads the source does not explain
 * (most ad leads are typed as "Paid Ads Leads").
 */
export const campaignTypeOf = (lead, campaign) => {
  const src = sourceKeyOf(lead?.source);
  if (src === 'whatsapp' && String(lead?.source ?? '').trim()) return 'whatsapp';
  if (src === 'website') return 'form';
  if (CALL_RX.test(String(lead?.source ?? ''))) return 'calls';
  switch (campaign?.objective) {
    case 'lead_generation':
      return 'lead_gen';
    case 'messages':
      return 'whatsapp';
    case 'traffic':
    case 'conversions':
      return 'form';
    default:
      return 'others';
  }
};

/**
 * Leads by Campaign Type: the campaign-tagged leads given (already cut to the range and brand), by type — only the types that have leads,
 * biggest first. `campaignsById`: Map(id → campaign). Leads of a campaign that no longer exists are left out.
 * → [{ key, label, leads, pct }]
 */
export const leadsByCampaignType = (leads = [], campaignsById = new Map()) => {
  const mine = leads.filter((l) => l.campaignId && campaignsById.has(idOf(l.campaignId)));
  const counts = new Map();
  for (const l of mine) {
    const k = campaignTypeOf(l, campaignsById.get(idOf(l.campaignId)));
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const order = (k) => CAMPAIGN_TYPES.findIndex((t) => t.key === k);
  return [...counts.entries()]
    .map(([key, n]) => ({ key, label: campaignTypeLabel(key), leads: n, pct: mine.length ? Math.round((n / mine.length) * 100) : 0 }))
    .sort((a, b) => b.leads - a.leads || order(a.key) - order(b.key));
};
