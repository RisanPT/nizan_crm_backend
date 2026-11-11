// Controller tests with the Mongoose models stubbed out: no database, no server.
//   node --test tests/consultationController.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Consultation from '../models/Consultation.js';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import Role from '../models/Role.js';
import Notification from '../models/Notification.js';
import * as ctl from '../controllers/consultationController.js';
import { deleteLead } from '../controllers/leadController.js';
import { accessFor } from '../utils/consultationRules.js';
import { referenceImageStore } from '../utils/consultationImages.js';
import StylistClient from '../models/StylistClient.js';
import Booking from '../models/Booking.js';

const mongoose = Consultation.base;
const oid = () => new mongoose.Types.ObjectId();

// An awaitable, chainable stand-in for a Mongoose Query.
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

const call = async (handler, { user, access, body = {}, query = {}, params = {} }) => {
  let code = 200;
  let out;
  const res = {
    status: (c) => ((code = c), res),
    json: (b) => ((out = b), res),
  };
  await handler({ user, consultAccess: access ?? accessFor(user), body, query, params }, res);
  return { code, body: out };
};

// ── Fixtures ────────────────────────────────────────────────────────────────
const stylist = (extra = {}) => ({
  _id: oid(),
  name: 'Asha',
  role: 'stylist',
  permissions: ['consultations.calendar'],
  ...extra,
});
const leadUser = (extra = {}) => ({
  _id: oid(),
  name: 'Meera',
  role: 'stylist_lead',
  permissions: ['consultations'],
  ...extra,
});

const FUTURE = '2030-01-15T05:30:00.000Z'; // 11:00 IST, well in the future

// A stand-in for a loaded Consultation document.
const fakeDoc = (over = {}) => {
  const doc = {
    _id: oid(),
    consultationNo: 'CN-300115-1234',
    leadId: oid(),
    stylistId: oid(),
    scheduledAt: new Date(FUTURE),
    durationMins: 45,
    endsAt: new Date(new Date(FUTURE).getTime() + 45 * 60000),
    status: 'Scheduled',
    mode: 'Video',
    meetingLink: '',
    meetingProvider: '',
    location: '',
    notes: 'secret notes',
    preferences: 'p',
    nextSteps: 'n',
    rescheduleCount: 0,
    remindersSent: [],
    history: [],
    saved: 0,
    async save() {
      this.saved += 1;
      return this;
    },
    toObject() {
      const { save, toObject, saved, ...rest } = this;
      return { ...rest, history: [...this.history] };
    },
    ...over,
  };
  return doc;
};

// Replace model statics for one test, restoring them afterwards.
const stub = (t, target, name, impl) => {
  const original = target[name];
  target[name] = impl;
  t.after(() => {
    target[name] = original;
  });
};

// Notifications must never touch a database.
const stubNotifications = (t) => {
  stub(t, User, 'find', () => chain([]));
  stub(t, Notification, 'insertMany', async () => []);
  stub(t, Notification, 'find', () => chain([]));
};

// ── Middleware ──────────────────────────────────────────────────────────────
test('validateTextFields rejects non-text and over-long fields', () => {
  const run = (body) => {
    let status = 200;
    let nexted = false;
    const res = { status: (c) => ((status = c), res), json: () => res };
    ctl.validateTextFields({ body }, res, () => (nexted = true));
    return { status, nexted };
  };
  assert.deepEqual(run({ notes: 'ok', reason: 'ok' }), { status: 200, nexted: true });
  assert.deepEqual(run(undefined), { status: 200, nexted: true });
  assert.equal(run({ notes: 'x'.repeat(5001) }).status, 400);
  assert.equal(run({ reason: { $gt: '' } }).status, 400);
  assert.equal(run({ location: 42 }).status, 400);
  assert.equal(run({ notes: 'x'.repeat(5000) }).nexted, true);
});

