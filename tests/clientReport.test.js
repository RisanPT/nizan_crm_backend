// Client report PDF: the HTML builder (pure) and the endpoint with the models,
// Chrome and Cloudinary stubbed — no database, no browser, no network.
//   node --test tests/clientReport.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Consultation from '../models/Consultation.js';
import StylistClient from '../models/StylistClient.js';
import * as ctl from '../controllers/stylistClientController.js';
import { accessFor } from '../utils/consultationRules.js';
import {
  agreedLook,
  buildClientReportHtml,
  isReportImageUrl,
  printSizedUrl,
} from '../utils/clientReport.js';

const mongoose = Consultation.base;
const oid = () => new mongoose.Types.ObjectId();
const NOW = new Date('2026-11-06T06:00:00.000Z');
const IMG = 'https://res.cloudinary.com/demo/image/upload/v1/team_n_crm/consultations/a.jpg';
const IMG2 = 'https://res.cloudinary.com/demo/image/upload/v1/team_n_crm/consultations/b.jpg';

const client = (over = {}) => ({
  _id: oid(),
  clientNo: 'SC-261105-4821',
  company: 'Nizan',
  name: 'Riya <Joseph>',
  phone: '9876543210',
  eventType: 'Reception',
  eventDates: ['2026-12-20'],
  venue: 'Thrissur',
  packageName: 'Bridal premium',
  artistNames: ['Asha'],
  outfitDetails: 'Lehenga',
  notes: 'Prefers evening calls',
  requiredCalls: 4,
  stylistId: { _id: oid(), name: 'Priya' },
  ...over,
});

const call = (over = {}) => ({
  _id: oid(),
  status: 'Completed',
  callNumber: 1,
  mode: 'Video',
  scheduledAt: new Date('2026-11-01T05:30:00.000Z'),
  stylistId: { _id: oid(), name: 'Priya' },
  canRead: true,
  referenceImages: [],
  ...over,
});

// ── Builder ─────────────────────────────────────────────────────────────────
test('the report has one neutral header, the client details and every completed call', () => {
  const html = buildClientReportHtml({
    client: client(),
    calls: [
      call({ preferences: 'Soft glam', lookHair: 'Low bun', conveyed: 'Suggested nude palette' }),
      call({ callNumber: 2, scheduledAt: new Date('2026-11-04T05:30:00.000Z'), lookHair: 'Side braid' }),
      call({ callNumber: 3, status: 'Scheduled', scheduledAt: new Date('2026-11-09T05:30:00.000Z') }),
      call({ callNumber: null, status: 'Cancelled' }),
    ],
    generatedBy: 'Priya',
    generatedAt: NOW,
  });
  assert.match(html, /Client consultation report/);
  assert.doesNotMatch(html, /Team N Makeovers|<img[^>]+logo/i); // neutral: no company branding
  assert.match(html, /Riya &lt;Joseph&gt;/); // escaped
  assert.doesNotMatch(html, /<Joseph>/);
  assert.match(html, /<th>Company<\/th><td>Nizan<\/td>/);
  assert.match(html, /20 Dec 2026/);
  assert.match(html, /Call 1 of 4/);
  assert.match(html, /Call 2 of 4/);
  assert.match(html, /What we conveyed/);
  assert.match(html, /Suggested nude palette/);
  assert.match(html, /2 of 4 calls done/);
  assert.match(html, /Upcoming calls[\s\S]*Call 3 of 4/);
  assert.doesNotMatch(html, /Cancelled/); // cancelled calls are not part of the report
  // The agreed look takes the latest value: the braid replaced the bun.
  assert.match(html, /Agreed look so far[\s\S]*Side braid/);
});

test("a call the user can't read shows only its date, not its notes", () => {
  const html = buildClientReportHtml({
    client: client(),
    calls: [call({ canRead: false, notes: 'SECRET' })],
    generatedAt: NOW,
  });
  assert.match(html, /only visible to its stylist/);
  assert.doesNotMatch(html, /SECRET/);
});

test('images are embedded when fetched, and a placeholder shows when not', () => {
  const html = buildClientReportHtml({
    client: client(),
    calls: [
      call({
        referenceImages: [
          { url: IMG, caption: 'Saree colour' },
          { url: IMG2, caption: '' },
        ],
      }),
    ],
    images: new Map([[IMG, 'data:image/jpeg;base64,AAAA']]),
    generatedAt: NOW,
  });
  assert.match(html, /<img src="data:image\/jpeg;base64,AAAA" alt="Saree colour">/);
  assert.match(html, /Image not available/);
  assert.match(html, /Reference images \(2\)/);
  assert.doesNotMatch(html, /res\.cloudinary\.com/); // never a network address in the page
});

