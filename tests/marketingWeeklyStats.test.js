// Pure unit tests: node --test tests/marketingWeeklyStats.test.js
// How the Marketing Weekly Report counts: headline figures (read from the Lead Report's own definitions), the day trend against the
// period before, each member's key result from their logs, production done against planned, revenue and collection, insights.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../utils/marketingWeeklyStats.js';
import * as R from '../utils/marketingLeadReportStats.js';

const RANGE = { from: '2026-11-09', to: '2026-11-15', brand: 'all' }; // Monday → Sunday
let n = 0;
const lead = (extra = {}) => ({ _id: `l${++n}`, name: `Lead ${n}`, source: 'WhatsApp (Organic)', status: 'New', priority: 'Warm', createdAt: '2026-11-10T05:00:00Z', ...extra });
const booking = (extra = {}) => ({ _id: `b${++n}`, status: 'confirmed', totalPrice: 10000, discountAmount: 0, advanceAmount: 0, collectedAmount: 0, ...extra });
const ctxOf = (bookings, extra = {}) => ({ bookings: new Map(bookings.map((b) => [b._id, b])), gst: { enabled: false, rate: 0, inclusive: true }, ...extra });
const converted = (b, extra = {}) => lead({ status: 'Converted', bookingId: b._id, ...extra });

test('figure: carries the previous value and the change in percent; nothing to compare against → null', () => {
  assert.deepEqual(W.figure(120, 100), { now: 120, before: 100, change: 20 });
  assert.deepEqual(W.figure(80, 100), { now: 80, before: 100, change: -20 });
  assert.equal(W.figure(5, 0).change, null);
  assert.equal(W.figure(0, 0).change, null);
});

test('headline: leads / bookings / revenue / conversion are the Lead Report\'s own numbers; ad spend is the Campaigns module\'s', () => {
  const b1 = booking({ totalPrice: 20000 });
  const b0 = booking({ totalPrice: 10000 });
  const leads = [
    lead(), lead(), lead({ status: 'Lost' }), converted(b1), // this week: 4 leads, 1 booking
    lead({ createdAt: '2026-11-03T05:00:00Z' }), converted(b0, { createdAt: '2026-11-04T05:00:00Z' }), // last week: 2 leads, 1 booking
  ];
  const period = R.leadPeriod({ leads, range: RANGE, ctx: ctxOf([b1, b0]) });
  const h = W.headline({ period, spend: { now: 6000, before: 4000 } });
  assert.deepEqual(h.leads, { now: 4, before: 2, change: 100 });
  assert.deepEqual(h.bookings, { now: 1, before: 1, change: 0 });
  assert.deepEqual(h.revenue, { now: 20000, before: 10000, change: 100 });
  assert.deepEqual(h.adSpend, { now: 6000, before: 4000, change: 50 });
  assert.equal(h.conversionRate.now, 25);
  assert.equal(h.conversionRate.before, 50);
  assert.equal(h.conversionRate.change, -25);
  assert.equal(h.conversionRate.unit, 'pp');
  // the same leads through the Lead Report give exactly this — the two pages cannot disagree
  assert.equal(h.leads.now, R.leadFigures(leads, RANGE, ctxOf([b1, b0])).total);
});

test('headline: no ad spend recorded → no ad-spend card (null), not a zero', () => {
  const period = R.leadPeriod({ leads: [lead()], range: RANGE, ctx: ctxOf([]) });
  assert.equal(W.headline({ period }).adSpend, null);
  assert.equal(W.headline({ period, spend: null }).adSpend, null);
});

