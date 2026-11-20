// Pure unit tests: node --test tests/assetSearch.test.js
// The gallery's search box and filters as the server reads them, the filter each part becomes, and the "Best match" order.
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { listOf, parseSearchText, parseAssetSearch, assetClauses, combineClauses, termClause, termRegex, wordVariants, scoreAsset, rankAssets, hasText } from '../utils/assetSearch.js';

test('lists: one value, repeated values, never an object; "all" and blanks mean no filter', () => {
  assert.deepEqual(listOf('video'), ['video']);
  assert.deepEqual(listOf(['video', 'image', 'video', ' ']), ['video', 'image']);
  assert.deepEqual(listOf(undefined), []);
  assert.deepEqual(listOf('all'), []);
  assert.deepEqual(listOf({ $ne: 'x' }), [], 'an operator is not a value');
  assert.deepEqual(listOf([{ $gt: '' }, 'reel']), ['reel']);
});

test('the search box: words, "phrases", -left out, #keywords, -#keywords', () => {
  const t = parseSearchText('Bridal  "Kerala Bride" -party #Reel -#BTS reels');
  assert.deepEqual(t.terms.map((x) => [x.text, x.phrase]), [['bridal', false], ['kerala bride', true], ['reels', false]]);
  assert.deepEqual(t.exclude.map((x) => x.text), ['party']);
  assert.deepEqual(t.keywords, ['reel']);
  assert.deepEqual(t.notKeywords, ['bts']);
  assert.equal(hasText(t), true);
});

test('the search box: one letter, a lone - or #, and doubles are not looked for; punctuation alone is text', () => {
  const t = parseSearchText('a - # bridal bridal, "bridal" x');
  assert.deepEqual(t.terms.map((x) => x.text), ['bridal', 'bridal'], 'the word and the "phrase" are kept apart once each');
  assert.deepEqual(parseSearchText('.*').terms.map((x) => x.text), ['.*'], 'a pattern is searched as text (and finds nothing)');
  assert.equal(hasText(parseSearchText('  ')), false);
  assert.deepEqual(parseSearchText('"kerala bride').terms.map((x) => [x.text, x.phrase]), [['kerala bride', true]], 'an unclosed quote runs to the end');
  assert.deepEqual(parseSearchText('bridal,reel').terms.map((x) => x.text), ['bridal', 'reel'], 'a comma separates too');
  assert.equal(parseSearchText(Array.from({ length: 15 }, (_, i) => `w${i}x`).join(' ')).terms.length, 10, 'at most ten words');
});

test('plurals: a word is also looked for as its singular', () => {
  assert.deepEqual(wordVariants('brides'), ['brides', 'bride']);
  assert.deepEqual(wordVariants('dresses'), ['dresses', 'dress']);
  assert.deepEqual(wordVariants('parties'), ['parties', 'party']);
  assert.deepEqual(wordVariants('dress'), ['dress'], 'a word ending in ss is not a plural');
  assert.deepEqual(wordVariants('bus'), ['bus'], 'short words are left alone');
  assert.deepEqual(wordVariants('kerala brides', true), ['kerala brides'], 'a "phrase" is looked for as typed');
  const rx = termRegex({ text: 'parties' });
  assert.ok(rx.test('Party Makeup') && rx.test('PARTIES'));
  assert.ok(!termRegex({ text: '.*' }).test('anything'), 'a regex typed is text');
});

test('a word may be found in the title, keywords, page, portfolio, owner, its shoot or who added it — and names a media or asset type', () => {
  const sid = new mongoose.Types.ObjectId();
  const uid = new mongoose.Types.ObjectId();
  const c = termClause({ text: 'video', key: 'video' }, { shootIds: [String(sid)], userIds: [uid] });
  const fields = c.$or.map((x) => Object.keys(x).join('+'));
  assert.deepEqual(fields, ['title', 'tags', 'page', 'portfolio', 'ownerName', 'shootId', 'ownerName+createdBy', 'media']);
  assert.equal(c.$or.at(-1).media, 'video');
  assert.ok(c.$or[5].shootId.$in[0] instanceof mongoose.Types.ObjectId, 'ids are ObjectIds (aggregate does not cast)');
  assert.equal(termClause({ text: 'reels', key: 'reels' }).$or.at(-1).kind, 'reel');
  assert.equal(termClause({ text: 'photos', key: 'photos' }).$or.at(-1).media, 'image');
  assert.equal(termClause({ text: 'bridal', key: 'bridal' }).$or.length, 5, 'no shoot, no person, no type: the asset\'s own fields');
});

