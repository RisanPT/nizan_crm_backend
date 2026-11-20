// Pure unit tests: node --test tests/marketingLeadReportStats.test.js
// How the Lead Report counts: leads in a range, stages, conversion and booking value, sources, funnel, trends, campaigns and cost,
// follow-ups, team rows, the list helpers, the report tables — and the checks on what the screens send.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as R from '../utils/marketingLeadReportStats.js';
import * as I from '../utils/marketingLeadReportInput.js';
import { outcomeContext } from '../utils/marketingOutcomes.js';

const RANGE = { from: '2026-11-01', to: '2026-11-30', brand: 'all' };
const TODAY = '2026-11-13';
let n = 0;
const lead = (extra = {}) => ({ _id: `l${++n}`, name: `Lead ${n}`, phone: '9876543210', source: 'WhatsApp (Organic)', status: 'New', priority: 'Warm', createdAt: '2026-11-10T05:00:00Z', ...extra });
const booking = (extra = {}) => ({ _id: `b${++n}`, status: 'confirmed', totalPrice: 10000, discountAmount: 0, createdBy: 'u9', ...extra });
const ctxOf = (bookings, extra = {}) => ({ bookings: new Map(bookings.map((b) => [b._id, b])), gst: { enabled: false, rate: 0, inclusive: true }, ...extra });

test('a lead counts on its own day in India: leadDate wins; 18:30 UTC is the next day; both ends of the range are inclusive', () => {
  const leads = [
    lead({ createdAt: '2026-11-01T00:00:00Z' }), // 1 Nov 05:30 IST — first day
    lead({ createdAt: '2026-10-31T18:29:00Z' }), // 31 Oct 23:59 IST — out
    lead({ createdAt: '2026-10-31T18:30:00Z' }), // 1 Nov 00:00 IST — in
    lead({ createdAt: '2026-11-30T18:29:00Z' }), // 30 Nov 23:59 IST — in
    lead({ createdAt: '2026-11-30T18:30:00Z' }), // 1 Dec 00:00 IST — out
    lead({ createdAt: '2026-12-05T00:00:00Z', leadDate: '2026-11-15T05:00:00Z' }), // leadDate puts it in November
    lead({ createdAt: '2026-11-15T05:00:00Z', leadDate: '2026-09-01T05:00:00Z' }), // leadDate puts it out
  ];
  assert.equal(R.leadsInRange(leads, RANGE).length, 4);
});

test('brand: an Instagram page names it, otherwise the region or district; "all" keeps everything', () => {
  const leads = [
    lead({ source: 'IG Leads — Kerala Page' }),
    lead({ source: 'IG Leads — Main Page', region: 'Calicut' }),
    lead({ source: 'WhatsApp (Organic)', region: 'Kochi' }),
    lead({ source: 'WhatsApp (Organic)', district: 'Mumbai' }),
  ];
  assert.equal(R.leadsInRange(leads, RANGE).length, 4);
  assert.equal(R.leadsInRange(leads, { ...RANGE, brand: 'kerala' }).length, 2);
  assert.equal(R.leadsInRange(leads, { ...RANGE, brand: 'main' }).length, 2);
});

test('stages: counts, shares and the CRM statuses; a lead waiting for "lost" approval is still in progress', () => {
  const list = ['New', 'New', 'Contacted', 'Qualified', 'Follow-up', 'Pending Lost Approval', 'Lost', 'Converted'].map((status) => lead({ status }));
  assert.deepEqual(R.stageCounts(list), { total: 8, new: 2, inProgress: 4, notConverted: 1, converted: 1 });
  assert.deepEqual(R.stageRows(list).map((r) => [r.key, r.count, r.pct]), [['new', 2, 25], ['in_progress', 4, 50], ['not_converted', 1, 12.5], ['converted', 1, 12.5]]);
  assert.deepEqual(R.statusRows(list).map((r) => [r.status, r.count, r.pct]), [['New', 2, 25], ['Contacted', 1, 12.5], ['Qualified', 1, 12.5], ['Follow-up', 1, 12.5], ['Pending Lost Approval', 1, 12.5], ['Lost', 1, 12.5], ['Converted', 1, 12.5]]);
  assert.equal(R.statusRows([])[0].pct, null);
  assert.equal(R.stageRows([]).every((r) => r.count === 0 && r.pct === null), true, 'no leads → no shares, not 0%');
});

test('conversion rate: bookings (leads linked to a live booking) ÷ leads, one decimal; the Converted STAGE is the CRM status', () => {
  const bs = [...Array(3)].map(() => booking());
  const leads = bs.map((b) => lead({ status: 'Converted', bookingId: b._id })).concat([lead({ status: 'Converted' })], [...Array(7)].map(() => lead()));
  const f = R.leadFigures(leads, RANGE, ctxOf(bs));
  assert.equal(f.total, 11);
  assert.equal(f.converted, 4, 'the stage: four leads have the status Converted');
  assert.equal(f.bookings, 3, 'a booking is a lead linked to a live booking — the one with no booking is not');
  assert.equal(f.conversionRate, 27.3);
  assert.equal(R.leadFigures([], RANGE).conversionRate, null);
});

