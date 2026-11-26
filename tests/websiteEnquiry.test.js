// Website enquiry → Lead, with stubbed models (no database).
// node --test tests/websiteEnquiry.test.js
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import Department from '../models/Department.js';
import Notification from '../models/Notification.js';
import ServicePackage from '../models/Package.js';
import AddonService from '../models/AddonService.js';
import District from '../models/District.js';
import Region from '../models/Region.js';
import WebsiteEnquiry from '../models/WebsiteEnquiry.js';
import WebsiteSection from '../models/WebsiteSection.js';
import websitePublicRoutes from '../routes/websitePublicRoutes.js';
import { resetEnquiryLimits } from '../controllers/website/enquiryController.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import { leadFromEnquiry, validateEnquiry } from '../utils/websiteEnquiry.js';
import { previewSections } from '../utils/websitePreview.js';

// ── pure rules ───────────────────────────────────────────────────────────────
const good = { type: 'booking', name: 'Anjali Nair', phone: '+91 98765 43210', startedAt: Date.now() - 60_000 };

test('validation: required fields, formats, past dates', () => {
  assert.equal(validateEnquiry(good, { todayIso: '2026-11-17' }).ok, true);
  const bad = validateEnquiry({ name: 'A', phone: '123', email: 'x@', eventDate: '2026-11-01' }, { todayIso: '2026-11-17' });
  assert.deepEqual(bad.errors, [
    'Please enter your name.',
    'Please enter a valid phone number.',
    'Please enter a valid email address.',
    'Wedding date is in the past.',
  ]);
  assert.match(validateEnquiry({ ...good, message: 'x'.repeat(1001) }).errors[0], /Message is too long/);
});

test('spam: honeypot filled or sent too fast', () => {
  assert.equal(validateEnquiry({ ...good, company: 'Acme' }).spam, true);
  assert.equal(validateEnquiry({ ...good, startedAt: Date.now() - 500 }).spam, true);
  assert.equal(validateEnquiry(good).spam, false);
});

test('unknown slot / bad ids are dropped, not trusted', () => {
  const v = validateEnquiry({ ...good, slot: '<b>', packageId: 'nope', addonIds: ['x', '665f00000000000000000001'] }).value;
  assert.equal(v.slot, '');
  assert.equal(v.packageId, null);
  assert.deepEqual(v.addonIds, ['665f00000000000000000001']);
});

test('lead fields: source Website, remarks summarise the request', () => {
  const v = validateEnquiry({ ...good, eventDate: '2027-01-20', slot: 'evening', venue: 'Kozhikode', message: 'Hi' }).value;
  const lead = leadFromEnquiry(v, { packageName: 'Platinum', addonNames: ['Trial'] });
  assert.equal(lead.source, 'Website');
  assert.equal(lead.status, 'New');
  assert.equal(lead.eventType, 'Wedding');
  assert.equal(lead.eventDate.toISOString(), '2027-01-19T18:30:00.000Z'); // IST midnight
  assert.match(lead.remarks, /Wedding date: 2027-01-20\nSlot: Evening\nPackage: Platinum\nAdd-ons: Trial/);
});

test('rate limiter: window and reset', () => {
  const rl = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(rl.hit('a', 0).allowed, true);
  assert.equal(rl.hit('a', 10).allowed, true);
  assert.equal(rl.hit('a', 20).allowed, false);
  assert.equal(rl.hit('a', 1001).allowed, true); // new window
});

test('preview shows drafts over live content', () => {
  const s = previewSections([
    { key: 'hero', draft: { title: 'Draft' }, published: { title: 'Live' } },
    { key: 'faq', draft: {}, published: { title: 'Live FAQ' } },
    { key: 'seo', draft: {}, published: null },
  ]);
  assert.deepEqual(s, { hero: { title: 'Draft' }, faq: { title: 'Live FAQ' } });
});

// ── routes with stubbed models ───────────────────────────────────────────────
const q = (data) => {
  const c = { select: () => c, populate: () => c, lean: async () => data, then: (a, b) => Promise.resolve(data).then(a, b) };
  return c;
};
let existingLead = null;
const created = { leads: [], enquiries: [], pushes: [], notes: [], enquiryUpdates: [] };
Lead.findOne = () => q(existingLead);
Lead.create = async (doc) => {
  created.leads.push(doc);
  return { _id: 'L1', ...doc };
};
Lead.updateOne = async (f, u) => created.pushes.push(u);
// Sales team lookup (getSalesLeadIds) → one Sales leader; notify()'s admin lookup → none.
Department.find = () => q([{ _id: 'deptSales' }]);
User.find = (f) => ({ select: async () => (f?.role?.$in?.includes?.('admin') ? [] : [{ _id: 'mgr1' }]) });
Notification.insertMany = async (docs) => created.notes.push(...docs);
const DISTRICT_ID = '665f00000000000000000d01';
const REGION_ID = '665f00000000000000000e01';
// Platinum: base 20000, Malabar region 22000, Kozhikode district 25000.
ServicePackage.findOne = () =>
  q({
    _id: '665f00000000000000000001',
    name: 'Platinum (CRM)',
    price: 20000,
    regionPrices: [{ region: REGION_ID, price: 22000 }],
    districtPrices: [{ district: DISTRICT_ID, price: 25000 }],
  });
