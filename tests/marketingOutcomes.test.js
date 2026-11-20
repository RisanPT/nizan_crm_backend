// Pure unit tests: node --test tests/marketingOutcomes.test.js
// The figures the Lead Report, the Campaigns hub and the Weekly Report share (utils/marketingOutcomes.js): what a booking is, what it is
// worth, who is qualified, what spend and cost per lead are, which brand a lead belongs to, and the campaign type of a lead.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../utils/marketingOutcomes.js';
import * as S from '../utils/marketingCampaignStats.js';
import * as R from '../utils/marketingLeadReportStats.js';

let n = 0;
const lead = (extra = {}) => ({ _id: `l${++n}`, status: 'New', priority: 'Warm', source: 'Paid Ads Leads', createdAt: '2026-11-10T05:00:00Z', ...extra });
const booking = (extra = {}) => ({ _id: `b${++n}`, status: 'confirmed', totalPrice: 10000, discountAmount: 0, createdBy: 'u1', createdAt: '2026-11-10T06:00:00Z', ...extra });

test('a booking is a lead linked to a LIVE booking: its own bookingId, else a booking that names it; dead ones are not bookings', () => {
  const live = booking();
  const dead = booking({ status: 'Cancelled' });
  const viaLeadId = booking({ leadId: 'L3' });
  const pending = booking({ status: 'pending' });
  const leads = [lead({ _id: 'L1', bookingId: live._id }), lead({ _id: 'L2', status: 'Converted', bookingId: dead._id }), lead({ _id: 'L3', status: 'Qualified' }), lead({ _id: 'L4', bookingId: pending._id }), lead({ _id: 'L5', bookingId: 'missing' })];
  const linked = O.linkBookings(leads, [live, dead, viaLeadId, pending]);
  assert.deepEqual([...linked.keys()].sort(), ['L1', 'L3']);
  assert.equal(linked.get('L3'), viaLeadId);
  for (const status of ['cancelled', 'Canceled', 'rejected', 'lost', 'draft', 'Pending']) assert.equal(O.isLiveBooking({ status }), false, status);
  for (const status of ['confirmed', 'completed', '', 'in-progress']) assert.equal(O.isLiveBooking({ status }), true, status);
  assert.equal(O.isLiveBooking(null), false);
});

test('a lead whose own booking was cancelled still counts when a later live booking names it (a re-booking)', () => {
  const cancelled = booking({ status: 'cancelled', leadId: 'L1' });
  const again = booking({ leadId: 'L1', createdAt: '2026-11-12T00:00:00Z' });
  const linked = O.linkBookings([lead({ _id: 'L1', bookingId: cancelled._id })], [cancelled, again]);
  assert.equal(linked.get('L1'), again);
});

test('one lead is ONE booking however many it has; one booking belongs to ONE lead (the one it names, else the earliest)', () => {
  const first = booking({ leadId: 'L1', createdAt: '2026-11-01T00:00:00Z' });
  const second = booking({ leadId: 'L1', createdAt: '2026-11-05T00:00:00Z' });
  const shared = booking(); // two leads with the same phone both point at it, it names neither
  const named = booking({ leadId: 'L5' }); // L4 points at it, but it names L5
  const leads = [
    lead({ _id: 'L1' }),
    lead({ _id: 'L2', bookingId: shared._id, createdAt: '2026-11-03T00:00:00Z' }),
    lead({ _id: 'L3', bookingId: shared._id, createdAt: '2026-11-02T00:00:00Z' }),
    lead({ _id: 'L4', bookingId: named._id }),
    lead({ _id: 'L5' }),
  ];
  const linked = O.linkBookings(leads, [first, second, shared, named]);
  assert.equal(linked.get('L1'), first, 'the oldest of its bookings');
  assert.equal(linked.get('L3'), shared, 'the earlier-arriving lead has the shared booking');
  assert.equal(linked.has('L2'), false, 'and the other does not count it again');
  assert.equal(linked.get('L5'), named);
  assert.equal(linked.has('L4'), false);
  const f = O.outcomeFigures(leads, O.outcomeContext({ leads, bookings: [first, second, shared, named] }));
  assert.equal(f.booked, 3);
  assert.equal(f.value, 30000, 'each booking counted once');
});