test('booking value: the converted lead\'s booking, after discount, GST backed out; only a real sale counts', () => {
  const good = booking({ totalPrice: 11800, discountAmount: 0 });
  const discounted = booking({ totalPrice: 6000, discountAmount: 1000 });
  const cancelled = booking({ status: 'cancelled' });
  const pending = booking({ status: 'pending' });
  const excluded = booking({ createdBy: 'ux' });
  const leads = [
    lead({ status: 'Converted', bookingId: good._id }),
    lead({ status: 'Converted', bookingId: discounted._id }),
    lead({ status: 'Converted', bookingId: cancelled._id }),
    lead({ status: 'Converted', bookingId: pending._id }),
    lead({ status: 'Converted', bookingId: excluded._id }),
    lead({ status: 'Converted', bookingId: 'missing' }),
    lead({ status: 'Converted' }),
  ];
  const all = [good, discounted, cancelled, pending, excluded];
  const gst = { enabled: true, rate: 18, inclusive: true };
  const ctx = outcomeContext({ leads, bookings: all, gst, countsTowardSales: (b) => b.createdBy !== 'ux' });
  const f = R.leadFigures(leads, RANGE, ctx);
  assert.equal(f.converted, 7, 'the CRM stage');
  assert.equal(f.bookings, 3, 'live bookings only: good, discounted and the excluded creator\'s — cancelled / pending / missing / none are not bookings');
  assert.equal(f.bookingValue, 14237.29, '11800 → 10000; 5000 → 4237.29');
  assert.equal(f.orderValue, 16800, 'what customers pay: 11800 + 5000');
  assert.equal(f.unvalued, 1, 'the excluded creator\'s booking is a booking with no value');
  const plain = R.leadFigures(leads, RANGE, outcomeContext({ leads, bookings: all, countsTowardSales: (b) => b.createdBy !== 'ux' }));
  assert.equal(plain.bookingValue, 16800, 'with no GST the value is the net');
  assert.equal(R.isSaleBooking({ status: 'Confirmed' }), true);
  assert.equal(R.isSaleBooking({ status: 'Cancelled' }), false);
  assert.equal(R.isSaleBooking({ status: 'canceled' }), false);
  assert.equal(R.isSaleBooking({ status: '' }), true);
});

test('the period before: counts change in percent, the rate in points; nothing to compare → null', () => {
  const bks = [];
  const mk = (day, status = 'New') => {
    if (status !== 'Converted') return lead({ createdAt: `${day}T05:00:00Z`, status });
    const b = booking();
    bks.push(b);
    return lead({ createdAt: `${day}T05:00:00Z`, status, bookingId: b._id });
  };
  const leads = [
    mk('2026-11-02', 'Converted'), mk('2026-11-03'), mk('2026-11-04', 'Converted'), mk('2026-11-05', 'Converted'), // 1–4 Nov: 3 leads, 2 converted (the 5th is outside)
    mk('2026-10-30'), mk('2026-10-31', 'Converted'), mk('2026-10-29'), mk('2026-10-28'), // 28–31 Oct: 4 leads, 1 converted (25%)
  ];
  const range = { from: '2026-11-01', to: '2026-11-04', brand: 'all' };
  const p = R.leadPeriod({ leads, range, ctx: ctxOf(bks) });
  assert.deepEqual(p.previous, { from: '2026-10-28', to: '2026-10-31', brand: 'all' });
  assert.equal(p.now.total, 3);
  assert.equal(p.before.total, 4);
  assert.equal(p.change.total, -25);
  assert.equal(p.change.converted, 100, '1 → 2');
  assert.equal(p.now.conversionRate, 66.7);
  assert.equal(p.before.conversionRate, 25);
  assert.equal(p.change.conversionRate, 41.7, 'percentage points');
  const lonely = R.leadPeriod({ leads: [mk('2026-11-02')], range, ctx: ctxOf(bks) });
  assert.equal(lonely.change.total, null);
  assert.equal(lonely.change.conversionRate, null);
});

test('quality is the CRM priority — Hot / Warm / Nurture / Cold; no priority is "Not rated", shown only when there is one', () => {
  const list = [lead({ priority: 'Hot' }), lead({ priority: 'Hot' }), lead({ priority: 'Cold' }), lead({ priority: 'Nurture' }), lead({ priority: undefined }), lead({ priority: 'Lukewarm' }), lead({ priority: 'Warm' }), lead({ priority: 'warm' })];
  const q = R.qualityDistribution(list);
  assert.deepEqual(q.rows.map((r) => [r.key, r.count, r.pct]), [['Hot', 2, 25], ['Warm', 2, 25], ['Nurture', 1, 12.5], ['Cold', 1, 12.5], ['Not rated', 2, 25]], 'an unset or unknown priority is never counted as Warm');
  assert.equal(q.total, 8);
  assert.deepEqual(R.qualityDistribution([lead({ priority: 'Hot' })]).rows.map((r) => [r.key, r.count]), [['Hot', 1], ['Warm', 0], ['Nurture', 0], ['Cold', 0]], 'no "Not rated" row when every lead is rated');
  const s = R.sourceDistribution([lead({ source: 'IG Leads — Main Page' }), lead({ source: 'IG Leads — Main Page' }), lead({ source: 'Paid Ads Leads' }), lead({ source: 'Trial Campaign Leads' }), lead({ source: 'YouTube' }), lead({ source: '' }), lead({ source: 'Cold call' })]);
  assert.deepEqual(s.rows.map((r) => [r.key, r.count]), [['ig_main', 2], ['meta_ads', 2], ['whatsapp', 1], ['youtube', 1], ['other', 1]], 'biggest first; ties in the CRM order; sources without leads are left out');
  assert.deepEqual(R.sourceDistribution([lead({ source: 'Website' })]).rows.map((r) => [r.key, r.label]), [['website', 'Website']]);
  assert.equal(R.sourceDistribution([]).rows.length, 0);
});