let addonRows = [];
AddonService.find = () => q(addonRows);
District.findOne = (f) =>
  q(String(f._id) === DISTRICT_ID ? { _id: DISTRICT_ID, name: 'Kozhikode', region: REGION_ID } : null);
Region.findById = () => q({ name: 'Malabar' });
WebsiteEnquiry.create = async (doc) => {
  created.enquiries.push(doc);
  return { _id: `E${created.enquiries.length}`, ...doc };
};
WebsiteEnquiry.updateOne = async (f, u) => created.enquiryUpdates.push(u.$set);

const app = express();
app.use(express.json());
app.use('/api/website/public', websitePublicRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/website/public`;
after(() => server.close());

let ipCounter = 0;
const post = async (body, ip = `10.0.0.${++ipCounter}`) => {
  const r = await fetch(`${base}/enquiry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

beforeEach(() => {
  resetEnquiryLimits();
  existingLead = null;
  for (const k of Object.keys(created)) created[k].length = 0;
});

test('new number → enquiry saved, Lead created, managers notified', async () => {
  const r = await post({ ...good, packageId: '665f00000000000000000001', eventDate: '2030-02-01' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body).sort(), ['message', 'ok']); // nothing about the CRM leaks back
  assert.equal(created.enquiries[0].packageName, 'Platinum (CRM)'); // name from the CRM, not the visitor
  assert.match(created.enquiries[0].ipHash, /^[a-f0-9]{32}$/);
  assert.equal(created.leads[0].source, 'Website');
  assert.deepEqual(created.enquiryUpdates.at(-1), { leadId: 'L1', leadAction: 'created' });
  assert.equal(created.notes[0].title, 'New lead from the website');
});

test('location + quoted total: worked out from CRM prices and copied to the Lead', async () => {
  addonRows = [{ _id: '665f0000000000000000000a', name: 'Trial', price: 8000 }];
  await post({
    ...good,
    type: 'booking',
    packageId: '665f00000000000000000001',
    districtId: DISTRICT_ID,
    addonIds: ['665f0000000000000000000a'],
    eventDate: '2030-02-01',
  });
  addonRows = [];
  assert.equal(created.enquiries[0].district, 'Kozhikode');
  assert.equal(created.enquiries[0].region, 'Malabar');
  assert.equal(created.enquiries[0].quotedTotal, 25000 + 8000);
  assert.equal(created.leads[0].district, 'Kozhikode');
  assert.equal(created.leads[0].region, 'Malabar');
  assert.match(created.leads[0].remarks, /Location: Kozhikode, Malabar/);
  assert.match(created.leads[0].remarks, /Website total shown: ₹33,000/);
});

test('existing number → note on that Lead, no duplicate', async () => {
  existingLead = { _id: 'L9', name: 'Anjali', assignedTo: 'sales7' };
  await post(good);
  assert.equal(created.leads.length, 0);
  assert.equal(created.pushes[0].$push.auditLog.action, 'website_enquiry');
  assert.deepEqual(created.enquiryUpdates.at(-1), { leadId: 'L9', leadAction: 'existing' });
  assert.deepEqual(created.notes.map((n) => n.recipient).sort(), ['mgr1', 'sales7']);
});

test('bad input → 422 with reasons; spam → friendly 201, nothing stored', async () => {
  const bad = await post({ name: '', phone: '1' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.errors.length >= 2);
  const spam = await post({ ...good, company: 'bot' });
  assert.equal(spam.status, 201);
  assert.equal(created.enquiries.length, 0);
});

test('limits: 5 per address per 10 min, 3 per phone per day', async () => {
  for (let i = 0; i < 5; i += 1) assert.equal((await post({ ...good, phone: `98765000${10 + i}` }, '1.1.1.1')).status, 201);
  const blocked = await post({ ...good, phone: '9876500099' }, '1.1.1.1');
  assert.equal(blocked.status, 429);

  resetEnquiryLimits();
  for (let i = 0; i < 3; i += 1) assert.equal((await post(good)).status, 201);
  assert.equal((await post(good)).status, 429);
});

test('preview needs a valid preview token (not a login token)', async () => {
  process.env.JWT_SECRET = 'test-secret';
  WebsiteSection.find = () => q([{ key: 'hero', draft: { title: 'Draft' }, published: null }]);
  const none = await fetch(`${base}/preview`);
  assert.equal(none.status, 401);
  const login = jwt.sign({ id: 'u1' }, 'test-secret');
  assert.equal((await fetch(`${base}/preview?token=${login}`)).status, 401);
  const token = jwt.sign({ typ: 'website-preview' }, 'test-secret', { expiresIn: 60 });
  const ok = await fetch(`${base}/preview?token=${token}`);
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).sections, { hero: { title: 'Draft' } });
});