test('consultationGuard blocks users without a consultations permission', () => {
  const run = (user) => {
    const req = { user };
    let status = 200;
    let nexted = false;
    const res = { status: (c) => ((status = c), res), json: () => res };
    ctl.consultationGuard(req, res, () => (nexted = true));
    return { status, nexted, access: req.consultAccess };
  };
  assert.equal(run({ _id: oid(), role: 'sales', permissions: ['sales'] }).status, 403);
  assert.equal(run({ _id: oid(), role: 'artist', permissions: [] }).status, 403);
  const ok = run(stylist());
  assert.equal(ok.nexted, true);
  assert.equal(ok.access.viewAll, false);
  assert.equal(run(leadUser()).access.viewAll, true);
  assert.equal(run({ _id: oid(), role: 'admin', permissions: [] }).nexted, true);
});

// ── List scoping and injection ──────────────────────────────────────────────
test('getConsultations rejects an operator smuggled in as the status filter', async (t) => {
  let queried = false;
  stub(t, Consultation, 'find', () => ((queried = true), chain([])));
  const r = await call(ctl.getConsultations, { user: leadUser(), query: { status: { $ne: 'Cancelled' } } });
  assert.equal(r.code, 400);
  assert.equal(queried, false);
});

test('getConsultations: a valid status passes through, unknown ones are rejected', async (t) => {
  let filter;
  stub(t, Consultation, 'find', (f) => ((filter = f), chain([])));
  assert.equal((await call(ctl.getConsultations, { user: leadUser(), query: { status: 'Completed' } })).code, 200);
  assert.equal(filter.status, 'Completed');
  assert.equal((await call(ctl.getConsultations, { user: leadUser(), query: { status: 'Bogus' } })).code, 400);
});

test('getConsultations: a stylist is always scoped to themselves', async (t) => {
  let filter;
  stub(t, Consultation, 'find', (f) => ((filter = f), chain([])));
  const me = stylist();
  await call(ctl.getConsultations, { user: me, query: { stylistId: String(oid()) } });
  assert.equal(String(filter.stylistId), String(me._id));
  // A lead may filter to someone else.
  const other = String(oid());
  await call(ctl.getConsultations, { user: leadUser(), query: { stylistId: other } });
  assert.equal(String(filter.stylistId), other);
});

test('getConsultations rejects an array posing as an id and bad dates', async (t) => {
  stub(t, Consultation, 'find', () => chain([]));
  const id = String(oid());
  assert.equal((await call(ctl.getConsultations, { user: leadUser(), query: { leadId: [id] } })).code, 400);
  assert.equal((await call(ctl.getConsultations, { user: leadUser(), query: { from: 'soon' } })).code, 400);
});

// ── Notes redaction ─────────────────────────────────────────────────────────
test('getConsultationById hides notes from someone without notes access', async (t) => {
  const reportsOnly = { _id: oid(), role: 'reporter', permissions: ['consultations.reports'], name: 'R' };
  const doc = fakeDoc();
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await call(ctl.getConsultationById, { user: reportsOnly, params: { id: String(doc._id) } });
  assert.equal(r.code, 200);
  assert.equal('notes' in r.body, false);
  assert.equal(r.body.consultationNo, 'CN-300115-1234');
});

test('getConsultationById shows notes to the assigned stylist and to a lead', async (t) => {
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id });
  stub(t, Consultation, 'findById', () => chain(doc));
  const own = await call(ctl.getConsultationById, { user: me, params: { id: String(doc._id) } });
  assert.equal(own.body.notes, 'secret notes');
  const asLead = await call(ctl.getConsultationById, { user: leadUser(), params: { id: String(doc._id) } });
  assert.equal(asLead.body.notes, 'secret notes');
});

test('a stylist cannot open another stylist\'s consultation', async (t) => {
  const doc = fakeDoc(); // someone else's
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await call(ctl.getConsultationById, { user: stylist(), params: { id: String(doc._id) } });
  assert.equal(r.code, 403);
  const missing = await call(ctl.getConsultationById, { user: stylist(), params: { id: 'not-an-id' } });
  assert.equal(missing.code, 404);
});

