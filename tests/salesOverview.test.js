// Redesigned Sales Dashboard endpoint — every model stubbed (no database).
// Checks its numbers agree with the Sales EOD, the enquiry check and Sales
// Targets, so the screens can never show different figures.
//   node --test tests/salesOverview.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import User from '../models/User.js';
import SalesTarget from '../models/SalesTarget.js';
import EnquiryCount from '../models/EnquiryCount.js';
import { getSalesOverview, workingDays, funnelOf } from '../controllers/salesOverviewController.js';
import { getVerification } from '../controllers/enquiryCountController.js';
import { salesEodReport } from '../controllers/salesReportController.js';
import { getTeamTargets } from '../controllers/salesTargetController.js';

const mongoose = Lead.base;
const oid = () => new mongoose.Types.ObjectId();

const chain = (value) => {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => q,
    then: (res, rej) => Promise.resolve(typeof value === 'function' ? value() : value).then(res, rej),
  };
  return q;
};

const safana = { _id: oid(), name: 'Safana', role: 'sales', active: true };
const malavika = { _id: oid(), name: 'Malavika', role: 'sales', active: true };
const admin = { _id: oid(), name: 'Admin', role: 'admin', active: true };
const users = [safana, malavika, admin];

const at = (day, hh = '06') => new Date(`${day}T${hh}:00:00.000Z`);
const L1 = { _id: oid(), name: 'Bride A', source: 'IG Leads — Main Page', status: 'Converted', assignedTo: safana._id, createdBy: safana._id, createdAt: at('2026-11-10') };
const L2 = { _id: oid(), name: 'Bride B', source: 'IG Leads — Main Page', status: 'New', assignedTo: malavika._id, createdBy: malavika._id, createdAt: at('2026-11-10') };
const L3 = { _id: oid(), name: 'Bride C', source: 'WhatsApp (Organic)', status: 'Follow-up', followUpDate: at('2026-11-05'), assignedTo: safana._id, createdBy: safana._id, createdAt: at('2026-11-09') };
const leads = [L1, L2, L3];

const bookings = [
  // Safana, via lead L1: complete value 50,000 (discount 5,000 NOT deducted)
  { _id: oid(), status: 'confirmed', totalPrice: 50000, discountAmount: 5000, advanceAmount: 3000, collectedAmount: 0, leadId: L1._id, salesPersonId: safana._id, createdBy: safana._id, createdAt: at('2026-11-10'), bookingDate: at('2026-12-01') },
  // Walk-in, no lead, no salesperson
  { _id: oid(), status: 'confirmed', totalPrice: 20000, discountAmount: 0, advanceAmount: 0, collectedAmount: 0, leadId: null, salesPersonId: null, createdBy: admin._id, createdAt: at('2026-11-10'), bookingDate: at('2026-12-05') },
  // Cancelled — never a sale
  { _id: oid(), status: 'cancelled', totalPrice: 10000, discountAmount: 0, advanceAmount: 0, collectedAmount: 0, leadId: null, salesPersonId: safana._id, createdBy: safana._id, createdAt: at('2026-11-10'), bookingDate: at('2026-12-06') },
];
const manual = [
  { date: '2026-11-10', channel: 'IG Leads — Main Page', count: 9 },
  { date: '2026-11-10', channel: 'WhatsApp (Organic)', count: 4 },
];
const targets = [{ userId: safana._id, month: 11, year: 2026, salesTarget: 200000, bookingsTarget: 4 }];

// Pull the createdAt window out of any (nested) Mongo filter.
const findRange = (q, key = 'createdAt') => {
  if (!q || typeof q !== 'object') return null;
  if (q[key] && (q[key].$gte || q[key].$lt)) return q[key];
  for (const v of Object.values(q)) {
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) {
      const r = findRange(x, key);
      if (r) return r;
    }
  }
  return null;
};
const within = (d, r) => !r || ((!r.$gte || d >= r.$gte) && (!r.$lte || d <= r.$lte) && (!r.$lt || d < r.$lt));

// Pull a `status: { $nin: [...] }` list out of any (nested) filter.
const statusNin = (q) => {
  if (!q || typeof q !== 'object') return null;
  if (q.status?.$nin) return q.status.$nin;
  for (const v of Object.values(q)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      const r = statusNin(x);
      if (r) return r;
    }
  }
  return null;
};
Booking.find = (q) =>
  chain(() => {
    const nin = statusNin(q) || [];
    return bookings.filter((b) => within(b.createdAt, findRange(q)) && !nin.includes(b.status));
  });