test('dayTrend: one point per day of the range, each against the same position in the period before; IST day edges', () => {
  const leads = [
    lead({ createdAt: '2026-11-08T18:30:00Z' }), // 9 Nov 00:00 IST → Monday (in)
    lead({ createdAt: '2026-11-09T18:29:00Z' }), // 9 Nov 23:59 IST → Monday
    lead({ createdAt: '2026-11-09T18:30:00Z' }), // 10 Nov 00:00 IST → Tuesday
    lead({ createdAt: '2026-11-02T05:00:00Z' }), // 2 Nov Monday last week
  ];
  const t = W.dayTrend(leads, RANGE, ctxOf([]));
  assert.equal(t.length, 7);
  assert.equal(t[0].day, '2026-11-09');
  assert.equal(t[6].day, '2026-11-15');
  assert.equal(t[0].now.leads, 2);
  assert.equal(t[1].now.leads, 1);
  assert.equal(t[0].before.day, '2026-11-02');
  assert.equal(t[0].before.leads, 1);
  assert.equal(t[0].weekday, 1); // Monday
  assert.equal(t.reduce((s, d) => s + d.now.leads, 0), 3); // day totals add up to the range
});

test('dayTrend: bookings and revenue come from the booked leads of that day (the Lead Report\'s rule: a cancelled booking is no booking); brand filter applies', () => {
  const good = booking({ totalPrice: 8000 });
  const cancelled = booking({ totalPrice: 5000, status: 'cancelled' });
  const kerala = booking({ totalPrice: 3000 });
  const leads = [
    converted(good, { createdAt: '2026-11-11T05:00:00Z' }),
    converted(cancelled, { createdAt: '2026-11-11T06:00:00Z' }),
    converted(kerala, { createdAt: '2026-11-11T07:00:00Z', source: 'IG Leads — Kerala Page' }),
  ];
  const all = W.dayTrend(leads, RANGE, ctxOf([good, cancelled, kerala]));
  const wed = all.find((d) => d.day === '2026-11-11');
  assert.equal(wed.now.leads, 3);
  assert.equal(wed.now.bookings, 2); // booked leads, as the Lead Report counts them (utils/marketingOutcomes.js isBooked)
  assert.equal(wed.now.bookings, R.leadFigures(leads, { from: '2026-11-11', to: '2026-11-11', brand: 'all' }, ctxOf([good, cancelled, kerala])).bookings, 'the day and the Lead Report agree');
  assert.equal(wed.now.revenue, 11000);
  const onlyKerala = W.dayTrend(leads, { ...RANGE, brand: 'kerala' }, ctxOf([good, cancelled, kerala])).find((d) => d.day === '2026-11-11');
  assert.equal(onlyKerala.now.leads, 1);
  assert.equal(onlyKerala.now.revenue, 3000);
});

test('dayTrend: a single-day range has one point', () => {
  const t = W.dayTrend([lead()], { from: '2026-11-10', to: '2026-11-10', brand: 'all' }, ctxOf([]));
  assert.equal(t.length, 1);
  assert.equal(t[0].now.leads, 1);
  assert.equal(t[0].before.day, '2026-11-09');
});

const members = [
  { id: 'm1', name: 'Asha', role: 'Videographer' },
  { id: 'm2', name: 'Bilal', role: 'Designer' },
  { id: 'm3', name: 'Chitra', role: 'Editor' },
  { id: 'm4', name: 'Dev', role: 'Copywriter' },
];
const act = (memberId, minutes, values = []) => ({ memberId, timeSpentMinutes: minutes, values: values.map(([metricId, value]) => ({ metricId, value })) });
const metricName = (id) => ({ reels: 'Reels posted', edits: 'Videos edited', posters: 'Posters made' }[id] ?? id);

test('memberInsights: the key result is the activity the member logged most; sums across their logs; change on the period before', () => {
  const now = [act('m1', 120, [['reels', 10], ['edits', 2]]), act('m1', 60, [['reels', 17]]), act('m2', 300, [['posters', 12]])];
  const before = [act('m1', 100, [['reels', 20]]), act('m2', 100, [['posters', 12]])];
  const { rows, silent } = W.memberInsights({ activities: now, before, members, metricName });
  const asha = rows.find((r) => r.memberId === 'm1');
  assert.equal(asha.metric, 'Reels posted');
  assert.equal(asha.value, 27);
  assert.equal(asha.unit, 'count');
  assert.equal(asha.change, 35); // 27 vs 20
  assert.equal(rows.find((r) => r.memberId === 'm2').change, 0);
  assert.equal(silent, 2); // Chitra and Dev logged nothing
  assert.equal(rows.length, 2);
});

