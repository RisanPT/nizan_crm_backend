import { istDay, addDays, eachDay, previousRange, changePct, daysBetween } from './marketingTeamStats.js';
import { leadDay } from './marketingLeadStages.js';
import { leadsInRange, countedBooking, bookingMoney, isBooked } from './marketingLeadReportStats.js';
import { revenueOf } from './workProfit.js';

// What the Marketing Weekly Report counts — a ONE-PAGE roll-up that reads the SAME definitions as the screens it summarises. It adds
// no counting rule of its own for leads, bookings, revenue or conversion: those come from utils/marketingLeadReportStats.js (the Lead
// Report) so this page and that one can never disagree (the document's own sample figures did: "1,09,250 leads against 1,092").
// Pure — no database (tests/marketingWeeklyStats.test.js); controllers/marketingWeeklyController.js loads the records and calls these.
// All days are IST day strings 'YYYY-MM-DD'.
//
//  • HEADLINE: total leads, bookings (= booked leads, the Lead Report's rule), revenue (= booking value after discount, GST backed out), conversion rate —
//    all from the Lead Report's leadPeriod(); ad spend from the Campaigns module. Each with its change on the period before.
//  • DAY TREND: the range's days against the period before, day by day in the same order (Monday against Monday for a week). Leads =
//    leads that arrived that day; bookings and revenue = those leads' bookings (the Lead Report's isBooked / cohort rule), so the days
//    always add up to the cards.
//  • INDIVIDUAL INSIGHT: a member's KEY RESULT from their LOGS = the activity they logged the most of in the range (the sum of the counts
//    on their Log Activity entries — "Reels posted 27"), with its change on the period before. A member who logged no counts gets
//    their hours logged. A member with no logs at all is counted, not listed.
//  • PRODUCTION: shoots of the range by category — PLANNED = shoots dated in the range that are not cancelled; DONE = those marked
//    Completed. The three biggest categories are shown with the overall figure.
//  • REVENUE & COLLECTION, over the bookings the Revenue figure counts: ORDER VALUE = what customers pay (after discount, GST
//    included); ADVANCE = the advances that count (not pending / refused by Accounts — the rule invoices use); COLLECTED LATER = the
//    verified final collections on those bookings; BALANCE DUE = order value − advance − collected later (never below 0); ADVANCE
//    PROGRESS = advance ÷ order value; AVERAGE ORDER = order value ÷ bookings counted.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round1 = (n) => Math.round(n * 10) / 10;
const round2 = (n) => Math.round(n * 100) / 100;
const pct1 = (a, b) => (b > 0 ? round1((a / b) * 100) : null);
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

/** A figure with its previous value and the change in percent (null with nothing to compare against). */
export const figure = (now, before) => ({ now, before, change: changePct(num(now), num(before)) });

/** The five KPI cards. `period` = leadPeriod() of the Lead Report; `spend` = { now, before } ad spend, or null when none is recorded. */
export const headline = ({ period, spend = null }) => ({
  leads: figure(period.now.total, period.before.total),
  bookings: figure(period.now.bookings, period.before.bookings),
  revenue: figure(period.now.bookingValue, period.before.bookingValue),
  adSpend: spend ? figure(spend.now, spend.before) : null,
  conversionRate: { now: period.now.conversionRate, before: period.before.conversionRate, change: period.change.conversionRate, unit: 'pp' },
});

/** Day by day: this range against the one before it (same length), leads / bookings / revenue. */
export const dayTrend = (leads, range, ctx = {}) => {
  const prev = previousRange(range);
  const point = (day, brand) => {
    const list = leadsInRange(leads, { from: day, to: day, brand });
    let bookings = 0;
    let revenue = 0;
    for (const l of list) {
      if (!isBooked(l, ctx)) continue;
      bookings += 1;
      const b = countedBooking(l, ctx);
      if (b) revenue += bookingMoney(b, ctx.gst).value;
    }
    return { leads: list.length, bookings, revenue: round2(revenue) };
  };
  const days = eachDay(range.from, range.to);
  const before = eachDay(prev.from, prev.to);
  return days.map((day, i) => ({ day, weekday: new Date(`${day}T00:00:00Z`).getUTCDay(), now: point(day, range.brand), before: before[i] ? { day: before[i], ...point(before[i], range.brand) } : null }));
};

/**
 * Each member's key result from their logs. `activities` / `before` = MarketingActivity-like { memberId, timeSpentMinutes, values:[{metricId,value}] }
 * for the range and the period before; `members` = [{ id, name, role }]; `metricName(id)`.
 *  → { rows: [{ memberId, name, role, metric, value, unit, change }], silent } — rows biggest first; `silent` = members with no logs.
 */
