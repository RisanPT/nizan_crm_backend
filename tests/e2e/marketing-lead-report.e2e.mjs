// End-to-end check of the Lead Report — against a THROWAWAY local MongoDB (needs a mongod on 127.0.0.1:27099; refuses to run against
// anything else and drops its own database first):
//
//   mkdir -p /tmp/lead-e2e && mongod --port 27099 --bind_ip 127.0.0.1 --dbpath /tmp/lead-e2e --fork --logpath /tmp/lead-e2e/log
//   node tests/e2e/marketing-lead-report.e2e.mjs
//
// The document's method: the leads are the CRM's own. Create them ONCE (with their bookings, campaigns and follow-ups), then every screen
// follows — Overview, All Leads, Lead Stages, Sources, Follow-ups, Conversion, Reports — for a range, a brand, a viewer. Plus who may see
// what (contact numbers, territory, own leads), bad input, and the numbers the pure util promises — and that the campaign figures are the
// Campaigns hub's for the same range and brand (one definition: utils/marketingOutcomes.js).
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

process.env.JWT_SECRET = 'e2e-secret';
// NOTHING leaves this machine: the code under test loads the real .env (dotenv does not override a variable that is already set, even
// to ''), so every outbound service's key is blanked first — no booking e-mail, SMS, WhatsApp, maps or AI call reaches anybody.
for (const k of ['NODEMAILER_EMAIL', 'NODEMAILER_PASS', 'SMTP_HOST', 'MSG91_AUTHKEY', 'SMS_PROVIDER', 'TEAMN_CHAT_KEY', 'ORS_API_KEY', 'GEMINI_API_KEY', 'CLOUDFLARE_API_TOKEN', 'HF_TOKEN', 'POLLEN_KEY', 'REVIEW_AUTO_SEND_FROM', 'TIMEBOX_API_KEY', 'TIMEBOX_API_URL', 'CLOUDINARY_URL', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET']) {
  process.env[k] = '';
}
await mongoose.connect('mongodb://127.0.0.1:27099/marketing_lead_report_e2e');
assert.equal(mongoose.connection.host, '127.0.0.1', 'SAFETY: not the local throwaway DB');
assert.equal(mongoose.connection.port, 27099, 'SAFETY: not the throwaway port');
assert.equal(mongoose.connection.name, 'marketing_lead_report_e2e', 'SAFETY: not our own database');
await mongoose.connection.dropDatabase();

const root = new URL('../../', import.meta.url);
for (const f of readdirSync(new URL('models/', root))) await import(new URL(`models/${f}`, root));
const imp = (p) => import(new URL(p, root)).then((m) => m.default ?? m);
const User = await imp('models/User.js');
const Employee = await imp('models/Employee.js');
const Lead = await imp('models/Lead.js');
const LeadActivity = await imp('models/LeadActivity.js');
const Booking = await imp('models/Booking.js');
const Campaign = await imp('models/Campaign.js');
const Region = await imp('models/Region.js');
const GstSetting = await imp('models/GstSetting.js');
const Role = await imp('models/Role.js');
const { ensureDefaultRoles } = await import(new URL('controllers/roleController.js', root));
const { sanitizeErrorResponses, errorHandler } = await import(new URL('middleware/errorMiddleware.js', root));
const { istDay, addDays } = await import(new URL('utils/marketingTeamStats.js', root));
const { isSale } = await import(new URL('controllers/dashboardController.js', root));
const R = await import(new URL('utils/marketingLeadReportStats.js', root));
await import(new URL('utils/asyncErrors.js', root));
await ensureDefaultRoles();
await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));

const app = express();
app.use(express.json());
app.use(sanitizeErrorResponses);
app.use('/api/marketing/lead-report', await imp('routes/marketingLeadReportRoutes.js'));
app.use('/api/marketing/campaign-hub', await imp('routes/marketingCampaignHubRoutes.js'));
app.use(errorHandler);
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const origin = `http://127.0.0.1:${server.address().port}/api/marketing/lead-report`;
const hubOrigin = `http://127.0.0.1:${server.address().port}/api/marketing/campaign-hub`;

const call = async (method, path, who, root = origin) => {
  const res = await fetch(`${root}${path}`, { method, headers: who ? { authorization: `Bearer ${who.token}` } : {} });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json, text };
};

let pass = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  ✔ ${name}`); } catch (e) { failures.push(name); console.log(`  ✖ ${name}\n      ${String(e.message).split('\n').slice(0, 10).join('\n      ')}`); }
};

// ── people ────────────────────────────────────────────────────────────────────
const today = istDay(new Date());
const d = (n) => addDays(today, n);
const at = (day, hh = 10, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:30`);
const FROM = d(-6);
const RANGE = `from=${FROM}&to=${today}`;
let n = 0;
const login = async (key, role, extra = {}) => {
  n += 1;
  const emp = await Employee.create({ name: key, department: 'Marketing' });
  const user = await User.create({ name: key, email: `${key}${n}@e2e.test`, password: 'secret123', role, employeeId: emp._id, ...extra });
  return { id: String(user._id), name: key, token: jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET) };
};
await Role.updateOne({ key: 'marketing_staff' }, { $setOnInsert: { key: 'marketing_staff', label: 'Marketing staff', permissions: ['marketing'] } }, { upsert: true });
await Role.updateOne({ key: 'sales' }, { $set: { permissions: ['sales', 'marketing'] } }, { upsert: true });
const boss = await login('boss', 'marketing_admin'); //     a Marketing Manager / Admin: sees contact numbers
const staff = await login('Preethi', 'marketing_staff'); //  marketing member: reads the report, no numbers
const outsider = await login('outsider', 'crm');
const asha = await login('Asha', 'sales'); //                 a sales user: only her own leads
const ben = await login('Ben', 'manager');
const excluded = await login('Excluded', 'sales', { countInSalesTotals: false });
const kochi = await Region.create({ name: 'Kochi Region' });
const territory = await login('Territory', 'marketing_staff', { regionId: kochi._id });

