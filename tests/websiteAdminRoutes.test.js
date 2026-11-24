// Admin route tests with stubbed models and a stubbed Cloudinary.
// No database connection and no real upload is made.
// node --test tests/websiteAdminRoutes.test.js
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import Role from '../models/Role.js';
import WebsiteSection from '../models/WebsiteSection.js';
import WebsiteMedia from '../models/WebsiteMedia.js';
import WebsiteGalleryItem from '../models/WebsiteGalleryItem.js';
import ServicePackage from '../models/Package.js';
import AddonService from '../models/AddonService.js';
import { cloudinary } from '../config/cloudinary.js';
import websiteAdminRoutes from '../routes/websiteAdminRoutes.js';
import websitePublicRoutes from '../routes/websitePublicRoutes.js';

// ── stubs ────────────────────────────────────────────────────────────────────
const query = (get) => {
  const q = {
    select: () => q, sort: () => q, skip: () => q, limit: () => q, populate: () => q,
    lean: async () => {
      const v = await get();
      return v?.toObject ? v.toObject() : v;
    },
    then: (ok, bad) => Promise.resolve(get()).then(ok, bad),
  };
  return q;
};

const users = {
  u_admin: { _id: 'u_admin', name: 'Admin', role: 'admin', active: true },
  u_mkt: { _id: 'u_mkt', name: 'Mkt', role: 'marketing_admin', active: true },
  u_gal: { _id: 'u_gal', name: 'Gal', role: 'gallery_only', active: true },
  u_sales: { _id: 'u_sales', name: 'Sales', role: 'sales', active: true },
};
const rolePerms = { marketing_admin: ['marketing', 'website'], gallery_only: ['website.gallery'], sales: ['sales'] };
User.findById = (id) => ({ select: async () => users[id] ?? null });
Role.findOne = (f) => query(() => ({ permissions: rolePerms[f.key] ?? [] }));

const sections = new Map();
WebsiteSection.findOne = (f) => query(() => (sections.has(f.key) ? new WebsiteSection(sections.get(f.key)) : null));
WebsiteSection.find = () => query(() => [...sections.values()]);
WebsiteSection.prototype.save = async function save() {
  sections.set(this.key, this.toObject());
  return this;
};

const media = [];
WebsiteMedia.create = async (doc) => {
  const m = { _id: `65f0000000000000000000${String(media.length).padStart(2, '0')}`, createdAt: new Date(), ...doc };
  media.push(m);
  return m;
};
WebsiteMedia.findById = (id) => query(() => media.find((m) => m._id === id) ?? null);
WebsiteMedia.deleteOne = async () => ({ deletedCount: 1 });

WebsiteGalleryItem.exists = async () => null;
ServicePackage.find = () => query(() => []);
const pkgUpdates = [];
ServicePackage.findById = () => query(() => ({ _id: 'p', website: { coverImage: null } }));
ServicePackage.updateOne = async (filter, update) => {
  pkgUpdates.push(update);
  return { matchedCount: 1 };
};
AddonService.find = () => query(() => []);

const cloudCalls = [];
cloudinary.uploader.upload_stream = (opts, cb) => ({
  end: (buf) => {
    cloudCalls.push(opts.folder);
    cb(null, {
      secure_url: `https://res.cloudinary.com/testcloud/image/upload/v1/${opts.folder}/x${cloudCalls.length}.png`,
      public_id: `${opts.folder}/x${cloudCalls.length}`,
      width: 1920,
      height: 1080,
      bytes: buf.length,
    });
  },
});
cloudinary.uploader.destroy = async () => ({ result: 'ok' });

