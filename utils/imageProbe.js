// Reads an image's real type and pixel size from its first bytes (magic numbers),
// with no image library. The file name and the browser's MIME type can lie;
// these bytes cannot.
import { IMAGE_FORMATS } from '../config/websiteUploadRules.js';

const MAX_PIXELS = 60_000_000; // 60 MP — refuse "decompression bomb" images

const ascii = (buf, start, end) => buf.subarray(start, end).toString('latin1');

function probePng(buf) {
  if (buf.length < 24 || ascii(buf, 12, 16) !== 'IHDR') return null;
  return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Walk JPEG segments to the first Start-Of-Frame marker, which holds the size.
function probeJpeg(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1];
    if (marker === 0xff) { i += 1; continue; } // fill byte
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return null; // end / scan before any frame
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof) return { format: 'jpg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function probeWebp(buf) {
  if (buf.length < 30) return null;
  const chunk = ascii(buf, 12, 16);
  if (chunk === 'VP8 ') {
    return { format: 'webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    return {
      format: 'webp',
      width: 1 + (((b1 & 0x3f) << 8) | buf[21]),
      height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8X') {
    return { format: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  }
  return null;
}

/**
 * → { format, width, height } for jpg / png / webp,
 *   { format: 'gif' | 'svg' | 'heic' | 'pdf' } for types we recognise but refuse,
 *   null for anything else.
 */
export function probeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && ascii(buf, 1, 4) === 'PNG') return probePng(buf);
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return probeJpeg(buf);
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return probeWebp(buf);
  if (ascii(buf, 0, 4) === 'GIF8') return { format: 'gif' };
  if (ascii(buf, 4, 8) === 'ftyp') return { format: 'heic' };
  if (ascii(buf, 0, 5) === '%PDF-') return { format: 'pdf' };
  const head = ascii(buf, 0, Math.min(buf.length, 512)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) return { format: 'svg' };
  return null;
}

const FORMAT_NAME = { jpg: 'JPG', png: 'PNG', webp: 'WebP', gif: 'GIF', svg: 'SVG', heic: 'HEIC', pdf: 'PDF' };
const extOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ''));
  return m ? `.${m[1].toLowerCase()}` : '';
};
const fail = (status, message) => ({ ok: false, status, message });

/**
 * Checks one uploaded file against an upload rule (config/websiteUploadRules.js).
 * file: { buffer, originalname, mimetype, size }
 * → { ok: true, format, mime, width, height, bytes } or { ok: false, status, message }
 */
export function checkImageAgainstRule(file, rule) {
  if (!file?.buffer?.length) return fail(400, 'No file was received.');
  const bytes = file.size ?? file.buffer.length;
  const allowed = rule.formats.map((f) => FORMAT_NAME[f]).join(', ');

  if (bytes > rule.maxBytes) {
    return fail(413, `This file is ${(bytes / 1048576).toFixed(1)} MB. The limit here is ${(rule.maxBytes / 1048576).toFixed(rule.maxBytes < 1048576 ? 1 : 0)} MB.`);
  }

  const probe = probeImage(file.buffer);
  if (!probe) return fail(415, `This file is not a readable image. Use ${allowed}.`);
  if (!rule.formats.includes(probe.format)) {
    return fail(415, `${FORMAT_NAME[probe.format]} files are not allowed here. Use ${allowed}.`);
  }

  // Name, declared type and real content must all agree.
  const fmt = IMAGE_FORMATS[probe.format];
  const ext = extOf(file.originalname);
  if (!fmt.extensions.includes(ext)) {
    return fail(415, `This file is really a ${FORMAT_NAME[probe.format]} but is named "${ext || 'no extension'}". Rename or re-export it.`);
  }
  const mime = String(file.mimetype || '').split(';')[0].trim().toLowerCase();
  if (mime !== fmt.mime && !(probe.format === 'jpg' && mime === 'image/jpg')) {
    return fail(415, `The file type (${mime || 'unknown'}) does not match its content (${FORMAT_NAME[probe.format]}).`);
  }

  const { width, height } = probe;
  if (!width || !height) return fail(415, 'Could not read the image size. Re-export the image and try again.');
  if (width * height > MAX_PIXELS) return fail(413, `This image is too large (${width} × ${height} px).`);
  if (width < rule.minWidth || height < rule.minHeight) {
    return fail(422, `This image is ${width} × ${height} px. It must be at least ${rule.minWidth} × ${rule.minHeight} px.`);
  }
  if (rule.ratio) {
    const ratio = width / height;
    const [lo, hi] = rule.ratio;
    // Small tolerance so exact ratios (e.g. 1:1) never fail on rounding.
    if (ratio < lo - 0.005 || ratio > hi + 0.005) {
      return fail(422, `This image is ${width} × ${height} px — the wrong shape. Needed: ${rule.shape}.`);
    }
  }

  return { ok: true, format: probe.format, mime: fmt.mime, width, height, bytes };
}
