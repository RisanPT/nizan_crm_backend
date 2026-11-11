// Stylist client files: the pure rules, and the controller with the Mongoose
// models stubbed out — no database, no server.
//   node --test tests/stylistClients.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import Booking from '../models/Booking.js';
import Consultation from '../models/Consultation.js';
import Lead from '../models/Lead.js';
import Role from '../models/Role.js';
import StylistClient from '../models/StylistClient.js';
import User from '../models/User.js';
import * as ctl from '../controllers/stylistClientController.js';
import { accessFor } from '../utils/consultationRules.js';
import {
  canActOnClient,
  cleanClientInput,
  clientProgress,
  numberCalls,
  snapshotFromTeamN,
} from '../utils/stylistClientRules.js';

const mongoose = Consultation.base;
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

const stub = (t, target, name, impl) => {
  const original = target[name];
  target[name] = impl;
  t.after(() => {
    target[name] = original;
  });
};

const call = async (handler, { user, body = {}, query = {}, params = {} }) => {
  let code = 200;
  let out;
  const res = { status: (c) => ((code = c), res), json: (b) => ((out = b), res) };
  await handler({ user, consultAccess: accessFor(user), body, query, params }, res);
  return { code, body: out };
};

const stylist = () => ({ _id: oid(), name: 'Asha', role: 'stylist', permissions: ['consultations.calendar'] });
const leadUser = () => ({ _id: oid(), name: 'Meera', role: 'stylist_lead', permissions: ['consultations'] });

// ── Rules ───────────────────────────────────────────────────────────────────
test('a Team N client is filled in from the booking first, then the lead', () => {
  const lead = {
    name: 'Anjali (enquiry)',
    phone: '9000000000',
    email: 'anjali@example.com',
    alternateNumber: '9111111111',
    eventType: 'Wedding',
    eventDate: new Date('2026-12-13T18:30:00.000Z'),
    location: 'Kochi',
  };
  const booking = {
    bookingNumber: 'NB-1234',
    customerName: 'Anjali Menon',
    phone: '9876543210',
    email: 'x@placeholder.local',
    selectedDates: ['2026-12-14'],
    eventSlot: 'Morning',
    address: 'Le Méridien, Kochi',
    district: 'Ernakulam',
    culture: 'Hindu',
    service: 'Bridal premium',
    outfitDetails: 'Red Kanjivaram',
    assignedStaff: [
      { artistName: 'Asha', roleType: 'lead' },
      { artistName: 'Ravi', roleType: 'driver' },
    ],
    bookingItems: [
      { service: 'Reception look', selectedDates: ['2026-12-15'], assignedStaff: [{ artistName: 'Bina' }] },
    ],
  };
  const s = snapshotFromTeamN(lead, booking);
  assert.equal(s.name, 'Anjali Menon');
  assert.equal(s.phone, '9876543210');
  assert.equal(s.email, 'anjali@example.com'); // placeholder booking email skipped
  assert.equal(s.altPhone, '9111111111');
  assert.equal(s.eventType, 'Wedding');
  assert.deepEqual(s.eventDates, ['2026-12-14', '2026-12-15']);
  assert.equal(s.venue, 'Le Méridien, Kochi');
  assert.equal(s.culture, 'Hindu');
  assert.equal(s.packageName, 'Reception look'); // items list the packages
  assert.equal(s.bookingNumber, 'NB-1234');
  assert.deepEqual(s.artistNames, ['Asha', 'Bina']); // drivers left out
  assert.equal(s.outfitDetails, 'Red Kanjivaram');
});

test('a Team N client without a booking uses the lead, with its event date as an IST day', () => {
  const s = snapshotFromTeamN({ name: 'Riya', phone: '9876543210', eventDate: new Date('2026-12-13T18:30:00.000Z') });
  assert.equal(s.name, 'Riya');
  assert.deepEqual(s.eventDates, ['2026-12-14']);
  assert.equal(s.bookingNumber, '');
  assert.deepEqual(s.artistNames, []);
});