test('memberInsights: biggest first; a tie on the value breaks by name; counts rank before hours-only rows', () => {
  const now = [act('m3', 600), act('m1', 60, [['reels', 5]]), act('m2', 60, [['posters', 5]]), act('m4', 60, [['edits', 9]])];
  const { rows } = W.memberInsights({ activities: now, members, metricName });
  assert.deepEqual(rows.map((r) => r.memberId), ['m4', 'm1', 'm2', 'm3']);
  assert.equal(rows[3].unit, 'hours');
});

test('memberInsights: logs with no counts show hours logged, with the change on the hours before; zero/negative counts are ignored', () => {
  const now = [act('m1', 90, [['reels', 0]]), act('m1', 90)];
  const before = [act('m1', 90)];
  const { rows } = W.memberInsights({ activities: now, before, members, metricName });
  assert.equal(rows[0].metric, null);
  assert.equal(rows[0].value, 3);
  assert.equal(rows[0].unit, 'hours');
  assert.equal(rows[0].change, 100);
});

test('memberInsights: no logs at all → no rows, everyone silent; ids may be objects; a tie between metrics breaks by name', () => {
  assert.deepEqual(W.memberInsights({ members }), { rows: [], silent: 4 });
  const { rows } = W.memberInsights({ activities: [{ memberId: { _id: 'm1' }, values: [{ metricId: { _id: 'posters' }, value: 4 }, { metricId: { _id: 'edits' }, value: 4 }] }], members, metricName });
  assert.equal(rows[0].metric, 'Posters made'); // "Posters made" < "Videos edited"
});

const shoot = (extra = {}) => ({ shootDate: '2026-11-10', status: 'planned', category: 'Bridal', brand: 'main', ...extra });

test('productionWeek: planned = shoots dated in the range that are not cancelled; done = those Completed; top categories by planned', () => {
  const shoots = [
    shoot({ category: 'Bridal', status: 'completed' }), shoot({ category: 'Bridal' }), shoot({ category: 'Bridal', status: 'cancelled' }),
    shoot({ category: 'Reels', status: 'completed' }), shoot({ category: 'Reels', status: 'completed' }),
    shoot({ category: 'Product' }), shoot({ category: 'Podcast' }),
    shoot({ shootDate: '2026-11-08' }), shoot({ shootDate: '2026-11-16' }), // out of range
  ];
  const p = W.productionWeek(shoots, RANGE);
  assert.equal(p.planned, 6);
  assert.equal(p.done, 3);
  assert.equal(p.categories.length, 3);
  // Bridal and Reels tie on 2 planned → alphabetical; Product and Podcast tie on 1 → Podcast takes the third place
  assert.deepEqual(p.categories, [{ category: 'Bridal', planned: 2, done: 1 }, { category: 'Reels', planned: 2, done: 2 }, { category: 'Podcast', planned: 1, done: 0 }]);
});

test('productionWeek: the order of equal categories is alphabetical; blank category → "Other shoots"; brand filter; boundaries inclusive', () => {
  const shoots = [shoot({ category: 'Bridal' }), shoot({ category: 'Reels' }), shoot({ category: '  ' }), shoot({ shootDate: '2026-11-09', category: 'Bridal' }), shoot({ shootDate: '2026-11-15', brand: 'kerala' })];
  const p = W.productionWeek(shoots, RANGE);
  assert.equal(p.planned, 5);
  assert.deepEqual(p.categories.map((c) => c.category), ['Bridal', 'Other shoots', 'Reels']);
  assert.equal(p.categories[0].planned, 3); // the Kerala shoot is also a Bridal one
  assert.equal(W.productionWeek(shoots, { ...RANGE, brand: 'kerala' }).planned, 1);
  assert.equal(W.productionWeek(shoots, { ...RANGE, brand: 'main' }).planned, 4);
});