test('booking value: after discount with the GST backed out; order value keeps the GST; an excluded creator makes it unvalued', () => {
  const a = booking({ totalPrice: 11800 });
  const b = booking({ totalPrice: 6000, discountAmount: 1000 });
  const c = booking({ totalPrice: 4000, createdBy: 'nosales' });
  const leads = [lead({ bookingId: a._id }), lead({ bookingId: b._id }), lead({ bookingId: c._id }), lead()];
  const ctx = O.outcomeContext({ leads, bookings: [a, b, c], gst: { enabled: true, rate: 18, inclusive: true }, countsTowardSales: (x) => x.createdBy !== 'nosales' });
  const f = O.outcomeFigures(leads, ctx);
  assert.deepEqual([f.leads, f.booked, f.value, f.order, f.unvalued, f.rate], [4, 3, 14237.29, 16800, 1, 75]);
  assert.deepEqual(O.bookingMoney(a, { enabled: false }), { value: 11800, order: 11800 });
  assert.equal(O.valuedBookingOf(leads[2], ctx), null);
  assert.equal(O.linkedBookingOf(leads[2], ctx), c);
  assert.equal(O.outcomeFigures([], ctx).rate, null);
});

test('qualified: the status says so, or the lead is booked', () => {
  const b = booking();
  const leads = [lead({ status: 'Qualified' }), lead({ status: 'Follow-up' }), lead({ status: 'Converted' }), lead({ status: 'Contacted', bookingId: b._id }), lead({ status: 'New' }), lead({ status: 'Lost' })];
  const ctx = O.outcomeContext({ leads, bookings: [b] });
  assert.deepEqual(leads.map((l) => O.isQualifiedLead(l, ctx)), [true, true, true, true, false, false]);
  assert.equal(O.outcomeFigures(leads, ctx).qualified, 4);
});

test('cost: spend of the days inside the range per campaign; cost per lead / booking null with nothing to divide or no spend', () => {
  const metrics = [{ campaignId: 'c1', day: '2026-11-01', spend: 100.555 }, { campaignId: 'c1', day: '2026-11-02', spend: 200 }, { campaignId: 'c1', day: '2026-10-31', spend: 999 }, { campaignId: 'c2', day: '2026-11-02', spend: 50 }];
  assert.deepEqual([...O.spendByCampaign(metrics, { from: '2026-11-01', to: '2026-11-30' })], [['c1', 300.56], ['c2', 50]]);
  assert.equal(O.costPer(300, 4), 75);
  assert.equal(O.costPer(300, 0), null);
  assert.equal(O.costPer(0, 4), null, '₹0 would only mean "nothing imported"');
});

test('brand: a campaign\'s lead carries the campaign\'s brand; a lead of a removed campaign keeps its own rule', () => {
  const campaigns = new Map([['c1', { brand: 'kerala' }], ['c2', {}]]);
  const out = O.withCampaignBrand([lead({ campaignId: 'c1' }), lead({ campaignId: 'c2' }), lead({ campaignId: 'gone' }), lead()], campaigns);
  assert.deepEqual(out.map((l) => l.campaignBrand), ['kerala', 'main', undefined, undefined]);
  assert.equal(O.brandOfCampaign({ brand: 'kerala' }), 'kerala');
  assert.equal(O.brandOfCampaign({}), 'main', 'a campaign made before the field existed is Main');
});