// ── Booking and clashes ─────────────────────────────────────────────────────
const stubBooking = (t, { conflicts = [], saved, client = null }) => {
  stubNotifications(t);
  stub(t, Lead, 'findById', () => chain({ _id: oid() }));
  stub(t, Consultation, 'find', () => chain(conflicts));
  // Client files: a booking by lead finds none and creates one; renumbering
  // writes nothing real.
  stub(t, Booking, 'findById', () => chain(null));
  stub(t, StylistClient, 'findOne', async () => null);
  stub(t, StylistClient, 'findById', async () => client);
  stub(t, Consultation, 'bulkWrite', async () => ({}));
  const originalClientSave = StylistClient.prototype.save;
  StylistClient.prototype.save = async function save() {
    saved.client = this;
    return this;
  };
  t.after(() => {
    StylistClient.prototype.save = originalClientSave;
  });
  const original = Consultation.prototype.save;
  Consultation.prototype.save = async function save() {
    this._id = this._id ?? oid();
    saved.doc = this;
    return this;
  };
  t.after(() => {
    Consultation.prototype.save = original;
  });
  stub(t, Consultation, 'findById', () =>
    chain(() => (saved.doc ? { ...saved.doc.toObject(), leadId: { _id: saved.doc.leadId, name: 'Anjali' } } : null))
  );
};

const bookBody = (extra = {}) => ({ leadId: String(oid()), scheduledAt: FUTURE, durationMins: 45, ...extra });
const clash = () => [
  { _id: oid(), consultationNo: 'CN-1', scheduledAt: new Date(FUTURE), endsAt: new Date(FUTURE), leadId: { name: 'Divya' } },
];

test('createConsultation books a free slot for the caller', async (t) => {
  const saved = {};
  stubBooking(t, { saved });
  const me = stylist();
  const r = await call(ctl.createConsultation, { user: me, body: bookBody({ meetingLink: 'meet.google.com/abc-defg-hij' }) });
  assert.equal(r.code, 201);
  assert.equal(String(saved.doc.stylistId), String(me._id));
  assert.equal(saved.doc.meetingLink, 'https://meet.google.com/abc-defg-hij');
  assert.equal(saved.doc.meetingProvider, 'Google Meet');
  assert.equal(saved.doc.history[0].action, 'Scheduled');
  assert.equal(saved.doc.history[0].overrodeConflict, false);
  // Booked by lead (an older app): a Team N client file is made and linked.
  assert.equal(saved.client.company, 'Team N');
  assert.equal(String(saved.client.stylistId), String(me._id));
  assert.equal(String(saved.doc.clientId), String(saved.client._id));
});

test("createConsultation by client file: own client yes, another stylist's or a cancelled one no", async (t) => {
  const me = stylist();
  const mine = { _id: oid(), company: 'Nizan', leadId: null, stylistId: me._id, status: 'Active' };
  const saved = {};
  stubBooking(t, { saved, client: mine });
  const body = { clientId: String(mine._id), scheduledAt: FUTURE, durationMins: 45 };

  const ok = await call(ctl.createConsultation, { user: me, body });
  assert.equal(ok.code, 201);
  assert.equal(String(saved.doc.clientId), String(mine._id));
  assert.equal(saved.doc.leadId, null); // a Nizan client has no CRM lead
  assert.equal(saved.client, undefined); // no new client file

  mine.stylistId = oid();
  assert.equal((await call(ctl.createConsultation, { user: me, body })).code, 403);
  assert.equal((await call(ctl.createConsultation, { user: leadUser(), body })).code, 201);

  mine.status = 'Cancelled';
  assert.equal((await call(ctl.createConsultation, { user: leadUser(), body })).code, 409);
  assert.equal((await call(ctl.createConsultation, { user: me, body: { ...body, clientId: 'nope' } })).code, 400);
});