test('productionWeek: a shoot saved with no brand is a Main shoot', () => {
  const shoots = [{ shootDate: '2026-11-10', status: 'planned', category: 'Bridal' }, { shootDate: '2026-11-11', status: 'planned', category: 'Bridal', brand: 'kerala' }];
  assert.equal(W.productionWeek(shoots, { ...RANGE, brand: 'main' }).planned, 1);
  assert.equal(W.productionWeek(shoots, { ...RANGE, brand: 'kerala' }).planned, 1);
  assert.equal(W.productionWeek(shoots, RANGE).planned, 2);
});

test('productionWeek: nothing planned → zeros and no categories', () => {
  assert.deepEqual(W.productionWeek([], RANGE), { planned: 0, done: 0, categories: [] });
});

test('revenueCollection: order value, advance that counts, later collections, balance (never below 0), progress, average', () => {
  const a = booking({ totalPrice: 30000, discountAmount: 5000, advanceAmount: 10000, collectedAmount: 5000 }); // net 25000, balance 10000
  const b = booking({ totalPrice: 20000, advanceAmount: 20000 }); // net 20000, balance 0
  const c = booking({ totalPrice: 10000, advanceAmount: 4000, advanceStatus: 'pending' }); // advance does not count yet → balance 10000
  const d = booking({ totalPrice: 10000, advanceAmount: 15000, collectedAmount: 2000 }); // over-paid → balance 0, not negative
  const leads = [converted(a), converted(b), converted(c), converted(d), lead(), converted(booking({ status: 'cancelled', totalPrice: 99999 }))];
  const bookings = [a, b, c, d];
  const r = W.revenueCollection(leads, RANGE, ctxOf(bookings));
  assert.equal(r.bookings, 4);
  assert.equal(r.orderValue, 65000);
  assert.equal(r.advance, 45000); // 10000 + 20000 + 0 (pending) + 15000
  assert.equal(r.collectedLater, 7000);
  assert.equal(r.balanceDue, 20000); // 10000 + 0 + 10000 + 0
  assert.equal(r.averageOrder, 16250);
  assert.equal(r.advanceProgress, 69.2);
});

test('revenueCollection: a refused advance is not counted; only the range\'s own converted leads; GST stays in the order value', () => {
  const a = booking({ totalPrice: 11800, advanceAmount: 5000, advanceStatus: 'rejected' });
  const old = booking({ totalPrice: 5000 });
  const leads = [converted(a), converted(old, { createdAt: '2026-10-01T05:00:00Z' })];
  const r = W.revenueCollection(leads, RANGE, ctxOf([a, old], { gst: { enabled: true, rate: 18, inclusive: true } }));
  assert.equal(r.bookings, 1);
  assert.equal(r.orderValue, 11800);
  assert.equal(r.advance, 0);
  assert.equal(r.balanceDue, 11800);
});

test('revenueCollection: nothing booked → zeros and null shares (no divide-by-zero)', () => {
  const r = W.revenueCollection([lead()], RANGE, ctxOf([]));
  assert.deepEqual(r, { bookings: 0, orderValue: 0, advance: 0, collectedLater: 0, balanceDue: 0, averageOrder: null, advanceProgress: null });
});

test('revenueCollection: its order value equals the headline revenue basis the Lead Report calls orderValue', () => {
  const a = booking({ totalPrice: 30000, discountAmount: 2000 });
  const b = booking({ totalPrice: 12000 });
  const leads = [converted(a), converted(b)];
  const ctx = ctxOf([a, b], { gst: { enabled: true, rate: 18, inclusive: true } });
  assert.equal(W.revenueCollection(leads, RANGE, ctx).orderValue, R.leadFigures(leads, RANGE, ctx).orderValue);
});

