// Pure unit tests: node --test tests/marketingCampaignStats.test.js
// How the Campaigns hub counts: paid-ads figures, CRM leads / bookings / revenue by campaign, change on the previous period, the trend,
// budget against spend, ad verdicts, insights, the report tables, and the pure functions the Weekly Report imports.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../utils/marketingCampaignStats.js';
import { CAMPAIGN_PLATFORMS, CAMPAIGN_OBJECTIVES } from '../models/Campaign.js';
import { AD_FORMATS } from '../models/CampaignAd.js';

const R = { from: '2026-11-01', to: '2026-11-07', brand: 'all' };
let n = 0;
const camp = (id, extra = {}) => ({ _id: id, title: `Campaign ${id}`, brand: 'kerala', status: 'active', platform: 'meta', objective: 'lead_generation', budget: 0, createdAt: '2026-10-01T05:00:00Z', ...extra });
const met = (campaignId, day, extra = {}) => ({ campaignId, day, spend: 0, reach: 0, impressions: 0, clicks: 0, results: 0, ...extra });
const lead = (campaignId, day, extra = {}) => ({ _id: `l${++n}`, campaignId, status: 'New', priority: 'Warm', source: 'Paid Ads', leadDate: `${day}T05:00:00Z`, createdAt: `${day}T05:00:00Z`, ...extra });
const book = (leadId, extra = {}) => ({ _id: `b${++n}`, leadId, status: 'confirmed', totalPrice: 10000, createdBy: 'u1', ...extra });

// a: Kerala, lead generation, ₹10,000 budget · b: Kerala, messages, no budget, paused · c: Main, reach
const A = camp('a', { budget: 10000 });
const B = camp('b', { objective: 'messages', status: 'paused' });
const C = camp('c', { brand: 'main', objective: 'reach' });
const campaigns = [A, B, C];
const metrics = [
  met('a', '2026-11-02', { spend: 1000, reach: 5000, impressions: 8000, clicks: 200, results: 10 }),
  met('a', '2026-11-03', { spend: 500, reach: 2000, impressions: 3000, clicks: 60, results: 4 }),
  met('b', '2026-11-03', { spend: 300, reach: 1000, impressions: 2000, clicks: 40, results: 3 }),
  met('c', '2026-11-04', { spend: 700, reach: 4000, impressions: 9000, clicks: 90, results: 0 }),
  met('a', '2026-10-30', { spend: 800, reach: 3000, impressions: 4000, clicks: 80, results: 5 }), // the period before
];
const l1 = lead('a', '2026-11-02', { status: 'Converted', priority: 'Hot', bookingId: 'bk1' });
const l2 = lead('a', '2026-11-03', { status: 'Qualified' });
const l3 = lead('a', '2026-11-03', { priority: 'Cold' });
const l4 = lead('b', '2026-11-03');
const l5 = lead('c', '2026-11-04', { status: 'Lost' });
const l6 = lead('a', '2026-10-30'); // the period before
const leads = [l1, l2, l3, l4, l5, l6];
const bookings = [{ _id: 'bk1', leadId: l1._id, status: 'confirmed', totalPrice: 40000, createdBy: 'u1' }];
const outcomes = S.leadOutcomes({ leads, bookings });
const args = { campaigns, metrics, leads, outcomes, range: R };

test('the ratios: CTR, CPM, cost per lead, ROAS — null when there is nothing to divide by', () => {
  assert.equal(S.ctrPct(200, 8000), 2.5);
  assert.equal(S.ctrPct(1, 3), 33.33);
  assert.equal(S.ctrPct(5, 0), null);
  assert.equal(S.cpmOf(500, 10000), 50);
  assert.equal(S.cpmOf(500, 0), null);
  assert.equal(S.cplOf(1000, 4), 250);
  assert.equal(S.cplOf(1000, 0), null, 'no leads');
  assert.equal(S.cplOf(0, 5), null, 'no spend recorded is not a ₹0 lead');
  assert.equal(S.roasOf(40000, 2000), 20);
  assert.equal(S.roasOf(40000, 0), null);
});

test('the lists agree with the models, so a form can never offer a value the database refuses', () => {
  assert.deepEqual(S.PLATFORMS.map((p) => p.key), CAMPAIGN_PLATFORMS);
  assert.deepEqual(S.OBJECTIVES.map((o) => o.key), CAMPAIGN_OBJECTIVES);
  assert.deepEqual(S.AD_FORMATS.map((f) => f.key), AD_FORMATS);
});

test('brand, platform, objective and status read older campaigns sensibly', () => {
  assert.equal(S.brandOfCampaign({}), 'main', 'a campaign made before the field existed is Main');
  assert.equal(S.brandOfCampaign({ brand: 'kerala' }), 'kerala');
  assert.equal(S.platformOfCampaign({ platform: 'google', channel: 'Instagram' }), 'google', 'the normalised field wins');
  assert.equal(S.platformOfCampaign({ channel: 'Instagram Reels' }), 'instagram');
  assert.equal(S.platformOfCampaign({ channel: 'Meta Ads' }), 'meta');
  assert.equal(S.platformOfCampaign({ channel: 'Facebook' }), 'facebook');
  assert.equal(S.platformOfCampaign({ channel: 'Google Search' }), 'google');
  assert.equal(S.platformOfCampaign({ channel: 'Flyers' }), 'other');
  assert.equal(S.platformOfCampaign({}), '');
  assert.equal(S.objectiveOfCampaign({ objective: 'messages' }), 'messages');
  assert.equal(S.objectiveOfCampaign({ objective: 'bogus' }), '');
  assert.equal(S.objectiveLabel(''), 'Not set');
  assert.equal(S.objectiveLabel('lead_generation'), 'Lead Generation');
  assert.equal(S.statusOfCampaign({}), 'active');
  assert.equal(S.statusOfCampaign({ status: 'paused' }), 'paused');
});

test('paid-ads figures: the days inside the range (both ends), of the brand, added up; the legacy lifetime adSpend is never added', () => {
  const cById = new Map(campaigns.map((c) => [c._id, c]));
  const all = S.sumMetrics(S.metricRowsIn(metrics, cById, R));
  assert.deepEqual(all, { spend: 2500, reach: 12000, impressions: 22000, clicks: 390, results: 17, days: 3 });
  const kerala = S.sumMetrics(S.metricRowsIn(metrics, cById, { ...R, brand: 'kerala' }));
  assert.equal(kerala.spend, 1800);
  assert.equal(S.sumMetrics(S.metricRowsIn(metrics, cById, { ...R, brand: 'main' })).spend, 700);
  // both ends of the range count; the day before and the day after do not
  const edge = [met('a', '2026-11-01', { spend: 1 }), met('a', '2026-11-07', { spend: 10 }), met('a', '2026-10-31', { spend: 100 }), met('a', '2026-11-08', { spend: 1000 })];
  assert.equal(S.sumMetrics(S.metricRowsIn(edge, cById, R)).spend, 11);
  // a record of a campaign that no longer exists counts nowhere
  assert.equal(S.sumMetrics(S.metricRowsIn([met('gone', '2026-11-02', { spend: 99 })], cById, R)).spend, 0);
  // the old Campaigns screen's lifetime adSpend is not read here
  const legacy = [camp('a', { adSpend: 99999 })];
  assert.equal(S.periodTotals({ campaigns: legacy, metrics, leads: [], outcomes: new Map(), range: R }).spend, 1500);
  assert.deepEqual(S.sumMetrics([]), S.emptyTotals());
});