test('createConsultation returns 409 with the clashing bookings', async (t) => {
  const saved = {};
  stubBooking(t, { saved, conflicts: clash() });
  const r = await call(ctl.createConsultation, { user: stylist(), body: bookBody() });
  assert.equal(r.code, 409);
  assert.equal(r.body.code, 'SCHEDULE_CONFLICT');
  assert.equal(r.body.conflicts[0].clientName, 'Divya');
  assert.equal(saved.doc, undefined); // nothing saved
});

test('only a stylist lead can force a booking over a clash', async (t) => {
  const saved = {};
  stubBooking(t, { saved, conflicts: clash() });
  const denied = await call(ctl.createConsultation, { user: stylist(), body: bookBody({ force: true }) });
  assert.equal(denied.code, 403);
  assert.equal(saved.doc, undefined);

  const allowed = await call(ctl.createConsultation, { user: leadUser(), body: bookBody({ force: true }) });
  assert.equal(allowed.code, 201);
  assert.equal(saved.doc.history[0].overrodeConflict, true);
});

test('createConsultation input validation', async (t) => {
  const saved = {};
  stubBooking(t, { saved });
  const me = stylist();
  const bad = async (body) => (await call(ctl.createConsultation, { user: me, body })).code;
  assert.equal(await bad(bookBody({ leadId: 'nope' })), 400);
  assert.equal(await bad(bookBody({ scheduledAt: '2030-01-15T11:00:00' })), 400); // no timezone
  assert.equal(await bad(bookBody({ durationMins: 5000 })), 400);
  assert.equal(await bad(bookBody({ mode: 'Phone' })), 400);
  assert.equal(await bad(bookBody({ meetingLink: 'javascript:alert(1)' })), 400);
  assert.equal(saved.doc, undefined);
});

test('a stylist cannot book for someone else; a lead can, if they are eligible', async (t) => {
  const saved = {};
  stubBooking(t, { saved });
  const other = String(oid());
  const denied = await call(ctl.createConsultation, { user: stylist(), body: bookBody({ stylistId: other }) });
  assert.equal(denied.code, 403);

  stub(t, User, 'findById', () => chain({ role: 'stylist', active: true }));
  stub(t, Role, 'findOne', () => chain({ permissions: ['consultations.calendar'], active: true }));
  const ok = await call(ctl.createConsultation, { user: leadUser(), body: bookBody({ stylistId: other }) });
  assert.equal(ok.code, 201);
  assert.equal(String(saved.doc.stylistId), other);

  // …but not to a user whose role has no consultations permission.
  stub(t, Role, 'findOne', () => chain({ permissions: ['sales'], active: true }));
  const ineligible = await call(ctl.createConsultation, { user: leadUser(), body: bookBody({ stylistId: other }) });
  assert.equal(ineligible.code, 400);
});

// ── Transitions ─────────────────────────────────────────────────────────────
test('reschedule checks clashes excluding the consultation itself', async (t) => {
  stubNotifications(t);
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id });
  let conflictQuery;
  stub(t, Consultation, 'findById', () => chain(doc));
  stub(t, Consultation, 'find', (q) => ((conflictQuery = q), chain([])));
  const r = await call(ctl.rescheduleConsultation, {
    user: me,
    params: { id: String(doc._id) },
    body: { scheduledAt: '2030-01-16T05:30:00.000Z', reason: 'Bride travelling' },
  });
  assert.equal(r.code, 200);
  assert.deepEqual(conflictQuery._id, { $ne: doc._id });
  assert.equal(doc.rescheduleCount, 1);
  assert.equal(doc.history.at(-1).action, 'Rescheduled');
  assert.equal(doc.history.at(-1).reason, 'Bride travelling');
  assert.equal(doc.saved, 1);
});