test('source groups: all six (Website is its own), with share and change on the period before; table rows add qualified, hot and bookings', () => {
  const now = [lead({ source: 'IG Leads — Main Page' }), lead({ source: 'IG Leads — Kerala Page' }), lead({ source: 'Paid Ads Leads' }), lead({ source: 'Reference' }), lead({ source: 'Walk-in' })];
  const before = [lead({ source: 'IG Leads — Main Page' }), lead({ source: 'WhatsApp (Organic)' })];
  const g = R.sourceGroups(now, before);
  assert.deepEqual(g.map((x) => x.key), ['instagram', 'meta_ads', 'whatsapp', 'youtube', 'website', 'others']);
  assert.deepEqual(g.map((x) => x.count), [2, 1, 0, 0, 0, 2]);
  assert.equal(R.groupKeyOfSource('website'), 'website');
  assert.equal(g[0].pct, 40);
  assert.equal(g[0].change, 100);
  assert.equal(g[1].change, null, 'no Meta leads before → nothing to compare');
  assert.equal(g[2].change, -100);
  assert.equal(R.groupKeyOfSource('reference'), 'others');
  assert.equal(R.groupKeyOfSource('ig_kerala'), 'instagram');
  assert.equal(R.groupKeyOfSource('nonsense'), 'others');
  const b = booking();
  const rows = R.sourceRows([lead({ source: 'YouTube', status: 'Converted', priority: 'Hot', bookingId: b._id }), lead({ source: 'YouTube', status: 'Qualified' }), lead({ source: 'YouTube' }), lead({ source: 'Walk-in' })], ctxOf([b]));
  assert.deepEqual(rows.map((r) => [r.key, r.leads, r.qualified, r.hot, r.bookings, r.rate, r.share]), [['youtube', 3, 2, 1, 1, 33.3, 75], ['walk_in', 1, 0, 0, 0, 0, 25]]);
});

test('the funnel: total → qualified → hot → bookings, each as a share of ALL leads; a booked lead is qualified whatever its status', () => {
  const b1 = booking();
  const b2 = booking();
  const list = [lead({ status: 'Converted', priority: 'Hot', bookingId: b1._id }), lead({ status: 'Qualified', priority: 'Hot' }), lead({ status: 'Follow-up' }), lead({ status: 'New', priority: 'Hot' }), lead({ status: 'Lost' }), lead({ status: 'Contacted', bookingId: b2._id })];
  const f = R.funnel(list, ctxOf([b1, b2]));
  assert.deepEqual(f.steps.map((s) => [s.key, s.count, s.pct]), [['leads', 6, 100], ['qualified', 4, 66.7], ['hot', 3, 50], ['bookings', 2, 33.3]], 'the Contacted lead with a live booking is a booking AND qualified');
  assert.deepEqual(R.funnel([]).steps.map((s) => s.pct), [null, null, null, null]);
});

test('trend buckets: a day each up to 31 days, then Monday–Sunday weeks clipped to the range', () => {
  const d = R.trendBuckets({ from: '2026-11-01', to: '2026-11-30' });
  assert.equal(d.granularity, 'day');
  assert.equal(d.buckets.length, 30);
  assert.equal(R.trendBuckets({ from: '2026-10-01', to: '2026-10-31' }).buckets.length, 31);
  const w = R.trendBuckets({ from: '2026-10-01', to: '2026-12-31' });
  assert.equal(w.granularity, 'week');
  assert.deepEqual(w.buckets[0], { from: '2026-10-01', to: '2026-10-04' }, '1 Oct 2026 is a Thursday: the first week is clipped to Sunday 4th');
  assert.deepEqual(w.buckets[1], { from: '2026-10-05', to: '2026-10-11' });
  assert.deepEqual(w.buckets.at(-1), { from: '2026-12-28', to: '2026-12-31' });
  assert.equal(R.trendBuckets({ from: '2026-11-13', to: '2026-11-13' }).buckets.length, 1);
});

test('the lead trend: leads and their stage now, by the day they arrived; the days add up to the total', () => {
  const leads = [
    lead({ createdAt: '2026-11-02T05:00:00Z' }),
    lead({ createdAt: '2026-11-02T06:00:00Z', status: 'Converted' }),
    lead({ createdAt: '2026-11-04T05:00:00Z', status: 'Lost' }),
    lead({ createdAt: '2026-11-04T05:00:00Z', status: 'Qualified' }),
    lead({ createdAt: '2026-10-02T05:00:00Z' }), // outside
  ];
  const t = R.leadTrend(leads, { from: '2026-11-01', to: '2026-11-07', brand: 'all' }, ctxOf([]));
  assert.equal(t.granularity, 'day');
  assert.equal(t.rows.length, 7);
  assert.deepEqual(t.rows.map((r) => r.leads), [0, 2, 0, 2, 0, 0, 0]);
  assert.deepEqual([t.rows[1].new, t.rows[1].converted, t.rows[3].notConverted, t.rows[3].inProgress, t.rows[3].qualified], [1, 1, 1, 1, 1]);
  assert.equal(t.rows[1].bookings, 0, 'Converted with no booking: the stage, not a booking');
  assert.equal(t.rows.reduce((s, r) => s + r.leads, 0), R.leadsInRange(leads, { from: '2026-11-01', to: '2026-11-07', brand: 'all' }).length);
  const wide = R.leadTrend(leads, { from: '2026-10-01', to: '2026-12-31', brand: 'all' });
  assert.equal(wide.granularity, 'week');
  assert.equal(wide.rows.reduce((s, r) => s + r.leads, 0), 5, 'week totals add up too');
});