// ── the CRM's records, created once ───────────────────────────────────────────
await GstSetting.create({ enabled: true, rate: 18, pricesIncludeTax: true });
// (platform / objective are passed because the Campaigns hub's enum fields default to '' — see the report). Made without a brand, so Main:
// a campaign's lead is under the CAMPAIGN's brand, so Anu (Kerala Instagram page, Bridal Campaign) counts as Main.
const C1 = await Campaign.create({ title: 'Bridal Campaign', channel: 'Instagram', platform: 'instagram', objective: 'lead_generation', adSpend: 20000, productionCost: 5000 });
const C2 = await Campaign.create({ title: 'Festive Offers', channel: 'Meta', platform: 'meta', objective: 'lead_generation', adSpend: 0 });
const sale = (extra) => Booking.create({ customerName: 'Client', service: 'Bridal', bookingDate: at(d(-2)), serviceStart: at(d(10)), serviceEnd: at(d(10), 18), status: 'confirmed', ...extra });
const B1 = await sale({ totalPrice: 11800 });
const B2 = await sale({ totalPrice: 9000, status: 'cancelled' });
const B3 = await sale({ totalPrice: 6000, discountAmount: 1000 });
const B4 = await sale({ totalPrice: 4000, createdBy: excluded.id });
const B5 = await sale({ totalPrice: 8000 });

let phone = 9876543210;
const mk = async (name, day, source, status, priority, extra = {}) => {
  const l = await Lead.create({ name, phone: String(phone), source, status, priority, leadDate: day ? at(day) : undefined, ...extra });
  phone += 1;
  return l;
};
const aRehana = await mk('Rehana P', d(-1), 'IG Leads — Main Page', 'Converted', 'Hot', { campaignId: C1._id, assignedTo: asha.id, bookingId: B1._id, remarks: 'Wants the gold set. Call 9000011111', reason: 'Booked on the first call' });
const bArjun = await mk('Arjun K', d(-2), 'IG Leads — Main Page', 'Qualified', 'Warm', { campaignId: C1._id, assignedTo: asha.id });
const cFathima = await mk('Fathima S', d(0), 'Paid Ads Leads', 'Follow-up', 'Hot', { campaignId: C2._id, assignedTo: ben.id, followUpDate: at(today, 18), followUpCount: 2, followUpCompletedCount: 1 });
const dNikhil = await mk('Nikhil R', d(-3), 'Trial Campaign Leads', 'Lost', 'Cold', { campaignId: C2._id, assignedTo: ben.id });
const eSneha = await mk('Sneha M', d(-4), 'WhatsApp (Organic)', 'New', 'Warm');
const fAnu = await mk('Anu (Kerala)', d(-5), 'IG Leads — Kerala Page', 'Converted', 'Hot', { campaignId: C1._id, assignedTo: ben.id, bookingId: B2._id, regionId: kochi._id, region: 'Kochi' });
const gMini = await mk('Mini (Kochi)', null, 'WhatsApp (Organic)', 'Contacted', 'Warm', { assignedTo: asha.id, region: 'Kochi', regionId: kochi._id });
await Lead.collection.updateOne({ _id: gMini._id }, { $set: { createdAt: at(FROM, 0, 10) } }); // 00:10 IST on the first day = the evening before in UTC
const hYusuf = await mk('Yusuf Y', d(-2), 'YouTube', 'Converted', 'Warm', { assignedTo: ben.id, bookingId: B3._id });
const iRia = await mk('Ria Ref', d(0), 'Reference', 'Follow-up', 'Warm', { assignedTo: asha.id, followUpDate: at(today, 11) });
const jWalt = await mk('Walt In', d(-3), 'Walk-in', 'Pending Lost Approval', 'Cold', { assignedTo: ben.id });
const kExcl = await mk('Excl Ex', d(-1), 'WhatsApp (Organic)', 'Converted', 'Warm', { assignedTo: asha.id, bookingId: B4._id });
const lOdd = await mk('Name (test) [x] =1+1', d(-4), 'Cold call', 'New', 'Warm', { assignedTo: asha.id });
// the period before (7 days), and one old lead (the campaign's whole life)
const p1 = await mk('Prev Converted', d(-8), 'WhatsApp (Organic)', 'Converted', 'Warm', { bookingId: B5._id, assignedTo: ben.id });
const p2 = await mk('Prev New', d(-9), 'IG Leads — Main Page', 'New', 'Warm');
await mk('Prev Lost', d(-10), 'Paid Ads Leads', 'Lost', 'Cold');
await mk('Prev Walk', d(-12), 'Walk-in', 'New', 'Warm');
const p5 = await mk('Prev Qualified', null, 'YouTube', 'Qualified', 'Warm');
await Lead.collection.updateOne({ _id: p5._id }, { $set: { createdAt: at(d(-7), 23, 50) } }); // the last evening of the period before
await mk('Old Bridal', d(-40), 'IG Leads — Main Page', 'Converted', 'Warm', { campaignId: C1._id });

const fu = (lead, type, status, when, extra = {}) => LeadActivity.create({ leadId: lead._id, createdBy: boss.id, type, status, scheduledDate: when, ...extra });
await fu(aRehana, 'followup', 'Completed', at(d(-2), 12), { remark: 'Confirmed the date' });
await fu(bArjun, 'followup', 'Pending', at(d(-2), 15), { remark: 'Send the price list', callResponse: 'No Answer', channel: 'whatsapp' });
await fu(bArjun, 'call', 'Completed', at(d(-1), 10), { callResponse: 'Connected' }); //   a call is not a follow-up
await fu(cFathima, 'followup', 'Cancelled', at(today, 18)); //                           cancelled: the lead's own date still stands
await fu(iRia, 'followup', 'Pending', at(today, 11)); //                                the same moment as the lead's date: ONE follow-up
await fu(eSneha, 'followup', 'Pending', at(d(-40), 10)); //                             long overdue, before the range
await fu(gMini, 'followup', 'Pending', at(d(1), 10)); //                                tomorrow
await fu(p1, 'followup', 'Completed', at(d(-9), 10));
await fu(p2, 'followup', 'Completed', at(d(-8), 10));

const find = (res, name) => res.body.items.find((i) => i.name === name);

