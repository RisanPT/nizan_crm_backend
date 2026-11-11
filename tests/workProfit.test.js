import test from 'node:test';
import assert from 'node:assert/strict';
import { THIN_MARGIN_PCT, addCost, newCosts, profitRow, revenueOf, sortRows, summarize } from '../utils/workProfit.js';

const gst5 = { enabled: true, rate: 5, inclusive: true };
const p = (rupees) => Math.round(rupees * 100);
const booking = (over = {}) => ({ totalPrice: 10500, discountAmount: 500, advanceAmount: 3000, collectedAmount: 2000, ...over });

// ── revenue ──
test('revenue: value after discount, with the 5% GST backed out of a tax-inclusive price', () => {
  const r = revenueOf(booking(), gst5);
  assert.deepEqual(r, { gross: 10500, discount: 500, net: 10000, taxable: 9523.81, gst: 476.19, received: 5000, outstanding: 5000 });
});

test('the taxable value and the GST always add back to what the customer pays', () => {
  for (const net of [1, 99.99, 10000, 24500, 123456.78]) {
    const r = revenueOf({ totalPrice: net }, gst5);
    assert.equal(Math.round((r.taxable + r.gst) * 100), Math.round(net * 100), String(net));
  }
});

test('GST switched off: the whole price is revenue', () => {
  const r = revenueOf(booking(), { enabled: false, rate: 5, inclusive: true });
  assert.deepEqual([r.net, r.taxable, r.gst], [10000, 10000, 0]);
  assert.equal(revenueOf(booking(), { enabled: true, rate: 0, inclusive: true }).taxable, 10000);
  assert.equal(revenueOf(booking(), undefined).taxable, 10000, 'no setting at all: nothing is taken out');
});

test('GST charged ON TOP of the price: the price is the revenue, the tax is extra and not counted', () => {
  const r = revenueOf(booking(), { enabled: true, rate: 5, inclusive: false });
  assert.deepEqual([r.net, r.taxable, r.gst], [10000, 10000, 500]);
});

test('a discount bigger than the price leaves nothing, never a negative', () => {
  const r = revenueOf({ totalPrice: 1000, discountAmount: 5000 }, gst5);
  assert.deepEqual([r.net, r.taxable, r.outstanding], [0, 0, 0]);
});

test('what has been received, and what is outstanding (never negative)', () => {
  assert.equal(revenueOf(booking({ advanceAmount: 9000, collectedAmount: 2000 }), gst5).outstanding, 0);
  assert.equal(revenueOf(booking({ advanceAmount: 0, collectedAmount: 0 }), gst5).outstanding, 10000);
});