test('campaign type: the lead\'s source first (WhatsApp, website, calls), then the campaign\'s objective', () => {
  const t = O.campaignTypeOf;
  assert.equal(t(lead({ source: 'WhatsApp (Organic)' }), { objective: 'lead_generation' }), 'whatsapp');
  assert.equal(t(lead({ source: 'Website' }), { objective: 'lead_generation' }), 'form');
  assert.equal(t(lead({ source: 'Missed call' }), { objective: 'reach' }), 'calls');
  assert.equal(t(lead({ source: 'Paid Ads Leads' }), { objective: 'lead_generation' }), 'lead_gen');
  assert.equal(t(lead({ source: 'Paid Ads Leads' }), { objective: 'messages' }), 'whatsapp');
  assert.equal(t(lead({ source: 'Trial Campaign Leads' }), { objective: 'traffic' }), 'form');
  assert.equal(t(lead({ source: 'Paid Ads Leads' }), { objective: 'conversions' }), 'form');
  assert.equal(t(lead({ source: 'Paid Ads Leads' }), { objective: 'engagement' }), 'others');
  assert.equal(t(lead({ source: '' }), { objective: '' }), 'others', 'an empty source is not "WhatsApp" here');
  const campaigns = new Map([['c1', { objective: 'lead_generation' }], ['c2', { objective: 'messages' }]]);
  const rows = O.leadsByCampaignType([lead({ campaignId: 'c1' }), lead({ campaignId: 'c1' }), lead({ campaignId: 'c2' }), lead({ campaignId: 'c1', source: 'Website' }), lead({ campaignId: 'gone' }), lead()], campaigns);
  assert.deepEqual(rows.map((r) => [r.key, r.leads, r.pct]), [['lead_gen', 2, 50], ['whatsapp', 1, 25], ['form', 1, 25]], 'only campaign leads of existing campaigns; biggest first, then the list order');
  assert.equal(O.campaignTypeLabel('calls'), 'Calls');
});

test('the Campaigns hub and the Lead Report count the same campaign the same way: leads, qualified, bookings, value, spend, cost per lead', () => {
  const gst = { enabled: true, rate: 18, inclusive: true };
  const c1 = { _id: 'c1', title: 'Bridal', brand: 'kerala', objective: 'lead_generation', status: 'active' };
  const b1 = booking({ totalPrice: 11800, leadId: 'A' });
  const b2 = booking({ totalPrice: 5900 }); // linked only by the lead's bookingId (a phone match)
  const b3 = booking({ totalPrice: 9999, status: 'cancelled' });
  const b4 = booking({ totalPrice: 7000, leadId: 'D', createdBy: 'nosales' });
  const leads = [
    lead({ _id: 'A', campaignId: 'c1', status: 'Converted', bookingId: b1._id }),
    lead({ _id: 'B', campaignId: 'c1', status: 'Converted', bookingId: b2._id }),
    lead({ _id: 'C', campaignId: 'c1', status: 'Converted', bookingId: b3._id }),
    lead({ _id: 'D', campaignId: 'c1', status: 'Contacted' }),
    lead({ _id: 'E', campaignId: 'c1', status: 'Qualified' }),
  ];
  const bookings = [b1, b2, b3, b4];
  const countsTowardSales = (b) => b.createdBy !== 'nosales';
  const metrics = [{ campaignId: 'c1', day: '2026-11-10', spend: 2500 }, { campaignId: 'c1', day: '2026-09-01', spend: 99999 }];
  const range = { from: '2026-11-01', to: '2026-11-30', brand: 'kerala' };
  const outcomes = S.leadOutcomes({ leads, bookings, countsTowardSales, gst });
  const hub = S.campaignRows({ campaigns: [c1], metrics, leads, outcomes, range })[0];
  const ctx = O.outcomeContext({ leads, bookings, gst, countsTowardSales });
  const list = R.leadsInRange(O.withCampaignBrand(leads, new Map([['c1', c1]])), range);
  const lr = R.campaignRows(list, { campaigns: new Map([['c1', c1]]), spend: O.spendByCampaign(metrics, range), ctx });
  const row = lr.rows[0];
  assert.deepEqual([hub.leads, hub.qualified, hub.bookings, hub.revenue, hub.spend, hub.cpl, hub.conversionRate], [5, 5, 3, 15000, 2500, 500, 60]);
  assert.deepEqual([row.leads, row.qualified, row.bookings, row.bookingValue, row.spend, row.costPerLead, row.rate], [hub.leads, hub.qualified, hub.bookings, hub.revenue, hub.spend, hub.cpl, hub.conversionRate]);
  assert.equal(lr.costs.costPerLead, hub.cpl);
  assert.equal(row.costPerBooking, S.cplOf(hub.spend, hub.bookings));
});