console.log('\n— Overview —');
await check('the KPI strip counts the range\'s leads by stage and the conversion rate; the change is read against the period before', async () => {
  const r = await call('GET', `/overview?${RANGE}`, boss);
  assert.equal(r.status, 200, r.text);
  const k = r.body.kpis;
  assert.deepEqual([k.total, k.new, k.inProgress, k.notConverted, k.converted], [12, 2, 5, 1, 4], 'the stages are the CRM status');
  assert.equal(k.bookings, 3, 'a booking is a lead linked to a LIVE booking: Anu is Converted but her booking was cancelled');
  assert.equal(k.conversionRate, 25, 'bookings ÷ leads');
  assert.equal(k.qualified, 7);
  assert.equal(k.hot, 3);
  // the period before: 5 leads, 1 booked (20%)
  assert.equal(k.change.total, 140);
  assert.equal(k.change.converted, 300);
  assert.equal(k.change.bookings, 200);
  assert.equal(k.change.conversionRate, 5, 'points');
  assert.equal(r.body.from, FROM);
  assert.equal(r.body.brand, 'all');
});
await check('a lead counts on its IST day: the one created at 00:10 IST on the first day is in, the one at 23:50 IST the day before is in the period before', async () => {
  const leads = (await call('GET', `/leads?${RANGE}&limit=50`, boss)).body.items;
  assert.ok(leads.some((l) => l.name === 'Mini (Kochi)'), '00:10 IST on the first day');
  assert.ok(!leads.some((l) => l.name === 'Prev Qualified'));
  const before = (await call('GET', `/leads?from=${d(-13)}&to=${d(-7)}&limit=50`, boss)).body.items;
  assert.ok(before.some((l) => l.name === 'Prev Qualified'));
  assert.equal(before.length, 5);
});
await check('booking value: each booked lead\'s booking after discount with GST backed out; a cancelled one is not a booking; an excluded creator\'s adds nothing', async () => {
  const k = (await call('GET', `/overview?${RANGE}`, boss)).body.kpis;
  assert.equal(k.bookingValue, 14237.29, '11800 incl. 18% GST → 10000; 5000 → 4237.29');
  assert.equal(k.orderValue, 16800);
  assert.equal(k.unvalued, 1, 'the booking entered by a user who does not count toward sales');
  assert.equal(k.change.bookingValue, 110, 'against 8000 → 6779.66');
});
await check('the funnel: total → qualified → hot → bookings, as shares of all leads', async () => {
  const f = (await call('GET', `/overview?${RANGE}`, boss)).body.funnel;
  assert.deepEqual(f.steps.map((s) => [s.key, s.count, s.pct]), [['leads', 12, 100], ['qualified', 7, 58.3], ['hot', 3, 25], ['bookings', 3, 25]]);
});
await check('sources: the six groups (Website its own) with share and change on the period before', async () => {
  const s = (await call('GET', `/overview?${RANGE}`, boss)).body.sources;
  assert.deepEqual(s.groups.map((g) => [g.key, g.count]), [['instagram', 3], ['meta_ads', 2], ['whatsapp', 3], ['youtube', 1], ['website', 0], ['others', 3]]);
  assert.equal(s.groups.reduce((t, g) => t + g.count, 0), s.total);
  assert.equal(s.groups.find((g) => g.key === 'whatsapp').change, 200, '3 against 1');
});
await check('follow-ups summary: due = overdue + today + upcoming; a logged follow-up and the lead\'s own date are one; cancelled and calls do not count', async () => {
  const f = (await call('GET', `/overview?${RANGE}`, boss)).body.followUps;
  assert.deepEqual([f.due, f.overdue, f.today, f.upcoming, f.completed, f.total, f.overdueBefore], [3, 1, 2, 0, 1, 4, 1]);
  assert.equal(f.change.completed, -50, '1 against 2 in the period before');
});
await check('the trend adds up: a day each for a week, weeks for a longer range, and the days sum to the leads', async () => {
  const t = (await call('GET', `/overview?${RANGE}`, boss)).body.trend;
  assert.equal(t.granularity, 'day');
  assert.equal(t.rows.length, 7);
  assert.equal(t.rows.reduce((s, r) => s + r.leads, 0), 12);
  assert.equal(t.rows.reduce((s, r) => s + r.converted, 0), 4);
  assert.equal(t.rows.reduce((s, r) => s + r.bookings, 0), 3);
  const long = (await call('GET', `/overview?from=${d(-45)}&to=${today}`, boss)).body;
  assert.equal(long.trend.granularity, 'week');
  assert.equal(long.kpis.total, 18, '12 + 5 + the old one');
  assert.equal(long.trend.rows.reduce((s, r) => s + r.leads, 0), 18);
});
await check('top campaigns by leads; the lifetime ad spend typed on the old Campaigns screen is NOT a cost here — no daily spend, no cost', async () => {
  const o = (await call('GET', `/overview?${RANGE}`, boss)).body;
  const c = o.campaigns;
  assert.equal(c.untagged, 7);
  assert.deepEqual(c.rows.map((r) => [r.title, r.leads, r.bookings]), [['Bridal Campaign', 3, 1], ['Festive Offers', 2, 0]]);
  const bridal = c.rows[0];
  assert.deepEqual([bridal.spend, bridal.costPerLead, bridal.costPerBooking], [null, null, null], 'the ₹20,000 typed on the old screen has no dates, so it is not used');
  assert.equal(bridal.bookingValue, 10000);
  assert.deepEqual(c.costs, { campaignsWithSpend: 0, campaignsTotal: 2, adSpend: null, leads: 5, bookings: 1, costPerLead: null, costPerBooking: null });
  assert.deepEqual(o.campaignTypes.map((t) => [t.key, t.leads]), [['lead_gen', 5]], 'Leads by Campaign Type: both campaigns are Lead Generation');
});
await check('the brand narrows everything; the same lead is the same thing as in the other modules', async () => {
  const k = await call('GET', `/overview?${RANGE}&brand=kerala`, boss);
  assert.equal(k.body.kpis.total, 1, 'the one in Kochi; Anu came from the Kerala page but through a Main campaign, so she is Main (as on the Campaigns hub)');
  assert.equal(k.body.kpis.converted, 0);
  const m = await call('GET', `/overview?${RANGE}&brand=main`, boss);
  assert.equal(m.body.kpis.total, 11);
  assert.equal(m.body.kpis.total + k.body.kpis.total, 12);
  assert.deepEqual(k.body.campaigns.rows, [], 'no Kerala campaign has a lead');
});
await check('an empty range is honest: zeros and no rate, not a made-up number', async () => {
  const r = (await call('GET', `/overview?from=${d(100)}&to=${d(106)}`, boss)).body;
  assert.equal(r.kpis.total, 0);
  assert.equal(r.kpis.conversionRate, null);
  assert.equal(r.kpis.change.total, null);
  assert.deepEqual(r.campaigns.rows, []);
  assert.equal(r.campaigns.costs.costPerBooking, null);
  assert.equal(r.funnel.steps[3].pct, null);
});