test('missing numbers are zero, never NaN', () => {
  const r = revenueOf({}, gst5);
  assert.deepEqual(Object.values(r), [0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(Object.values(revenueOf(null, gst5)), [0, 0, 0, 0, 0, 0, 0]);
});

// ── adding costs ──
test('costs add up by group and category, in paise', () => {
  const c = newCosts();
  addCost(c, 'artist', 'food', p(300));
  addCost(c, 'artist', 'food', p(120.5));
  addCost(c, 'artist', 'stay', p(1000), { pending: true });
  addCost(c, 'fleet', 'fuel', p(800));
  addCost(c, 'fleet', 'toll', p(100), { shared: true });
  addCost(c, 'freelance', 'payout', p(2000), { pending: true });
  assert.deepEqual(c.artist, { total: p(1420.5), pending: p(1000), byCategory: { food: p(420.5), stay: p(1000) } });
  assert.deepEqual(c.fleet, { total: p(900), pending: 0, shared: p(100), byCategory: { fuel: p(800), toll: p(100) } });
  assert.deepEqual(c.freelance, { total: p(2000), pending: p(2000), byCategory: { payout: p(2000) } });
});

test('a category we do not list counts as "other"; a freelance cost is always a payout', () => {
  const c = newCosts();
  addCost(c, 'artist', 'parking', 500);
  addCost(c, 'fleet', 'stay', 700);
  addCost(c, 'freelance', 'anything', 900);
  assert.deepEqual([c.artist.byCategory, c.fleet.byCategory, c.freelance.byCategory], [{ other: 500 }, { other: 700 }, { payout: 900 }]);
});

test('an unknown group is a bug, not a silent zero', () => {
  assert.throws(() => addCost(newCosts(), 'salary', 'x', 1), /unknown cost group/);
});

// ── one work ──
const costed = () => {
  const c = newCosts();
  addCost(c, 'artist', 'food', p(1500));
  addCost(c, 'fleet', 'fuel', p(800));
  addCost(c, 'freelance', 'payout', p(2000));
  return c;
};

test('a profitable work: revenue (ex GST) − artist − fleet − freelance, and the margin', () => {
  const r = profitRow({ booking: booking(), gst: gst5, costs: costed() });
  assert.equal(r.revenue.taxable, 9523.81);
  assert.deepEqual([r.costs.artist.total, r.costs.fleet.total, r.costs.freelance.total, r.costs.total], [1500, 800, 2000, 4300]);
  assert.equal(r.profit, 5223.81);
  assert.equal(r.marginPct, 54.9);
  assert.deepEqual(r.flags, []);
});

test('the cost groups report their categories and the part still unverified', () => {
  const c = costed();
  addCost(c, 'artist', 'stay', p(500), { pending: true });
  const r = profitRow({ booking: booking(), gst: gst5, costs: c });
  assert.deepEqual(r.costs.artist.byCategory, { food: 1500, stay: 500 });
  assert.deepEqual([r.costs.artist.pending, r.costs.pending], [500, 500]);
  assert.deepEqual(r.flags, ['pending_costs']);
});

test('costs above the revenue: a LOSS, flagged', () => {
  const c = newCosts();
  addCost(c, 'freelance', 'payout', p(12000));
  const r = profitRow({ booking: booking(), gst: gst5, costs: c });
  assert.equal(r.profit, -2476.19);
  assert.equal(r.marginPct, -26);
  assert.deepEqual(r.flags, ['loss']);
});

test('a margin under the threshold is THIN; at the threshold it is not', () => {
  assert.equal(THIN_MARGIN_PCT, 20);
  const thin = newCosts();
  addCost(thin, 'artist', 'food', p(8000)); // 9523.81 − 8000 = 1523.81 → 16%
  const r = profitRow({ booking: booking(), gst: gst5, costs: thin });
  assert.deepEqual([r.marginPct, r.flags], [16, ['thin']]);
  const exact = newCosts();
  addCost(exact, 'artist', 'food', p(1000));
  const ok = profitRow({ booking: { totalPrice: 1250 }, gst: { enabled: false }, costs: exact });
  assert.deepEqual([ok.marginPct, ok.flags], [20, []], 'exactly 20% is fine');
});

test('a work with no costs recorded is flagged (profit may be overstated), not called a loss', () => {
  const r = profitRow({ booking: booking(), gst: gst5 });
  assert.equal(r.profit, 9523.81);
  assert.deepEqual(r.flags, ['no_costs']);
});

test('no revenue: no margin; costs make it a loss', () => {
  const c = newCosts();
  addCost(c, 'fleet', 'fuel', p(300));
  const r = profitRow({ booking: { totalPrice: 0 }, gst: gst5, costs: c });
  assert.deepEqual([r.marginPct, r.profit, r.flags], [null, -300, ['loss']]);
  assert.deepEqual(profitRow({ booking: { totalPrice: 0 }, gst: gst5 }).flags, ['no_costs']);
});

// ── a period ──
test('the period adds every work up, counts the flags, and keeps costs that belong to no work apart', () => {
  const a = profitRow({ booking: booking(), gst: gst5, costs: costed() });
  const loss = newCosts();
  addCost(loss, 'freelance', 'payout', p(12000), { pending: true });
  const b = profitRow({ booking: booking(), gst: gst5, costs: loss });
  const none = profitRow({ booking: booking(), gst: gst5 });
  const s = summarize([a, b, none], { artist: 250, fleet: 100 });
  assert.deepEqual(s.revenue, { net: 30000, taxable: 28571.43, gst: 1428.57, received: 15000 });
  assert.deepEqual(s.costs, { artist: 1500, fleet: 800, freelance: 14000, total: 16300, pending: 12000 });
  assert.equal(s.profit, 12271.43);
  assert.equal(s.marginPct, 43, '12271.43 of 28571.43 = 42.95%');
  assert.deepEqual(s.unallocated, { artist: 250, fleet: 100, total: 350 });
  assert.equal(s.profitAfterUnallocated, 11921.43);
  assert.deepEqual(s.count, { works: 3, loss: 1, thin: 0, noCosts: 1, pendingCosts: 1 });
});

test('an empty period is all zeros, with no margin', () => {
  const s = summarize([]);
  assert.deepEqual([s.profit, s.marginPct, s.count.works, s.unallocated.total, s.profitAfterUnallocated], [0, null, 0, 0, 0]);
});

// ── sorting ──
test('the orders asked for, ties broken the same way every time', () => {
  const row = (id, date, profit, marginPct) => ({ bookingId: id, serviceStart: date, profit, marginPct });
  const rows = [row('b', '2026-10-02', 500, 10), row('a', '2026-10-03', -200, -5), row('c', '2026-10-01', 900, null), row('d', '2026-10-03', 100, 50)];
  const ids = (sort) => sortRows(rows, sort).map((r) => r.bookingId);
  assert.deepEqual(ids('date_desc'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(ids('date_asc'), ['c', 'b', 'a', 'd']);
  assert.deepEqual(ids('profit_asc'), ['a', 'd', 'b', 'c']);
  assert.deepEqual(ids('profit_desc'), ['c', 'b', 'd', 'a']);
  assert.deepEqual(ids('margin_asc'), ['a', 'b', 'd', 'c'], 'no margin sorts last');
  assert.deepEqual(ids('margin_desc'), ['d', 'b', 'a', 'c'], 'no margin sorts last');
  assert.deepEqual(ids('nonsense'), ids('date_desc'));
  assert.deepEqual(rows.map((r) => r.bookingId), ['b', 'a', 'c', 'd'], 'the input is not reordered');
});