test('the agreed look keeps the latest value of each field', () => {
  assert.deepEqual(
    agreedLook([
      { lookMakeup: 'Dewy', lookHair: 'Bun' },
      { lookHair: '  ', lookOutfit: 'Red saree' },
      { lookHair: 'Braid' },
    ]),
    { lookMakeup: 'Dewy', lookHair: 'Braid', lookOutfit: 'Red saree' }
  );
});

test('only our own Cloudinary image links are ever fetched', () => {
  assert.equal(isReportImageUrl(IMG), true);
  assert.equal(isReportImageUrl('http://res.cloudinary.com/demo/image/upload/a.jpg'), false);
  assert.equal(isReportImageUrl('https://evil.example/image/upload/a.jpg'), false);
  assert.equal(isReportImageUrl('https://res.cloudinary.com.evil.example/x/image/upload/a.jpg'), false);
  assert.equal(isReportImageUrl('http://169.254.169.254/latest/meta-data'), false);
  assert.equal(isReportImageUrl(''), false);
  assert.equal(
    printSizedUrl(IMG),
    'https://res.cloudinary.com/demo/image/upload/c_limit,w_900,q_auto,f_jpg/v1/team_n_crm/consultations/a.jpg'
  );
});

// ── Endpoint ────────────────────────────────────────────────────────────────
const chain = (value) => {
  const q = {
    select: () => q,
    populate: () => q,
    sort: () => q,
    limit: () => q,
    lean: () => q,
    then: (res, rej) => Promise.resolve(value).then(res, rej),
  };
  return q;
};

const stub = (t, target, name, impl) => {
  const original = target[name];
  target[name] = impl;
  t.after(() => {
    target[name] = original;
  });
};

const callReport = async (user, id) => {
  const out = { code: 200, headers: {}, body: null };
  const res = {
    status: (c) => ((out.code = c), res),
    json: (b) => ((out.body = b), res),
    send: (b) => ((out.body = b), res),
    setHeader: (k, v) => {
      out.headers[k.toLowerCase()] = v;
    },
  };
  await ctl.downloadClientReport({ user, consultAccess: accessFor(user), params: { id: String(id) } }, res);
  return out;
};

test('the report endpoint sends a PDF, embedding only images the user may see', async (t) => {
  const me = { _id: oid(), name: 'Priya', role: 'stylist', permissions: ['consultations.calendar'] };
  const file = client({ stylistId: me._id });
  stub(t, StylistClient, 'findById', () => chain(file));
  stub(t, Consultation, 'find', () =>
    chain([
      call({ stylistId: { _id: me._id, name: 'Priya' }, preferences: 'Soft glam', referenceImages: [{ url: IMG }] }),
      // Another stylist's call: its images must not be fetched or shown.
      call({ callNumber: 2, stylistId: { _id: oid(), name: 'Bina' }, notes: 'PRIVATE', referenceImages: [{ url: IMG2 }] }),
    ])
  );
  const fetched = [];
  let html = '';
  stub(t, ctl.reportDeps, 'fetchImage', async (u) => (fetched.push(u), 'data:image/jpeg;base64,AAAA'));
  stub(t, ctl.reportDeps, 'htmlToPdf', async (h) => ((html = h), Buffer.from('%PDF-1.7 test')));

  const r = await callReport(me, file._id);
  assert.equal(r.code, 200);
  assert.equal(r.headers['content-type'], 'application/pdf');
  assert.match(r.headers['content-disposition'], /^attachment; filename="Client_Report_Riya_Joseph_\d{4}-\d{2}-\d{2}\.pdf"$/);
  assert.equal(r.body.toString(), '%PDF-1.7 test');
  assert.deepEqual(fetched, [IMG]);
  assert.match(html, /Soft glam/);
  assert.doesNotMatch(html, /PRIVATE/);
});

test("a stylist can't download another stylist's client report", async (t) => {
  const me = { _id: oid(), name: 'Priya', role: 'stylist', permissions: ['consultations.calendar'] };
  const theirs = client({ stylistId: oid() });
  stub(t, StylistClient, 'findById', async () => theirs);
  let rendered = false;
  stub(t, ctl.reportDeps, 'htmlToPdf', async () => ((rendered = true), Buffer.from('')));
  const r = await callReport(me, theirs._id);
  assert.equal(r.code, 403);
  assert.equal(rendered, false);
});

test('a renderer failure answers with a readable message, not a stack trace', async (t) => {
  const lead = { _id: oid(), name: 'Meera', role: 'stylist_lead', permissions: ['consultations'] };
  const file = client();
  stub(t, StylistClient, 'findById', () => chain(file));
  stub(t, Consultation, 'find', () => chain([]));
  stub(t, ctl.reportDeps, 'htmlToPdf', async () => {
    throw new Error('Chrome crashed at /usr/lib/x');
  });
  const r = await callReport(lead, file._id);
  assert.equal(r.code, 500);
  assert.equal(r.body.message, 'Could not make the report. Try again in a minute.');
});
