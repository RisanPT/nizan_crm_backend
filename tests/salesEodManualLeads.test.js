// Sales EOD lead counts from the shared manual team count — every model is
// stubbed: no database, no server.
//   node --test tests/salesEodManualLeads.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Booking from '../models/Booking.js';
import Collection from '../models/Collection.js';
import Lead from '../models/Lead.js';
import LeadActivity from '../models/LeadActivity.js';
import User from '../models/User.js';
import SalesTarget from '../models/SalesTarget.js';
import EnquiryCount from '../models/EnquiryCount.js';
import { salesEodReport } from '../controllers/salesReportController.js';

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

const safana = { _id: oid(), name: 'Safana', role: 'sales' };
const malavika = { _id: oid(), name: 'Malavika', role: 'sales' };
const admin = { _id: oid(), name: 'Admin', role: 'admin' };

// Day 1 (2026-11-09): NO manual count → form leads. Day 2 (2026-11-10): manual count.
const d1 = new Date('2026-11-09T06:00:00.000Z');
const d2 = new Date('2026-11-10T06:00:00.000Z');
const formLeads = [
  { source: 'IG Leads — Main Page', assignedTo: safana._id, createdBy: safana._id, createdAt: d1 },
  { source: 'IG Leads — Main Page', assignedTo: malavika._id, createdBy: malavika._id, createdAt: d1 },
  { source: 'WhatsApp (Organic)', assignedTo: safana._id, createdBy: safana._id, createdAt: d2 },
];
const manual = [
  { date: '2026-11-10', channel: 'IG Leads — Main Page', count: 9 },
  { date: '2026-11-10', channel: 'WhatsApp (Organic)', count: 4 },
  { date: '2026-11-10', channel: 'YouTube', count: 1 },
];

const inRange = (d, r) => !r || (d >= r.$gte && d <= r.$lte);

Lead.find = (q = {}) =>
  chain(() => {
    if (q.status) return []; // converted / follow-ups
    if (q.$expr) {
      // salesLeadsSaved: { $expr: { $and: [ {$gte:[x,start]}, {$lte:[x,end]} ] } }
      const [gte, lte] = q.$expr.$and;
      return formLeads.filter((l) => l.createdAt >= gte.$gte[1] && l.createdAt <= lte.$lte[1]);
    }
    return formLeads.filter(
      (l) => inRange(l.createdAt, q.createdAt) && (!q.assignedTo || String(l.assignedTo) === String(q.assignedTo))
    );
  });
LeadActivity.find = () => chain([]);
Booking.find = () => chain([]);
Collection.find = () => chain([]);
SalesTarget.find = () => chain([]);
SalesTarget.findOne = () => chain(null);
User.find = () => chain([safana, malavika, admin]);
User.findById = (id) => chain([safana, malavika].find((u) => String(u._id) === String(id)) ?? null);
EnquiryCount.find = (q) => chain(manual.filter((r) => r.date >= q.date.$gte && r.date <= q.date.$lte));

const run = async (user, query) => {
  let code = 200;
  let out;
  const res = { status: (c) => ((code = c), res), json: (b) => ((out = b), res) };
  await salesEodReport({ user, query }, res);
  return { code, body: out };
};

test('team EOD: manual-count day uses the team count; other day falls back to form leads', async () => {
  const r = await run(admin, { from: '2026-11-09', to: '2026-11-10' });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  const l = r.body.leadsAndFollowUps;
  // 9 Nov form: 2 IG main. 10 Nov manual: 9 IG main (form WhatsApp on 10 Nov ignored).
  assert.equal(l.igMainLeads.today, 11);
  assert.equal(l.whatsappLeads.today, 4);
  assert.equal(l.otherLeads.today, 1);

  const c = r.body.leadCountCheck.today;
  assert.equal(c.source, 'mixed');
  assert.equal(c.manualDays, 1);
  assert.equal(c.manualCount, 14);
  assert.equal(c.savedInCrm, 1); // only the 10 Nov lead is on a manual day
  assert.equal(c.notLogged, 13);
});

test('ledger: one team row on the manual day, salesperson rows carry no leads that day', async () => {
  const r = await run(admin, { from: '2026-11-09', to: '2026-11-10' });
  const rows = r.body.ledgerRows;
  const team = rows.filter((x) => x.isTeamCount);
  assert.equal(team.length, 1);
  assert.equal(team[0].igMainLeads, 9);
  assert.equal(team[0].whatsappLeads, 4);
  const repsOnManualDay = rows.filter((x) => !x.isTeamCount && x.date === team[0].date);
  assert.ok(repsOnManualDay.every((x) => x.whatsappLeads === 0 && x.igMainLeads === 0));
  // Totals = form leads of 9 Nov (2 IG) + team row of 10 Nov (9 IG) — not multiplied.
  assert.equal(r.body.ledgerTotals.igMainLeads, 11);
  assert.ok(!r.body.teamBreakdown.some((x) => x.id === 'team'));
});