Collection.find = () => chain([]);
LeadActivity.find = () =>
  chain([
    { type: 'call', createdBy: safana._id, createdAt: at('2026-11-10') },
    { type: 'followup', createdBy: safana._id, createdAt: at('2026-11-10') },
  ]);
SalesTarget.find = () => chain(targets);
SalesTarget.findOne = () => chain(null);
EnquiryCount.find = (q) => chain(manual.filter((r) => r.date >= q.date.$gte && r.date <= q.date.$lte));
User.find = (q = {}) =>
  chain(() => {
    if (q.countInSalesTotals === false) return [];
    if (q._id?.$in) return users.filter((u) => q._id.$in.map(String).includes(String(u._id)));
    return [safana, malavika]; // sales roles
  });
User.findById = (id) => chain(users.find((u) => String(u._id) === String(id)) ?? null);
Lead.countDocuments = async () => 0;
Lead.find = (q = {}) =>
  chain(() => {
    if (q.status === 'Follow-up') return leads.filter((l) => l.status === 'Follow-up' && l.followUpDate < q.followUpDate.$lt);
    if (q.status) return [];
    if (q._id?.$in) return leads.filter((l) => q._id.$in.map(String).includes(String(l._id)));
    if (q.assignedTo && !q.$and && !q.createdAt) return leads.filter((l) => String(l.assignedTo) === String(q.assignedTo));
    if (q.$expr) {
      const [gte, lte] = q.$expr.$and;
      return leads.filter((l) => l.createdAt >= gte.$gte[1] && l.createdAt <= lte.$lte[1]);
    }
    const r = findRange(q) || findRange(q, 'leadDate');
    return leads.filter((l) => within(l.createdAt, r));
  });

const run = async (handler, user, query) => {
  let code = 200;
  let out;
  const res = { status: (c) => ((code = c), res), json: (b) => ((out = b), res) };
  await handler({ user, query, body: {}, params: {} }, res);
  assert.equal(code, 200, JSON.stringify(out));
  return out;
};

const DAY = { from: '2026-11-10', to: '2026-11-10' };

test('money: complete order value, sales only, outstanding net of discount', async () => {
  const o = await run(getSalesOverview, admin, DAY);
  assert.equal(o.kpis.bookings, 2);
  assert.equal(o.kpis.orderValue, 70000);
  assert.equal(o.kpis.avgOrderValue, 35000);
  assert.equal(o.kpis.advance, 3000);
  assert.equal(o.kpis.outstanding, 45000 - 3000 + 20000);
});

test('team count and gap match the enquiry check and the Sales EOD exactly', async () => {
  for (const range of [DAY, { from: '2026-11-09', to: '2026-11-10' }]) {
    const o = await run(getSalesOverview, admin, range);
    const v = await run(getVerification, admin, range);
    const e = await run(salesEodReport, admin, range);
    assert.equal(o.kpis.enquiries, v.totals.enquiries);
    assert.equal(o.kpis.enquiries, e.leadCountCheck.today.manualCount);
    assert.equal(o.kpis.savedOnCountDays, v.totals.savedOnCountDays);
    assert.equal(o.kpis.savedOnCountDays, e.leadCountCheck.today.savedInCrm);
    assert.equal(o.kpis.notSaved, v.totals.gap);
    assert.equal(o.kpis.notSaved, e.leadCountCheck.today.notLogged);
  }
  const o = await run(getSalesOverview, admin, DAY);
  assert.deepEqual([o.kpis.enquiries, o.kpis.savedOnCountDays, o.kpis.notSaved], [13, 2, 11]);
});

test('order value matches the Sales EOD for the same day', async () => {
  const o = await run(getSalesOverview, admin, DAY);
  const e = await run(salesEodReport, admin, { date: '2026-11-10' });
  assert.equal(o.kpis.orderValue, e.orderValueAndPayments.totalOrderValue.today);
  assert.equal(o.kpis.bookings, e.bookingsBySource.totalBookings.today);
});