test('leads: arrival day in IST (leadDate, else created); tagged to a campaign of the brand', () => {
  const cById = new Map(campaigns.map((c) => [c._id, c]));
  const at = (iso, extra = {}) => lead('a', '2026-11-02', { leadDate: iso, createdAt: iso, ...extra });
  const edges = [
    at('2026-10-31T18:29:00Z'), // 31 Oct 23:59 IST: before
    at('2026-10-31T18:30:00Z'), // 1 Nov 00:00 IST: in
    at('2026-11-07T18:29:00Z'), // 7 Nov 23:59 IST: in
    at('2026-11-07T18:30:00Z'), // 8 Nov 00:00 IST: out
  ];
  assert.equal(S.leadsIn(edges, cById, R).length, 2);
  // leadDate wins over createdAt
  assert.equal(S.leadsIn([lead('a', '2026-11-03', { createdAt: '2026-09-01T05:00:00Z' })], cById, R).length, 1);
  // no campaign, or a campaign that is gone: not a campaign lead
  assert.equal(S.leadsIn([lead(null, '2026-11-03'), lead('gone', '2026-11-03')], cById, R).length, 0);
  // the brand is the campaign's
  assert.equal(S.leadsIn(leads, cById, { ...R, brand: 'main' }).length, 1);
  assert.equal(S.leadsIn(leads, cById, { ...R, brand: 'kerala' }).length, 4);
});

test('bookings and revenue: dead bookings are left out, excluded creators add no revenue but the booking stays, one booking belongs to one lead', () => {
  const ls = [{ _id: 'x', bookingId: null }, { _id: 'y', bookingId: 'by' }];
  for (const status of ['cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending', 'CANCELLED']) {
    assert.equal(S.leadOutcomes({ leads: ls, bookings: [{ _id: 'bx', leadId: 'x', status, totalPrice: 5000 }] }).has('x'), false, status);
  }
  // ONE booking per lead (the Lead Report's rule): its oldest live booking; the value after discount with GST backed out
  const live = S.leadOutcomes({ leads: ls, bookings: [{ _id: 'b1', leadId: 'x', status: 'confirmed', totalPrice: 5900, discountAmount: 0, createdAt: '2026-11-01' }, { _id: 'b2', leadId: 'x', status: 'completed', totalPrice: 2500.5, createdAt: '2026-11-05' }], gst: { enabled: true, rate: 18, inclusive: true } });
  assert.deepEqual(live.get('x'), { bookings: 1, revenue: 5000, order: 5900, valued: true });
  assert.deepEqual(S.leadOutcomes({ leads: ls, bookings: [{ _id: 'b9', leadId: 'x', status: 'confirmed', totalPrice: 6000, discountAmount: 1000 }] }).get('x').revenue, 5000, 'after discount; no GST setting → nothing backed out');
  // the sales-totals rule: the booking counts, its money does not
  const rule = S.leadOutcomes({ leads: ls, bookings: [{ _id: 'b3', leadId: 'x', status: 'confirmed', totalPrice: 9000, createdBy: 'skip' }], countsTowardSales: (b) => b.createdBy !== 'skip' });
  assert.deepEqual(rule.get('x'), { bookings: 1, revenue: 0, order: 0, valued: false });
  // found through the lead's own bookingId when the booking carries no leadId
  const viaLead = S.leadOutcomes({ leads: ls, bookings: [{ _id: 'by', leadId: null, status: 'confirmed', totalPrice: 700 }] });
  assert.deepEqual(viaLead.get('y'), { bookings: 1, revenue: 700, order: 700, valued: true });
  // a booking linked to lead x by leadId is NOT also credited to lead y whose bookingId points at it
  const once = S.leadOutcomes({ leads: ls, bookings: [{ _id: 'by', leadId: 'x', status: 'confirmed', totalPrice: 700 }] });
  assert.equal(once.has('y'), false);
  assert.equal(once.get('x').bookings, 1);
  assert.equal(S.leadOutcomes({ leads: [], bookings: [] }).size, 0);
});

test('the funnel: every step is a subset of the one above; a booked lead is qualified; one lead is one booking', () => {
  const ls = [
    lead('a', '2026-11-02', { status: 'New', priority: 'Hot', _id: 'q1' }),
    lead('a', '2026-11-02', { status: 'Qualified', _id: 'q2' }),
    lead('a', '2026-11-02', { status: 'Follow-up', priority: 'Cold', _id: 'q3' }),
    lead('a', '2026-11-02', { status: 'Contacted', _id: 'q4' }), // booked, but the CRM status was never moved on
    lead('a', '2026-11-02', { status: 'Lost', _id: 'q5' }),
  ];
  const out = S.leadOutcomes({ leads: ls, bookings: [{ _id: 'k1', leadId: 'q4', status: 'confirmed', totalPrice: 100 }, { _id: 'k2', leadId: 'q4', status: 'confirmed', totalPrice: 50 }] });
  const f = S.leadFunnel(ls, out);
  assert.deepEqual(f, { leads: 5, qualified: 3, hot: 1, warm: 3, nurture: 0, cold: 1, notRated: 0, bookedLeads: 1, bookings: 1, revenue: 100 });
  assert.ok(f.qualified <= f.leads && f.bookedLeads <= f.qualified);
  const steps = S.funnelSteps(f);
  assert.deepEqual(steps.map((s) => [s.key, s.count, s.pct]), [['leads', 5, 100], ['qualified', 3, 60], ['booked', 1, 20]]);
  assert.deepEqual(S.funnelSteps({ leads: 0, qualified: 0, bookedLeads: 0 }).map((s) => s.pct), [null, null, null]);
  assert.deepEqual(S.qualitySplit(ls), { Hot: 1, Warm: 3, Nurture: 0, Cold: 1 }, 'every lead rated: no "Not rated"');
  assert.deepEqual(S.qualitySplit([...ls, lead('a', '2026-11-02', { priority: 'Nurture' }), lead('a', '2026-11-02', { priority: undefined })]), { Hot: 1, Warm: 3, Nurture: 1, Cold: 1, 'Not rated': 1 }, 'no priority is never Warm');
  const q = S.leadFunnel([lead('a', '2026-11-02', { priority: 'Nurture' }), lead('a', '2026-11-02', { priority: '' })], new Map());
  assert.deepEqual([q.nurture, q.notRated, q.warm], [1, 1, 0]);
});