console.log('\n— All Leads —');
await check('the list: stage chips with counts, newest first, one page at a time', async () => {
  const r = await call('GET', `/leads?${RANGE}&limit=5`, boss);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.counts, { all: 12, new: 2, in_progress: 5, not_converted: 1, converted: 4 });
  assert.equal(r.body.total, 12);
  assert.equal(r.body.items.length, 5);
  assert.equal(r.body.pageSize, 5);
  const days = r.body.items.map((l) => l.createdDay);
  assert.deepEqual(days, [...days].sort().reverse(), 'newest first');
  const p3 = await call('GET', `/leads?${RANGE}&limit=5&page=3`, boss);
  assert.equal(p3.body.items.length, 2);
  assert.equal((await call('GET', `/leads?${RANGE}&limit=5&page=4`, boss)).body.items.length, 0);
  const row = find(await call('GET', `/leads?${RANGE}&limit=50`, boss), 'Rehana P');
  assert.deepEqual([row.sourceLabel, row.campaign, row.assignedTo, row.status, row.stage, row.priority], ['Instagram (Main)', 'Bridal Campaign', 'Asha', 'Converted', 'converted', 'Hot']);
  assert.match(row.shortId, /^#[0-9A-F]{6}$/);
});
await check('a stage chip, a source group, brand and sort each narrow or order the list; chip counts follow the search', async () => {
  assert.equal((await call('GET', `/leads?${RANGE}&stage=converted`, boss)).body.total, 4);
  assert.equal((await call('GET', `/leads?${RANGE}&stage=in_progress`, boss)).body.total, 5);
  const ig = await call('GET', `/leads?${RANGE}&source=instagram&limit=50`, boss);
  assert.deepEqual(ig.body.items.map((l) => l.name).sort(), ['Anu (Kerala)', 'Arjun K', 'Rehana P']);
  assert.equal((await call('GET', `/leads?${RANGE}&brand=kerala`, boss)).body.counts.all, 1);
  const byName = await call('GET', `/leads?${RANGE}&sort=name&dir=asc&limit=3`, boss);
  assert.deepEqual(byName.body.items.map((l) => l.name), ['Anu (Kerala)', 'Arjun K', 'Excl Ex']);
  const search = await call('GET', `/leads?${RANGE}&q=bridal`, boss);
  assert.deepEqual(search.body.counts, { all: 3, new: 0, in_progress: 1, not_converted: 0, converted: 2 }, 'the campaign matches Rehana, Arjun and Anu; counts follow the search');
  assert.equal((await call('GET', `/leads?${RANGE}&q=asha`, boss)).body.total, 6, 'the assignee matches');
});
await check('search treats text as text: brackets and dots are not a pattern; a phone number finds the lead however it is typed', async () => {
  assert.equal((await call('GET', `/leads?${RANGE}&q=${encodeURIComponent('(test) [x]')}`, boss)).body.total, 1);
  assert.equal((await call('GET', `/leads?${RANGE}&q=${encodeURIComponent('.*')}`, boss)).body.total, 0);
  assert.equal((await call('GET', `/leads?${RANGE}&q=${encodeURIComponent('+91 98765 43210')}`, boss)).body.items[0].name, 'Rehana P');
  assert.equal((await call('GET', `/leads?${RANGE}&q=${encodeURIComponent('98765-43210')}`, boss)).body.total, 1);
});
await check('contact numbers: a manager sees them; a member sees them masked, cannot search by them, and the free text stays hidden', async () => {
  const boss1 = find(await call('GET', `/leads?${RANGE}&limit=50`, boss), 'Rehana P');
  assert.equal(boss1.phone, '9876543210');
  const r = await call('GET', `/leads?${RANGE}&limit=50`, staff);
  const s1 = find(r, 'Rehana P');
  assert.equal(r.body.canContact, false);
  assert.equal(s1.phone, '', 'the number never leaves the server');
  assert.equal(s1.phoneMasked, '98••••••10');
  assert.ok(!r.text.includes('9876543210') && !r.text.includes('9876543211'), 'no number anywhere in the answer');
  assert.equal((await call('GET', `/leads?${RANGE}&q=${encodeURIComponent('98765 43210')}`, staff)).body.total, 0, 'a number cannot be probed');
  assert.equal((await call('GET', `/leads?${RANGE}&q=rehana`, staff)).body.total, 1, 'names still work');
});
await check('one lead, read-only: facts, counters, booking value and the follow-up history; a manager reads the notes', async () => {
  const r = await call('GET', `/leads/${aRehana._id}`, boss);
  assert.equal(r.status, 200, r.text);
  const l = r.body;
  assert.deepEqual([l.name, l.status, l.stage, l.priority, l.qualified, l.brand, l.campaign, l.assignedTo, l.sourceLabel], ['Rehana P', 'Converted', 'converted', 'Hot', true, 'main', 'Bridal Campaign', 'Asha', 'Instagram (Main)']);
  assert.deepEqual(l.booking && { counted: l.booking.counted, value: l.booking.value, status: l.booking.status }, { counted: true, value: 10000, status: 'confirmed' });
  assert.equal(l.phone, '9876543210');
  assert.match(l.remarks, /gold set/);
  assert.equal(l.reason, 'Booked on the first call');
  assert.deepEqual(l.activities.map((a) => [a.type, a.status, a.remark]), [['followup', 'Completed', 'Confirmed the date']]);
  const c = (await call('GET', `/leads/${cFathima._id}`, boss)).body;
  assert.deepEqual([c.followUpState, c.followUpCount, c.followUpCompletedCount], ['today', 2, 1]);
  const b = (await call('GET', `/leads/${bArjun._id}`, boss)).body;
  assert.deepEqual(b.activities.map((a) => a.type).sort(), ['call', 'followup'], 'calls are in the history, just not counted as follow-ups');
  assert.equal(b.booking, null);
  const f = (await call('GET', `/leads/${fAnu._id}`, boss)).body;
  assert.deepEqual([f.booking.counted, f.booking.value], [false, null], 'a cancelled booking is shown but adds no value');
  const s = (await call('GET', `/leads/${aRehana._id}`, staff)).body;
  assert.deepEqual([s.phone, s.remarks, s.reason, s.activities[0].remark], ['', '', '', ''], 'a member does not read the notes or numbers');
  assert.equal(s.phoneMasked, '98••••••10');
});
await check('a lead that does not exist, an invalid id, or a lead outside the viewer\'s own: not found', async () => {
  assert.equal((await call('GET', '/leads/not-an-id', boss)).status, 404);
  assert.equal((await call('GET', '/leads/64b7f0c2a1b2c3d4e5f60718', boss)).status, 404);
  assert.equal((await call('GET', `/leads/${cFathima._id}`, asha)).status, 404, 'Fathima is Ben\'s lead; Asha is a sales user');
  assert.equal((await call('GET', `/leads/${aRehana._id}`, asha)).status, 200);
  assert.equal((await call('GET', `/leads/${aRehana._id}`, territory)).status, 404, 'outside the territory');
  assert.equal((await call('GET', `/leads/${fAnu._id}`, territory)).status, 200);
});