test('only a stylist lead can reassign during a reschedule', async (t) => {
  stubNotifications(t);
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id });
  stub(t, Consultation, 'findById', () => chain(doc));
  stub(t, Consultation, 'find', () => chain([]));
  const r = await call(ctl.rescheduleConsultation, {
    user: me,
    params: { id: String(doc._id) },
    body: { scheduledAt: '2030-01-16T05:30:00.000Z', stylistId: String(oid()) },
  });
  assert.equal(r.code, 403);
  assert.equal(doc.saved, 0);
});

test('a finished consultation cannot be rescheduled, completed or cancelled again', async (t) => {
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id, status: 'Completed' });
  stub(t, Consultation, 'findById', () => chain(doc));
  const p = { user: me, params: { id: String(doc._id) } };
  assert.equal((await call(ctl.rescheduleConsultation, { ...p, body: { scheduledAt: FUTURE } })).code, 409);
  assert.equal((await call(ctl.completeConsultation, { ...p })).code, 409);
  assert.equal((await call(ctl.cancelConsultation, { ...p })).code, 409);
  assert.equal((await call(ctl.markNoShow, { ...p })).code, 409);
  assert.equal(doc.saved, 0);
});

test('cancelling records the reason and frees the slot', async (t) => {
  stubNotifications(t);
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id });
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await call(ctl.cancelConsultation, {
    user: me,
    params: { id: String(doc._id) },
    body: { reason: 'Bride unwell' },
  });
  assert.equal(r.code, 200);
  assert.equal(doc.status, 'Cancelled');
  assert.equal(doc.cancelReason, 'Bride unwell');
  assert.equal(doc.history.at(-1).action, 'Cancelled');
});

test('completing stores the outcome and lists which fields changed (not their content)', async (t) => {
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id, notes: '', preferences: '', nextSteps: '' });
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await call(ctl.completeConsultation, {
    user: me,
    params: { id: String(doc._id) },
    body: { notes: 'Wants a soft look', nextSteps: 'Book trial' },
  });
  assert.equal(r.code, 200);
  assert.equal(doc.status, 'Completed');
  assert.equal(doc.notes, 'Wants a soft look');
  const entry = doc.history.at(-1);
  assert.deepEqual(entry.fields, ['notes', 'nextSteps']);
  assert.equal(JSON.stringify(entry).includes('Wants a soft look'), false);
});

test('updating notes needs notes access; meeting details do not', async (t) => {
  const reportsOnly = { _id: oid(), role: 'reporter', permissions: ['consultations.reports'], name: 'R' };
  const doc = fakeDoc();
  stub(t, Consultation, 'findById', () => chain(doc));
  const p = { user: reportsOnly, params: { id: String(doc._id) } };
  assert.equal((await call(ctl.updateConsultation, { ...p, body: { notes: 'hacked' } })).code, 403);
  assert.equal(doc.notes, 'secret notes');
  const link = await call(ctl.updateConsultation, { ...p, body: { meetingLink: 'https://zoom.us/j/123' } });
  assert.equal(link.code, 200);
  assert.equal(doc.meetingProvider, 'Zoom');
  assert.deepEqual(doc.history.at(-1).fields, ['meetingLink']);
});

// ── After-call details ──────────────────────────────────────────────────────
test('completing stores the new after-call fields and records only their names', async (t) => {
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id });
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await call(ctl.completeConsultation, {
    user: me,
    params: { id: String(doc._id) },
    body: { conveyed: '  Suggested a nude palette  ', lookHair: 'Low bun', skinNotes: 'Allergic to latex' },
  });
  assert.equal(r.code, 200);
  assert.equal(doc.conveyed, 'Suggested a nude palette');
  assert.equal(doc.lookHair, 'Low bun');
  assert.deepEqual(doc.history.at(-1).fields, ['conveyed', 'lookHair', 'skinNotes']);
  assert.equal(JSON.stringify(doc.history.at(-1)).includes('latex'), false);
});