test('the conversion rate counts BOOKED LEADS: a lead that booked twice is one conversion and one booking', () => {
  const ls = [lead('a', '2026-11-02', { _id: 'm1' }), lead('a', '2026-11-02', { _id: 'm2' }), lead('a', '2026-11-02', { _id: 'm3' }), lead('a', '2026-11-02', { _id: 'm4' })];
  const out = S.leadOutcomes({ leads: ls, bookings: [{ _id: 'k1', leadId: 'm1', status: 'confirmed', totalPrice: 1 }, { _id: 'k2', leadId: 'm1', status: 'confirmed', totalPrice: 1 }, { _id: 'k3', leadId: 'm2', status: 'confirmed', totalPrice: 1 }]});
  const t = S.periodTotals({ campaigns: [A], metrics: [], leads: ls, outcomes: out, range: R });
  assert.deepEqual([t.leads, t.bookedLeads, t.bookings, t.conversionRate], [4, 2, 2, 50]);
  assert.equal(S.campaignRows({ campaigns: [A], metrics: [], leads: ls, outcomes: out, range: R })[0].conversionRate, 50);
});

test('period totals: paid-ads sums + CRM leads, bookings, revenue and the ratios', () => {
  const t = S.periodTotals(args);
  assert.equal(t.spend, 2500);
  assert.equal(t.reach, 12000);
  assert.equal(t.impressions, 22000);
  assert.equal(t.clicks, 390);
  assert.equal(t.results, 17, 'the platform\'s results stay beside the CRM leads');
  assert.equal(t.leads, 5, 'CRM leads, not platform results');
  assert.equal(t.qualified, 2);
  assert.equal(t.bookedLeads, 1);
  assert.equal(t.bookings, 1);
  assert.equal(t.revenue, 40000);
  assert.equal(t.ctr, 1.77);
  assert.equal(t.cpl, 500, 'spend ÷ CRM leads (2500 ÷ 5), never ÷ platform results');
  assert.equal(t.conversionRate, 20);
  assert.equal(t.roas, 16);
  const kerala = S.periodTotals({ ...args, range: { ...R, brand: 'kerala' } });
  assert.equal(kerala.spend, 1800);
  assert.equal(kerala.leads, 4);
  assert.equal(kerala.cpl, 450);
  const none = S.periodTotals({ campaigns, metrics: [], leads: [], outcomes: new Map(), range: R });
  assert.equal(none.cpl, null);
  assert.equal(none.ctr, null);
  assert.equal(none.conversionRate, null);
});

test('change on the previous period: percent, null with nothing before, conversion rate in points', () => {
  const k = S.kpiBlock(args);
  // previous period is 25–31 Oct: spend 800, 1 lead (CPL 800), impressions 4000, clicks 80
  assert.equal(k.before.spend, 800);
  assert.equal(k.before.leads, 1);
  assert.equal(k.before.cpl, 800);
  assert.equal(k.change.spend, 213); // 2500 vs 800
  assert.equal(k.change.leads, 400);
  assert.equal(k.change.cpl, -37); // 500 vs 800 is -37.5%, rounded
  assert.equal(k.change.impressions, 450);
  assert.equal(k.change.revenue, null, 'nothing before to compare with');
  assert.equal(k.change.conversionRate, 20, 'none of the period before\'s leads booked: 0% then, 20% now = +20 points');
  // a conversion rate moves in points: 20% now against 10% before is +10
  const before = [lead('a', '2026-10-30', { _id: 'p1' }), lead('a', '2026-10-30', { _id: 'p2' })];
  const withBooking = S.leadOutcomes({ leads: [...leads, ...before], bookings: [...bookings, { _id: 'bp', leadId: 'p1', status: 'confirmed', totalPrice: 1 }] });
  const k2 = S.kpiBlock({ ...args, leads: [...leads, ...before], outcomes: withBooking });
  assert.equal(k2.before.conversionRate, 33.3);
  assert.equal(k2.change.conversionRate, -13.3);
  assert.equal(S.kpiBlock({ campaigns, metrics: [], leads: [], outcomes: new Map(), range: R }).change.cpl, null);
});