console.log('\n— Lead Stages —');
await check('stage tiles with shares and change, the CRM\'s own statuses, quality, and the stage trend', async () => {
  const r = await call('GET', `/stages?${RANGE}`, boss);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.stages.map((s) => [s.key, s.count, s.pct]), [['new', 2, 16.7], ['in_progress', 5, 41.7], ['not_converted', 1, 8.3], ['converted', 4, 33.3]]);
  assert.equal(r.body.stages.find((s) => s.key === 'converted').change, 300);
  assert.deepEqual(r.body.statuses.map((s) => [s.status, s.count]), [['New', 2], ['Contacted', 1], ['Qualified', 1], ['Follow-up', 2], ['Pending Lost Approval', 1], ['Lost', 1], ['Converted', 4]]);
  assert.deepEqual(r.body.quality.rows.map((q) => [q.key, q.count]), [['Hot', 3], ['Warm', 7], ['Nurture', 0], ['Cold', 2]], 'every lead is rated: no "Not rated"');
  const day = r.body.trend.rows.find((x) => x.from === d(-1));
  assert.deepEqual([day.leads, day.converted], [2, 2], 'Rehana and Excl arrived yesterday and are converted now');
  assert.equal(r.body.trend.rows.reduce((t, x) => t + x.leads, 0), 12);
});

console.log('\n— Sources —');
await check('the source groups and a table by source with qualified, hot and conversion; the campaigns list with cost', async () => {
  const r = await call('GET', `/sources?${RANGE}`, boss);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.groups.map((g) => [g.key, g.count, g.pct]), [['instagram', 3, 25], ['meta_ads', 2, 16.7], ['whatsapp', 3, 25], ['youtube', 1, 8.3], ['website', 0, 0], ['others', 3, 25]]);
  const ig = r.body.sources.find((s) => s.key === 'ig_main');
  assert.deepEqual([ig.leads, ig.qualified, ig.hot, ig.bookings, ig.rate, ig.bookingValue], [2, 2, 1, 1, 50, 10000]);
  assert.equal(r.body.sources.reduce((t, s) => t + s.leads, 0), 12);
  assert.equal(r.body.campaigns.rows[0].costPerLead, null, 'no spend recorded yet');
  assert.equal(r.body.campaigns.untagged, 7);
  assert.deepEqual(r.body.campaignTypes.map((t) => t.key), ['lead_gen']);
});

console.log('\n— Follow-ups —');
await check('the counts and the list, one chip at a time, with the lead, campaign, assignee, due time and state', async () => {
  const all = await call('GET', `/followups?${RANGE}`, boss);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual([all.body.counts.due, all.body.counts.overdue, all.body.counts.today, all.body.counts.upcoming, all.body.counts.completed, all.body.counts.overdueBefore], [3, 1, 2, 0, 1, 1]);
  assert.equal(all.body.total, 4);
  assert.deepEqual(all.body.items.map((i) => [i.name, i.state]), [['Rehana P', 'completed'], ['Arjun K', 'overdue'], ['Ria Ref', 'today'], ['Fathima S', 'today']]);
  const overdue = await call('GET', `/followups?${RANGE}&filter=overdue`, boss);
  assert.deepEqual(overdue.body.items.map((i) => [i.name, i.campaign, i.assignedTo, i.dueDay, i.kind, i.remark, i.channel, i.channelLabel]), [['Arjun K', 'Bridal Campaign', 'Asha', d(-2), 'activity', 'Send the price list', 'whatsapp', 'WhatsApp']], 'the follow-up\'s type, as logged in the CRM');
  assert.ok(all.body.items.filter((i) => i.name !== 'Arjun K').every((i) => i.channel === '' && i.channelLabel === 'Follow-up'), 'one logged without a type, or a date on the lead, reads "Follow-up"');
  const today1 = await call('GET', `/followups?${RANGE}&filter=today`, boss);
  assert.deepEqual(today1.body.items.map((i) => [i.name, i.kind]), [['Ria Ref', 'activity'], ['Fathima S', 'lead']], 'Ria is ONE item; Fathima comes from the lead\'s own date (her logged one was cancelled)');
  assert.equal((await call('GET', `/followups?${RANGE}&filter=completed`, boss)).body.items[0].name, 'Rehana P');
  assert.equal((await call('GET', `/followups?${RANGE}&filter=upcoming`, boss)).body.total, 0);
  assert.equal((await call('GET', `/followups?${RANGE}&limit=2&page=2`, boss)).body.items.length, 2);
});
await check('upcoming follow-ups appear when the range reaches tomorrow; overdue ones from before the range are counted, not lost', async () => {
  const r = await call('GET', `/followups?from=${today}&to=${d(3)}&filter=upcoming`, boss);
  assert.deepEqual(r.body.items.map((i) => [i.name, i.state, i.dueDay]), [['Mini (Kochi)', 'upcoming', d(1)]]);
  assert.deepEqual([r.body.counts.due, r.body.counts.today, r.body.counts.upcoming], [3, 2, 1]);
  assert.equal(r.body.counts.overdueBefore, 2, 'still pending and before today: 40 days ago (Sneha) and Arjun\'s two days ago; today\'s two are not overdue yet');
  const wide = await call('GET', `/followups?from=${d(-45)}&to=${today}&filter=overdue`, boss);
  assert.deepEqual(wide.body.items.map((i) => i.name), ['Sneha M', 'Arjun K']);
});
await check('the brand of the LEAD decides which follow-ups a brand sees', async () => {
  const k = await call('GET', `/followups?${RANGE}&brand=kerala`, boss);
  assert.equal(k.body.total, 0);
  const wk = await call('GET', `/followups?from=${today}&to=${d(3)}&brand=kerala`, boss);
  assert.deepEqual(wk.body.items.map((i) => i.name), ['Mini (Kochi)']);
});
await check('contact: a manager gets numbers for the call and WhatsApp buttons; a member gets none — and no notes', async () => {
  const b = await call('GET', `/followups?${RANGE}&filter=overdue`, boss);
  assert.equal(b.body.canContact, true);
  assert.equal(b.body.items[0].phone, '9876543211');
  const s = await call('GET', `/followups?${RANGE}`, staff);
  assert.equal(s.body.canContact, false);
  assert.ok(s.body.items.every((i) => i.phone === '' && i.remark === '' && /^\d\d•+\d\d$/.test(i.phoneMasked)));
  assert.ok(!/987654321\d/.test(s.text), 'no number anywhere in the answer');
});

