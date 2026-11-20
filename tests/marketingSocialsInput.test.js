// Pure unit tests: node --test tests/marketingSocialsInput.test.js
// Checking what the app sends for assets, accounts and targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { httpUrl, cleanAssetInput, cleanAccountInput, cleanTargetInput, mondayOf } from '../utils/marketingSocialsInput.js';
import { cleanMetrics } from '../controllers/contentController.js';

test('links: only http(s); anything else is empty', () => {
  assert.equal(httpUrl('https://drive.google.com/x'), 'https://drive.google.com/x');
  assert.equal(httpUrl('  http://a.test/b  '), 'http://a.test/b');
  for (const v of ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://x', 'not a url', '', null, undefined, 'data:text/html,hi']) assert.equal(httpUrl(v), '', String(v));
});

test('asset: a new one needs a title and a link; defaults follow the kind', () => {
  assert.equal(cleanAssetInput({ url: 'https://a.test' }).ok, false);
  assert.equal(cleanAssetInput({ title: 'x', url: 'https://a.test' }).field, 'title');
  assert.equal(cleanAssetInput({ title: 'Hero', url: 'nope' }).field, 'url');
  const r = cleanAssetInput({ title: ' Hero ', url: 'https://a.test/h', kind: 'film' });
  assert.equal(r.ok, true);
  assert.equal(r.value.title, 'Hero');
  assert.equal(r.value.media, 'video');
  assert.equal(cleanAssetInput({ title: 'Look', url: 'https://a.test', kind: 'still' }).value.media, 'image');
  assert.equal(cleanAssetInput({ title: 'Look', url: 'https://a.test', kind: 'design' }).value.media, 'design');
  assert.equal(cleanAssetInput({ title: 'Look', url: 'https://a.test', kind: 'still', media: 'video' }).value.media, 'video', 'what the sender said wins');
});

test('asset: an update changes only what was sent', () => {
  const existing = { title: 'Old' };
  assert.deepEqual(cleanAssetInput({ stage: 'in_edit' }, existing).value, { stage: 'in_edit' });
  assert.equal(cleanAssetInput({ stage: 'shipped' }, existing).ok, false);
  assert.equal(cleanAssetInput({ brand: 'mars' }, existing).ok, false);
  assert.equal(cleanAssetInput({ thumbUrl: 'javascript:x' }, existing).field, 'thumbUrl');
  assert.equal(cleanAssetInput({ thumbUrl: '' }, existing).value.thumbUrl, '', 'clearing the thumbnail is allowed');
  assert.deepEqual(cleanAssetInput({ tags: 'Bridal, bridal ,  Kerala' }, existing).value.tags, ['bridal', 'kerala']);
  assert.equal(cleanAssetInput({ durationSec: -4, sizeMb: 'x' }, existing).value.durationSec, 0);
  assert.equal(cleanAssetInput({ sizeMb: 92.84 }, existing).value.sizeMb, 92.8);
  assert.equal(cleanAssetInput({ shootId: 'nope' }, existing).value.shootId, null);
  assert.equal(cleanAssetInput({ isFinal: 'yes' }, existing).value.isFinal, false, 'only true is true');
});

test('account: a platform is needed; status and followers are checked', () => {
  assert.equal(cleanAccountInput({ brand: 'main' }).ok, false);
  const r = cleanAccountInput({ platform: ' Instagram ', brand: 'kerala', handle: ' @x ', followers: '1200.6' });
  assert.deepEqual(r.value, { platform: 'instagram', brand: 'kerala', handle: '@x', followers: 1201 });
  assert.equal(cleanAccountInput({ platform: 'x', status: 'live' }).ok, false);
  assert.equal(cleanAccountInput({ followers: -1 }, {}).ok, false);
  assert.equal(cleanAccountInput({ followers: 'a' }, {}).ok, false);
  assert.equal(cleanAccountInput({ followers: 2e9 }, {}).ok, false);
});

test('week: any day maps to its Monday', () => {
  assert.equal(mondayOf('2026-11-02'), '2026-11-02');
  assert.equal(mondayOf('2026-11-08'), '2026-11-02', 'Sunday belongs to the week before it');
  assert.equal(mondayOf('2026-11-09'), '2026-11-09');
  assert.equal(mondayOf('2026-01-01'), '2025-12-29');
});

test('targets: a real day, a list of numbers ≥ 0, a known brand', () => {
  const m = '64b7f0c2a1b2c3d4e5f60718';
  const ok = cleanTargetInput({ period: '2026-11-04', values: [{ metricId: m, target: '26' }] });
  assert.deepEqual(ok.value, { brand: 'all', period: '2026-11-02', rows: [{ metricId: m, target: 26 }] });
  for (const body of [{ period: '2026-02-31', values: [{ metricId: m, target: 1 }] }, { values: [{ metricId: m, target: 1 }] }, { period: '2026-11-02' }, { period: '2026-11-02', values: [] }, { period: '2026-11-02', values: [{ metricId: 'x', target: 1 }] }, { period: '2026-11-02', values: [{ metricId: m, target: -1 }] }, { period: '2026-11-02', values: [{ metricId: m, target: 1e9 }] }, { brand: 'mars', period: '2026-11-02', values: [{ metricId: m, target: 1 }] }]) {
    assert.equal(cleanTargetInput(body).ok, false, JSON.stringify(body));
  }
});

test('post metrics: only the known counts, whole numbers ≥ 0', () => {
  assert.deepEqual(cleanMetrics({ reach: '120.4', likes: 5, saves: -1, nope: 9, views: '', comments: null, shares: 'x' }), { reach: 120, likes: 5 });
  assert.deepEqual(cleanMetrics(null), {});
  assert.deepEqual(cleanMetrics('x'), {});
});