test('the trend: every day (gaps are zero), leads on their arrival day, bookings on the day their LEAD arrived', () => {
  const t = S.trendSeries(args);
  assert.equal(t.length, 7);
  assert.deepEqual(t.map((p) => p.day), ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
  assert.equal(t[0].spend, 0);
  assert.equal(t[1].spend, 1000);
  assert.equal(t[1].leads, 1);
  assert.equal(t[1].bookings, 1, 'booked from the 2 Nov lead');
  assert.equal(t[1].cpl, 1000);
  assert.equal(t[2].spend, 800);
  assert.equal(t[2].leads, 3);
  assert.equal(t[2].cpl, 266.67);
  assert.equal(t[0].cpl, null);
  // days add up to the range
  assert.equal(t.reduce((s, p) => s + p.spend, 0), 2500);
  assert.equal(t.reduce((s, p) => s + p.leads, 0), 5);
  assert.equal(t.reduce((s, p) => s + p.bookings, 0), 1);
  assert.equal(S.trendSeries({ ...args, range: { ...R, brand: 'main' } }).reduce((s, p) => s + p.spend, 0), 700);
});

test('a long range is drawn week by week (Monday to Sunday), the first week starting at the range start', () => {
  const range = { from: '2026-08-05', to: '2026-11-20', brand: 'all' }; // 108 days
  const t = S.trendSeries({ ...args, range, metrics: [met('a', '2026-08-05', { spend: 5 }), met('a', '2026-08-09', { spend: 7 }), met('a', '2026-08-10', { spend: 11 })] });
  assert.equal(t[0].day, '2026-08-05', 'Wed 5 Aug: the first bucket starts where the range starts');
  assert.equal(t[0].days, 5);
  assert.equal(t[0].spend, 12);
  assert.equal(t[1].day, '2026-08-10', 'Monday');
  assert.equal(t[1].spend, 11);
  assert.equal(t.reduce((s, p) => s + p.days, 0), 108);
  assert.equal(S.trendSeries({ ...args, range: { from: '2026-09-02', to: '2026-11-30', brand: 'all' } }).length, 90, '90 days stay daily');
});

test('leads by campaign type: lead gen / WhatsApp / website form / calls / others, from the objective and the lead\'s source, biggest first', () => {
  const t = S.leadsByType({ campaigns, leads, range: R });
  assert.deepEqual(t.map((x) => [x.key, x.leads]), [['lead_gen', 3], ['whatsapp', 1], ['others', 1]], 'a: lead generation · b: messages → WhatsApp · c: reach → others');
  assert.equal(t[0].label, 'Lead gen (Meta form)');
  assert.equal(t[0].pct, 60);
  assert.equal(t.reduce((s, x) => s + x.pct, 0), 100);
  const bySource = S.leadsByType({ campaigns: [camp('z', { objective: '' })], leads: [lead('z', '2026-11-02', { source: 'Website' }), lead('z', '2026-11-02', { source: 'Phone call' }), lead('z', '2026-11-02', { source: 'WhatsApp (Organic)' })], range: R });
  assert.deepEqual(bySource.map((x) => x.key).sort(), ['calls', 'form', 'whatsapp']);
  assert.deepEqual(S.leadsByType({ campaigns, leads: [], range: R }), []);
  assert.deepEqual(S.CAMPAIGN_TYPES.map((x) => x.key), ['lead_gen', 'whatsapp', 'form', 'calls', 'others']);
});

test('campaign rows: each campaign\'s figures for the range, logged work attached, brand filter', () => {
  const work = S.workByCampaign([{ campaignId: 'a', timeSpentMinutes: 90 }, { campaignId: 'a', timeSpentMinutes: 30 }, { campaignId: 'b', timeSpentMinutes: 15 }, { campaignId: null, timeSpentMinutes: 600 }]);
  assert.deepEqual(work.get('a'), { minutes: 120, entries: 2 });
  assert.equal(work.has('c'), false);
  const rows = S.campaignRows({ ...args, work });
  assert.equal(rows.length, 3);
  const a = rows.find((r) => r.id === 'a');
  assert.deepEqual([a.spend, a.leads, a.qualified, a.bookings, a.revenue, a.cpl, a.ctr, a.results, a.workMinutes, a.workEntries], [1500, 3, 2, 1, 40000, 500, 2.36, 14, 120, 2]);
  assert.equal(a.conversionRate, 33.3);
  assert.equal(a.roas, 26.67);
  assert.equal(a.budget, 10000);
  const b = rows.find((r) => r.id === 'b');
  assert.equal(b.budget, 0);
  assert.equal(b.cpl, 300);
  assert.equal(b.workMinutes, 15);
  assert.equal(S.campaignRows({ ...args, range: { ...R, brand: 'main' } }).map((r) => r.id).join(), 'c');
  // a campaign with nothing in the range is still a row, with zeros and no ratios
  const idle = S.campaignRows({ ...args, campaigns: [camp('idle')] })[0];
  assert.deepEqual([idle.spend, idle.leads, idle.cpl, idle.ctr, idle.conversionRate], [0, 0, null, null, null]);
});

test('sorting, status counts and the table\'s search and filters', () => {
  const rows = S.campaignRows(args);
  assert.deepEqual(S.sortCampaignRows(rows).map((r) => r.id), ['a', 'c', 'b'], 'active first (biggest spend first), then paused');
  const done = { ...rows[0], id: 'd', title: 'Zed', status: 'completed' };
  const planned = { ...rows[0], id: 'p', title: 'Plan', status: 'planned', spend: 0, leads: 0 };
  assert.deepEqual(S.sortCampaignRows([done, planned, ...rows]).map((r) => r.status), ['active', 'active', 'paused', 'planned', 'completed']);
  const tie = S.sortCampaignRows([{ ...rows[0], id: 't1', title: 'beta', spend: 5, leads: 1 }, { ...rows[0], id: 't2', title: 'Alpha', spend: 5, leads: 1 }]);
  assert.deepEqual(tie.map((r) => r.id), ['t2', 't1'], 'A–Z when everything else ties');
  assert.deepEqual(S.statusCounts([...campaigns, camp('d', { status: 'completed' }), camp('p', { status: 'planned' })]), { total: 5, planned: 1, active: 2, paused: 1, completed: 1 });
  assert.deepEqual(S.statusCounts(campaigns, 'kerala'), { total: 2, planned: 0, active: 1, paused: 1, completed: 0 });
  assert.deepEqual(S.statusCounts([], 'all'), { total: 0, planned: 0, active: 0, paused: 0, completed: 0 });
  const f = (o) => S.filterCampaignRows(rows, o).map((r) => r.id);
  assert.deepEqual(f({}), ['a', 'b', 'c']);
  assert.deepEqual(f({ q: 'campaign b' }), ['b']);
  assert.deepEqual(f({ q: 'REACH' }), ['c'], 'text reaches the objective, any case');
  assert.deepEqual(f({ status: 'paused' }), ['b']);
  assert.deepEqual(f({ objective: 'messages' }), ['b']);
  assert.deepEqual(f({ platform: 'google' }), []);
  assert.deepEqual(S.filterCampaignRows([{ ...rows[0], metaCampaignId: '12036' }, rows[1]], { q: '1203' }).length, 1, 'text reaches the Meta ID');
  assert.deepEqual(f({ q: '.*' }), [], 'a regex typed in the box is just text');
});

test('objective-wise results: campaigns, spend, CRM leads, cost per lead and platform results per objective', () => {
  const o = S.objectiveRows(S.campaignRows(args));
  assert.deepEqual(o.map((x) => [x.key, x.campaigns, x.spend, x.leads, x.cpl, x.results]), [['lead_generation', 1, 1500, 3, 500, 14], ['reach', 1, 700, 1, 700, 0], ['messages', 1, 300, 1, 300, 3]]);
  assert.deepEqual(S.objectiveRows([]), []);
  assert.equal(S.objectiveRows([{ objective: '', spend: 10, leads: 0, results: 0 }])[0].label, 'Not set');
});

test('which campaigns are in the period: spend in the range, or not completed and the dates overlap', () => {
  const r = { from: '2026-11-01', to: '2026-11-30' };
  const day = (d) => `${d}T00:00:00+05:30`;
  assert.equal(S.campaignInPeriod(camp('x', { status: 'completed' }), true, r), true, 'spend in the range: always in');
  assert.equal(S.campaignInPeriod(camp('x', { status: 'completed' }), false, r), false, 'a completed campaign with no spend in the range is not');
  assert.equal(S.campaignInPeriod(camp('x', { startDate: day('2026-10-01'), endDate: day('2026-12-31') }), false, r), true);
  assert.equal(S.campaignInPeriod(camp('x', { startDate: day('2026-12-01') }), false, r), false, 'starts after the range');
  assert.equal(S.campaignInPeriod(camp('x', { startDate: day('2026-12-01') }), false, { from: '2026-11-01', to: '2026-12-01' }), true, 'starts on the last day');
  assert.equal(S.campaignInPeriod(camp('x', { startDate: day('2026-09-01'), endDate: day('2026-10-31') }), false, r), false, 'ended before the range');
  assert.equal(S.campaignInPeriod(camp('x', { startDate: day('2026-09-01'), endDate: day('2026-11-01') }), false, r), true, 'ends on the first day');
  assert.equal(S.campaignInPeriod(camp('x', { startDate: null, endDate: null, createdAt: '2026-09-01T05:00:00Z' }), false, r), true, 'no dates: open-ended since it was created');
  assert.equal(S.campaignInPeriod(camp('x', { startDate: null, endDate: null, createdAt: '2026-12-05T05:00:00Z' }), false, r), false, 'created after the range');
});

test('budget: spent to the end of the range against the campaign budget; no budget is never invented; remaining never below zero', () => {
  const spentTo = new Map([['a', { toEnd: 4000, toPrevEnd: 2500 }], ['b', { toEnd: 300, toPrevEnd: 0 }], ['c', { toEnd: 700, toPrevEnd: 0 }]]);
  const rows = S.budgetRows({ campaigns, metrics, spentTo, range: R });
  const a = rows.find((r) => r.id === 'a');
  assert.deepEqual([a.hasBudget, a.budget, a.spentToDate, a.remaining, a.utilisationPct, a.spendInPeriod, a.overBy], [true, 10000, 4000, 6000, 40, 1500, 0]);
  const b = rows.find((r) => r.id === 'b');
  assert.deepEqual([b.hasBudget, b.remaining, b.utilisationPct, b.spendInPeriod], [false, null, null, 300], 'no budget set: no remaining, no utilisation');
  assert.deepEqual(rows.map((r) => r.id), ['a', 'c', 'b'], 'biggest spend in the period first');
  const s = S.budgetSummary(rows);
  assert.equal(s.totalBudget, 10000, 'only the budgeted campaign adds to the budget');
  assert.equal(s.spentToDate, 4000);
  assert.equal(s.remaining, 6000);
  assert.equal(s.utilisationPct, 40);
  assert.equal(s.remainingPct, 60);
  assert.equal(s.utilisationChangePts, 15, '40% now, 25% at the end of the period before');
  assert.equal(s.budgetedCampaigns, 1);
  assert.equal(s.unbudgetedCampaigns, 2);
  assert.equal(s.spendInPeriod, 2500);
  assert.equal(s.unbudgetedSpendInPeriod, 1000, 'spend on campaigns with no budget is reported on its own');
  // over budget: remaining is 0, "over by" says how much
  const over = S.budgetRows({ campaigns: [A], metrics, spentTo: new Map([['a', { toEnd: 12500, toPrevEnd: 12000 }]]), range: R })[0];
  assert.equal(over.remaining, 0);
  assert.equal(over.overBy, 2500);
  assert.equal(over.utilisationPct, 125);
  assert.equal(S.budgetSummary([over]).remaining, 0);
  assert.equal(S.budgetSummary([over]).overBy, 2500);
  // nothing budgeted at all
  const bare = S.budgetSummary(S.budgetRows({ campaigns: [B], metrics, range: R }));
  assert.deepEqual([bare.totalBudget, bare.utilisationPct, bare.remainingPct, bare.utilisationChangePts], [0, null, null, null]);
  // no lifetime sums supplied: falls back to what is in the range
  assert.equal(S.budgetRows({ campaigns: [A], metrics, range: R })[0].spentToDate, 1500);
  // a completed campaign with no spend in the range is not part of the period
  assert.equal(S.budgetRows({ campaigns: [camp('old', { status: 'completed', budget: 5000 })], metrics, range: R }).length, 0);
  // brand filter
  assert.deepEqual(S.budgetRows({ campaigns, metrics, spentTo, range: { ...R, brand: 'main' } }).map((r) => r.id), ['c']);
});

test('daily spend and the spend donut', () => {
  const days = S.spendByDay({ campaigns, metrics, from: R.from, to: R.to });
  assert.equal(days.length, 7);
  assert.deepEqual(days.map((d) => d.spend), [0, 1000, 800, 700, 0, 0, 0]);
  assert.equal(S.spendByDay({ campaigns, metrics, from: R.from, to: R.to, brand: 'main' }).reduce((s, d) => s + d.spend, 0), 700);
  const rows = [
    { id: '1', title: 'One', spendInPeriod: 500 }, { id: '2', title: 'Two', spendInPeriod: 300 }, { id: '3', title: 'Three', spendInPeriod: 100 },
    { id: '4', title: 'Four', spendInPeriod: 60 }, { id: '5', title: 'Five', spendInPeriod: 30 }, { id: '6', title: 'Six', spendInPeriod: 10 }, { id: '7', title: 'Seven', spendInPeriod: 0 },
  ];
  const split = S.spendSplit(rows);
  assert.equal(split.total, 1000);
  assert.deepEqual(split.slices.map((s) => [s.label, s.pct]), [['One', 50], ['Two', 30], ['Three', 10], ['Four', 6], ['Others', 4]]);
  assert.equal(split.slices.reduce((s, x) => s + x.pct, 0), 100);
  assert.deepEqual(S.spendSplit(rows.slice(0, 2)).slices.map((s) => s.label), ['One', 'Two'], 'no Others when everything fits');
  assert.deepEqual(S.spendSplit([]), { total: 0, slices: [] });
});

const ad = (extra = {}) => ({ _id: `ad${++n}`, campaignId: 'a', name: 'Ad', impressions: 10000, clicks: 200, spend: 1000, results: 10, ...extra });

test('ad verdicts against the average of the brand\'s ads: too early, top, underperforming, needs attention', () => {
  const avg = S.adAverages([ad(), ad()]); // CTR 2%, ₹100 per result
  assert.equal(avg.ctr, 2);
  assert.equal(avg.costPerResult, 100);
  const v = (o) => S.adVerdict(ad(o), avg);
  assert.equal(v({}), 'ok', 'right on the average');
  assert.equal(v({ impressions: 999, clicks: 10, spend: 499, results: 0 }), 'early', 'under both minimums');
  assert.equal(v({ impressions: 999, clicks: 40, spend: 500, results: 5 }), 'top', 'enough spend to judge (₹500) though under 1,000 impressions: CTR 4% is good, ₹100 a result is average');
  assert.equal(v({ clicks: 220 }), 'top', 'CTR at 110% of the average is good');
  assert.equal(v({ clicks: 219 }), 'ok', 'a hair under 110%');
  assert.equal(v({ results: 12 }), 'top', 'cost per result at 90% of the average is good (₹83.33)');
  assert.equal(v({ results: 11 }), 'ok', '₹90.9 a result is not below 90%');
  assert.equal(v({ clicks: 139 }), 'under', 'CTR below 70% of the average is poor; cost is average');
  assert.equal(v({ clicks: 140 }), 'ok', 'exactly 70% is not poor');
  assert.equal(v({ results: 7 }), 'under', '₹142.9 a result is above 130% of the average');
  assert.equal(v({ results: 7, clicks: 139 }), 'needs_attention', 'both poor');
  assert.equal(v({ results: 0 }), 'needs_attention', '₹1,000 spent for no result while others get results');
  assert.equal(v({ spend: 499, results: 0, impressions: 5000, clicks: 100 }), 'ok', 'under ₹500 with no result: not judged on cost yet');
  assert.equal(v({ clicks: 300, results: 7 }), 'ok', 'good CTR but poor cost: mixed');
  assert.equal(v({ clicks: 300, results: 0 }), 'needs_attention', 'money spent, nothing back, whatever the CTR');
  // when no ad has results recorded, cost is not judged at all (results are simply not being tracked)
  const noResults = S.adAverages([ad({ results: 0 }), ad({ results: 0 })]);
  assert.equal(noResults.costPerResult, null);
  assert.equal(S.adVerdict(ad({ results: 0 }), noResults), 'ok');
  assert.equal(S.adVerdict(ad({ results: 0, clicks: 300 }), noResults), 'top');
  assert.equal(S.adVerdict(ad({ clicks: 100 }), { ctr: null, costPerResult: null }), 'ok', 'no average to judge against');
});

test('ad rows carry the ratios and verdict; the chips count them; the best ads come first; ads with no delivery are left out', () => {
  const cById = new Map([['a', camp('a', { title: 'Bridal' })]]);
  const ads = [ad({ _id: 'x1', name: 'Top reel', clicks: 300 }), ad({ _id: 'x2', name: 'Weak', clicks: 50, results: 3 }), ad({ _id: 'x3', name: 'Waste', results: 0 }), ad({ _id: 'x4', name: 'Fresh', impressions: 100, clicks: 1, spend: 10, results: 0 }), ad({ _id: 'x5', name: 'Not shown', impressions: 0, clicks: 0, spend: 0, results: 0 })];
  const rows = S.adRows(ads, cById);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(by.x1.campaign, 'Bridal');
  assert.equal(by.x1.ctr, 3);
  assert.equal(by.x1.cpm, 100);
  assert.equal(by.x1.costPerResult, 100);
  assert.equal(by.x3.costPerResult, null, 'no results: no cost per result');
  assert.equal(by.x4.verdict, 'early');
  assert.deepEqual(rows.map((r) => r.verdict), ['top', 'needs_attention', 'needs_attention', 'early', 'early']);
  const counts = S.adCounts(rows);
  assert.deepEqual(counts, { all: 5, top: 1, under: 0, needs_attention: 2 });
  assert.deepEqual(S.topAds(rows, 3).map((r) => r.id), ['x1', 'x2', 'x3'], 'top first, then most results; the ad with no impressions is left out');
  assert.deepEqual(S.topAds(rows, 10).map((r) => r.id), ['x1', 'x2', 'x3', 'x4'], 'with room to spare, the ad that was never shown is still not listed');
  assert.deepEqual(S.topAds([], 3), []);
  assert.equal(S.adVerdictLabel('needs_attention'), 'Needs attention');
});

const base = { rows: [], budgets: [], ads: [], today: '2026-11-13' };
const now = { spend: 2500, leads: 5, cpl: 500 };

test('insights: only what the numbers support, in plain words', () => {
  assert.deepEqual(S.insights({ ...base, now: { spend: 0, leads: 0, cpl: null }, before: { spend: 0, leads: 0, cpl: null }, hasAnyMetric: false }).map((i) => i.kind), ['info']);
  assert.match(S.insights({ ...base, now: { spend: 0, leads: 0, cpl: null }, before: { spend: 0, leads: 0, cpl: null }, hasAnyMetric: false })[0].text, /Import from Meta Ads Manager/);
  assert.match(S.insights({ ...base, now: { spend: 0, leads: 0, cpl: null }, before: { spend: 0, leads: 0, cpl: null } })[0].text, /No ad spend is recorded for this period/);
  assert.deepEqual(S.insights({ ...base, now: { spend: 100, leads: 0, cpl: null }, before: { spend: 100, leads: 0, cpl: null } }), [], 'nothing to say is nothing said');
  // cost per lead lower than before: good; higher: warn
  const lower = S.insights({ ...base, now, before: { spend: 800, leads: 1, cpl: 800 } });
  assert.deepEqual(lower[0], { kind: 'good', text: 'Cost per lead is ₹500, 37% lower than the period before (₹800).' });
  const higher = S.insights({ ...base, now: { ...now, cpl: 900 }, before: { spend: 800, leads: 4, cpl: 600 } });
  assert.equal(higher[0].kind, 'warn');
  assert.match(higher[0].text, /50% higher/);
  assert.equal(S.insights({ ...base, now, before: { spend: 1, leads: 1, cpl: 500 } }).length, 0, 'an unchanged cost per lead says nothing');
  // spend up, leads down
  const sl = S.insights({ ...base, now: { spend: 2000, leads: 5, cpl: 400 }, before: { spend: 1000, leads: 10, cpl: 100 } });
  assert.ok(sl.some((i) => i.text === 'Spend is up 100% while leads are down 50%.'));
  // top campaign by leads; lowest cost per lead needs two campaigns with ≥ 3 leads
  const rows = [{ title: 'Bridal', leads: 8, cpl: 90 }, { title: 'Party', leads: 3, cpl: 70 }, { title: 'Tiny', leads: 2, cpl: 10 }];
  const t = S.insights({ ...base, now: { spend: 5000, leads: 13, cpl: 385 }, before: { spend: 0, leads: 0, cpl: null }, rows });
  assert.ok(t.some((i) => i.text === 'Bridal brought the most leads: 8 of 13 (62%).'));
  assert.ok(t.some((i) => i.text === 'Party has the lowest cost per lead: ₹70.'), 'a campaign with only 2 leads is not "the best"');
  assert.ok(!S.insights({ ...base, now, before: now, rows: rows.slice(0, 1) }).some((i) => /lowest cost per lead/.test(i.text)));
  // budget alerts
  const b = S.insights({ ...base, now, before: now, budgets: [{ title: 'A', hasBudget: true, budget: 10000, utilisationPct: 92, overBy: 0 }, { title: 'B', hasBudget: true, budget: 5000, utilisationPct: 120, overBy: 1000 }, { title: 'C', hasBudget: true, budget: 5000, utilisationPct: 89.9, overBy: 0 }, { title: 'D', hasBudget: false, utilisationPct: null, overBy: 0 }] });
  assert.deepEqual(b.map((i) => i.text), ['A has used 92% of its ₹10,000 budget.', 'B is over its budget by ₹1,000.']);
  // ads needing attention
  assert.match(S.insights({ ...base, now, before: now, ads: [{ verdict: 'needs_attention' }, { verdict: 'top' }] })[0].text, /^1 ad needs attention/);
  assert.match(S.insights({ ...base, now, before: now, ads: [{ verdict: 'needs_attention' }, { verdict: 'needs_attention' }] })[0].text, /^2 ads need attention/);
  // leads from Meta Ads that carry no campaign
  assert.equal(S.insights({ ...base, now, before: now, untaggedPaidLeads: 1 })[0].text, '1 lead from Meta Ads is not tagged to a campaign, so its cost cannot be counted.');
  assert.match(S.insights({ ...base, now, before: now, untaggedPaidLeads: 3 })[0].text, /^3 leads from Meta Ads are not tagged/);
  // a stale import
  assert.equal(S.insights({ ...base, now, before: now, lastImport: { day: '2026-11-06' } })[0].text, 'The last Meta import was 7 days ago, so recent spend may be missing.');
  assert.deepEqual(S.insights({ ...base, now, before: now, lastImport: { day: '2026-11-07' } }), [], '6 days is fresh enough');
  // never more than the cap
  const many = S.insights({ ...base, now, before: { spend: 800, leads: 1, cpl: 800 }, rows, budgets: [{ title: 'A', hasBudget: true, budget: 1, utilisationPct: 95, overBy: 0 }], ads: [{ verdict: 'needs_attention' }], untaggedPaidLeads: 2, lastImport: { day: '2026-10-01' }, max: 3 });
  assert.equal(many.length, 3);
});

test('leads from Meta Ads with no campaign: inside the range, the Meta Ads source, brand by the lead\'s region', () => {
  const l = (extra) => ({ campaignId: null, source: 'Paid Ads', leadDate: '2026-11-03T05:00:00Z', region: 'Calicut', ...extra });
  assert.equal(S.untaggedPaidLeads([l(), l({ campaignId: 'a' }), l({ source: 'WhatsApp (Organic)' }), l({ leadDate: '2026-10-03T05:00:00Z' }), l({ source: 'Trial Campaign' })], R), 2);
  assert.equal(S.untaggedPaidLeads([l(), l({ region: 'Bangalore' })], { ...R, brand: 'kerala' }), 1);
  assert.equal(S.untaggedPaidLeads([l(), l({ region: 'Bangalore' })], { ...R, brand: 'main' }), 1);
  assert.equal(S.untaggedPaidLeads([], R), 0);
});

test('what the Weekly Report imports: spend for a range and brand with the period before, spend by day, the campaigns table, paid-ads totals', () => {
  const inp = { campaigns, metrics, leads, bookings, from: R.from, to: R.to };
  assert.deepEqual(S.adSpendForRange(inp), { spend: 2500, previousSpend: 800, change: 213 });
  assert.deepEqual(S.adSpendForRange({ ...inp, brand: 'main' }), { spend: 700, previousSpend: 0, change: null });
  assert.deepEqual(S.spendByDay(inp).map((d) => d.spend), [0, 1000, 800, 700, 0, 0, 0]);
  const table = S.campaignsTable(inp);
  assert.deepEqual(table.map((r) => [r.id, r.spend, r.leads, r.bookings, r.revenue]), [['a', 1500, 3, 1, 40000], ['c', 700, 1, 0, 0], ['b', 300, 1, 0, 0]]);
  assert.equal(S.campaignsTable({ ...inp, gst: { enabled: true, rate: 18, inclusive: true } })[0].revenue, 33898.31, 'with the GST setting, the value is ex-GST — as on the Lead Report');
  assert.deepEqual(Object.keys(table[0]).sort(), ['bookings', 'brand', 'cpl', 'id', 'leads', 'revenue', 'roas', 'spend', 'status', 'title']);
  assert.equal(S.campaignsTable({ ...inp, campaigns: [...campaigns, camp('idle')] }).length, 3, 'a campaign with no spend and no leads is not a row');
  assert.equal(S.campaignsTable({ ...inp, brand: 'main' }).length, 1);
  const totals = S.paidAdsTotals(inp);
  assert.equal(totals.now.spend, 2500);
  assert.equal(totals.now.leads, 5);
  assert.equal(totals.now.revenue, 40000);
  assert.equal(totals.before.spend, 800);
  assert.equal(totals.change.spend, 213);
  // the sales-totals rule reaches revenue through the helpers too
  assert.equal(S.paidAdsTotals({ ...inp, countsTowardSales: () => false }).now.revenue, 0);
  assert.equal(S.paidAdsTotals({ ...inp, countsTowardSales: () => false }).now.bookings, 1);
  assert.equal(S.adSpendForRange({ campaigns: [], metrics: [], from: R.from, to: R.to }).spend, 0);
});

test('report tables: the same numbers as the screens, in the columns a CSV needs', () => {
  const rows = S.campaignRows(args);
  const budgets = S.budgetRows({ campaigns, metrics, spentTo: new Map([['a', { toEnd: 12500, toPrevEnd: 0 }]]), range: R });
  const ads = S.adRows([ad({ _id: 'z1', name: 'Reel', campaignId: 'a', clicks: 300 })], new Map([['a', A]]));
  const audiences = S.audienceSegments({ rows: [{ campaignId: 'a', day: '2026-11-02', dimension: 'age', age: '25-34', gender: '', placement: '', spend: 400, impressions: 1000, clicks: 20, results: 4 }], campaigns, range: R });
  const data = { rows, budgets, ads, audiences, kpis: S.kpiBlock(args), types: S.leadsByType({ campaigns, leads, range: R }), trend: S.trendSeries(args) };
  assert.equal(S.reportTable('bogus', data), null);
  assert.deepEqual(S.REPORT_TYPES.map((t) => t.key), ['campaign', 'creative', 'lead', 'conversion', 'spend', 'audience', 'overview', 'performance']);
  for (const t of S.REPORT_TYPES) {
    const r = S.reportTable(t.key, data);
    assert.equal(r.title, t.title);
    assert.ok(r.rows.length > 0, t.key);
    for (const row of r.rows) assert.equal(row.length, r.columns.length, `${t.key}: a row is as wide as its header`);
  }
  const camp1 = S.reportTable('campaign', data);
  assert.equal(camp1.rows.length, 3);
  assert.deepEqual(camp1.rows[0].slice(0, 6), ['Campaign a', 'kerala', 'Meta', 'Lead Generation', 'Active', 10000]);
  assert.equal(camp1.rows[1][5], 'No budget set', 'campaign c has no budget');
  const lead1 = S.reportTable('lead', data);
  assert.deepEqual(lead1.columns, ['Campaign', 'Leads', 'Hot', 'Warm', 'Nurture', 'Cold', 'Not rated', 'Qualified', 'Qualified %', 'Bookings', 'Conversion %', 'Booking value (INR, ex-GST)', 'Spend (INR)', 'Cost per lead (INR)']);
  assert.deepEqual(lead1.rows[0], ['Campaign a', 3, 1, 1, 0, 1, 0, 2, 66.7, 1, 33.3, 40000, 1500, 500]);
  const conv = S.reportTable('conversion', data);
  assert.deepEqual(conv.rows[0], ['Campaign a', 3, 2, 1, 33.3, 40000, 1500, 1500, 26.67]);
  const aud = S.reportTable('audience', data);
  assert.deepEqual(aud.rows[0], ['Age', '25-34', 400, 1000, 20, 2, 4, 100, 100]);
  const ov = S.reportTable('overview', data);
  assert.deepEqual(ov.rows[0], ['Spend (INR)', 2500, 800, 213]);
  assert.ok(ov.rows.some((r) => r[0] === 'Leads by campaign type: Lead gen (Meta form)' && r[1] === 3));
  const perf = S.reportTable('performance', data);
  assert.equal(perf.rows.filter((r) => r[0] === 'Day').length, 7, 'a day each for a week');
  assert.ok(perf.rows.some((r) => r[0] === 'Objective' && r[1] === 'Lead Generation'));
  const spend = S.reportTable('spend', data);
  assert.deepEqual(spend.rows.find((r) => r[0] === 'Campaign a'), ['Campaign a', 'kerala', 'Active', 10000, 12500, 'Over by 2500', 125, 1500]);
  assert.equal(spend.rows.find((r) => r[0] === 'Campaign b')[3], 'No budget set');
  const cre = S.reportTable('creative', data);
  assert.equal(cre.rows[0][0], 'Reel');
  assert.equal(cre.rows[0][5], 'Lifetime (typed)');
  // a campaign with nothing in the period is not in the figures reports
  assert.equal(S.reportTable('campaign', { rows: S.campaignRows({ ...args, campaigns: [camp('idle')] }) }).rows.length, 0);
});

test('Creatives & Ads follow the range: an imported ad shows its days in the range; a typed ad its lifetime figures; CRM leads and CPL per ad', () => {
  const cById = new Map([['a', camp('a', { title: 'Bridal' })], ['c', camp('c', { title: 'Courses', brand: 'main' })]]);
  const ads = [
    ad({ _id: 'i1', name: 'Reel #17', metaAdId: '9001', dailyFigures: true, impressions: 99999, spend: 99999 }), // lifetime sums are NOT used in a range
    ad({ _id: 'i2', name: 'Old reel', dailyFigures: true }), // imported, but nothing in this range
    ad({ _id: 't1', name: 'Typed static', impressions: 5000, clicks: 50, spend: 500, results: 5 }),
    ad({ _id: 'c1', campaignId: 'c', name: 'Reel #17', dailyFigures: true }),
  ];
  const adDays = new Map([
    ['i1', [met('a', '2026-11-02', { spend: 300, impressions: 4000, clicks: 80, results: 6 }), met('a', '2026-11-03', { spend: 200, impressions: 2000, clicks: 20, results: 2 }), met('a', '2026-10-01', { spend: 999 })]],
    ['i2', [met('a', '2026-09-01', { spend: 500, impressions: 900 })]],
    ['c1', [met('c', '2026-11-04', { spend: 100, impressions: 1000, clicks: 10 })]],
  ]);
  const crm = [
    lead('a', '2026-11-02', { creative: 'reel 17' }), // matches i1 (same campaign; "Reel #17" ≈ "reel 17")
    lead('a', '2026-11-03', { creative: '9001' }), // the Meta ad ID
    lead('c', '2026-11-04', { creative: 'Reel #17' }), // the Courses ad of the same name
    lead(null, '2026-11-04', { creative: 'Reel #17' }), // no campaign, two ads share the name: not guessed
    lead(null, '2026-11-04', { creative: 'typed static' }), // no campaign, one ad has the name
  ];
  const rows = S.adRows(ads, cById, { adDays, range: R, leads: crm });
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), ['c1', 'i1', 't1'], 'an imported ad with no day in the range did not run then');
  assert.deepEqual([by.i1.figures, by.i1.spend, by.i1.impressions, by.i1.clicks, by.i1.results, by.i1.leads, by.i1.cpl], ['range', 500, 6000, 100, 8, 2, 250]);
  assert.deepEqual([by.t1.figures, by.t1.spend, by.t1.leads, by.t1.cpl], ['lifetime', 500, 1, null], 'a lifetime spend over a range\'s leads would mean nothing');
  assert.deepEqual([by.c1.leads, by.c1.cpl], [1, 100]);
  assert.equal(S.creativeKey('Reel #17'), 'reel17');
  // the Weekly Report's call (no options) keeps the stored figures
  const plain = S.adRows([ads[0]], cById);
  assert.deepEqual([plain[0].figures, plain[0].spend, plain[0].leads], ['lifetime', 99999, null]);
});