test('the request: every filter takes several values; keywords all (default) or any; the older ?tag= still works', () => {
  const s = parseAssetSearch({ media: ['video', 'image'], stage: 'approved', kw: ['Bridal', 'reel'], tag: 'kerala', notKw: ['bts', 'bridal'], kwMode: 'any', final: '1', untagged: 'true', shootId: ['nope', String(new mongoose.Types.ObjectId())], sort: 'title', pageNo: '3', limit: '60' });
  assert.deepEqual(s.media, ['video', 'image']);
  assert.deepEqual(s.stage, ['approved']);
  assert.deepEqual(s.keywords, ['bridal', 'reel', 'kerala']);
  assert.deepEqual(s.notKeywords, ['bts'], 'a keyword both asked for and left out is asked for');
  assert.equal(s.kwMode, 'any');
  assert.equal(s.final && s.untagged, true);
  assert.equal(s.shootIds.length, 1, 'a bad id is dropped');
  assert.deepEqual([s.sort, s.pageNo, s.limit], ['title', 3, 60]);
  const d = parseAssetSearch({});
  assert.deepEqual([d.kwMode, d.sort, d.pageNo, d.limit, d.usable], ['all', 'newest', 1, 120, false], 'the defaults older app builds rely on');
  assert.equal(parseAssetSearch({ sort: 'relevance' }).sort, 'newest', 'best match without words = the newest');
  assert.equal(parseAssetSearch({ sort: 'relevance', q: 'bridal' }).sort, 'relevance');
  assert.equal(parseAssetSearch({ sort: 'drop table' }).sort, 'newest');
  assert.equal(parseAssetSearch({ limit: '100000' }).limit, 500);
  assert.equal(parseAssetSearch({ pageNo: '-2' }).pageNo, 1);
});

test('clauses: a list is "any of these", lists add up, keywords all/any/left out, owner by name or by who added it', () => {
  const uid = new mongoose.Types.ObjectId();
  const s = parseAssetSearch({ media: ['video', 'image'], kw: ['bridal', 'reel'], notKw: 'bts', owner: 'Preethi', usable: '1', q: 'kerala -party #hero' });
  const c = assetClauses(s, { ownerUsers: new Map([['preethi', [uid]]]) });
  assert.deepEqual(c.media, { media: { $in: ['video', 'image'] } });
  assert.deepEqual(c.keywords, { tags: { $all: ['bridal', 'reel'] } });
  assert.deepEqual(assetClauses({ ...s, kwMode: 'any' }).keywords, { tags: { $in: ['bridal', 'reel'] } });
  assert.deepEqual(c.notKeywords, { tags: { $nin: ['bts'] } });
  assert.equal(c.owner.$or.length, 2);
  assert.ok(c.owner.$or[0].ownerName.test('preethi') && !c.owner.$or[0].ownerName.test('Preethi K'), 'the owner name exactly (any case)');
  assert.deepEqual(c.owner.$or[1].createdBy.$in, [uid]);
  assert.deepEqual(c.usable, { $or: [{ stage: 'approved' }, { isFinal: true }] });
  assert.equal(c.text.$and.length, 3, 'a word, a word left out, a #keyword');
  assert.deepEqual(c.text.$and[2], { tags: { $all: ['hero'] } });
  assert.equal(c.stage, null);
  const all = combineClauses(c);
  assert.equal(all.$and.length, 6);
  assert.equal(combineClauses(c, ['media']).$and.length, 5, 'a facet is counted with every filter but its own');
  assert.deepEqual(combineClauses(assetClauses(parseAssetSearch({}))), {}, 'nothing asked = everything');
});

test('best match: the keyword itself, then the start of a title word, then anywhere; all the words in order add more', () => {
  const t = parseSearchText('bridal reel');
  const day = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T10:00:00Z`);
  const a = [
    { _id: '1', title: 'Studio clip', tags: ['bridal', 'reel'], createdAt: day(10) },
    { _id: '2', title: 'Bridal reel — Anjali', tags: [], createdAt: day(11) },
    { _id: '3', title: 'Nonbridalish steelreel', tags: [], createdAt: day(12) },
    { _id: '4', title: 'Bridal look', tags: ['reel'], page: 'Bridal Makeup', createdAt: day(13) },
    { _id: '5', title: 'Newest, matched only by its shoot', tags: [], createdAt: day(14), shootId: 's1' },
  ];
  const hits = new Map([['bridal', { shootIds: ['s1'] }], ['reel', { shootIds: ['s1'] }]]);
  // 1: both are keywords (12) · 4: "reel" a keyword, "bridal" at the title's start and in the page (11.5) · 2: both at the start of
  // title words, in order (11) · 3: inside words only (4) · 5: only through its shoot (2), though it is the newest
  assert.deepEqual(rankAssets(a, t, hits).map((x) => x._id), ['1', '4', '2', '3', '5']);
  assert.equal(scoreAsset(a[0], t), 12, 'both words are keywords: 6 + 6');
  assert.equal(scoreAsset(a[1], t), 11, 'both at the start of a title word (4 + 4) and in order (3)');
  assert.equal(scoreAsset(a[2], t), 4, 'inside words only: 2 + 2');
  assert.equal(scoreAsset(a[4], t, hits), 2, 'the shoot: 1 + 1');
  const tie = [{ _id: 'old', title: 'Reel', tags: [], createdAt: day(1) }, { _id: 'new', title: 'Reel', tags: [], createdAt: day(2) }];
  assert.deepEqual(rankAssets(tie, parseSearchText('reel')).map((x) => x._id), ['new', 'old'], 'a tie: the newest first');
  assert.equal(scoreAsset({ title: 'Reels of brides', tags: ['brides'] }, parseSearchText('bride reel')), 3 + 4 + 4, 'a singular typed reaches a plural keyword as "inside a keyword" (3), not as the keyword itself (6)');
});