test('campaigns: leads in range; spend, cost per lead and per booking are the RANGE\'s (the Campaigns hub\'s), never a lifetime figure', () => {
  const b1 = booking({ totalPrice: 5000 });
  const list = [
    lead({ campaignId: 'c1' }), lead({ campaignId: 'c1', status: 'Converted', bookingId: b1._id }), lead({ campaignId: 'c1' }),
    lead({ campaignId: 'c2' }),
    lead({ campaignId: 'c3' }),
    lead({ campaignId: 'gone' }),
    lead(), lead(),
  ];
  // c1 also has a lifetime adSpend typed on the old screen: it is NOT read
  const campaigns = new Map([['c1', { title: 'Bridal', channel: 'Instagram', brand: 'kerala', adSpend: 99999 }], ['c2', { title: 'Festive', channel: 'Meta' }], ['c3', { title: 'Studio', channel: 'Meta' }], ['c4', { title: 'No leads', channel: 'Meta' }]]);
  const spend = new Map([['c1', 900], ['c3', 300], ['c4', 600]]); // the range's spend of the brand's campaigns
  const c = R.campaignRows(list, { campaigns, spend, ctx: ctxOf([b1]) });
  assert.equal(c.untagged, 2);
  assert.deepEqual(c.rows.map((r) => [r.title, r.leads]), [['Bridal', 3], ['Festive', 1], ['Removed campaign', 1], ['Studio', 1]], 'most leads first, then by name');
  const bridal = c.rows[0];
  assert.deepEqual([bridal.spend, bridal.costPerLead, bridal.costPerBooking, bridal.bookings, bridal.rate, bridal.bookingValue, bridal.brand], [900, 300, 900, 1, 33.3, 5000, 'kerala'], '900 ÷ the 3 leads of the range; ÷ its 1 booking');
  const festive = c.rows[1];
  assert.deepEqual([festive.spend, festive.costPerLead, festive.costPerBooking], [null, null, null], 'no spend in the range → "—", never a guess');
  assert.equal(c.rows[2].spend, null, 'a removed campaign has no spend');
  assert.deepEqual([c.rows[3].costPerLead, c.rows[3].costPerBooking], [300, null], 'no bookings → no cost per booking');
  assert.deepEqual(c.costs, { campaignsWithSpend: 3, campaignsTotal: 4, adSpend: 1800, leads: 5, bookings: 1, costPerLead: 360, costPerBooking: 1800 }, 'ALL the spend of the range (even a campaign with no lead) ÷ the leads of existing campaigns — the hub\'s figure');
  const hidden = R.campaignRows(list, { campaigns, spend, ctx: ctxOf([b1]), showCost: false });
  assert.deepEqual(hidden.rows.map((r) => r.spend), [null, null, null, null]);
  assert.deepEqual([hidden.costs.adSpend, hidden.costs.costPerLead, hidden.costs.costPerBooking, hidden.costs.campaignsWithSpend], [null, null, null, 0]);
  const none = R.campaignRows([], { campaigns, spend: new Map() });
  assert.deepEqual([none.costs.adSpend, none.costs.costPerLead, none.costs.costPerBooking], [null, null, null]);
  assert.equal(R.campaignCosts(c), c.costs);
});

test('campaign rows carry the booking value of their booked leads', () => {
  const b = booking({ totalPrice: 5000 });
  const list = [lead({ campaignId: 'c1', status: 'Converted', bookingId: b._id }), lead({ campaignId: 'c1', status: 'Converted' })];
  const c = R.campaignRows(list, { campaigns: new Map([['c1', { title: 'A' }]]), spend: new Map([['c1', 1000]]), ctx: ctxOf([b]) });
  assert.equal(c.rows[0].bookingValue, 5000);
  assert.equal(c.rows[0].bookings, 1, 'the Converted lead with no booking is not a booking');
  assert.equal(c.rows[0].costPerBooking, 1000);
});

test('All Leads filters: assigned to (a person or unassigned) and campaign (one or none); their choices come from the range\'s leads', () => {
  const rows = [
    { id: '1', assignedToId: 'u1', assignedTo: 'Asha', campaignId: 'c1', campaign: 'Bridal' },
    { id: '2', assignedToId: 'u1', assignedTo: 'Asha', campaignId: '', campaign: '' },
    { id: '3', assignedToId: '', assignedTo: '', campaignId: 'c2', campaign: 'Festive' },
    { id: '4', assignedToId: 'u2', assignedTo: 'Ben', campaignId: 'c1', campaign: 'Bridal' },
  ];
  const ids = (f) => rows.filter((r) => R.matchesFilters(r, f)).map((r) => r.id);
  assert.deepEqual(ids({}), ['1', '2', '3', '4']);
  assert.deepEqual(ids({ assignee: 'u1' }), ['1', '2']);
  assert.deepEqual(ids({ assignee: 'unassigned' }), ['3']);
  assert.deepEqual(ids({ campaign: 'c1' }), ['1', '4']);
  assert.deepEqual(ids({ campaign: 'none' }), ['2']);
  assert.deepEqual(ids({ assignee: 'u1', campaign: 'c1' }), ['1']);
  const o = R.leadFilterOptions(rows);
  assert.deepEqual(o.assignees, [{ id: 'u1', name: 'Asha', count: 2 }, { id: 'u2', name: 'Ben', count: 1 }]);
  assert.deepEqual(o.campaigns, [{ id: 'c1', title: 'Bridal', count: 2 }, { id: 'c2', title: 'Festive', count: 1 }]);
  assert.deepEqual([o.unassigned, o.untagged], [1, 1]);
});