test("one salesperson's EOD shows the same shared team count", async () => {
  const s = await run(safana, { date: '2026-11-10' });
  const m = await run(malavika, { date: '2026-11-10' });
  assert.equal(s.code, 200, JSON.stringify(s.body));
  for (const r of [s, m]) {
    assert.equal(r.body.leadsAndFollowUps.igMainLeads.today, 9);
    assert.equal(r.body.leadsAndFollowUps.whatsappLeads.today, 4);
    assert.equal(r.body.leadCountCheck.today.source, 'manual');
    assert.ok(r.body.ledgerRows.some((x) => x.isTeamCount));
  }
});

test('a day with no manual count keeps the old form-lead numbers', async () => {
  const r = await run(safana, { date: '2026-11-09' });
  assert.equal(r.body.leadsAndFollowUps.igMainLeads.today, 1); // Safana's own form lead
  assert.equal(r.body.leadCountCheck.today.source, 'form');
  assert.ok(!r.body.ledgerRows.some((x) => x.isTeamCount));
});

// ── Consistency: every place that shows the count must agree ─────────────────
import { getVerification, saveDayCounts } from '../controllers/enquiryCountController.js';

const callCtl = async (handler, user, { query = {}, body = {} } = {}) => {
  let code = 200;
  let out;
  const res = { status: (c) => ((code = c), res), json: (b) => ((out = b), res) };
  await handler({ user, query, body }, res);
  return { code, body: out };
};

const leadRowsTotal = (l, k) =>
  ['whatsappLeads', 'igMainLeads', 'igKeralaLeads', 'paidAdsLeads', 'trialCampaignLeads', 'otherLeads']
    .reduce((s, key) => s + l[key][k], 0);

test('EOD lead rows add up to the dashboard team count; cross-check matches verification', async () => {
  const eod = await run(admin, { date: '2026-11-10' });
  const ver = await callCtl(getVerification, admin, { query: { from: '2026-11-10', to: '2026-11-10' } });
  assert.equal(leadRowsTotal(eod.body.leadsAndFollowUps, 'today'), ver.body.totals.enquiries); // 14
  assert.equal(eod.body.leadCountCheck.today.manualCount, ver.body.totals.enquiries);
  assert.equal(eod.body.leadCountCheck.today.savedInCrm, ver.body.totals.leads);
  assert.equal(eod.body.leadCountCheck.today.notLogged, ver.body.totals.gap);
});

test('ledger TOTAL row equals the sum of its rows', async () => {
  const r = await run(admin, { from: '2026-11-09', to: '2026-11-10' });
  for (const k of ['whatsappLeads', 'igMainLeads', 'igKeralaLeads', 'paidAdsLeads', 'trialCampaignLeads']) {
    assert.equal(r.body.ledgerTotals[k], r.body.ledgerRows.reduce((s, x) => s + x[k], 0), k);
  }
});

test('MTD includes the report day; MTD cross-check covers every manual day of the month', async () => {
  const r = await run(admin, { date: '2026-11-10' });
  const l = r.body.leadsAndFollowUps;
  for (const k of ['whatsappLeads', 'igMainLeads', 'otherLeads']) assert.ok(l[k].mtd >= l[k].today, k);
  assert.equal(r.body.leadCountCheck.mtd.manualDays, 1);
  assert.equal(r.body.leadCountCheck.mtd.formDays, 9); // 1–9 Nov fall back to form
});

test('after an edit, the very next EOD shows the edited count everywhere', async () => {
  // Route saves into the same in-memory rows the EOD reads.
  EnquiryCount.bulkWrite = async (ops) => {
    for (const { updateOne: u } of ops) {
      const row = manual.find((m) => m.date === u.filter.date && m.channel === u.filter.channel);
      if (row) row.count = u.update.$set.count;
      else manual.push({ ...u.filter, count: u.update.$set.count });
    }
  };
  const edit = await callCtl(saveDayCounts, malavika, {
    body: { date: '2026-11-10', counts: { 'IG Leads — Main Page': 12 } },
  });
  assert.equal(edit.code, 200, JSON.stringify(edit.body));
  const eod = await run(safana, { date: '2026-11-10' });
  assert.equal(eod.body.leadsAndFollowUps.igMainLeads.today, 12);
  assert.equal(eod.body.ledgerRows.find((x) => x.isTeamCount).igMainLeads, 12);
  assert.equal(eod.body.leadCountCheck.today.manualCount, 12 + 4 + 1);
});
