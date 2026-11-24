// Pure unit tests (no database): node --test tests/websiteSeed.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { planWebsiteSeed } from '../utils/websiteSeed.js';

const seed = JSON.parse(fs.readFileSync(new URL('../data/websiteSeed.json', import.meta.url), 'utf8')).sections;

test('the exported website text is valid for every section', () => {
  const plan = planWebsiteSeed(seed, []);
  assert.deepEqual(plan.invalid, []);
  assert.equal(plan.create.length, 18);
});

test('sections already set up in the CRM are never touched', () => {
  const plan = planWebsiteSeed(seed, ['hero', 'faq']);
  assert.deepEqual(plan.skip.map((s) => s.key), ['hero', 'faq']);
  assert.ok(!plan.create.some((c) => c.key === 'hero'));
});

test('unknown keys and bad data are reported, not written', () => {
  const plan = planWebsiteSeed({ nope: {}, hero: { title: 'x'.repeat(80) } }, []);
  assert.equal(plan.skip[0].key, 'nope');
  assert.equal(plan.invalid[0].key, 'hero');
  assert.equal(plan.create.length, 0);
});

test('seed carries no images and no fallback package ids', () => {
  const json = JSON.stringify(seed);
  assert.doesNotMatch(json, /"url"\s*:/);
  for (const row of seed.packagesPage.comparison) assert.deepEqual(row.values, {});
});