// ── follow-ups ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const act = (leadId, scheduledDate, extra = {}) => ({ _id: `a${++n}`, leadId, type: 'followup', status: 'Pending', scheduledDate, remark: '', ...extra });

test('follow-ups: a logged follow-up and the lead\'s own date for the same moment are ONE; calls and cancelled ones are not follow-ups', () => {
  const L1 = lead({ _id: 'L1', status: 'Follow-up', followUpDate: '2026-11-12T05:00:00Z', assignedTo: 'u1' }); // logged for the same moment
  const L2 = lead({ _id: 'L2', status: 'Follow-up', followUpDate: '2026-11-13T05:00:00Z', assignedTo: 'u2' }); // only the lead form
  const L3 = lead({ _id: 'L3', status: 'Contacted', followUpDate: '2026-11-14T05:00:00Z' }); // has a date but is not in the Follow-up stage
  const L4 = lead({ _id: 'L4', status: 'Follow-up', followUpDate: '2026-11-15T05:00:00Z', assignedTo: 'u1' }); // its logged follow-up was cancelled
  const L5 = lead({ _id: 'L5', status: 'Follow-up', followUpDate: '2026-11-16T05:00:00Z' }); // its logged follow-up is done: not pending any more
  const activities = [
    act('L1', '2026-11-12T05:00:00Z'),
    act('L3', '2026-11-05T05:00:00Z', { status: 'Completed', remark: 'spoke' }),
    act('L3', '2026-11-06T05:00:00Z', { type: 'call' }),
    act('L3', '2026-11-07T05:00:00Z', { type: 'activity' }),
    act('L4', '2026-11-15T05:00:00Z', { status: 'Cancelled' }),
    act('L5', '2026-11-16T05:00:00Z', { status: 'Completed' }),
    act('stranger', '2026-11-08T05:00:00Z'), // a lead the viewer may not see
  ];
  const items = R.buildFollowUps({ activities, leads: [L1, L2, L3, L4, L5] });
  const key = (i) => `${i.leadId}:${i.kind}:${i.done ? 'done' : 'open'}`;
  assert.deepEqual(items.map(key).sort(), ['L1:activity:open', 'L2:lead:open', 'L3:activity:done', 'L4:lead:open', 'L5:activity:done'].sort());
  assert.equal(items.find((i) => i.leadId === 'L3').remark, 'spoke');
  assert.equal(items.find((i) => i.leadId === 'L1').assignedTo, 'u1');
  assert.equal(items.find((i) => i.leadId === 'L2').dueDay, '2026-11-13');
});

test('follow-up state against today (IST): overdue, today, upcoming, completed; the due day is the day in India', () => {
  const day = (iso, done = false) => ({ done, dueDay: iso });
  assert.equal(R.followUpState(day('2026-11-12'), TODAY), 'overdue');
  assert.equal(R.followUpState(day('2026-11-13'), TODAY), 'today');
  assert.equal(R.followUpState(day('2026-11-14'), TODAY), 'upcoming');
  assert.equal(R.followUpState(day('2026-11-01', true), TODAY), 'completed');
  const [i] = R.buildFollowUps({ activities: [act('L1', '2026-11-12T19:00:00Z')], leads: [lead({ _id: 'L1' })] });
  assert.equal(i.dueDay, '2026-11-13', '19:00 UTC is 00:30 IST the next day');
});

const fuItems = () => {
  const leads = [lead({ _id: 'A', assignedTo: 'u1' }), lead({ _id: 'B', assignedTo: 'u2', source: 'IG Leads — Kerala Page' }), lead({ _id: 'C', status: 'Follow-up', followUpDate: '2026-11-09T05:00:00Z', assignedTo: 'u1' })];
  const activities = [
    act('A', '2026-11-10T05:00:00Z'), // overdue
    act('A', '2026-11-11T05:00:00Z', { status: 'Completed' }),
    act('A', '2026-11-13T05:00:00Z'), // today
    act('B', '2026-11-13T09:00:00Z'), // today (Kerala)
    act('B', '2026-11-20T05:00:00Z'), // upcoming (Kerala)
    act('B', '2026-11-25T05:00:00Z', { status: 'Completed' }),
    act('A', '2026-10-20T05:00:00Z'), // before the range, still pending: overdue from before
    act('A', '2026-10-21T05:00:00Z', { status: 'Completed' }), // before the range, done: nobody cares
    act('A', '2026-12-10T05:00:00Z'), // after the range
  ];
  return R.buildFollowUps({ activities, leads });
};