console.log('\n— Conversion —');
await check('conversion: rate, bookings, booking value, cost per booking where known, the funnel, the trend and conversion by source', async () => {
  const r = await call('GET', `/conversion?${RANGE}`, boss);
  assert.equal(r.status, 200, r.text);
  const k = r.body.kpis;
  assert.deepEqual([k.conversionRate, k.bookings, k.bookingValue, k.orderValue, k.unvalued], [25, 3, 14237.29, 16800, 1]);
  assert.equal(r.body.costs.costPerBooking, null, 'no ad spend recorded in the range');
  assert.deepEqual(r.body.funnel.steps.map((s) => s.count), [12, 7, 3, 3]);
  assert.equal(r.body.trend.rows.reduce((t, x) => t + x.leads, 0), 12);
  assert.equal(r.body.trend.rows.reduce((t, x) => t + x.bookings, 0), k.bookings, 'the trend adds up to the card');
  const by = Object.fromEntries(r.body.bySource.map((s) => [s.key, [s.leads, s.bookings, s.rate]]));
  assert.deepEqual(by.ig_main, [2, 1, 50]);
  assert.deepEqual(by.whatsapp, [3, 1, 33.3]);
  assert.deepEqual(by.youtube, [1, 1, 100]);
  assert.deepEqual(by.meta_ads, [2, 0, 0]);
  assert.equal(r.body.bySource.reduce((t, s) => t + s.leads, 0), 12);
});
await check('a Converted lead whose booking was cancelled is in the Converted stage but is not a booking; no ad spend anywhere → no cost per booking', async () => {
  const r = await call('GET', `/conversion?from=${d(-5)}&to=${d(-5)}&brand=main`, boss);
  assert.deepEqual([r.body.kpis.converted, r.body.kpis.bookings, r.body.kpis.bookingValue, r.body.kpis.unvalued], [1, 0, 0, 0], 'Anu: Converted, booking cancelled');
  const none = await call('GET', `/conversion?from=${d(-3)}&to=${d(-3)}`, boss);
  assert.equal(none.body.costs.costPerBooking, null);
  assert.equal(none.body.costs.adSpend, null);
});

console.log('\n— Reports —');
await check('the five reports and the two lists each come back as a table, as wide as their columns', async () => {
  for (const type of ['summary', 'sources', 'campaigns', 'team', 'conversion', 'leads', 'followups']) {
    const r = await call('GET', `/reports/${type}?${RANGE}`, boss);
    assert.equal(r.status, 200, `${type}: ${r.text}`);
    assert.ok(r.body.columns.length > 2 && r.body.rows.length > 0, type);
    for (const row of r.body.rows) assert.equal(row.length, r.body.columns.length, `${type}: ${JSON.stringify(row)}`);
    assert.equal(r.body.type, type);
    assert.equal(r.body.from, FROM);
    assert.ok(r.body.generatedAt);
  }
});
await check('the numbers in the reports are the numbers on the screens', async () => {
  const sum = (await call('GET', `/reports/summary?${RANGE}`, boss)).body;
  const val = (label) => sum.rows.find((r) => r[0] === label)[1];
  assert.deepEqual([val('Total leads'), val('New'), val('In progress'), val('Not converted'), val('Converted (CRM stage)'), val('Bookings'), val('Booking value (ex-GST)'), val('Follow-ups due'), val('Follow-ups overdue'), val('Follow-ups completed')], [12, 2, 5, 1, 4, 3, 14237.29, 3, 1, 1]);
  const camp = (await call('GET', `/reports/campaigns?${RANGE}`, boss)).body;
  assert.deepEqual(camp.rows[0].slice(0, 6), ['Bridal Campaign', 'Instagram', 'main', 3, 3, 1]);
  assert.deepEqual([camp.rows[0][8], camp.rows[0][9]], ['', ''], 'no ad spend in the range → empty, not zero');
  const team = (await call('GET', `/reports/team?${RANGE}`, boss)).body;
  const by = Object.fromEntries(team.rows.map((r) => [r[0], r]));
  assert.deepEqual([by.Asha[1], by.Asha[4], by.Asha[5], by.Asha[6], by.Asha[7], by.Asha[8], by.Asha[9]], [6, 2, 33.3, 10000, 2, 1, 1], 'Asha: 6 leads; Rehana and Excl converted; follow-ups: Arjun overdue and Ria today are due, Rehana\'s is completed');
  assert.deepEqual([by.Ben[1], by.Ben[4], by.Ben[5], by.Ben[6]], [5, 1, 20, 4237.29], 'Anu\'s booking was cancelled: not a booking');
  assert.equal(by.Unassigned[1], 1);
  const conv = (await call('GET', `/reports/conversion?${RANGE}`, boss)).body;
  assert.deepEqual(conv.rows[0].slice(0, 5), ['Headline', 'Conversion rate', 12, 3, 25]);
  const fus = (await call('GET', `/reports/followups?${RANGE}`, boss)).body;
  assert.ok(fus.columns.includes('Type') && fus.rows.some((r) => r.includes('WhatsApp')));
  const src = (await call('GET', `/reports/sources?${RANGE}`, boss)).body;
  assert.equal(src.rows.reduce((t, r) => t + r[1], 0), 12);
});
await check('the lead and follow-up exports carry phone numbers only for a manager; the free text of a lead stays as typed', async () => {
  const m = (await call('GET', `/reports/leads?${RANGE}`, boss)).body;
  assert.ok(m.columns.includes('Phone'));
  assert.equal(m.rows.length, 12);
  assert.ok(m.rows.some((r) => r[1] === 'Name (test) [x] =1+1'), 'the server sends text as it is; the CSV writer neutralises formulas');
  const s = await call('GET', `/reports/leads?${RANGE}`, staff);
  assert.ok(!s.body.columns.includes('Phone'));
  assert.ok(!/987654321\d/.test(s.text));
  const sf = await call('GET', `/reports/followups?${RANGE}`, staff);
  assert.ok(!sf.body.columns.includes('Phone') && !/987654321\d/.test(sf.text));
  assert.ok((await call('GET', `/reports/followups?${RANGE}`, boss)).body.columns.includes('Phone'));
});
await check('an unknown report is not found', async () => {
  assert.equal((await call('GET', `/reports/payroll?${RANGE}`, boss)).status, 404);
  assert.equal((await call('GET', `/reports/__proto__?${RANGE}`, boss)).status, 404);
});

