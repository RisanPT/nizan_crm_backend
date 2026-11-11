// WORK PROFIT: what one work earned and what it cost to deliver.
//
//   revenue   the booking's value after discount (the same "net value" the dashboards use), with the
//             GST backed out when prices include it — GST is collected for the government, not earned.
//   costs     only what can be tied to the work:
//               • ARTIST    the artists' own expenses (food, travel, stay, materials, fuel, other) placed on
//                           the work by utils/mealAllocation.js
//               • FLEET     the drivers' expenses (fuel, toll, parking, food, service, other), tied to the work
//                           or shared equally over the driver's works that day (utils/expenseAllocation.js)
//               • FREELANCE what a freelance artist is paid for the job (ArtistPayout)
//             Rejected bills / cancelled payouts are not costs. Pending ones ARE counted — they are real
//             money — and reported separately so nobody mistakes them for verified.
//   profit    revenue − those costs. It leaves out salaries, rent, marketing and other overheads: it says
//             whether the WORK paid for itself, not whether the business made money.
//
// Pure — no database. Money is added in paise so the parts always add back to the whole.
// tests/workProfit.test.js.

import { toPaise, toRupees } from './expenseAllocation.js';

/// A work whose margin is below this is "thin" (percent of its revenue).
export const THIN_MARGIN_PCT = 20;

export const ARTIST_CATEGORIES = ['food', 'travel', 'stay', 'materials', 'fuel', 'other'];
export const FLEET_CATEGORIES = ['fuel', 'toll', 'parking', 'food', 'service', 'other'];

const GROUPS = ['artist', 'fleet', 'freelance'];

/// An empty running total of costs (paise) for one work.
export const newCosts = () => ({
  artist: { total: 0, pending: 0, byCategory: {} },
  fleet: { total: 0, pending: 0, shared: 0, byCategory: {} },
  freelance: { total: 0, pending: 0, byCategory: {} },
});

/**
 * Adds one cost line to a work's running total.
 * @param {object}  costs     from newCosts()
 * @param {string}  group     artist | fleet | freelance
 * @param {string}  category  food, toll, … (anything not listed for the group counts as 'other')
 * @param {number}  paise     the part of the cost that belongs to this work
 * @param {object}  [opts]    { pending: true } if not yet verified; { shared: true } if it was a share of a whole-day cost
 */
export const addCost = (costs, group, category, paise, { pending = false, shared = false } = {}) => {
  if (!GROUPS.includes(group)) throw new Error(`unknown cost group: ${group}`);
  const allowed = group === 'artist' ? ARTIST_CATEGORIES : group === 'fleet' ? FLEET_CATEGORIES : ['payout'];
  const cat = allowed.includes(category) ? category : group === 'freelance' ? 'payout' : 'other';
  const g = costs[group];
  g.total += paise;
  g.byCategory[cat] = (g.byCategory[cat] || 0) + paise;
  if (pending) g.pending += paise;
  if (shared && g.shared !== undefined) g.shared += paise;
};

/**
 * The booking's revenue figures, in rupees.
 * @param {object} booking  { totalPrice, discountAmount, advanceAmount, collectedAmount }
 * @param {object} gst      { enabled, rate, inclusive } — as the ledger reads it (services/posting.js)
 * @returns {{ gross, discount, net, taxable, gst, received, outstanding }}
 *   net      value after discount (what the customer pays)
 *   taxable  net with the GST taken out when prices include it — the revenue profit is measured on
 */
export const revenueOf = (booking, gst = {}) => {
  const gross = toPaise(booking?.totalPrice);
  const discount = Math.min(gross, toPaise(booking?.discountAmount));
  const net = gross - discount;
  const rate = Number(gst?.rate) || 0;
  const taxed = gst?.enabled !== false && rate > 0;
  const inclusive = gst?.inclusive !== false;
  const taxable = taxed && inclusive ? Math.round(net / (1 + rate / 100)) : net;
  const tax = !taxed ? 0 : inclusive ? net - taxable : Math.round((net * rate) / 100);
  const received = toPaise(booking?.advanceAmount) + toPaise(booking?.collectedAmount);
  return {
    gross: toRupees(gross),
    discount: toRupees(discount),
    net: toRupees(net),
    taxable: toRupees(taxable),
    gst: toRupees(tax),
    received: toRupees(received),
    outstanding: toRupees(Math.max(0, net - received)),
  };
};

const groupOut = (g) => ({
  total: toRupees(g.total),
  pending: toRupees(g.pending),
  byCategory: Object.fromEntries(Object.entries(g.byCategory).map(([k, v]) => [k, toRupees(v)])),
  ...(g.shared !== undefined ? { shared: toRupees(g.shared) } : {}),
});