test('target bar equals Sales Targets (team and one salesperson)', async () => {
  const o = await run(getSalesOverview, admin, DAY);
  const t = await run(getTeamTargets, admin, { month: 11, year: 2026 });
  assert.equal(o.target.valueTarget, t.totals.salesTarget);
  assert.equal(o.target.value, t.totals.salesValue);
  assert.equal(o.target.bookings, t.totals.bookings);
  assert.equal(o.target.value, 50000); // complete value, walk-in uncredited
  const s = await run(getSalesOverview, admin, { ...DAY, salesPersonId: String(safana._id) });
  assert.equal(s.target.scope, 'person');
  assert.deepEqual([s.target.valueTarget, s.target.value, s.target.bookingsTarget], [200000, 50000, 4]);
});

test('sources: one row per channel; totals reconcile with KPIs', async () => {
  const o = await run(getSalesOverview, admin, DAY);
  const ig = o.sources.find((r) => r.channel === 'IG Leads — Main Page');
  assert.deepEqual([ig.enquiries, ig.saved, ig.notSaved, ig.leads, ig.converted, ig.bookings, ig.orderValue], [9, 2, 7, 2, 1, 1, 50000]);
  const sum = (k) => o.sources.reduce((s, r) => s + r[k], 0);
  assert.equal(sum('enquiries'), o.kpis.enquiries);
  assert.equal(sum('saved'), o.kpis.savedOnCountDays);
  assert.equal(sum('leads'), o.kpis.leads);
  assert.equal(sum('bookings') + o.direct.bookings, o.kpis.bookings);
  assert.equal(sum('orderValue') + o.direct.orderValue, o.kpis.orderValue);
});

test('team leaderboard + uncredited = all sales; trend adds up', async () => {
  const o = await run(getSalesOverview, admin, DAY);
  const tb = o.team.reduce((s, r) => s + r.bookings, 0) + o.othersCredited.bookings;
  const tv = o.team.reduce((s, r) => s + r.orderValue, 0) + o.othersCredited.orderValue;
  assert.equal(tb, o.kpis.bookings);
  assert.equal(tv, o.kpis.orderValue);
  const saf = o.team.find((r) => r.name === 'Safana');
  assert.deepEqual([saf.bookings, saf.orderValue, saf.calls, saf.followUps, saf.overdueFollowUps], [1, 50000, 1, 1, 1]);
  assert.equal(o.trend.reduce((s, d) => s + d.orderValue, 0), o.kpis.orderValue);
  assert.equal(o.trend.reduce((s, d) => s + d.bookings, 0), o.kpis.bookings);
});

test('alerts: unsaved enquiries and overdue follow-ups', async () => {
  const o = await run(getSalesOverview, admin, DAY);
  assert.equal(o.alerts.notSaved, 11);
  assert.equal(o.alerts.overdueFollowUps, 1);
});

test('a salesperson only ever sees their own figures', async () => {
  const o = await run(getSalesOverview, malavika, { ...DAY, salesPersonId: String(safana._id) });
  assert.equal(o.salesPersonId, String(malavika._id));
  assert.equal(o.selfScoped, true);
  assert.deepEqual(o.salespeople, []);
});

test('working days and funnel helpers', () => {
  assert.deepEqual(workingDays(2026, 11, 10), { all: 25, elapsed: 8 }); // Nov 2026: 5 Sundays
  assert.deepEqual(funnelOf(leads), { leads: 3, contacted: 2, followUp: 2, qualified: 1, converted: 1, lost: 0 });
});

test('a booking Safana enters for Malavika counts once — for Malavika — on EOD and dashboard', async () => {
  const b = { _id: oid(), status: 'confirmed', totalPrice: 30000, discountAmount: 0, advanceAmount: 0, collectedAmount: 0, leadId: null, salesPersonId: malavika._id, createdBy: safana._id, createdAt: at('2026-11-10'), bookingDate: at('2026-12-09') };
  bookings.push(b);
  try {
    const eod = await run(salesEodReport, admin, { date: '2026-11-10' });
    const row = (n) => eod.ledgerRows.find((r) => r.salesPersonName === n);
    assert.equal(row('Malavika').totalOrderValue, 30000);
    assert.equal(row('Safana').totalOrderValue, 50000); // not 80,000
    assert.equal(eod.ledgerTotals.totalOrderValue, 80000); // 50k + 30k; walk-in has no salesperson row
    const o = await run(getSalesOverview, admin, DAY);
    assert.equal(o.team.find((r) => r.name === 'Malavika').orderValue, 30000);
    assert.equal(o.team.find((r) => r.name === 'Safana').orderValue, 50000);
  } finally {
    bookings.pop();
  }
});
