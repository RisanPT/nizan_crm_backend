// Pure unit tests (no database): node --test tests/websiteContent.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSectionData } from '../utils/websiteContent.js';
import { WEBSITE_SECTIONS } from '../config/websiteSections.js';
import { UPLOAD_RULES, describeRule, publicRule } from '../config/websiteUploadRules.js';

const PREFIX = 'https://res.cloudinary.com/teamn/';
const img = (extra = {}) => ({ url: `${PREFIX}image/upload/a.webp`, publicId: 'a', width: 1920, height: 1080, alt: 'Bride', ...extra });

test('every image field points at a real upload rule', () => {
  const walk = (fields) => {
    for (const [name, def] of Object.entries(fields)) {
      if (def.type === 'image') assert.ok(UPLOAD_RULES[def.rule], `${name} → ${def.rule}`);
      if (def.type === 'list') walk(def.fields);
    }
  };
  for (const s of Object.values(WEBSITE_SECTIONS)) walk(s.fields);
});

test('rule hint text for the CRM', () => {
  assert.equal(describeRule('portrait'), 'JPG, WebP · max 3 MB · at least 900 × 1125 px · Portrait, 4:5');
  assert.deepEqual(publicRule('favicon').mimeTypes, ['image/png']);
  assert.ok(!JSON.stringify(UPLOAD_RULES).includes('svg'));
});

test('unknown section is refused', () => {
  assert.equal(validateSectionData('nope', {}).ok, false);
});

test('changing one field publishes; empty fields keep the built-in content', () => {
  assert.equal(validateSectionData('hero', { title: 'Only the title' }, { forPublish: true }).ok, true);
  assert.equal(validateSectionData('contact', { phone: '+91 90000 00000' }, { forPublish: true }).ok, true);
  assert.equal(validateSectionData('seo', {}, { forPublish: true }).ok, true);
});

test('no top-level field is required (only fields inside list items)', () => {
  for (const [key, s] of Object.entries(WEBSITE_SECTIONS)) {
    for (const [name, def] of Object.entries(s.fields)) assert.ok(!def.required, `${key}.${name}`);
  }
});

test('unknown fields are dropped and text is trimmed', () => {
  const r = validateSectionData('availabilityStrip', { title: '  Book now \n ', evil: '<script>' });
  assert.deepEqual(r.value, { title: 'Book now' });
});

test('too-long text is rejected with a clear message', () => {
  const r = validateSectionData('hero', { title: 'x'.repeat(61) });
  assert.match(r.errors[0], /title must be at most 60 characters \(now 61\)/);
});

test('images must come from our Cloudinary and carry alt text', () => {
  const opts = { imageUrlPrefix: PREFIX };
  assert.equal(validateSectionData('hero', { imageDesktop: img() }, opts).ok, true);
  assert.match(
    validateSectionData('hero', { imageDesktop: img({ url: 'https://evil.example/a.jpg' }) }, opts).errors[0],
    /uploaded through Team N Website/
  );
  assert.match(validateSectionData('hero', { imageDesktop: img({ alt: '' }) }, opts).errors[0], /alt text/);
});

test('lists: max items and nested required fields', () => {
  const tooMany = Array.from({ length: 4 }, () => ({ value: 1, label: 'x' }));
  assert.match(validateSectionData('hero', { stats: tooMany }).errors[0], /at most 3 items/);
  const r = validateSectionData('faq', { items: [{ question: 'Q?' }] }, { forPublish: true });
  assert.ok(r.errors.includes('items[1].answer is required'));
});

test('links, phones and emails are checked', () => {
  const ok = validateSectionData('contact', {
    phone: '+91 96454 24281',
    whatsapp: '919645424281',
    email: 'Hello@TeamN.com',
    mapUrl: 'https://maps.google.com/?q=x',
    instagramUrl: '/portfolio',
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.email, 'hello@teamn.com');
  const bad = validateSectionData('contact', { mapUrl: 'javascript:alert(1)', phone: 'abc', email: 'x@' });
  assert.equal(bad.errors.length, 3);
});

test('keyedText keeps safe keys only', () => {
  const r = validateSectionData('packagesPage', {
    comparison: [{ feature: 'Lead artist', values: { '665f1a': 'Feeniya', 'bad key!': 'x', empty: ' ' } }],
  });
  assert.deepEqual(r.value.comparison[0].values, { '665f1a': 'Feeniya' });
});