console.log('\n— who sees which leads —');
await check('a sales user sees only her own leads, in every screen', async () => {
  const o = await call('GET', `/overview?${RANGE}`, asha);
  assert.equal(o.status, 200, o.text);
  assert.equal(o.body.kpis.total, 6);
  assert.equal(o.body.campaigns.costs.adSpend, null, 'a partial view must not show a whole campaign\'s spend');
  assert.ok(o.body.campaigns.rows.every((c) => c.spend === null && c.costPerLead === null));
  assert.equal((await call('GET', `/leads?${RANGE}&limit=50`, asha)).body.total, 6);
  assert.deepEqual((await call('GET', `/followups?${RANGE}`, asha)).body.items.map((i) => i.name).sort(), ['Arjun K', 'Rehana P', 'Ria Ref']);
  assert.equal((await call('GET', `/conversion?${RANGE}`, asha)).body.kpis.converted, 2);
});
await check('a territory-scoped member sees only the leads of their region', async () => {
  const o = await call('GET', `/overview?${RANGE}`, territory);
  assert.equal(o.body.kpis.total, 2, 'Anu and Mini are in the Kochi region');
  assert.deepEqual((await call('GET', `/leads?${RANGE}`, territory)).body.items.map((l) => l.name).sort(), ['Anu (Kerala)', 'Mini (Kochi)']);
  assert.ok(o.body.campaigns.rows.every((c) => c.spend === null));
  const fu = await call('GET', `/followups?${RANGE}`, territory);
  assert.equal(fu.body.total, 0, 'every follow-up in the range belongs to a lead outside the territory — even those found through a logged follow-up');
  assert.equal(fu.body.counts.overdueBefore, 0);
  assert.deepEqual((await call('GET', `/followups?from=${today}&to=${d(3)}`, territory)).body.items.map((i) => i.name), ['Mini (Kochi)']);
});
await check('the loaders the Weekly Report reuses give the figures the screens show', async () => {
  const { leadScopeFor, loadLeadWindow, bookingContext, loadFollowUps } = await import(new URL('services/marketingLeadReportData.js', root));
  const range = { from: FROM, to: today, brand: 'all' };
  const scope = await leadScopeFor(await User.findById(boss.id));
  assert.deepEqual(scope, {});
  const leads = await loadLeadWindow(range, scope);
  const p = R.leadPeriod({ leads, range, ctx: await bookingContext(leads) });
  assert.deepEqual([p.now.total, p.now.converted, p.now.bookings, p.now.bookingValue, p.now.conversionRate, p.before.total, p.change.total], [12, 4, 3, 14237.29, 25, 5, 140]);
  assert.deepEqual(p.now.quality.rows.map((q) => q.count), [3, 7, 0, 2]);
  assert.deepEqual(p.now.sources.rows.map((r) => [r.key, r.count]), [['whatsapp', 3], ['ig_main', 2], ['meta_ads', 2], ['ig_kerala', 1], ['youtube', 1], ['reference', 1], ['walk_in', 1], ['other', 1]]);
  const f = R.followUpPeriod(await loadFollowUps(range, scope), range, today);
  assert.deepEqual([f.due, f.today, f.overdue, f.completed, f.overdueBefore], [3, 2, 1, 1, 1]);
  const sales = await User.findById(asha.id);
  assert.deepEqual(await leadScopeFor(sales), { assignedTo: sales._id });
});

console.log('\n— bad input and access —');
await check('every endpoint refuses what it cannot read, in plain words', async () => {
  for (const path of ['/overview', '/leads', '/stages', '/sources', '/followups', '/conversion', '/reports/summary']) {
    for (const q of ['from=2026-02-31', 'from=abc&to=2026-11-01', 'from=2026-11-10&to=2026-11-01', 'from=2024-01-01&to=2026-11-01', 'brand=mars', 'from=2026-11-01&from=2026-11-02']) {
      const r = await call('GET', `${path}?${q}`, boss);
      assert.equal(r.status, 400, `${path}?${q} → ${r.status}`);
      assert.ok(r.body.message && r.body.message.length > 5, `${path}?${q}`);
    }
  }
  for (const q of ['stage=won', 'source=tv', 'sort=phone', 'dir=up', 'page=two', 'limit=1.5', 'q=a&q=b', 'assignee=Asha', 'campaign=Bridal', 'campaign[$ne]=x']) assert.equal((await call('GET', `/leads?${RANGE}&${q}`, boss)).status, 400, q);
  for (const q of ['filter=soon', 'page=x', 'limit=-3']) assert.equal((await call('GET', `/followups?${RANGE}&${q}`, boss)).status, 400, q);
});
await check('someone outside Marketing is refused everywhere; no login is refused; nothing can be written', async () => {
  for (const path of ['/overview', '/leads', `/leads/${aRehana._id}`, '/stages', '/sources', '/followups', '/conversion', '/reports/summary']) {
    assert.equal((await call('GET', path, outsider)).status, 403, path);
    assert.equal((await call('GET', path)).status, 401, path);
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) assert.equal((await call(method, `/leads/${aRehana._id}`, boss)).status, 404, `${method}: there is no write endpoint`);
  assert.equal((await Lead.findById(aRehana._id).lean()).status, 'Converted');
});
await check('the booking list used for "a sale" is the dashboards\' own', async () => {
  for (const status of ['confirmed', 'completed', 'Confirmed', '', 'cancelled', 'Cancelled', 'canceled', 'rejected', 'lost', 'draft', 'pending', 'Pending', 'in-progress']) assert.equal(R.isSaleBooking({ status }), isSale({ status }), status);
});

