// Pure unit tests: node --test tests/marketingSocialsRules.test.js
// The Socials rules added after the audit: platforms are never quietly turned into Instagram, only approved / final assets can be
// posted, targets are pro-rated by days, each platform's growth is against the period before, the "Next actions" rules, an asset
// takes its shoot's brand / portfolio / tags, and when an asset counts as approved.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../utils/marketingSocialsStats.js';
import { platformOf, isUsableAsset, approvedAtFor, assetFromShoot, portfolioOfBrand } from '../utils/marketingSocialsInput.js';
import { CONTENT_PLATFORMS } from '../models/ContentItem.js';

const R = { from: '2026-11-09', to: '2026-11-15', brand: 'all' }; // a Monday to Sunday; the week before is 2–8 Nov
let n = 0;
const item = (extra = {}) => ({ _id: `i${++n}`, title: `Post ${n}`, status: 'published', contentType: 'reel', platform: 'instagram', brand: 'main', scheduledDate: '2026-11-10T04:30:00Z', publishedDate: '2026-11-10T04:30:00Z', metrics: {}, ...extra });
const before = (extra = {}) => item({ scheduledDate: '2026-11-03T04:30:00Z', publishedDate: '2026-11-03T04:30:00Z', ...extra });

test('platforms: every platform the app offers is kept as itself; an unknown one is refused (null), never Instagram', () => {
  for (const p of ['instagram', 'youtube', 'facebook', 'whatsapp', 'website', 'pinterest', 'snapchat', 'linkedin', 'other']) assert.equal(platformOf(p), p, p);
  assert.equal(platformOf(' Pinterest '), 'pinterest', 'case and spaces do not matter');
  assert.equal(platformOf('myspace'), null);
  assert.equal(platformOf(''), null);
  assert.equal(platformOf(undefined), null);
  assert.ok(CONTENT_PLATFORMS.includes('snapchat') && CONTENT_PLATFORMS.includes('linkedin'), 'the stored list has them too');
  for (const old of ['instagram', 'youtube', 'facebook', 'whatsapp', 'website', 'other']) assert.ok(CONTENT_PLATFORMS.includes(old), `posts saved as ${old} stay valid`);
});

test('a post can be made only from an approved or final asset', () => {
  assert.equal(isUsableAsset({ stage: 'approved' }), true);
  assert.equal(isUsableAsset({ stage: 'in_edit', isFinal: true }), true, 'marked final');
  for (const stage of ['raw', 'in_edit', 'post_produced', 'in_review', 'rejected']) assert.equal(isUsableAsset({ stage }), false, stage);
  assert.equal(isUsableAsset(null), false);
});

test('approvedAt: set when it becomes approved / final, kept while it stays so, cleared when it stops; older approvals stay unknown', () => {
  const now = new Date('2026-11-12T06:00:00Z');
  const earlier = new Date('2026-11-10T06:00:00Z');
  assert.equal(approvedAtFor({}, { stage: 'raw' }, now), null, 'a new raw asset');
  assert.equal(approvedAtFor({}, { stage: 'approved' }, now), now, 'a new asset added approved');
  assert.equal(approvedAtFor({ stage: 'in_review' }, { stage: 'approved' }, now), now, 'approved now');
  assert.equal(approvedAtFor({ stage: 'in_edit' }, { stage: 'in_edit', isFinal: true }, now), now, 'made final now');
  assert.equal(approvedAtFor({ stage: 'approved', approvedAt: earlier }, { stage: 'approved', isFinal: true }, now), earlier, 'stays approved → the first day');
  assert.equal(approvedAtFor({ stage: 'approved', approvedAt: earlier }, { stage: 'rejected' }, now), null, 'rejected → no longer delivered');
  assert.equal(approvedAtFor({ stage: 'approved', approvedAt: null }, { stage: 'approved' }, now), null, 'approved before this was kept → unknown, not "now"');
});

test('an asset of a shoot takes the shoot\'s brand, portfolio and category tag; its own page wins, else the category', () => {
  const kerala = { brand: 'kerala', category: 'Bridal Makeup' };
  assert.deepEqual(assetFromShoot(kerala, { page: '', tags: ['hero'] }), { brand: 'kerala', portfolio: 'Kerala', page: 'Bridal Makeup', tags: ['hero', 'bridal makeup'] });
  assert.equal(assetFromShoot(kerala, { page: 'Custom' }).page, 'Custom');
  assert.deepEqual(assetFromShoot(kerala, { tags: ['bridal makeup'] }).tags, ['bridal makeup'], 'the tag is not doubled');
  assert.deepEqual(assetFromShoot({ brand: 'main', category: '' }, {}), { brand: 'main', portfolio: 'Main (Company)', page: '', tags: [] });
  assert.equal(portfolioOfBrand('kerala'), 'Kerala');
  assert.equal(portfolioOfBrand('main'), 'Main (Company)');
});

