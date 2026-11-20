// Pure unit tests: node --test tests/assetKeywords.test.js
// The gallery's keywords: one spelling each, however typed or pasted; too many or too long refused with the reason; rename/merge,
// bulk add/remove and the suggestions while typing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKeyword, splitKeywords, cleanKeywords, keywordAsStored, renameKeyword, applyKeywordChange, rankKeywordSuggestions, MAX_KEYWORDS, MAX_KEYWORD_LEN } from '../utils/assetKeywords.js';
import { cleanAssetInput, assetFromShoot } from '../utils/marketingSocialsInput.js';

test('one spelling: case, #, spaces and stray punctuation at the ends do not make a new keyword', () => {
  for (const v of ['Bridal', ' bridal ', '#Bridal', '##BRIDAL.', '"bridal"', 'bridal!', '(bridal)', '- bridal -']) assert.equal(normalizeKeyword(v), 'bridal', v);
  assert.equal(normalizeKeyword('Kerala   Bride'), 'kerala bride', 'a keyword may hold spaces; runs of them become one');
  assert.equal(normalizeKeyword('Pre-Wedding'), 'pre-wedding', 'a hyphen inside is kept');
  assert.equal(normalizeKeyword('Hair & Makeup'), 'hair & makeup');
  assert.equal(normalizeKeyword('ｂｒｉｄａｌ'), 'bridal', 'full-width letters are the same letters');
  assert.equal(normalizeKeyword('മണവാട്ടി'), 'മണവാട്ടി', 'Malayalam is kept as typed');
  for (const v of ['', '   ', '#', '...', null, undefined, {}, ['x']]) assert.equal(normalizeKeyword(v), '', String(v));
});

test('splitting: a comma, semicolon, new line, tab or # starts the next keyword; a list may hold pasted lists', () => {
  assert.deepEqual(splitKeywords('bridal, reel; kerala\nbride\tlook').map((s) => s.trim()), ['bridal', 'reel', 'kerala', 'bride', 'look']);
  assert.deepEqual(splitKeywords('#bridal #kerala bride').map((s) => s.trim()).filter(Boolean), ['bridal', 'kerala bride']);
  assert.deepEqual(splitKeywords(['bridal', 'reel, bts', null, 7]).map((s) => s.trim()), ['bridal', 'reel', 'bts', '7']);
});

test('cleaning: duplicates go (the first place is kept), the order typed stays', () => {
  const r = cleanKeywords(['Reel', 'bridal', '#reel', 'BRIDAL ', 'kerala bride', 'Kerala  Bride']);
  assert.deepEqual(r, { ok: true, value: ['reel', 'bridal', 'kerala bride'] });
  assert.deepEqual(cleanKeywords('').value, []);
  assert.deepEqual(cleanKeywords(', ,#, ;').value, [], 'separators alone are no keyword');
});

test('cleaning: too long or too many is refused with the reason — never cut short quietly', () => {
  const long = 'x'.repeat(MAX_KEYWORD_LEN + 1);
  const r = cleanKeywords(['ok', long]);
  assert.equal(r.ok, false);
  assert.match(r.message, /40 characters/);
  assert.equal(cleanKeywords('x'.repeat(MAX_KEYWORD_LEN)).ok, true, 'exactly the most is fine');
  const many = Array.from({ length: MAX_KEYWORDS + 3 }, (_, i) => `k${i}`);
  const m = cleanKeywords(many);
  assert.equal(m.ok, false);
  assert.match(m.message, /up to 50 keywords — this has 53\. Remove 3\./);
  assert.equal(cleanKeywords(many.slice(0, MAX_KEYWORDS)).value.length, MAX_KEYWORDS, 'exactly 50 is fine');
  assert.equal(cleanKeywords([...many.slice(0, MAX_KEYWORDS), 'K0', '#k1']).ok, true, 'duplicates do not count towards the most');
});

test('the asset form uses the same rules; an asset from a shoot gets the category as one more keyword', () => {
  const existing = { title: 'Old' };
  assert.deepEqual(cleanAssetInput({ tags: '#Bridal, bridal, Kerala Bride; reel' }, existing).value.tags, ['bridal', 'kerala bride', 'reel']);
  assert.deepEqual(cleanAssetInput({ tags: ['Bridal', 'bridal ', 'reel, bts'] }, existing).value.tags, ['bridal', 'reel', 'bts']);
  const r = cleanAssetInput({ tags: Array.from({ length: 51 }, (_, i) => `k${i}`) }, existing);
  assert.equal(r.ok, false);
  assert.equal(r.field, 'tags');
  assert.deepEqual(assetFromShoot({ brand: 'main', category: 'Bridal Makeup' }, { tags: ['reel', 'bridal makeup'] }).tags, ['reel', 'bridal makeup'], 'the category is not added twice');
  assert.deepEqual(assetFromShoot({ brand: 'main', category: ' #Party  Makeup ' }, { tags: [] }).tags, ['party makeup']);
});

test('a filter names a keyword exactly as stored (older ones may hold a #)', () => {
  assert.equal(keywordAsStored(' #Bridal '), '#bridal');
  assert.equal(keywordAsStored({ $ne: 1 }), '', 'never an operator');
});

test('rename: the keyword changes everywhere; into one the asset has = merged, its first place kept', () => {
  assert.deepEqual(renameKeyword(['bride', 'reel'], 'bride', 'bridal'), ['bridal', 'reel']);
  assert.deepEqual(renameKeyword(['bridal', 'reel', 'bride'], 'bride', 'bridal'), ['bridal', 'reel']);
  assert.deepEqual(renameKeyword(['reel'], 'bride', 'bridal'), ['reel']);
});

test('bulk change: removing first, then adding at the end, never twice', () => {
  assert.deepEqual(applyKeywordChange(['a', 'b'], ['c', 'a'], ['b']), ['a', 'c']);
  assert.deepEqual(applyKeywordChange([], ['x'], []), ['x']);
  assert.deepEqual(applyKeywordChange(['x'], ['x'], ['x']), [], 'asked to add and remove the same: removed');
  assert.deepEqual(applyKeywordChange(undefined, ['a'], []), ['a']);
});

test('suggestions: the exact keyword, then those starting with what is typed (or with a word that does), then those containing it', () => {
  const rows = [
    { keyword: 'kerala bride', count: 40 },
    { keyword: 'bride', count: 12 },
    { keyword: 'bride to be', count: 30 },
    { keyword: 'christian bride', count: 50 },
    { keyword: 'bridesmaid', count: 3 },
    { keyword: 'hairbride', count: 99 },
    { keyword: 'reel', count: 500 },
  ];
  assert.deepEqual(rankKeywordSuggestions(rows, 'Bride').map((r) => r.keyword), ['bride', 'christian bride', 'kerala bride', 'bride to be', 'bridesmaid', 'hairbride']);
  assert.deepEqual(rankKeywordSuggestions(rows, '', 2).map((r) => r.keyword), ['reel', 'hairbride'], 'nothing typed: the most used');
  assert.deepEqual(rankKeywordSuggestions(rows, 'zzz'), []);
});