test('audiences & placements: top segments by spend, each field read from ONE dimension, of the brand and the range', () => {
  const b = (extra) => ({ campaignId: 'a', day: '2026-11-02', age: '', gender: '', placement: '', spend: 0, impressions: 0, clicks: 0, results: 0, ...extra });
  const rows = [
    b({ dimension: 'age', age: '25-34', spend: 600, impressions: 6000, clicks: 60, results: 6 }),
    b({ dimension: 'age', age: '18-24', spend: 400, impressions: 2000, clicks: 40, results: 0 }),
    // the same money by age AND gender: gender is read from here, age is not (the plain 'age' file exists)
    b({ dimension: 'age+gender', age: '25-34', gender: 'female', spend: 550, impressions: 5000, clicks: 50, results: 6 }),
    b({ dimension: 'age+gender', age: '25-34', gender: 'male', spend: 50, impressions: 1000, clicks: 10, results: 0 }),
    b({ dimension: 'placement', placement: 'Instagram · Reels', spend: 700, impressions: 7000, clicks: 70, results: 5 }),
    b({ dimension: 'placement', placement: 'Facebook · Feed', spend: 300, impressions: 1000, clicks: 30, results: 1 }),
    b({ dimension: 'age', age: '25-34', day: '2026-10-01', spend: 9999 }), // outside the range
    b({ campaignId: 'c', dimension: 'age', age: '45-54', spend: 100 }), // a Main campaign
  ];
  const a = S.audienceSegments({ rows, campaigns, range: { ...R, brand: 'kerala' } });
  assert.equal(a.hasData, true);
  assert.deepEqual(a.age.rows.map((r) => [r.segment, r.spend, r.results, r.costPerResult, r.spendPct]), [['25-34', 600, 6, 100, 60], ['18-24', 400, 0, null, 40]]);
  assert.equal(a.age.dimension, 'age');
  assert.deepEqual([a.gender.dimension, a.gender.rows.map((r) => [r.segment, r.spend])], ['age+gender', [['female', 550], ['male', 50]]]);
  assert.deepEqual(a.placement.rows.map((r) => [r.segment, r.ctr]), [['Instagram · Reels', 1], ['Facebook · Feed', 3]]);
  assert.deepEqual(S.audienceSegments({ rows, campaigns, range: { ...R, brand: 'main' } }).age.rows.map((r) => r.segment), ['45-54']);
  const empty = S.audienceSegments({ rows: [], campaigns, range: R });
  assert.deepEqual([empty.hasData, empty.age.rows, empty.placement.dimension], [false, [], '']);
  assert.equal(S.dimensionOf({ age: '25-34', gender: 'female' }), 'age+gender');
});