test('targets are pro-rated by days: a day is a seventh of the week, a month adds up its weeks and the parts at its ends', () => {
  const rows = [{ brand: 'all', period: '2026-11-02', metricId: 'm1', target: 28 }];
  const t = (from, to) => S.rangeTarget(rows, { brand: 'all', from, to, metricId: 'm1' });
  assert.equal(t('2026-11-11', '2026-11-11'), 4, 'Today: one day of 28 a week');
  assert.equal(t('2026-11-09', '2026-11-15'), 28, 'a whole week');
  assert.equal(t('2026-11-12', '2026-11-18'), 28, 'seven days across two weeks');
  assert.equal(t('2026-11-01', '2026-11-30'), 116, 'November: the week of 26 Oct has none; 4 whole weeks and Monday the 30th');
  assert.equal(t('2026-10-26', '2026-11-01'), null, 'no target set yet');
  assert.equal(S.rangeTarget([{ brand: 'all', period: '2026-11-02', metricId: 'm1', target: 26 }], { brand: 'all', from: '2026-11-11', to: '2026-11-11', metricId: 'm1' }), 3.7, 'rounded to one decimal');
});

test('platform performance carries each platform\'s growth against the period before', () => {
  const items = [
    item({ metrics: { reach: 300, likes: 30 } }),
    item({ metrics: { reach: 300 } }),
    before({ metrics: { reach: 400, likes: 10 } }),
    item({ platform: 'pinterest', metrics: { reach: 50 } }),
    before({ platform: 'youtube', metrics: { reach: 90 } }),
  ];
  const rows = S.platformPerformance(items, R);
  const ig = rows.find((r) => r.platform === 'instagram');
  assert.deepEqual(ig.change, { posts: 100, reach: 50, engagements: 200 }, '2 vs 1 posts, 600 vs 400 reach, 30 vs 10 likes');
  const pin = rows.find((r) => r.platform === 'pinterest');
  assert.equal(pin.label, 'Pinterest');
  assert.deepEqual(pin.change, { posts: null, reach: null, engagements: null }, 'nothing before → no growth figure');
  assert.equal(rows.find((r) => r.platform === 'youtube'), undefined, 'a platform with nothing this period has no row');
});

test('next actions: only what the figures support, plain words', () => {
  const now = new Date('2026-11-14T06:00:00Z');
  const quiet = S.nextActions([item({ metrics: { reach: 100, likes: 5 } })], R, { now, upcoming: 3 });
  assert.deepEqual(quiet, [], 'a healthy week asks for nothing');

  const items = [
    item({ status: 'scheduled', publishedDate: null, scheduledDate: '2026-11-12T04:30:00Z' }), // overdue
    item({ status: 'in-review', publishedDate: null, scheduledDate: '2026-11-16T04:30:00Z' }), // waiting for approval
    item({ metrics: {} }), // out with no numbers
    ...[1, 2].map(() => item({ contentType: 'reel', metrics: { reach: 1000, likes: 300 } })),
    ...[1, 2].map(() => item({ contentType: 'post', metrics: { reach: 1000, likes: 100 } })),
    before({ platform: 'youtube', metrics: { reach: 1000 } }),
    item({ platform: 'youtube', metrics: { reach: 500 } }),
  ];
  const a = S.nextActions(items, R, { now, upcoming: 0, followers: -4 });
  const has = (re) => assert.ok(a.some((x) => re.test(x)), `${re} in ${JSON.stringify(a, null, 1)}`);
  has(/^Publish or reschedule the 1 post past its scheduled day/);
  has(/^Review the 1 post waiting for approval/);
  has(/^Type the numbers on the 1 post that went out without any/);
  has(/^Nothing is planned for the next 7 days/);
  has(/^Reels are earning 3× the engagement of static posts/);
  has(/^Reach on YouTube fell 50%/);
  has(/^Followers fell 4%/);
  assert.ok(!S.nextActions(items, { ...R, to: '2026-11-13' }, { now: new Date('2026-12-30T06:00:00Z'), upcoming: 0 }).some((x) => /next 7 days/.test(x)), 'a period that is over does not ask to plan the next week');
  assert.ok(!S.nextActions(items, R, { now, upcoming: 2 }).some((x) => /next 7 days/.test(x)), 'something planned → no prompt');
});
