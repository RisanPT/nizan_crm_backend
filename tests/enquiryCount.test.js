// Shared team enquiry count — controller tests with the Mongoose models
// stubbed out: no database, no server.
//   node --test tests/enquiryCount.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import EnquiryCount from '../models/EnquiryCount.js';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import * as ctl from '../controllers/enquiryCountController.js';

const mongoose = EnquiryCount.base;
const oid = () => new mongoose.Types.ObjectId();

const chain = (value) => {
  const q = {
    select: () => q,
    lean: () => q,
    then: (res, rej) => Promise.resolve(typeof value === 'function' ? value() : value).then(res, rej),
  };
  return q;
};

const call = async (handler, { user, body = {}, query = {} }) => {
  let code = 200;
  let out;
  const res = { status: (c) => ((code = c), res), json: (b) => ((out = b), res) };
  await handler({ user, body, query }, res);
  return { code, body: out };
};

// In-memory "collection" for EnquiryCount, keyed by date|channel.
const store = new Map();
EnquiryCount.find = (q) =>
  chain(() =>
    [...store.values()].filter((r) =>
      typeof q.date === 'string' ? r.date === q.date : r.date >= q.date.$gte && r.date <= q.date.$lte
    )
  );
EnquiryCount.bulkWrite = async (ops) => {
  for (const { updateOne: u } of ops) {
    const k = `${u.filter.date}|${u.filter.channel}`;
    const row = store.get(k) ?? { ...u.filter, history: [], ...u.update.$setOnInsert };
    Object.assign(row, u.update.$set, { updatedAt: new Date() });
    row.history = [...row.history, ...u.update.$push.history.$each].slice(u.update.$push.history.$slice);
    store.set(k, row);
  }
};

const safana = { _id: oid(), name: 'Safana', role: 'sales' };
const malavika = { _id: oid(), name: 'Malavika', role: 'sales_executive' };
const marketingHead = { _id: oid(), name: 'Marketing Head', role: 'marketing_admin' };
const artist = { _id: oid(), name: 'Artist', role: 'artist' };
const day = '2026-11-10';
const IG = 'IG Leads — Main Page';
const WA = 'WhatsApp (Organic)';

test('one shared count: what Safana enters, Malavika and marketing see', async () => {
  store.clear();
  const save = await call(ctl.saveDayCounts, { user: safana, body: { date: day, counts: { [IG]: 9, [WA]: 4 } } });
  assert.equal(save.code, 200);
  assert.equal(save.body.changed, 2);

  for (const viewer of [malavika, marketingHead]) {
    const r = await call(ctl.getDayCounts, { user: viewer, query: { date: day } });
    assert.equal(r.code, 200);
    assert.equal(r.body.counts[IG], 9);
    assert.equal(r.body.counts[WA], 4);
    assert.equal(r.body.updatedByName, 'Safana');
  }
  const mk = await call(ctl.getDayCounts, { user: marketingHead, query: { date: day } });
  assert.equal(mk.body.canEdit, false);
});

test('Malavika corrects it; Safana sees the change; history records who', async () => {
  const r = await call(ctl.saveDayCounts, { user: malavika, body: { date: day, counts: { [IG]: 11 } } });
  assert.equal(r.code, 200);
  assert.equal(r.body.changed, 1);
  const s = await call(ctl.getDayCounts, { user: safana, query: { date: day } });
  assert.equal(s.body.counts[IG], 11);
  assert.equal(s.body.counts[WA], 4); // untouched channel kept
  assert.equal(s.body.updatedByName, 'Malavika');
  const igHist = s.body.history.filter((h) => h.channel === IG);
  assert.deepEqual(igHist.map((h) => [h.from, h.to, h.byName]).sort(), [[9, 11, 'Malavika'], [null, 9, 'Safana']].sort());
});

test('saving the same number again writes nothing', async () => {
  const r = await call(ctl.saveDayCounts, { user: safana, body: { date: day, counts: { [IG]: 11 } } });
  assert.equal(r.body.changed, 0);
});

test('marketing and non-sales cannot write; future dates and bad numbers rejected', async () => {
  assert.equal((await call(ctl.saveDayCounts, { user: marketingHead, body: { date: day, counts: { [IG]: 1 } } })).code, 403);
  assert.equal((await call(ctl.getDayCounts, { user: artist, query: { date: day } })).code, 403);
  assert.equal((await call(ctl.saveDayCounts, { user: safana, body: { date: '2999-01-01', counts: { [IG]: 1 } } })).code, 400);
  assert.equal((await call(ctl.saveDayCounts, { user: safana, body: { date: day, counts: { [IG]: 1.5 } } })).code, 400);
  assert.equal((await call(ctl.saveDayCounts, { user: safana, body: { date: day, counts: { Nope: 1 } } })).code, 400);
});

test('verification: team count vs leads saved by sales staff only', async () => {
  const crm = { _id: oid(), name: 'CRM', role: 'crm' };
  const at = new Date('2026-11-10T06:00:00.000Z');
  Lead.find = () =>
    chain([
      { source: IG, createdBy: safana._id, createdAt: at },
      { source: IG, createdBy: malavika._id, createdAt: at },
      { source: 'whatsapp', createdBy: safana._id, createdAt: at },
      { source: IG, createdBy: crm._id, createdAt: at }, // not sales → ignored
    ]);
  User.find = () => chain([safana, malavika, crm]);
  const r = await call(ctl.getVerification, { user: malavika, query: { from: day, to: day } });
  assert.equal(r.code, 200);
  const ig = r.body.channels.find((c) => c.channel === IG);
  assert.deepEqual([ig.enquiries, ig.leads, ig.gap], [11, 2, 9]);
  assert.equal(r.body.totals.enquiries, 15);
  assert.equal(r.body.totals.leads, 3);
  assert.equal(r.body.daysEntered, 1);
  assert.deepEqual(r.body.people.map((p) => [p.name, p.leads]), [['Safana', 2], ['Malavika', 1]]);
});

test('manualCountsByDay only lists days that were entered', async () => {
  const m = await ctl.manualCountsByDay('2026-11-01', '2026-11-30');
  assert.deepEqual([...m.keys()], [day]);
  assert.equal(m.get(day)[IG], 11);
});