// ── app ──────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use('/api/website/admin', websiteAdminRoutes);
app.use('/api/website/public', websitePublicRoutes);
let server;
let base;
before(() => {
  // config/cloudinary.js loads .env with override, so set these after the imports.
  process.env.JWT_SECRET = 'test-secret';
  process.env.CLOUDINARY_CLOUD_NAME = 'testcloud';
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}/api/website`;
});
after(() => server.close());

const token = (id) => jwt.sign({ id }, 'test-secret');
const call = async (method, path, { as, body, form } = {}) => {
  const headers = as ? { Authorization: `Bearer ${token(as)}` } : {};
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + path, { method, headers, body: payload });
  return { status: r.status, body: await r.json() };
};

const png = (w, h) => {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const fileForm = (buf, name, type) => {
  const f = new FormData();
  f.append('file', new Blob([buf], { type }), name);
  return f;
};

// ── tests ────────────────────────────────────────────────────────────────────
test('login and permission are required', async () => {
  assert.equal((await call('GET', '/admin/schema')).status, 401);
  assert.equal((await call('GET', '/admin/schema', { as: 'u_sales' })).status, 403);
  assert.equal((await call('GET', '/admin/schema', { as: 'u_mkt' })).status, 200);
});

test('sub-permission opens only its area', async () => {
  assert.equal((await call('GET', '/admin/sections', { as: 'u_gal' })).status, 403);
  WebsiteGalleryItem.find = () => query(() => []);
  assert.equal((await call('GET', '/admin/gallery', { as: 'u_gal' })).status, 200);
});

test('schema carries upload rules for image fields', async () => {
  const r = await call('GET', '/admin/schema', { as: 'u_admin' });
  const field = r.body.sections.hero.fields.imageDesktop;
  assert.equal(field.upload.maxBytes, 5 * 1024 * 1024);
  assert.match(field.upload.hint, /JPG, PNG, WebP · max 5 MB · at least 1600 × 900 px/);
  assert.deepEqual(r.body.sections.hero.fields.stats.fields.label.type, 'text');
});

test('upload: renamed file refused before Cloudinary; valid file stored', async () => {
  const before = cloudCalls.length;
  const bad = await call('POST', '/admin/media/hero/imageDesktop', {
    as: 'u_mkt',
    form: fileForm(png(1920, 1080), 'hero.jpg', 'image/jpeg'),
  });
  assert.equal(bad.status, 415);
  assert.equal(cloudCalls.length, before);

  const small = await call('POST', '/admin/media/hero/imageDesktop', {
    as: 'u_mkt',
    form: fileForm(png(1280, 720), 'hero.png', 'image/png'),
  });
  assert.equal(small.status, 422);

  const ok = await call('POST', '/admin/media/hero/imageDesktop', {
    as: 'u_mkt',
    form: fileForm(png(1920, 1080), 'hero.png', 'image/png'),
  });
  assert.equal(ok.status, 201);
  assert.equal(cloudCalls.at(-1), 'team_n_website/hero');
  assert.equal(ok.body.rule, 'heroDesktop');
  assert.match(ok.body.value.url, /^https:\/\/res\.cloudinary\.com\/testcloud\//);
});

test('upload: unknown field 404, wrong area 403', async () => {
  const form = () => fileForm(png(1920, 1080), 'a.png', 'image/png');
  assert.equal((await call('POST', '/admin/media/hero/title', { as: 'u_mkt', form: form() })).status, 404);
  assert.equal((await call('POST', '/admin/media/hero/imageDesktop', { as: 'u_gal', form: form() })).status, 403);
});

test('draft → publish → change → revert', async () => {
  const image = {
    url: 'https://res.cloudinary.com/testcloud/image/upload/v1/team_n_website/hero/x1.png',
    publicId: 'team_n_website/hero/x1',
    width: 1920,
    height: 1080,
    alt: 'Bride in a magenta saree',
  };

  const tooLong = await call('PUT', '/admin/sections/hero', { as: 'u_mkt', body: { title: 'x'.repeat(61) } });
  assert.equal(tooLong.status, 422);

  const foreign = await call('PUT', '/admin/sections/hero', {
    as: 'u_mkt',
    body: { imageDesktop: { ...image, url: 'https://evil.example/team_n_website/a.png' } },
  });
  assert.equal(foreign.status, 422);

  const draft = await call('PUT', '/admin/sections/hero', { as: 'u_mkt', body: { subtitle: 'Hello', junk: 1 } });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.status, 'draft');
  assert.deepEqual(draft.body.draft, { subtitle: 'Hello' });

  // One field changed → it publishes; everything else keeps the website's built-in content.
  const early = await call('POST', '/admin/sections/hero/publish', { as: 'u_mkt' });
  assert.equal(early.status, 200);
  assert.deepEqual(early.body.published, { subtitle: 'Hello' });

  // An incomplete list item is still refused (a question without its answer).
  await call('PUT', '/admin/sections/faq', { as: 'u_mkt', body: { items: [{ question: 'Q?' }] } });
  const faq = await call('POST', '/admin/sections/faq/publish', { as: 'u_mkt' });
  assert.equal(faq.status, 422);
  assert.deepEqual(faq.body.errors, ['items[1].answer is required']);

  await call('PUT', '/admin/sections/hero', {
    as: 'u_mkt',
    body: { title: 'Bridal artistry', subtitle: 'Hello', imageDesktop: image },
  });
  const pub = await call('POST', '/admin/sections/hero/publish', { as: 'u_mkt' });
  assert.equal(pub.status, 200);
  assert.equal(pub.body.status, 'published');

  // The public site sees it immediately (publish clears the cache).
  WebsiteSection.find = (f) =>
    query(() => (f?.published ? [...sections.values()].filter((s) => s.published) : [...sections.values()]));
  const live = await call('GET', '/public/content');
  assert.equal(live.body.sections.hero.title, 'Bridal artistry');

  const changed = await call('PUT', '/admin/sections/hero', {
    as: 'u_mkt',
    body: { title: 'New title', imageDesktop: image },
  });
  assert.equal(changed.body.status, 'changed');
  assert.equal((await call('GET', '/public/content')).body.sections.hero.title, 'Bridal artistry'); // drafts stay private

  const reverted = await call('POST', '/admin/sections/hero/revert', { as: 'u_mkt' });
  assert.equal(reverted.body.status, 'published');
  assert.equal(reverted.body.draft.title, 'Bridal artistry');
});

test('unknown section is 404', async () => {
  assert.equal((await call('PUT', '/admin/sections/nope', { as: 'u_admin', body: {} })).status, 404);
});

test('image in use cannot be deleted', async () => {
  const r = await call('DELETE', `/admin/media/${media[0]._id}`, { as: 'u_mkt' });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Hero \(top of home page\) \(live\)/);
});

test('package website update only touches website.* fields', async () => {
  const r = await call('PUT', '/admin/packages/65f000000000000000000001', {
    as: 'u_mkt',
    body: { show: true, tagline: 'Signature look', features: ['A', ' ', 'B'], price: 1, name: 'Hacked' },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(pkgUpdates.at(-1), {
    $set: { 'website.show': true, 'website.tagline': 'Signature look', 'website.features': ['A', 'B'] },
  });
  const bad = await call('PUT', '/admin/packages/65f000000000000000000001', {
    as: 'u_mkt',
    body: { features: Array.from({ length: 13 }, (_, i) => `f${i}`) },
  });
  assert.equal(bad.status, 422);
});

test('section comes with the website text it starts from (no comparison cells)', async () => {
  const hero = await call('GET', '/admin/sections/seo', { as: 'u_mkt' });
  assert.equal(hero.status, 200);
  assert.match(hero.body.defaults.siteTitle, /Team N/);
  const pkg = await call('GET', '/admin/sections/packagesPage', { as: 'u_mkt' });
  assert.ok(pkg.body.defaults.guarantees.length > 0);
  assert.equal(pkg.body.defaults.comparison, undefined);
});