export const memberInsights = ({ activities = [], before = [], members = [], metricName = () => '' }) => {
  const tally = (list) => {
    const by = new Map();
    for (const a of list) {
      const m = by.get(idOf(a.memberId)) ?? { minutes: 0, logs: 0, metrics: new Map() };
      m.logs += 1;
      m.minutes += num(a.timeSpentMinutes);
      for (const v of a.values ?? []) m.metrics.set(idOf(v.metricId), (m.metrics.get(idOf(v.metricId)) ?? 0) + num(v.value));
      by.set(idOf(a.memberId), m);
    }
    return by;
  };
  const now = tally(activities);
  const prev = tally(before);
  const rows = [];
  let silent = 0;
  for (const m of members) {
    const mine = now.get(m.id);
    if (!mine) {
      silent += 1;
      continue;
    }
    const before0 = prev.get(m.id);
    const top = [...mine.metrics.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || String(metricName(a[0])).localeCompare(String(metricName(b[0]))))[0];
    if (top) rows.push({ memberId: m.id, name: m.name, role: m.role, metric: metricName(top[0]), value: top[1], unit: 'count', change: changePct(top[1], before0?.metrics.get(top[0]) ?? 0) });
    else rows.push({ memberId: m.id, name: m.name, role: m.role, metric: null, value: round1(mine.minutes / 60), unit: 'hours', change: changePct(mine.minutes, before0?.minutes ?? 0) });
  }
  rows.sort((a, b) => (a.unit === b.unit ? b.value - a.value : a.unit === 'count' ? -1 : 1) || a.name.localeCompare(b.name));
  return { rows, silent };
};

/** Shoots done against planned: overall and for the [top] biggest categories. `shoots` = { shootDate, status, category, brand }. */
export const productionWeek = (shoots, { from, to, brand = 'all' }, top = 3) => {
  const list = shoots.filter((s) => s.status !== 'cancelled' && s.shootDate >= from && s.shootDate <= to && (brand === 'all' || (s.brand ?? 'main') === brand));
  const done = (l) => l.filter((s) => s.status === 'completed').length;
  const by = new Map();
  for (const s of list) {
    const k = String(s.category ?? '').trim() || 'Other shoots';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(s);
  }
  const categories = [...by.entries()].map(([category, l]) => ({ category, planned: l.length, done: done(l) })).sort((a, b) => b.planned - a.planned || a.category.localeCompare(b.category)).slice(0, top);
  return { planned: list.length, done: done(list), categories };
};

/** Order value, advance, later collections, balance and progress over the bookings counted in the range. */
export const revenueCollection = (leads, range, ctx = {}) => {
  let orders = 0;
  let advance = 0;
  let collected = 0;
  let balance = 0;
  let count = 0;
  for (const l of leadsInRange(leads, range)) {
    const b = countedBooking(l, ctx);
    if (!b) continue;
    const net = revenueOf(b, ctx.gst).net;
    const adv = ['pending', 'rejected'].includes(b.advanceStatus ?? '') ? 0 : num(b.advanceAmount);
    const col = num(b.collectedAmount);
    orders += net;
    advance += adv;
    collected += col;
    balance += Math.max(0, net - adv - col);
    count += 1;
  }
  return { bookings: count, orderValue: round2(orders), advance: round2(advance), collectedLater: round2(collected), balanceDue: round2(balance), averageOrder: count ? round2(orders / count) : null, advanceProgress: pct1(advance, orders) };
};

/** The newest events across the records, newest first. Each event { at: Date|string, kind, text }. */
export const recentActivities = (events, limit = 8) =>
  events
    .filter((e) => e && e.at && !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);

/**
 * The little trend lines behind the five KPI cards: one value per day of the range, taken from the day trend (so they add up to the card)
 * and from the Campaigns module's daily spend. Conversion per day = that day's bookings ÷ that day's leads, 0 on a day with no leads.
 * `spendDays` = [{ day, spend }] or null when no ad spend was ever recorded (no line, not a flat zero).
 */
export const sparklines = (trend, spendDays = null) => ({
  leads: trend.map((d) => d.now.leads),
  bookings: trend.map((d) => d.now.bookings),
  revenue: trend.map((d) => d.now.revenue),
  adSpend: spendDays ? spendDays.map((d) => d.spend) : null,
  conversionRate: trend.map((d) => (d.now.leads > 0 ? round1((d.now.bookings / d.now.leads) * 100) : 0)),
});

/** Plain-language findings, each only when the data supports it. */
export const keyInsights = ({ period, topSource = null, spend = null }) => {
  const out = [];
  const { now, change } = period;
  if (change.total !== null && now.total > 0) out.push(`Leads ${change.total >= 0 ? 'increased' : 'fell'} ${Math.abs(change.total)}% compared with the period before.`);
  if (topSource && topSource.pct !== null && topSource.count > 0) out.push(`${topSource.label} contributed ${topSource.pct}% of the leads.`);
  if (change.conversionRate !== null && now.conversionRate !== null) out.push(`Conversion rate ${change.conversionRate >= 0 ? 'improved' : 'fell'} to ${now.conversionRate}% (${change.conversionRate >= 0 ? '+' : '−'}${Math.abs(change.conversionRate)} pp).`);
  if (change.bookingValue !== null && period.before.bookingValue > 0) out.push(`Revenue is ${Math.abs(change.bookingValue)}% ${change.bookingValue >= 0 ? 'higher' : 'lower'} than the period before.`);
  if (spend && spend.now > 0 && now.bookings > 0) out.push(`Ad spend per booking was ₹${Math.round(spend.now / now.bookings).toLocaleString('en-IN')}.`);
  return out;
};

export { istDay, addDays, daysBetween, leadDay };