test('follow-up counts: due = overdue + today + upcoming (pending in range); completed apart; older overdue ones counted separately', () => {
  const c = R.followUpCounts(fuItems(), RANGE, TODAY);
  assert.deepEqual(c, { due: 5, today: 2, overdue: 2, upcoming: 1, completed: 2, total: 7, overdueBefore: 1 });
  assert.equal(c.due, c.overdue + c.today + c.upcoming);
  assert.equal(c.total, c.due + c.completed);
  const kerala = R.followUpCounts(fuItems(), { ...RANGE, brand: 'kerala' }, TODAY);
  assert.deepEqual([kerala.due, kerala.today, kerala.upcoming, kerala.completed, kerala.overdueBefore], [2, 1, 1, 1, 0], 'the brand of the lead decides');
  const week = R.followUpCounts(fuItems(), { from: '2026-11-09', to: '2026-11-15', brand: 'all' }, TODAY);
  assert.deepEqual([week.due, week.overdue, week.today, week.completed, week.overdueBefore], [4, 2, 2, 1, 1]);
  const past = R.followUpCounts(fuItems(), { from: '2026-11-01', to: '2026-11-08', brand: 'all' }, TODAY);
  assert.deepEqual([past.total, past.overdueBefore], [0, 1]);
  const future = R.followUpCounts(fuItems(), { from: '2026-11-20', to: '2026-11-30', brand: 'all' }, TODAY);
  assert.deepEqual([future.due, future.upcoming, future.overdue, future.completed], [1, 1, 0, 1]);
  assert.equal(future.overdueBefore, 3, 'still pending and before today: 10 Nov, 9 Nov and 20 Oct (today\'s two are not overdue yet)');
});

test('follow-up period: completed and total change against the period before', () => {
  const items = R.buildFollowUps({
    activities: [act('A', '2026-11-12T05:00:00Z', { status: 'Completed' }), act('A', '2026-11-13T05:00:00Z', { status: 'Completed' }), act('A', '2026-11-14T05:00:00Z'), act('A', '2026-11-05T05:00:00Z', { status: 'Completed' })],
    leads: [lead({ _id: 'A' })],
  });
  const p = R.followUpPeriod(items, { from: '2026-11-10', to: '2026-11-14', brand: 'all' }, TODAY);
  assert.deepEqual([p.completed, p.total, p.due], [2, 3, 1]);
  assert.equal(p.change.completed, 100, '2 against 1 in 5–9 Nov');
  assert.equal(p.change.total, 200);
  assert.equal(R.followUpPeriod([], RANGE, TODAY).change.completed, null);
});