console.log('\n— All Leads: Assigned to and Campaign filters —');
await check('the list narrows by the person a lead is assigned to (or nobody) and by its campaign (or none); the choices come with the list', async () => {
  const r = await call('GET', `/leads?${RANGE}&limit=50`, boss);
  assert.deepEqual(r.body.filters.assignees.map((a) => [a.name, a.count]), [['Asha', 6], ['Ben', 5]]);
  assert.deepEqual([r.body.filters.unassigned, r.body.filters.untagged], [1, 7]);
  assert.deepEqual(r.body.filters.campaigns.map((c) => [c.title, c.count]), [['Bridal Campaign', 3], ['Festive Offers', 2]]);
  assert.equal((await call('GET', `/leads?${RANGE}&assignee=${asha.id}`, boss)).body.total, 6);
  assert.deepEqual((await call('GET', `/leads?${RANGE}&assignee=unassigned`, boss)).body.items.map((l) => l.name), ['Sneha M']);
  const bridal = await call('GET', `/leads?${RANGE}&campaign=${C1._id}&limit=50`, boss);
  assert.deepEqual(bridal.body.items.map((l) => l.name).sort(), ['Anu (Kerala)', 'Arjun K', 'Rehana P']);
  assert.deepEqual(bridal.body.counts, { all: 3, new: 0, in_progress: 1, not_converted: 0, converted: 2 }, 'the chips follow the filters');
  assert.equal((await call('GET', `/leads?${RANGE}&campaign=none`, boss)).body.total, 7);
  assert.deepEqual((await call('GET', `/leads?${RANGE}&campaign=${C1._id}&assignee=${ben.id}`, boss)).body.items.map((l) => l.name), ['Anu (Kerala)']);
  assert.equal((await call('GET', `/leads?${RANGE}&campaign=${C1._id}`, boss)).body.items[0].campaignId, String(C1._id));
});

console.log('\n— Lead quality —');
await check('Nurture is a quality of its own; a lead with no priority is "Not rated" (shown only then), never Warm', async () => {
  const far = d(-200);
  const nurture = await mk('Long way off', far, 'WhatsApp (Organic)', 'Contacted', 'Nurture');
  const unrated = await mk('Never rated', far, 'WhatsApp (Organic)', 'New', 'Warm');
  await Lead.collection.updateOne({ _id: unrated._id }, { $unset: { priority: '' } }); // made before the field existed
  const r = (await call('GET', `/stages?from=${far}&to=${far}`, boss)).body;
  assert.deepEqual(r.quality.rows.map((q) => [q.key, q.count]), [['Hot', 0], ['Warm', 0], ['Nurture', 1], ['Cold', 0], ['Not rated', 1]]);
  const list = (await call('GET', `/leads?from=${far}&to=${far}`, boss)).body.items;
  assert.deepEqual(list.map((l) => [l.name, l.priority]).sort(), [['Long way off', 'Nurture'], ['Never rated', 'Not rated']]);
  await Lead.deleteMany({ _id: { $in: [nurture._id, unrated._id] } });
});

console.log('\n— one source: the Lead Report\'s campaign figures ARE the Campaigns hub\'s —');
await check('spend, cost per lead and per booking are the range\'s daily ad spend (the hub\'s records); the lifetime figure of the old screen is not used', async () => {
  const Metric = await imp('models/CampaignDailyMetric.js');
  await Metric.create([{ campaignId: C2._id, day: d(-1), spend: 3000 }, { campaignId: C2._id, day: d(-40), spend: 2000 }, { campaignId: C1._id, day: d(-2), spend: 1500 }]);
  const o = await call('GET', `/overview?${RANGE}`, boss);
  assert.equal(o.status, 200);
  const rows = o.body.campaigns.rows;
  const festive = rows.find((r) => r.title === 'Festive Offers');
  const bridal = rows.find((r) => r.title === 'Bridal Campaign');
  assert.deepEqual([festive.spend, festive.costPerLead, festive.costPerBooking], [3000, 1500, null], 'only the day inside the range; ÷ its 2 leads of the range');
  assert.deepEqual([bridal.spend, bridal.costPerLead, bridal.costPerBooking], [1500, 500, 1500], 'not the ₹20,000 typed on the old screen');
  assert.deepEqual(o.body.campaigns.costs, { campaignsWithSpend: 2, campaignsTotal: 2, adSpend: 4500, leads: 5, bookings: 1, costPerLead: 900, costPerBooking: 4500 });
});
await check('for the same range and brand, every campaign figure on the Lead Report equals the Campaigns hub\'s: leads, qualified, bookings, booking value, spend, cost per lead, conversion', async () => {
  for (const brand of ['all', 'main', 'kerala']) {
    const q = `${RANGE}&brand=${brand}`;
    const lr = (await call('GET', `/sources?${q}`, boss)).body;
    const conv = (await call('GET', `/conversion?${q}`, boss)).body;
    const hubList = await call('GET', `/campaigns?${q}&limit=50`, boss, hubOrigin);
    const hubOverview = await call('GET', `/overview?${q}`, boss, hubOrigin);
    assert.equal(hubList.status, 200, hubList.text);
    const hubBy = Object.fromEntries(hubList.body.items.map((c) => [c.id, c]));
    for (const r of lr.campaigns.rows) {
      const h = hubBy[r.id];
      assert.ok(h, `${brand}: ${r.title} is on the hub`);
      assert.deepEqual(
        [r.leads, r.qualified, r.bookings, r.bookingValue, r.spend ?? 0, r.costPerLead, r.costPerBooking, r.rate],
        [h.leads, h.qualified, h.bookings, h.revenue, h.spend, h.cpl, h.spend > 0 && h.bookings > 0 ? Math.round((h.spend / h.bookings) * 100) / 100 : null, h.conversionRate],
        `${brand}: ${r.title}`,
      );
    }
    // every hub campaign with leads in the range is on the Lead Report too
    for (const h of hubList.body.items.filter((c) => c.leads > 0)) assert.ok(lr.campaigns.rows.some((r) => r.id === h.id), `${brand}: ${h.title} is on the Lead Report`);
    const k = hubOverview.body.kpis.now;
    assert.deepEqual([lr.campaigns.costs.adSpend ?? 0, lr.campaigns.costs.leads, lr.campaigns.costs.bookings, lr.campaigns.costs.costPerLead], [k.spend, k.leads, k.bookings, k.cpl], `${brand}: the overall cost`);
    assert.deepEqual(conv.costs, lr.campaigns.costs, `${brand}: Conversion shows the same costs`);
    assert.deepEqual(lr.campaignTypes, hubOverview.body.leadsByType, `${brand}: Leads by Campaign Type flows on to the Lead Report`);
  }
});

await mongoose.connection.dropDatabase();
server.close();
await mongoose.disconnect();
console.log(`\n${pass} passed${failures.length ? `, ${failures.length} FAILED:\n - ${failures.join('\n - ')}` : ''}`);
process.exit(failures.length ? 1 : 0);