test('client input is checked and cleaned', () => {
  const ok = cleanClientInput({
    name: '  Riya Joseph ',
    phone: '98765 43210',
    eventDates: ['2026-12-20', '2026-12-19', '2026-12-20'],
    artistNames: ['Asha', ' ', 'Asha'],
    requiredCalls: 5,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, 'Riya Joseph');
  assert.deepEqual(ok.value.eventDates, ['2026-12-19', '2026-12-20']);
  assert.deepEqual(ok.value.artistNames, ['Asha']);

  assert.match(cleanClientInput({ phone: '9876543210' }).message, /name is required/);
  assert.match(cleanClientInput({ name: 'R', phone: '123' }).message, /valid phone/);
  assert.match(cleanClientInput({ name: 'R', phone: '9876543210', eventDates: ['14/12/2026'] }).message, /YYYY-MM-DD/);
  assert.match(cleanClientInput({ name: 'R', phone: '9876543210', requiredCalls: 0 }).message, /requiredCalls/);
  assert.match(cleanClientInput({ name: 'R', phone: '9876543210', notes: { $gt: '' } }).message, /must be text/);
  assert.match(cleanClientInput({ name: 'R', phone: '9876543210', status: 'Lost' }).message, /status/);
  // An update may leave name/phone out, but not blank them.
  assert.equal(cleanClientInput({ notes: 'x' }, { partial: true }).ok, true);
  assert.equal(cleanClientInput({ name: ' ' }, { partial: true }).ok, false);
});

test('calls are numbered in time order; cancelled calls and no-shows give up their number', () => {
  const at = (d) => new Date(`2026-11-${String(d).padStart(2, "0")}T05:00:00.000Z`);
  const calls = [
    { _id: 'c', status: 'Scheduled', scheduledAt: at(10) },
    { _id: 'a', status: 'Completed', scheduledAt: at(1) },
    { _id: 'x', status: 'Cancelled', scheduledAt: at(3) },
    { _id: 'b', status: 'Completed', scheduledAt: at(5) },
    { _id: 'n', status: 'No-show', scheduledAt: at(7) },
  ];
  const n = numberCalls(calls);
  assert.deepEqual(
    ['a', 'x', 'b', 'n', 'c'].map((id) => n.get(id)),
    [1, null, 2, null, 3]
  );
});

test('progress counts completed calls and finds the next booked one', () => {
  const now = new Date('2026-11-05T00:00:00.000Z');
  const p = clientProgress(
    [
      { _id: 1, status: 'Completed', scheduledAt: new Date('2026-11-01T05:00:00Z') },
      { _id: 2, status: 'Scheduled', scheduledAt: new Date('2026-11-09T05:00:00Z') },
      { _id: 3, status: 'Scheduled', scheduledAt: new Date('2026-11-06T05:00:00Z') },
      { _id: 4, status: 'Cancelled', scheduledAt: new Date('2026-11-02T05:00:00Z') },
    ],
    4,
    now
  );
  assert.deepEqual(p, { done: 1, required: 4, booked: 2, nextCallAt: new Date('2026-11-06T05:00:00Z'), nextCallId: 3 });
});

test('a stylist may open only their own client; a lead any', () => {
  const me = stylist();
  assert.equal(canActOnClient(accessFor(me), me, { stylistId: me._id }), true);
  assert.equal(canActOnClient(accessFor(me), me, { stylistId: { _id: me._id, name: 'Asha' } }), true);
  assert.equal(canActOnClient(accessFor(me), me, { stylistId: oid() }), false);
  const lead = leadUser();
  assert.equal(canActOnClient(accessFor(lead), lead, { stylistId: oid() }), true);
});

// ── Controller ──────────────────────────────────────────────────────────────
// Captures client files the controller saves, and answers findById with them.
const stubClientStore = (t) => {
  const saved = [];
  const original = StylistClient.prototype.save;
  StylistClient.prototype.save = async function save() {
    saved.push(this);
    return this;
  };
  t.after(() => {
    StylistClient.prototype.save = original;
  });
  stub(t, StylistClient, 'findById', (id) =>
    chain(() => {
      const doc = saved.find((s) => String(s._id) === String(id));
      return doc ? doc.toObject() : null;
    })
  );
  return saved;
};

test('a Nizan client is created from the typed-in details, owned by the caller', async (t) => {
  const saved = stubClientStore(t);
  const me = stylist();
  const r = await call(ctl.createClient, {
    user: me,
    body: {
      company: 'Nizan',
      name: 'Riya Joseph',
      phone: '9876543210',
      eventType: 'Reception',
      eventDates: ['2026-12-20'],
      venue: 'Thrissur',
      bookingNumber: 'FAKE-1',
      leadId: String(oid()), // ignored for Nizan
    },
  });
  assert.equal(r.code, 201);
  const c = saved[0];
  assert.equal(c.company, 'Nizan');
  assert.equal(c.name, 'Riya Joseph');
  assert.deepEqual([...c.eventDates], ['2026-12-20']);
  assert.equal(c.leadId, null);
  assert.equal(c.bookingNumber, '');
  assert.equal(String(c.stylistId), String(me._id));
  assert.match(c.clientNo, /^SC-\d{6}-\d{4}$/);
  assert.deepEqual(r.body.progress.done, 0);
});

test('a Team N client is filled in from its enquiry and booking; a second file is refused', async (t) => {
  const saved = stubClientStore(t);
  const leadId = oid();
  const bookingId = oid();
  stub(t, Lead, 'findById', () => chain({ _id: leadId, name: 'Anjali', phone: '9876543210', eventType: 'Wedding', bookingId }));
  stub(t, Booking, 'findById', () =>
    chain({ _id: bookingId, customerName: 'Anjali Menon', phone: '9876543210', bookingNumber: 'NB-1', selectedDates: ['2026-12-14'] })
  );
  stub(t, StylistClient, 'findOne', async () => null);
  const me = stylist();

  const r = await call(ctl.createClient, {
    user: me,
    body: { company: 'Team N', leadId: String(leadId), name: 'Typed name ignored', requiredCalls: 5 },
  });
  assert.equal(r.code, 201);
  const c = saved[0];
  assert.equal(c.name, 'Anjali Menon');
  assert.equal(c.bookingNumber, 'NB-1');
  assert.equal(String(c.bookingId), String(bookingId));
  assert.equal(c.requiredCalls, 5);
  assert.ok(c.syncedAt instanceof Date);

  stub(t, StylistClient, 'findOne', async () => ({ _id: c._id }));
  const again = await call(ctl.createClient, { user: me, body: { company: 'Team N', leadId: String(leadId) } });
  assert.equal(again.code, 409);
  assert.equal(again.body.code, 'CLIENT_EXISTS');
  assert.equal(String(again.body.clientId), String(c._id));
});

test('createClient input checks and ownership', async (t) => {
  stubClientStore(t);
  const me = stylist();
  assert.equal((await call(ctl.createClient, { user: me, body: { company: 'Other' } })).code, 400);
  assert.equal((await call(ctl.createClient, { user: me, body: { company: 'Team N' } })).code, 400);
  assert.equal((await call(ctl.createClient, { user: me, body: { company: 'Nizan', name: 'R' } })).code, 400);
  // A stylist can't add a client for someone else…
  const other = String(oid());
  const denied = await call(ctl.createClient, {
    user: me,
    body: { company: 'Nizan', name: 'R', phone: '9876543210', stylistId: other },
  });
  assert.equal(denied.code, 403);
  // …a lead can, for someone who takes consultations.
  stub(t, User, 'findById', () => chain({ role: 'stylist', active: true }));
  stub(t, Role, 'findOne', () => chain({ permissions: ['consultations.calendar'], active: true }));
  const ok = await call(ctl.createClient, {
    user: leadUser(),
    body: { company: 'Nizan', name: 'R', phone: '9876543210', stylistId: other },
  });
  assert.equal(ok.code, 201);
});

test('a stylist lists only their own clients; a lead can list everyone', async (t) => {
  let filter = null;
  stub(t, StylistClient, 'find', (f) => ((filter = f), chain([])));
  stub(t, Consultation, 'find', () => chain([]));
  const me = stylist();
  await call(ctl.listClients, { user: me, query: { stylistId: String(oid()), q: 'riya' } });
  assert.equal(String(filter.stylistId), String(me._id));
  assert.equal(filter.status, 'Active');
  assert.ok(filter.$or.some((c) => c.name instanceof RegExp));

  await call(ctl.listClients, { user: leadUser(), query: { status: 'all', company: 'Nizan' } });
  assert.equal(filter.stylistId, undefined);
  assert.equal(filter.status, undefined);
  assert.equal(filter.company, 'Nizan');

  assert.equal((await call(ctl.listClients, { user: me, query: { company: 'X' } })).code, 400);
  assert.equal((await call(ctl.listClients, { user: me, query: { status: { $ne: 1 } } })).code, 400);
});

test('list rows carry call progress', async (t) => {
  const me = stylist();
  const clientId = oid();
  stub(t, StylistClient, 'find', () => chain([{ _id: clientId, name: 'Riya', requiredCalls: 4 }]));
  stub(t, Consultation, 'find', () =>
    chain([
      { clientId, status: 'Completed', scheduledAt: new Date('2026-01-01T05:00:00Z') },
      { clientId, status: 'Scheduled', scheduledAt: new Date('2099-01-01T05:00:00Z') },
    ])
  );
  const r = await call(ctl.listClients, { user: me });
  assert.equal(r.body[0].progress.done, 1);
  assert.equal(r.body[0].progress.booked, 1);
});

test("a stylist can't open, edit or refresh another stylist's client", async (t) => {
  const theirs = { _id: oid(), company: 'Team N', stylistId: oid() };
  stub(t, StylistClient, 'findById', async () => theirs);
  const p = { user: stylist(), params: { id: String(theirs._id) } };
  assert.equal((await call(ctl.getClient, p)).code, 403);
  assert.equal((await call(ctl.updateClient, { ...p, body: { notes: 'x' } })).code, 403);
  assert.equal((await call(ctl.refreshClient, p)).code, 403);
  assert.equal((await call(ctl.getClient, { ...p, params: { id: 'nope' } })).code, 404);
});

test('only a lead can move a client to another stylist; a Nizan client cannot be refreshed', async (t) => {
  const me = stylist();
  const doc = {
    _id: oid(),
    company: 'Nizan',
    stylistId: me._id,
    bookingNumber: '',
    async save() {
      return this;
    },
  };
  stub(t, StylistClient, 'findById', (id) => {
    const q = chain(doc);
    // findById is awaited directly by loadClient and chained by withOwnerName.
    q.then = (res, rej) => Promise.resolve(doc).then(res, rej);
    return q;
  });
  const p = { user: me, params: { id: String(doc._id) } };
  const moved = await call(ctl.updateClient, { ...p, body: { stylistId: String(oid()) } });
  assert.equal(moved.code, 403);
  const edited = await call(ctl.updateClient, { ...p, body: { notes: 'Prefers evening calls', requiredCalls: 6 } });
  assert.equal(edited.code, 200);
  assert.equal(doc.notes, 'Prefers evening calls');
  assert.equal(doc.requiredCalls, 6);
  assert.equal((await call(ctl.refreshClient, p)).code, 400);
});

test('the client page lists calls and gathers the images the caller may see', async (t) => {
  const me = stylist();
  const client = { _id: oid(), company: 'Team N', stylistId: me._id, requiredCalls: 4, name: 'Anjali' };
  stub(t, StylistClient, 'findById', () => {
    const q = chain(client);
    return q;
  });
  const img = { _id: oid(), url: 'https://x/a.jpg', caption: 'Saree' };
  stub(t, Consultation, 'find', () =>
    chain([
      { _id: oid(), stylistId: me._id, status: 'Completed', callNumber: 1, scheduledAt: new Date('2026-11-01'), referenceImages: [img] },
      // Another stylist's call on this client: listed, but its images stay hidden.
      { _id: oid(), stylistId: oid(), status: 'Completed', callNumber: 2, scheduledAt: new Date('2026-11-03'), referenceImages: [img] },
    ])
  );
  const r = await call(ctl.getClient, { user: me, params: { id: String(client._id) } });
  assert.equal(r.code, 200);
  assert.equal(r.body.calls.length, 2);
  assert.equal(r.body.images.length, 1);
  assert.equal(r.body.images[0].callNumber, 1);
  assert.equal(r.body.calls[1].imageCount, 0);
  assert.equal('referenceImages' in r.body.calls[0], false);
  assert.equal(r.body.progress.done, 2);
});
