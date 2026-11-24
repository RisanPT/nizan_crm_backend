// Pure unit tests (no database): node --test tests/imageProbe.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkImageAgainstRule, probeImage } from '../utils/imageProbe.js';
import { UPLOAD_RULES } from '../config/websiteUploadRules.js';

// Minimal headers that carry a size — enough for the probe, not real pictures.
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpg = (w, h) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.alloc(14)]);
  const sof = Buffer.alloc(19);
  sof[0] = 0xff; sof[1] = 0xc0; sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
};
const webpX = (w, h) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8X', 12, 'latin1');
  b.writeUIntLE(w - 1, 24, 3); b.writeUIntLE(h - 1, 27, 3);
  return b;
};
const webpLossy = (w, h) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8 ', 12, 'latin1');
  b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
};
const webpLossless = (w, h) => {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); b.write('VP8L', 12, 'latin1');
  b[20] = 0x2f;
  const W = w - 1; const H = h - 1;
  b[21] = W & 0xff;
  b[22] = ((W >> 8) & 0x3f) | ((H & 0x3) << 6);
  b[23] = (H >> 2) & 0xff;
  b[24] = (H >> 10) & 0x0f;
  return b;
};
const file = (buffer, originalname, mimetype) => ({ buffer, originalname, mimetype, size: buffer.length });

test('probe reads size from PNG, JPEG and all three WebP kinds', () => {
  assert.deepEqual(probeImage(png(1920, 1080)), { format: 'png', width: 1920, height: 1080 });
  assert.deepEqual(probeImage(jpg(960, 1200)), { format: 'jpg', width: 960, height: 1200 });
  assert.deepEqual(probeImage(webpX(1200, 630)), { format: 'webp', width: 1200, height: 630 });
  assert.deepEqual(probeImage(webpLossy(1000, 800)), { format: 'webp', width: 1000, height: 800 });
  assert.deepEqual(probeImage(webpLossless(1500, 1875)), { format: 'webp', width: 1500, height: 1875 });
});

test('probe recognises refused types', () => {
  assert.equal(probeImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')).format, 'svg');
  assert.equal(probeImage(Buffer.from('GIF89a......')).format, 'gif');
  assert.equal(probeImage(Buffer.from('%PDF-1.7 ....')).format, 'pdf');
  assert.equal(probeImage(Buffer.from('hello world, plain text')), null);
});

test('valid portrait JPG passes', () => {
  const r = checkImageAgainstRule(file(jpg(960, 1200), 'bride.JPG', 'image/jpeg'), UPLOAD_RULES.portrait);
  assert.deepEqual(r, { ok: true, format: 'jpg', mime: 'image/jpeg', width: 960, height: 1200, bytes: r.bytes });
});

test('renamed file is refused (PDF named .jpg)', () => {
  const pdf = Buffer.from('%PDF-1.7 fake content padding');
  const r = checkImageAgainstRule(file(pdf, 'photo.jpg', 'image/jpeg'), UPLOAD_RULES.portrait);
  assert.equal(r.status, 415);
  assert.match(r.message, /PDF files are not allowed/);
});

test('PNG content with a .jpg name is refused', () => {
  const r = checkImageAgainstRule(file(png(1920, 1080), 'hero.jpg', 'image/jpeg'), UPLOAD_RULES.heroDesktop);
  assert.match(r.message, /really a PNG but is named "\.jpg"/);
});

test('declared type must match content', () => {
  const r = checkImageAgainstRule(file(png(1920, 1080), 'hero.png', 'image/webp'), UPLOAD_RULES.heroDesktop);
  assert.equal(r.status, 415);
});

test('format not allowed by this rule (PNG for gallery)', () => {
  const r = checkImageAgainstRule(file(png(960, 1200), 'a.png', 'image/png'), UPLOAD_RULES.gallery);
  assert.match(r.message, /PNG files are not allowed here. Use JPG, WebP/);
});

test('SVG is never accepted', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(checkImageAgainstRule(file(svg, 'logo.svg', 'image/svg+xml'), UPLOAD_RULES.logo).status, 415);
});

test('too small and wrong shape give clear messages', () => {
  const small = checkImageAgainstRule(file(jpg(800, 1000), 'a.jpg', 'image/jpeg'), UPLOAD_RULES.portrait);
  assert.match(small.message, /800 × 1000 px. It must be at least 900 × 1125/);
  const wide = checkImageAgainstRule(file(jpg(2000, 1200), 'a.jpg', 'image/jpeg'), UPLOAD_RULES.portrait);
  assert.match(wide.message, /wrong shape. Needed: Portrait, 4:5/);
});

test('file over the size limit is refused with 413', () => {
  const big = { ...file(jpg(960, 1200), 'a.jpg', 'image/jpeg'), size: 3.5 * 1048576 };
  const r = checkImageAgainstRule(big, UPLOAD_RULES.portrait);
  assert.equal(r.status, 413);
  assert.match(r.message, /3\.5 MB. The limit here is 3 MB/);
});

test('square favicon passes at exactly 1:1', () => {
  assert.equal(checkImageAgainstRule(file(png(512, 512), 'f.png', 'image/png'), UPLOAD_RULES.favicon).ok, true);
});