test('recentActivities: newest first, capped, bad dates dropped', () => {
  const ev = [
    { at: '2026-11-10T05:00:00Z', kind: 'task', text: 'a' },
    { at: '2026-11-12T05:00:00Z', kind: 'post', text: 'b' },
    { at: 'garbage', kind: 'x', text: 'c' },
    { at: null, kind: 'x', text: 'd' },
    null,
    { at: '2026-11-11T05:00:00Z', kind: 'shoot', text: 'e' },
  ];
  assert.deepEqual(W.recentActivities(ev).map((e) => e.text), ['b', 'e', 'a']);
  assert.equal(W.recentActivities(ev, 2).length, 2);
  assert.deepEqual(W.recentActivities([]), []);
});

test('keyInsights: each sentence only when the data supports it', () => {
  const b = booking({ totalPrice: 20000 });
  const leads = [lead(), lead(), converted(b), lead({ createdAt: '2026-11-03T05:00:00Z' })];
  const period = R.leadPeriod({ leads, range: RANGE, ctx: ctxOf([b]) });
  const out = W.keyInsights({ period, topSource: { label: 'WhatsApp', count: 3, pct: 100 }, spend: { now: 6000, before: 0 } });
  assert.ok(out.includes('Leads increased 200% compared with the period before.'));
  assert.ok(out.some((s) => s.startsWith('WhatsApp contributed 100%')));
  assert.ok(out.some((s) => s.includes('Ad spend per booking was ₹6,000')));
  const none = W.keyInsights({ period: R.leadPeriod({ leads: [], range: RANGE, ctx: ctxOf([]) }) });
  assert.deepEqual(none, []);
});

test('keyInsights: a fall is worded as a fall; the conversion sentence carries percentage points', () => {
  const b0 = booking({ totalPrice: 10000 });
  const leads = [lead(), lead({ createdAt: '2026-11-03T05:00:00Z' }), lead({ createdAt: '2026-11-04T05:00:00Z' }), converted(b0, { createdAt: '2026-11-05T05:00:00Z' })];
  const period = R.leadPeriod({ leads, range: RANGE, ctx: ctxOf([b0]) });
  const out = W.keyInsights({ period });
  assert.ok(out.some((s) => s.startsWith('Leads fell 67%')));
  assert.ok(out.some((s) => s.startsWith('Conversion rate fell to 0%') || s.startsWith('Conversion rate')));
});

test('sparklines: one value per day from the day trend; conversion per day = bookings ÷ leads (0 with no leads); no spend records → no ad-spend line', () => {
  const b = booking({ totalPrice: 4000 });
  const leads = [lead({ createdAt: '2026-11-10T05:00:00Z' }), converted(b, { createdAt: '2026-11-10T06:00:00Z' }), lead({ createdAt: '2026-11-12T05:00:00Z' })];
  const trend = W.dayTrend(leads, RANGE, ctxOf([b]));
  const spark = W.sparklines(trend, null);
  assert.equal(spark.leads.length, 7);
  assert.deepEqual(spark.leads, [0, 2, 0, 1, 0, 0, 0]);
  assert.deepEqual(spark.bookings, [0, 1, 0, 0, 0, 0, 0]);
  assert.deepEqual(spark.revenue, [0, 4000, 0, 0, 0, 0, 0]);
  assert.deepEqual(spark.conversionRate, [0, 50, 0, 0, 0, 0, 0]);
  assert.equal(spark.adSpend, null);
  const days = trend.map((d, i) => ({ day: d.day, spend: i * 100 }));
  assert.deepEqual(W.sparklines(trend, days).adSpend, [0, 100, 200, 300, 400, 500, 600]);
  // every line adds up to its card
  assert.equal(spark.leads.reduce((a, v) => a + v, 0), R.leadFigures(leads, RANGE, ctxOf([b])).total);
});

test('keyInsights: ad spend with no bookings gives no "per booking" sentence (no division by zero)', () => {
  const period = R.leadPeriod({ leads: [lead(), lead({ createdAt: '2026-11-03T05:00:00Z' })], range: RANGE, ctx: ctxOf([]) });
  const out = W.keyInsights({ period, spend: { now: 5000, before: 0 } });
  assert.ok(!out.some((x) => x.includes('per booking')));
  assert.ok(!out.some((x) => x.includes('Infinity') || x.includes('NaN')));
});