test('the follow-up list: one chip at a time, by due time (completed: newest first)', () => {
  const items = fuItems();
  const ids = (f) => R.followUpList(items, { ...RANGE, filter: f }, TODAY).map((i) => `${i.dueDay}${i.done ? '✓' : ''}`);
  assert.deepEqual(ids('all'), ['2026-11-09', '2026-11-10', '2026-11-11✓', '2026-11-13', '2026-11-13', '2026-11-20', '2026-11-25✓']);
  assert.deepEqual(ids('overdue'), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(ids('today'), ['2026-11-13', '2026-11-13']);
  assert.deepEqual(ids('upcoming'), ['2026-11-20']);
  assert.deepEqual(ids('completed'), ['2026-11-25✓', '2026-11-11✓']);
  assert.equal(R.followUpList(items, { ...RANGE, filter: 'all', brand: 'main' }, TODAY).length, 4);
});

test('team rows: per assignee, with their follow-ups; unassigned apart; people with nothing are left out', () => {
  const bk = booking();
  const list = [lead({ assignedTo: 'u1', status: 'Converted', priority: 'Hot', bookingId: bk._id }), lead({ assignedTo: 'u1' }), lead({ assignedTo: 'u2', status: 'Qualified' }), lead()];
  const items = R.buildFollowUps({
    activities: [act('L9', '2026-11-12T05:00:00Z'), act('L9', '2026-11-13T05:00:00Z', { status: 'Completed' }), act('L8', '2026-11-12T05:00:00Z')],
    leads: [lead({ _id: 'L9', assignedTo: 'u1' }), lead({ _id: 'L8', assignedTo: 'u3' })],
  });
  const rows = R.teamRows(list, items, { nameOf: (id) => ({ u1: 'Asha', u2: 'Ben', u3: 'Cara' })[id], ctx: ctxOf([bk]), range: RANGE, today: TODAY });
  assert.deepEqual(rows.map((r) => [r.name, r.leads, r.bookings, r.rate, r.hot, r.followUpsDue, r.followUpsOverdue, r.followUpsCompleted]), [
    ['Asha', 2, 1, 50, 1, 1, 1, 1],
    ['Ben', 1, 0, 0, 0, 0, 0, 0],
    ['Unassigned', 1, 0, 0, 0, 0, 0, 0],
    ['Cara', 0, 0, null, 0, 1, 1, 0],
  ]);
});

// ── list helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const row = (extra = {}) => ({ id: `r${++n}`, shortId: '#ABC123', name: 'Rehana P', phone: '+91 98765-43210', sourceLabel: 'Instagram (Main)', campaign: 'Bridal Campaign', assignedTo: 'Preethi', status: 'New', createdAt: 100, ...extra });

test('search: name, campaign, assignee, source and id always; the phone only for someone who may see numbers', () => {
  const r = row();
  for (const q of ['rehana', 'BRIDAL', 'preethi', 'instagram', 'abc123', '  rehana  ', '']) assert.equal(R.matchesQuery(r, q, { phone: false }), true, q);
  assert.equal(R.matchesQuery(r, 'nobody', { phone: true }), false);
  assert.equal(R.matchesQuery(r, '98765 43210', { phone: true }), true, 'spaces and dashes do not matter');
  assert.equal(R.matchesQuery(r, '+91 98765-43210', { phone: true }), true, 'nor does the country code');
  assert.equal(R.matchesQuery(r, '987', { phone: true }), true);
  assert.equal(R.matchesQuery(r, '98765 43210', { phone: false }), false, 'a number cannot be probed by someone who may not see it');
  assert.equal(R.matchesQuery(r, '98', { phone: true }), false, 'two digits is not a phone search');
  assert.equal(R.matchesQuery(r, '.*', { phone: true }), false, 'text is text, not a pattern');
});

test('sorting: newest first by default; name, status, source and assignee read in order either way; ties are stable', () => {
  const rows = [row({ id: 'a', name: 'bob', createdAt: 1, status: 'Lost' }), row({ id: 'b', name: 'Asha', createdAt: 3, status: 'New' }), row({ id: 'c', name: 'cara', createdAt: 2, status: 'Converted' })];
  assert.deepEqual(R.sortLeadRows(rows).map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(R.sortLeadRows(rows, 'created', 'asc').map((r) => r.id), ['a', 'c', 'b']);
  assert.deepEqual(R.sortLeadRows(rows, 'name').map((r) => r.id), ['b', 'a', 'c'], 'case does not matter');
  assert.deepEqual(R.sortLeadRows(rows, 'name', 'desc').map((r) => r.id), ['c', 'a', 'b']);
  assert.deepEqual(R.sortLeadRows(rows, 'status').map((r) => r.id), ['c', 'a', 'b']);
  assert.deepEqual(R.sortLeadRows(rows, 'bogus').map((r) => r.id), ['b', 'c', 'a'], 'an unknown sort falls back to newest first');
  assert.deepEqual(R.sortLeadRows([row({ id: 'z', name: 'x' }), row({ id: 'y', name: 'x' })], 'name').map((r) => r.id), ['y', 'z']);
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c'], 'the input is not reordered');
});

test('paging, short ids and masked numbers', () => {
  assert.deepEqual(R.paginate([1, 2, 3, 4, 5], 2, 2), [3, 4]);
  assert.deepEqual(R.paginate([1, 2, 3], 3, 2), []);
  assert.equal(R.shortLeadId('64b7f0c2a1b2c3d4e5f60718'), '#F60718');
  assert.equal(R.maskPhone('+91 98765-43210'), '91••••••••10');
  assert.equal(R.maskPhone('9876543210'), '98••••••10');
  assert.equal(R.maskPhone('1234'), '••••');
  assert.equal(R.maskPhone(''), '');
  assert.equal(R.maskPhone(undefined), '');
});

// ── report tables ────────────────────────────────────────────────────────────────────────────────────────────────────────

test('report tables: every row is as wide as its columns; contact columns exist only for someone who may see them', () => {
  const bk = booking();
  const list = [lead({ status: 'Converted', source: 'Paid Ads Leads', campaignId: 'c1', priority: 'Hot', assignedTo: 'u1', bookingId: bk._id }), lead({ source: 'WhatsApp (Organic)' })];
  const ctx = ctxOf([bk]);
  const figures = R.leadFigures(list, RANGE, ctx);
  const items = R.buildFollowUps({ activities: [act('X', '2026-11-12T05:00:00Z', { channel: 'whatsapp' })], leads: [lead({ _id: 'X', name: 'Xan', assignedTo: 'u1' })] });
  const camp = R.campaignRows(list, { campaigns: new Map([['c1', { title: 'Bridal', channel: 'Meta', brand: 'kerala' }]]), spend: new Map([['c1', 500]]), ctx });
  const tables = {
    summary: R.summaryTable({ figures, statuses: R.statusRows(list), quality: figures.quality, groups: R.sourceGroups(list, []), followUps: R.followUpCounts(items, RANGE, TODAY) }),
    sources: R.sourceTable(R.sourceRows(list, ctx)),
    campaigns: R.campaignTable(camp.rows),
    team: R.teamTable(R.teamRows(list, items, { nameOf: () => 'Asha', ctx, range: RANGE, today: TODAY })),
    conversion: R.conversionTable({ figures, funnel: R.funnel(list, ctx), bySource: R.conversionBySource(list, ctx), trend: R.leadTrend(list, RANGE, ctx), costs: camp.costs, types: [{ key: 'lead_gen', label: 'Lead gen (Meta form)', leads: 1, pct: 100 }] }),
  };
  for (const [name, t] of Object.entries(tables)) {
    assert.ok(t.rows.length > 0, name);
    for (const r of t.rows) assert.equal(r.length, t.columns.length, `${name}: ${JSON.stringify(r)}`);
  }
  assert.deepEqual(tables.summary.rows[0], ['Total leads', 2, '']);
  assert.deepEqual(tables.summary.rows.find((r) => r[0] === 'Bookings'), ['Bookings', 1, 50]);
  assert.deepEqual(tables.summary.rows.find((r) => r[0] === 'Converted (CRM stage)'), ['Converted (CRM stage)', 1, 50]);
  assert.deepEqual(tables.campaigns.rows[0].slice(0, 4), ['Bridal', 'Meta', 'kerala', 1]);
  assert.deepEqual([tables.campaigns.rows[0][8], tables.campaigns.rows[0][9]], [500, 500], 'spend in the range; cost per lead 500 ÷ 1');
  assert.ok(tables.conversion.rows.some((r) => r[0] === 'By campaign type' && r[1] === 'Lead gen (Meta form)'));
  assert.deepEqual(tables.sources.rows.map((r) => r[0]), ['WhatsApp', 'Meta Ads'], 'equal leads: the CRM\'s own source order');
  const shaped = [{ shortId: '#A', name: 'N', phone: '9876543210', sourceLabel: 'WhatsApp', campaign: 'C', assignedTo: 'Z', status: 'New', priority: 'Hot', createdDay: '2026-11-10' }];
  const open = R.leadsTable(shaped, { canContact: true });
  const closed = R.leadsTable(shaped, { canContact: false });
  assert.ok(open.columns.includes('Phone') && open.rows[0].includes('9876543210'));
  assert.ok(!closed.columns.includes('Phone') && !JSON.stringify(closed).includes('9876543210'));
  assert.equal(closed.rows[0].length, closed.columns.length);
  const fu = [{ shortId: '#A', name: 'N', phone: '9876543210', campaign: 'C', assignedTo: 'Z', channel: 'whatsapp', dueDay: '2026-11-12', state: 'overdue', remark: 'x' }];
  assert.ok(R.followUpsTable(fu, { canContact: false }).rows[0].includes('WhatsApp'), 'the follow-up\'s type is in the export');
  assert.equal(items[0].channel, 'whatsapp');
  assert.equal(R.followUpChannelLabel(''), 'Follow-up');
  assert.ok(!JSON.stringify(R.followUpsTable(fu, { canContact: false })).includes('9876543210'));
  assert.ok(JSON.stringify(R.followUpsTable(fu, { canContact: true })).includes('9876543210'));
  assert.deepEqual(R.REPORTS.map((r) => r.key), ['summary', 'sources', 'campaigns', 'team', 'conversion', 'leads', 'followups']);
});

// ── what the screens send ────────────────────────────────────────────────────────────────────────────────────────────────

test('range: this week and all brands when nothing is sent; real days only; at most a year; one value each', () => {
  const ok = (q) => I.cleanRange(q, '2026-11-13'); // a Friday
  assert.deepEqual(ok({}).value, { from: '2026-11-09', to: '2026-11-15', brand: 'all' });
  assert.deepEqual(ok({ from: '2026-11-01', to: '2026-11-30', brand: 'KERALA' }).value, { from: '2026-11-01', to: '2026-11-30', brand: 'kerala' });
  for (const q of [{ from: '2026-02-31' }, { from: 'x' }, { from: '2026-11-10', to: '2026-11-01' }, { from: '2025-01-01', to: '2026-11-01' }, { brand: 'mars' }, { from: ['2026-11-01', '2026-11-02'] }, { brand: ['main'] }]) assert.equal(ok(q).ok, false, JSON.stringify(q));
  assert.equal(ok({ from: '2025-11-13', to: '2026-11-13' }).ok, true, 'exactly a year (366 days apart) is fine');
});

test('the list query: defaults, every filter checked, page sizes capped', () => {
  assert.deepEqual(I.cleanLeadListQuery({}).value, { stage: 'all', group: 'all', assignee: 'all', campaign: 'all', q: '', sort: 'created', dir: '', page: 1, limit: 10 });
  assert.deepEqual(I.cleanLeadListQuery({ stage: 'converted', source: 'instagram', q: ' asha ', sort: 'name', dir: 'asc', page: '3', limit: '500' }).value, { stage: 'converted', group: 'instagram', assignee: 'all', campaign: 'all', q: 'asha', sort: 'name', dir: 'asc', page: 3, limit: 100 });
  assert.deepEqual([I.cleanLeadListQuery({ assignee: '64B7F0C2A1B2C3D4E5F60718', campaign: 'none' }).value.assignee, I.cleanLeadListQuery({ campaign: 'none' }).value.campaign], ['64b7f0c2a1b2c3d4e5f60718', 'none']);
  assert.equal(I.cleanLeadListQuery({ assignee: 'unassigned' }).value.assignee, 'unassigned');
  for (const q of [{ assignee: 'Asha' }, { campaign: 'Bridal' }, { assignee: ['all', 'unassigned'] }, { campaign: '{"$ne":null}' }]) assert.equal(I.cleanLeadListQuery(q).ok, false, JSON.stringify(q));
  assert.equal(I.cleanLeadListQuery({ q: 'x'.repeat(300) }).value.q.length, 100);
  for (const q of [{ stage: 'won' }, { source: 'tv' }, { sort: 'phone' }, { dir: 'up' }, { page: 'two' }, { page: '-1' }, { limit: '1.5' }, { q: ['a', 'b'] }, { stage: ['new'] }]) assert.equal(I.cleanLeadListQuery(q).ok, false, JSON.stringify(q));
  assert.equal(I.cleanLeadListQuery({ page: '0' }).value.page, 1, 'page 0 is page 1');
  assert.deepEqual(I.cleanFollowUpQuery({}).value, { filter: 'all', page: 1, limit: 10 });
  assert.equal(I.cleanFollowUpQuery({ filter: 'overdue', page: '2' }).value.page, 2);
  for (const q of [{ filter: 'soon' }, { filter: ['all', 'today'] }, { page: 'x' }]) assert.equal(I.cleanFollowUpQuery(q).ok, false, JSON.stringify(q));
  assert.equal(I.cleanReportType('team').ok, true);
  assert.equal(I.cleanReportType('payroll').ok, false);
  assert.equal(I.cleanReportType('__proto__').ok, false);
});