test('the new after-call fields need notes access and are hidden without it', async (t) => {
  const reportsOnly = { _id: oid(), role: 'reporter', permissions: ['consultations.reports'], name: 'R' };
  const doc = fakeDoc({
    conveyed: 'private',
    referenceImages: [{ _id: oid(), url: 'https://x/a.jpg', publicId: 'a' }],
  });
  stub(t, Consultation, 'findById', () => chain(doc));
  const p = { user: reportsOnly, params: { id: String(doc._id) } };
  assert.equal((await call(ctl.updateConsultation, { ...p, body: { lookMakeup: 'x' } })).code, 403);
  const seen = await call(ctl.getConsultationById, p);
  assert.equal(seen.code, 200);
  assert.equal('conveyed' in seen.body, false);
  assert.equal('referenceImages' in seen.body, false);
});

test('validateTextFields limits the new fields too', () => {
  let code = 200;
  const res = { status: (c) => ((code = c), res), json: () => res };
  let passed = false;
  ctl.validateTextFields({ body: { conveyed: 'x'.repeat(3001) } }, res, () => (passed = true));
  assert.equal(code, 400);
  assert.equal(passed, false);
});

// ── Reference images ────────────────────────────────────────────────────────
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const NOT_IMAGE = Buffer.from('%PDF-1.4 not an image');

// Cloudinary is never reached: uploads return fake links, deletes are recorded.
const stubStore = (t) => {
  const deleted = [];
  let n = 0;
  stub(t, referenceImageStore, 'upload', async () => {
    n += 1;
    return { secure_url: `https://res.cloudinary.com/demo/img${n}.jpg`, public_id: `team_n_crm/consultations/img${n}` };
  });
  stub(t, referenceImageStore, 'destroy', async (id) => deleted.push(id));
  return deleted;
};

const callWithFiles = (handler, opts, files) =>
  call((req, res) => handler({ ...req, files }, res), opts);

test('the assigned stylist can add reference images', async (t) => {
  stubStore(t);
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id, referenceImages: [] });
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await callWithFiles(
    ctl.addReferenceImages,
    { user: me, params: { id: String(doc._id) } },
    [{ buffer: JPEG }, { buffer: JPEG }]
  );
  assert.equal(r.code, 201);
  assert.equal(doc.referenceImages.length, 2);
  assert.equal(doc.referenceImages[0].url, 'https://res.cloudinary.com/demo/img1.jpg');
  assert.equal(doc.referenceImages[0].uploadedByName, 'Asha');
  assert.deepEqual(doc.history.at(-1).fields, ['referenceImages']);
});

test('reference images: non-images, too many, no access and cancelled calls are refused', async (t) => {
  const deleted = stubStore(t);
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id, referenceImages: [] });
  stub(t, Consultation, 'findById', () => chain(doc));
  const p = { user: me, params: { id: String(doc._id) } };

  assert.equal((await callWithFiles(ctl.addReferenceImages, p, [{ buffer: NOT_IMAGE }])).code, 415);
  assert.equal((await callWithFiles(ctl.addReferenceImages, p, [])).code, 400);
  doc.referenceImages = Array.from({ length: 14 }, () => ({ _id: oid(), url: 'u', publicId: 'p' }));
  const over = await callWithFiles(ctl.addReferenceImages, p, [{ buffer: JPEG }, { buffer: JPEG }]);
  assert.equal(over.code, 400);
  assert.match(over.body.message, /Only 1 more image fits/);
  assert.equal(doc.referenceImages.length, 14);

  const reportsOnly = { _id: oid(), role: 'reporter', permissions: ['consultations.reports'], name: 'R' };
  // A lead without the notes sub-key still has notes access (full module), so
  // use a user who can open the call but not its notes.
  const noNotes = await callWithFiles(
    ctl.addReferenceImages,
    { user: reportsOnly, params: p.params },
    [{ buffer: JPEG }]
  );
  assert.equal(noNotes.code, 403);

  doc.status = 'Cancelled';
  doc.referenceImages = [];
  assert.equal((await callWithFiles(ctl.addReferenceImages, p, [{ buffer: JPEG }])).code, 409);
  assert.deepEqual(deleted, []);
});

