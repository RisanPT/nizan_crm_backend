// Website visitor counter — pure rules + routes with stubbed models (no database).
// node --test tests/websiteVisits.test.js
import test, { beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import WebsiteVisit from '../models/WebsiteVisit.js';
import WebsiteEnquiry from '../models/WebsiteEnquiry.js';
import { recordVisit, getVisitorStats, resetVisitLimits } from '../controllers/website/visitController.js';
import {
  buildVisitorStats,
  classifySource,
  deviceFromUa,
  isBot,
  parseRange,
  validateVisit,
} from '../utils/websiteVisits.js';
import { todayIst } from '../utils/istDate.js';

const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
const CHROME_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';

// ── Pure rules ──────────────────────────────────────────────────────────────
test('bots and link previews are not counted', () => {
  assert.equal(isBot(''), true);
  assert.equal(isBot('Googlebot/2.1 (+http://www.google.com/bot.html)'), true);
  assert.equal(isBot('facebookexternalhit/1.1'), true);
  assert.equal(isBot('WhatsApp/2.23.20.0 A'), true);
  assert.equal(isBot('Mozilla/5.0 HeadlessChrome/120'), true);
  assert.equal(isBot(CHROME_ANDROID), false);
  assert.equal(isBot(CHROME_DESKTOP), false);
});

test('device type from the user agent', () => {
  assert.equal(deviceFromUa(CHROME_ANDROID), 'mobile');
  assert.equal(deviceFromUa(CHROME_DESKTOP), 'desktop');
  assert.equal(deviceFromUa(IPAD), 'tablet');
  assert.equal(deviceFromUa('Mozilla/5.0 (Linux; Android 13; SM-X200) Safari/537.36'), 'tablet');
});

test('traffic source: utm first, then referrer, else direct', () => {
  assert.equal(classifySource({}), 'direct');
  assert.equal(classifySource({ refHost: 'www.google.co.in' }), 'google');
  assert.equal(classifySource({ refHost: 'l.instagram.com' }), 'instagram');
  assert.equal(classifySource({ refHost: 'm.facebook.com' }), 'facebook');
  assert.equal(classifySource({ refHost: 'teamnmakeovers.com', siteHost: 'www.teamnmakeovers.com' }), 'direct');
  assert.equal(classifySource({ refHost: 'weddingblog.in' }), 'weddingblog.in');
  assert.equal(classifySource({ utmSource: 'IG', refHost: 'www.google.com' }), 'instagram');
  assert.equal(classifySource({ utmSource: 'Facebook_Ads' }), 'facebook');
  assert.equal(classifySource({ utmSource: 'newsletter' }), 'newsletter');
});

test('validateVisit keeps the path only and rejects bad ids', () => {
  assert.equal(validateVisit({}).ok, false);
  assert.equal(validateVisit({ vid: 'short', sid: 'abcdefgh12' }).ok, false);
  assert.equal(validateVisit({ vid: 'abcdefgh12', sid: 'abcdefgh34', path: 'http://x' }).ok, false);
  const v = validateVisit({
    vid: 'abcdefgh12',
    sid: 'abcdefgh34',
    path: '/book/?preview=SECRET#top',
    utm: { source: 'instagram', medium: 'Paid', campaign: 'Nov Brides' },
    newVisitor: true,
  });
  assert.equal(v.ok, true);
  assert.deepEqual(v.value, {
    vid: 'abcdefgh12',
    sid: 'abcdefgh34',
    path: '/book',
    source: 'instagram',
    medium: 'paid',
    campaign: 'Nov Brides',
    newVisitor: true,
  });
  assert.equal(validateVisit({ vid: 'abcdefgh12', sid: 'abcdefgh34' }).value.path, '/');
});

test('parseRange allows 7, 30 or 90 days only', () => {
  assert.equal(parseRange('7'), 7);
  assert.equal(parseRange('90'), 90);
  assert.equal(parseRange('365'), 30);
  assert.equal(parseRange(undefined), 30);
});

test('buildVisitorStats fills empty days and works out rates', () => {
  const s = buildVisitorStats({
    facet: {
      totals: [{ visitors: 40, visits: 50, pageViews: 125, newVisitors: 30 }],
      today: [{ visitors: 3, pageViews: 7 }],
      daily: [{ _id: '2026-11-18', visitors: 10, pageViews: 25 }],
      pages: [{ _id: '/', views: 60, visitors: 35 }],
      sources: [{ _id: 'instagram', views: 70, visitors: 20 }],
      devices: [{ _id: 'mobile', views: 100, visitors: 32 }],
    },
    days: ['2026-11-17', '2026-11-18', '2026-11-19'],
    today: '2026-11-19',
    enquiries: { booking: 2, contact: 1 },
  });
  assert.deepEqual(s.range, { from: '2026-11-17', to: '2026-11-19', days: 3 });
  assert.equal(s.totals.pagesPerVisit, 2.5);
  assert.deepEqual(s.today, { visitors: 3, pageViews: 7 });
  assert.equal(s.enquiries.bookingRate, 5);
  assert.equal(s.enquiries.enquiryRate, 7.5);
  assert.deepEqual(s.daily.map((d) => d.visitors), [0, 10, 0]);
  assert.deepEqual(s.pages[0], { path: '/', views: 60, visitors: 35 });
  assert.deepEqual(s.sources[0], { name: 'instagram', views: 70, visitors: 20 });
});

test('buildVisitorStats with no data is all zeros', () => {
  const s = buildVisitorStats({ days: ['2026-11-19'], today: '2026-11-19' });
  assert.equal(s.totals.visitors, 0);
  assert.equal(s.enquiries.bookingRate, 0);
  assert.equal(s.daily.length, 1);
});

// ── Routes ──────────────────────────────────────────────────────────────────
const created = [];
WebsiteVisit.create = async (doc) => {
  created.push(doc);
  return doc;
};
let pipelines = [];
WebsiteVisit.aggregate = async (p) => {
  pipelines.push(p);
  return [{ totals: [{ visitors: 4, visits: 5, pageViews: 9, newVisitors: 2 }], daily: [], pages: [], sources: [], devices: [] }];
};
WebsiteEnquiry.aggregate = async () => [{ _id: 'booking', n: 1 }];

const app = express();
app.use(express.json());
app.post('/visit', recordVisit);
app.get('/visitors', getVisitorStats);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

beforeEach(() => {
  created.length = 0;
  pipelines = [];
  resetVisitLimits();
});

const ping = (body, ua = CHROME_ANDROID) =>
  fetch(`${base}/visit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': ua },
    body: JSON.stringify(body),
  });

test('POST /visit stores one anonymous row', async () => {
  const r = await ping({ vid: 'abcdefgh12', sid: 'abcdefgh34', path: '/packages', refHost: 'www.google.com' });
  assert.equal(r.status, 204);
  assert.equal(created.length, 1);
  assert.equal(created[0].path, '/packages');
  assert.equal(created[0].source, 'google');
  assert.equal(created[0].device, 'mobile');
  assert.equal(created[0].day, todayIst());
  assert.equal('ip' in created[0], false);
});

test('POST /visit ignores bots and junk but still answers 204', async () => {
  assert.equal((await ping({ vid: 'abcdefgh12', sid: 'abcdefgh34' }, 'Googlebot/2.1')).status, 204);
  assert.equal((await ping({ vid: 'x', sid: 'y' })).status, 204);
  assert.equal(created.length, 0);
});

test('POST /visit is rate-limited per address', async () => {
  for (let i = 0; i < 125; i += 1) await ping({ vid: 'abcdefgh12', sid: 'abcdefgh34' });
  assert.equal(created.length, 120);
});

test('GET /visitors returns the dashboard for the chosen range', async () => {
  const r = await fetch(`${base}/visitors?days=7`);
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.range.days, 7);
  assert.equal(body.daily.length, 7);
  assert.equal(body.totals.visitors, 4);
  assert.equal(body.enquiries.booking, 1);
  assert.equal(body.enquiries.bookingRate, 25);
  assert.equal(pipelines[0][0].$match.day.$lte, todayIst());
});