/**
 * One work's profit.
 * @param {object} o  { booking (plain), gst, costs (from newCosts()) }
 * @returns {{ revenue, costs: { artist, fleet, freelance, total, pending }, profit, marginPct, flags: string[] }}
 *   marginPct  profit as a percent of revenue (1 decimal); null when the work earned nothing
 *   flags      loss | thin | no_costs | pending_costs
 */
export const profitRow = ({ booking, gst, costs = newCosts() }) => {
  const revenue = revenueOf(booking, gst);
  const total = costs.artist.total + costs.fleet.total + costs.freelance.total;
  const pending = costs.artist.pending + costs.fleet.pending + costs.freelance.pending;
  const profitPaise = toPaise(revenue.taxable) - total;
  const marginPct = toPaise(revenue.taxable) > 0 ? Math.round((profitPaise / toPaise(revenue.taxable)) * 1000) / 10 : null;

  const flags = [];
  if (profitPaise < 0) flags.push('loss');
  else if (marginPct !== null && marginPct < THIN_MARGIN_PCT) flags.push('thin');
  if (total === 0) flags.push('no_costs');
  if (pending > 0) flags.push('pending_costs');

  return {
    revenue,
    costs: {
      artist: groupOut(costs.artist),
      fleet: groupOut(costs.fleet),
      freelance: groupOut(costs.freelance),
      total: toRupees(total),
      pending: toRupees(pending),
    },
    profit: toRupees(profitPaise),
    marginPct,
    flags,
  };
};

/**
 * The period's totals over every work, plus the costs that belong to no work.
 * @param {Array}  rows         profitRow results
 * @param {object} unallocated  { artist, fleet } rupees spent in the period that could not be put on a work
 */
export const summarize = (rows, unallocated = {}) => {
  let taxable = 0, net = 0, gst = 0, received = 0, artist = 0, fleet = 0, freelance = 0, pending = 0;
  const count = { works: rows.length, loss: 0, thin: 0, noCosts: 0, pendingCosts: 0 };
  for (const r of rows) {
    taxable += toPaise(r.revenue.taxable);
    net += toPaise(r.revenue.net);
    gst += toPaise(r.revenue.gst);
    received += toPaise(r.revenue.received);
    artist += toPaise(r.costs.artist.total);
    fleet += toPaise(r.costs.fleet.total);
    freelance += toPaise(r.costs.freelance.total);
    pending += toPaise(r.costs.pending);
    if (r.flags.includes('loss')) count.loss += 1;
    if (r.flags.includes('thin')) count.thin += 1;
    if (r.flags.includes('no_costs')) count.noCosts += 1;
    if (r.flags.includes('pending_costs')) count.pendingCosts += 1;
  }
  const costs = artist + fleet + freelance;
  const profit = taxable - costs;
  const loose = toPaise(unallocated.artist) + toPaise(unallocated.fleet);
  return {
    revenue: { net: toRupees(net), taxable: toRupees(taxable), gst: toRupees(gst), received: toRupees(received) },
    costs: { artist: toRupees(artist), fleet: toRupees(fleet), freelance: toRupees(freelance), total: toRupees(costs), pending: toRupees(pending) },
    profit: toRupees(profit),
    marginPct: taxable > 0 ? Math.round((profit / taxable) * 1000) / 10 : null,
    unallocated: { artist: toRupees(toPaise(unallocated.artist)), fleet: toRupees(toPaise(unallocated.fleet)), total: toRupees(loose) },
    profitAfterUnallocated: toRupees(profit - loose),
    count,
  };
};

export const SORTS = ['date_desc', 'date_asc', 'profit_asc', 'profit_desc', 'margin_asc', 'margin_desc'];

/// [rows] in the order asked (a copy). Works with no margin (no revenue) sort last for the margin orders.
export const sortRows = (rows, sort = 'date_desc') => {
  const date = (r) => new Date(r.serviceStart ?? 0).getTime();
  const tie = (a, b) => String(a.bookingId).localeCompare(String(b.bookingId));
  const cmp = {
    date_desc: (a, b) => date(b) - date(a) || tie(a, b),
    date_asc: (a, b) => date(a) - date(b) || tie(a, b),
    profit_asc: (a, b) => a.profit - b.profit || tie(a, b),
    profit_desc: (a, b) => b.profit - a.profit || tie(a, b),
    margin_asc: (a, b) => (a.marginPct ?? Infinity) - (b.marginPct ?? Infinity) || tie(a, b),
    margin_desc: (a, b) => (b.marginPct ?? -Infinity) - (a.marginPct ?? -Infinity) || tie(a, b),
  }[SORTS.includes(sort) ? sort : 'date_desc'];
  return [...rows].sort(cmp);
};
