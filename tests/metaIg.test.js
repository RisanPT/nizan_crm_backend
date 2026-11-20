// Pure unit tests: node --test tests/metaIg.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contentTypeOf,
  hashtagsOf,
  igAccountsFrom,
  igConfig,
  igDays,
  igSyncDue,
  igTime,
  insightValues,
  istDayOf,
  matchMedia,
  mediaMetrics,
  normLink,
  titleFromCaption,
  typeFits,
} from '../utils/metaIg.js';

test('accounts: id with its brand (main when not said), junk and repeats left out; ready needs an account', () => {
  assert.deepEqual(igAccountsFrom('17841400000000001:kerala, 17841400000000002 ; abc:main, 17841400000000001:main, 12:main'), [
    { id: '17841400000000001', brand: 'kerala' },
    { id: '17841400000000002', brand: 'main' },
  ]);
  const c = igConfig({ META_APP_SECRET: 's', META_ACCESS_TOKEN: 't' });
  assert.deepEqual([c.ready, c.canFind], [false, true], 'finding the accounts needs no account yet');
  assert.equal(igConfig({ META_APP_SECRET: 's', META_ACCESS_TOKEN: 't', META_IG_ACCOUNTS: '17841400000000001' }).ready, true);
});

test('the kind of post: reels, carousels, videos, posts; stories are told apart', () => {
  assert.equal(contentTypeOf({ media_product_type: 'REELS', media_type: 'VIDEO' }), 'reel');
  assert.equal(contentTypeOf({ media_product_type: 'FEED', media_type: 'CAROUSEL_ALBUM' }), 'carousel');
  assert.equal(contentTypeOf({ media_product_type: 'FEED', media_type: 'VIDEO' }), 'video');
  assert.equal(contentTypeOf({ media_product_type: 'FEED', media_type: 'IMAGE' }), 'post');
  assert.equal(contentTypeOf({ media_product_type: 'STORY', media_type: 'IMAGE' }), 'story');
  assert.equal(typeFits('reel', 'trial_reel'), true);
  assert.equal(typeFits('reel', 'carousel'), false);
  assert.equal(typeFits('carousel', 'post'), true);
});

test('links compared without www, query, fragment or trailing slash', () => {
  assert.equal(normLink('https://www.instagram.com/reel/ABC123/?igsh=xyz'), 'https://instagram.com/reel/ABC123');
  assert.equal(normLink('http://instagram.com/reel/ABC123'), 'https://instagram.com/reel/ABC123');
  assert.equal(normLink('not a link'), '');
  assert.equal(normLink(''), '');
});

test('times and days: Graph\'s +0000, the IST day', () => {
  assert.equal(igTime('2026-11-17T20:00:00+0000').toISOString(), '2026-11-17T20:00:00.000Z');
  assert.equal(istDayOf(igTime('2026-11-17T20:00:00+0000')), '2026-11-18', '1:30 am in India is the next day');
  assert.equal(igTime('nope'), null);
});

test('titles and hashtags from a caption', () => {
  assert.equal(titleFromCaption('#bride #kerala\nOur Kozhikode bride, ready by 6 am ✨ #teamn', new Date('2026-11-18T05:00:00Z')), 'Our Kozhikode bride, ready by 6 am ✨');
  assert.equal(titleFromCaption('', new Date('2026-11-18T05:00:00Z')), 'Instagram post 2026-11-18');
  assert.equal(titleFromCaption('x'.repeat(100)).length, 78);
  assert.deepEqual(hashtagsOf('Ready #bride #kerala #bride'), ['bride', 'kerala']);
});

test('insights read either way Meta writes them; "saved" is our saves; like and comment counts fill a gap', () => {
  const v = insightValues({ data: [{ name: 'reach', values: [{ value: 900 }] }, { name: 'views', total_value: { value: 2400 } }, { name: 'saved', values: [{ value: 12 }] }, { name: 'impressions', values: [{ value: 5 }] }] });
  assert.deepEqual(v, { reach: 900, views: 2400, saves: 12 });
  assert.deepEqual(mediaMetrics({ like_count: 40, comments_count: 3 }, v), { reach: 900, views: 2400, likes: 40, comments: 3, shares: 0, saves: 12 });
  assert.deepEqual(mediaMetrics({ like_count: 40 }, { likes: 55 }).likes, 55, 'the insight wins over the count');
  assert.deepEqual(insightValues(null), {});
});

test('window and the automatic run', () => {
  assert.equal(igDays(undefined), 30);
  assert.equal(igDays(90), 90);
  assert.equal(igDays(91), null);
  const now = new Date('2026-11-18T12:00:00Z');
  assert.equal(igSyncDue(null, now), true);
  assert.equal(igSyncDue(new Date('2026-11-18T07:00:00Z'), now), false);
  assert.equal(igSyncDue(new Date('2026-11-18T05:59:00Z'), now), true);
});

test('matching: Instagram id first, then the link, then THE one planned post that day — never two guesses, never one post twice', () => {
  const at = new Date('2026-11-18T05:00:00Z');
  const p = (id, o) => ({ _id: id, platform: 'instagram', brand: 'main', status: 'scheduled', contentType: 'reel', permalink: '', igMediaId: '', scheduledDate: new Date('2026-11-18T04:00:00Z'), ...o });
  const posts = [
    p('linked', { igMediaId: '1' }),
    p('byLink', { permalink: 'https://www.instagram.com/p/CODE2/' }),
    p('day', {}),
    p('kerala', { brand: 'kerala' }),
    p('cancelled', { status: 'cancelled', contentType: 'carousel' }),
  ];
  const media = [
    { id: '1', permalink: 'https://instagram.com/reel/CODE1/', at, brand: 'main', media_product_type: 'REELS' },
    { id: '2', permalink: 'https://instagram.com/p/CODE2/', at, brand: 'main', media_product_type: 'FEED', media_type: 'IMAGE' },
    { id: '3', permalink: 'https://instagram.com/reel/CODE3/', at, brand: 'main', media_product_type: 'REELS' },
    { id: '4', permalink: 'https://instagram.com/reel/CODE4/', at, brand: 'main', media_product_type: 'REELS' },
    { id: '5', permalink: 'https://instagram.com/p/CODE5/', at, brand: 'main', media_product_type: 'FEED', media_type: 'CAROUSEL_ALBUM' },
  ];
  const m = matchMedia(media, posts);
  assert.deepEqual(Object.fromEntries([...m].map(([k, v]) => [k, v._id])), { 1: 'linked', 2: 'byLink' });
  assert.equal(m.has('3') || m.has('4'), false, 'two reels that day and one planned reel: which is which is not guessed');
  // one reel that day and its one planned reel: matched
  assert.equal(matchMedia([media[2]], [p('day', {})]).get('3')._id, 'day');
  assert.equal(m.has('5'), false, 'a cancelled post is never a match');
  // two planned reels that day: neither is guessed
  const two = matchMedia([media[2]], [p('a', {}), p('b', {})]);
  assert.equal(two.size, 0);
  // another brand's post, another day's post: not matched
  assert.equal(matchMedia([{ ...media[2], brand: 'kerala' }], [p('x', {})]).size, 0);
  assert.equal(matchMedia([{ ...media[2], at: new Date('2026-11-19T05:00:00Z') }], [p('x', {})]).size, 0);
});
