// Route tests with stubbed models — no database connection is made.
// node --test tests/websitePublicRoutes.test.js
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import ServicePackage from '../models/Package.js';
import AddonService from '../models/AddonService.js';
import Booking from '../models/Booking.js';
import BlockedDate from '../models/BlockedDate.js';
import SlotCapacity from '../models/SlotCapacity.js';
import SlotHold from '../models/SlotHold.js';
import WebsiteSection from '../models/WebsiteSection.js';
import WebsiteGalleryItem from '../models/WebsiteGalleryItem.js';
import Region from '../models/Region.js';
import District from '../models/District.js';
import { priceForLocation } from '../utils/websitePublic.js';
import websitePublicRoutes from '../routes/websitePublicRoutes.js';
import { clearPublicCache } from '../controllers/website/publicController.js';
import { todayIst } from '../utils/istDate.js';

// Query stub: every chain method returns itself; lean() resolves the data.
const chain = (data, spy) => {
  const q = {
    select: () => q,
    sort: () => q,
    limit: () => q,
    lean: async () => data,
  };
  return (...args) => {
    spy?.(...args);
    return q;
  };
};

const writes = [];
for (const M of [ServicePackage, AddonService, Booking, BlockedDate, SlotCapacity, SlotHold, WebsiteSection, WebsiteGalleryItem]) {
  // Any write attempt would show up here.
  for (const w of ['create', 'updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'insertMany']) {
    M[w] = (...args) => {
      writes.push(`${M.modelName}.${w}`);
      return Promise.resolve(args);
    };
  }
}

const app = express();
app.use('/api/website/public', websitePublicRoutes);
app.use((err, req, res, _next) => res.status(500).json({ message: err.message }));
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/website/public`;
after(() => server.close());

const get = async (path) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
};

beforeEach(() => {
  clearPublicCache();
  WebsiteSection.find = chain([]);
  WebsiteGalleryItem.find = chain([]);
  ServicePackage.find = chain([]);
  AddonService.find = chain([]);
  SlotCapacity.findOne = chain(null);
  SlotCapacity.find = chain([]);
  BlockedDate.find = chain([]);
  Booking.find = chain([]);
  SlotHold.find = chain([]);
});

test('content returns only published sections', async () => {
  let filter;
  WebsiteSection.find = chain(
    [{ key: 'hero', published: { title: 'Hi' }, publishedAt: new Date('2026-11-16T10:00:00Z') }],
    (f) => (filter = f)
  );
  const r = await get('/content');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.sections, { hero: { title: 'Hi' } });
  assert.deepEqual(filter.published, { $ne: null });
  assert.equal(r.cache, 'no-cache'); // a Publish shows at once
});

test('packages: only website-enabled, safe fields, website order', async () => {
  let filter;
  ServicePackage.find = chain(
    [
      { _id: 'p2', name: 'Airbrush', price: 35000, advanceAmount: 3000, sortOrder: 1, regionPrices: [{ x: 1 }, { region: 'r1', price: 30000 }], districtPrices: [{ district: 'd1', price: 40000, secret: 'no' }], website: { show: true, sortOrder: 2 } },
      { _id: 'p1', name: 'Platinum', price: 50000, advanceAmount: 5000, description: 'CRM text', website: { show: true, sortOrder: 1, highlighted: true, features: ['A'] } },
    ],
    (f) => (filter = f)
  );
  AddonService.find = chain([{ _id: 'a1', name: 'Trial', price: 8000, website: { show: true, description: 'Web text' } }]);
  const r = await get('/packages');
  assert.deepEqual(filter, { 'website.show': true });
  assert.deepEqual(r.body.packages.map((p) => p.name), ['Platinum', 'Airbrush']);
  assert.equal(r.body.packages[0].description, 'CRM text'); // falls back to the CRM description
  assert.equal(r.body.packages[0].highlighted, true);
  // Location prices go out only as clean { id: price } maps (bad rows dropped, no other fields).
  assert.deepEqual(r.body.packages[1].regionPrices, { r1: 30000 });
  assert.deepEqual(r.body.packages[1].districtPrices, { d1: 40000 });
  assert.equal(r.body.packages[1].priceMin, 30000);
  assert.equal(r.body.packages[1].priceMax, 40000);
  assert.deepEqual(r.body.packages[0].regionPrices, {});
  assert.equal(r.body.packages[0].priceMin, 50000);
  assert.deepEqual(r.body.addons, [{ id: 'a1', name: 'Trial', price: 8000, description: 'Web text' }]);
});

test('price for a location: district, then region, then base (same as bookings)', () => {
  const p = { price: 100, regionPrices: [{ region: 'r1', price: 80 }], districtPrices: [{ district: 'd1', price: 120 }] };
  assert.equal(priceForLocation(p, { districtId: 'd1', regionId: 'r1' }), 120);
  assert.equal(priceForLocation(p, { districtId: 'd2', regionId: 'r1' }), 80);
  assert.equal(priceForLocation(p, { districtId: 'd2', regionId: 'r2' }), 100);
  assert.equal(priceForLocation(p), 100);
});

test('locations: active regions with their active districts, names only', async () => {
  let rf;
  let df;
  Region.find = chain([{ _id: 'r2', name: 'Malabar' }, { _id: 'r1', name: 'Central', state: 'x' }, { _id: 'r3', name: 'Empty' }], (f) => (rf = f));
  District.find = chain(
    [
      { _id: 'd2', name: 'Kozhikode', region: 'r2' },
      { _id: 'd1', name: 'Ernakulam', region: 'r1' },
      { _id: 'd3', name: 'Kannur', region: 'r2' },
    ],
    (f) => (df = f)
  );
  const r = await get('/locations');
  assert.deepEqual(rf, { status: 'active' });
  assert.deepEqual(df, { status: 'active' });
  assert.deepEqual(r.body.regions, [
    { id: 'r1', name: 'Central', districts: [{ id: 'd1', name: 'Ernakulam' }] },
    { id: 'r2', name: 'Malabar', districts: [{ id: 'd3', name: 'Kannur' }, { id: 'd2', name: 'Kozhikode' }] },
  ]);
});

test('gallery rejects an unknown category', async () => {
  const r = await get('/gallery?category=<script>');
  assert.equal(r.status, 400);
});

test('gallery returns active items with categories', async () => {
  let filter;
  WebsiteGalleryItem.find = chain(
    [{ _id: 'g1', image: { url: 'https://res.cloudinary.com/x/a.jpg', width: 960, height: 1200 }, alt: 'Bride', category: 'makeup' }],
    (f) => (filter = f)
  );
  const r = await get('/gallery?category=makeup');
  assert.deepEqual(filter, { active: true, category: 'makeup' });
  assert.equal(r.body.items[0].image.alt, 'Bride');
  assert.equal(r.body.categories.length, 4);
});

test('availability month: statuses only, past days marked', async () => {
  const month = todayIst().slice(0, 7);
  const today = todayIst();
  SlotCapacity.findOne = chain({ morning: 1, evening: 1 });
  Booking.find = chain([{ bookingDate: new Date(`${today}T00:00:00Z`), eventSlot: 'Morning', status: 'confirmed' }]);
  const r = await get(`/availability?month=${month}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.days[today].morning.status, 'full');
  assert.equal(r.body.days[today].evening.status, 'few');
  if (today.slice(8) !== '01') assert.equal(r.body.days[`${month}-01`].status, 'past');
  assert.doesNotMatch(JSON.stringify(r.body), /capacity|booked|confirmed/);
});

test('availability month: bad or out-of-range month is refused', async () => {
  assert.equal((await get('/availability?month=2020-01')).status, 400);
  assert.equal((await get('/availability?month=abc')).status, 400);
});

test('availability date: one day, never cached', async () => {
  const [y, m] = todayIst().split('-').map(Number);
  const next = `${m === 12 ? y + 1 : y}-${String((m % 12) + 1).padStart(2, '0')}-10`;
  BlockedDate.find = chain([{ date: new Date(`${next}T00:00:00Z`) }]);
  const r = await get(`/availability/${next}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.date, next);
  assert.equal(r.body.status, 'blocked');
  assert.equal(r.cache, 'no-store');
  assert.equal((await get('/availability/2026-02-31')).status, 400);
});

test('no endpoint writes to the database', () => {
  assert.deepEqual(writes, []);
});