test('a failed upload removes the images already sent from that batch', async (t) => {
  const deleted = stubStore(t);
  let n = 0;
  stub(t, referenceImageStore, 'upload', async () => {
    n += 1;
    if (n === 2) throw new Error('network');
    return { secure_url: 'https://x/1.jpg', public_id: 'one' };
  });
  const me = stylist();
  const doc = fakeDoc({ stylistId: me._id, referenceImages: [] });
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await callWithFiles(
    ctl.addReferenceImages,
    { user: me, params: { id: String(doc._id) } },
    [{ buffer: JPEG }, { buffer: JPEG }]
  );
  assert.equal(r.code, 502);
  assert.deepEqual(deleted, ['one']);
  assert.equal(doc.referenceImages.length, 0);
  assert.equal(doc.saved, 0);
});

test('removing a reference image deletes it from the record and from Cloudinary', async (t) => {
  const deleted = stubStore(t);
  const me = stylist();
  const keep = { _id: oid(), url: 'https://x/k.jpg', publicId: 'keep' };
  const drop = { _id: oid(), url: 'https://x/d.jpg', publicId: 'drop' };
  const doc = fakeDoc({ stylistId: me._id, referenceImages: [keep, drop] });
  stub(t, Consultation, 'findById', () => chain(doc));
  const p = { user: me, params: { id: String(doc._id), imageId: String(drop._id) } };

  const r = await call(ctl.removeReferenceImage, p);
  assert.equal(r.code, 200);
  assert.deepEqual(doc.referenceImages, [keep]);
  assert.deepEqual(deleted, ['drop']);
  assert.equal((await call(ctl.removeReferenceImage, p)).code, 404);
});

test('a reference image caption can be changed', async (t) => {
  const me = stylist();
  const img = { _id: oid(), url: 'https://x/a.jpg', publicId: 'a', caption: '' };
  const doc = fakeDoc({ stylistId: me._id, referenceImages: [img] });
  stub(t, Consultation, 'findById', () => chain(doc));
  const r = await call(ctl.updateReferenceImage, {
    user: me,
    params: { id: String(doc._id), imageId: String(img._id) },
    body: { caption: '  Saree colour  ' },
  });
  assert.equal(r.code, 200);
  assert.equal(img.caption, 'Saree colour');
});

// ── Lead deletion ───────────────────────────────────────────────────────────
test('deleteLead refuses while the enquiry has consultation records', async (t) => {
  let deleted = false;
  stub(t, Consultation, 'countDocuments', async () => 2);
  stub(t, Lead, 'findByIdAndDelete', async () => ((deleted = true), { _id: oid() }));
  const r = await call(deleteLead, { user: leadUser(), params: { id: String(oid()) } });
  assert.equal(r.code, 409);
  assert.match(r.body.message, /2 consultation records/);
  assert.equal(deleted, false);
});

test('deleteLead refuses while a stylist keeps a client file on the enquiry', async (t) => {
  let deleted = false;
  stub(t, Consultation, 'countDocuments', async () => 0);
  stub(t, StylistClient, 'exists', async () => ({ _id: oid() }));
  stub(t, Lead, 'findByIdAndDelete', async () => ((deleted = true), { _id: oid() }));
  const r = await call(deleteLead, { user: leadUser(), params: { id: String(oid()) } });
  assert.equal(r.code, 409);
  assert.match(r.body.message, /client file/);
  assert.equal(deleted, false);
});

test('deleteLead still works for an enquiry with no consultations', async (t) => {
  stub(t, Consultation, 'countDocuments', async () => 0);
  stub(t, StylistClient, 'exists', async () => null);
  stub(t, Lead, 'findByIdAndDelete', async () => ({ _id: oid() }));
  const r = await call(deleteLead, { user: leadUser(), params: { id: String(oid()) } });
  assert.equal(r.code, 200);
});
