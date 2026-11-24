// Upload rules for every image field on the public website (Team N Website menu).
// One place for type / size / dimension limits: the upload middleware enforces
// them and the CRM shows them as hints, so the two can never disagree.
//
// SVG, GIF and HEIC are deliberately not allowed: SVG can carry scripts and
// HEIC does not render in every browser.

const MB = 1024 * 1024;
const KB = 1024;

// Accepted formats: MIME type → allowed file extensions.
export const IMAGE_FORMATS = {
  jpg: { mime: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
  png: { mime: 'image/png', extensions: ['.png'] },
  webp: { mime: 'image/webp', extensions: ['.webp'] },
};

/**
 * Each rule:
 *   formats      keys of IMAGE_FORMATS
 *   maxBytes     largest file accepted
 *   minWidth / minHeight   smallest pixel size accepted
 *   ratio        [min, max] of width / height (shape check), null = any shape
 *   label / shape          human text the CRM shows next to the upload button
 */
export const UPLOAD_RULES = {
  heroDesktop: {
    label: 'Hero background (desktop)',
    formats: ['jpg', 'png', 'webp'],
    maxBytes: 5 * MB,
    minWidth: 1600,
    minHeight: 900,
    ratio: [1.6, 1.9],
    shape: 'Landscape, about 16:9',
  },
  heroMobile: {
    label: 'Hero background (mobile)',
    formats: ['jpg', 'png', 'webp'],
    maxBytes: 4 * MB,
    minWidth: 1080,
    minHeight: 1920,
    ratio: [0.5, 0.62],
    shape: 'Portrait, about 9:16',
  },
  portrait: {
    label: 'Portrait photo',
    formats: ['jpg', 'webp'],
    maxBytes: 3 * MB,
    minWidth: 900,
    minHeight: 1125,
    ratio: [0.74, 0.86],
    shape: 'Portrait, 4:5',
  },
  gallery: {
    label: 'Portfolio / gallery photo',
    formats: ['jpg', 'webp'],
    maxBytes: 4 * MB,
    minWidth: 800,
    minHeight: 1200,
    ratio: [0.6, 0.85],
    shape: 'Portrait, 4:5 or 2:3',
  },
  packageCover: {
    label: 'Package cover',
    formats: ['jpg', 'webp'],
    maxBytes: 3 * MB,
    minWidth: 1200,
    minHeight: 900,
    ratio: [1.25, 1.42],
    shape: 'Landscape, 4:3',
  },
  logo: {
    label: 'Logo',
    formats: ['png', 'webp'],
    maxBytes: 1 * MB,
    minWidth: 300,
    minHeight: 100,
    ratio: null,
    shape: 'Transparent background',
  },
  shareImage: {
    label: 'Social share image',
    formats: ['jpg', 'png'],
    maxBytes: 2 * MB,
    minWidth: 1200,
    minHeight: 630,
    ratio: [1.85, 1.97],
    shape: 'Landscape, 1.91:1 (1200 × 630)',
  },
  favicon: {
    label: 'Favicon',
    formats: ['png'],
    maxBytes: 200 * KB,
    minWidth: 512,
    minHeight: 512,
    ratio: [1, 1],
    shape: 'Square',
  },
};

const formatSize = (bytes) => (bytes >= MB ? `${bytes / MB} MB` : `${Math.round(bytes / KB)} KB`);

// What the CRM shows under an upload button, e.g.
// "JPG, WebP · max 3 MB · at least 900 × 1125 px · Portrait, 4:5"
export const describeRule = (ruleKey) => {
  const rule = UPLOAD_RULES[ruleKey];
  if (!rule) return '';
  return [
    rule.formats.map((f) => (f === 'webp' ? 'WebP' : f.toUpperCase())).join(', '),
    `max ${formatSize(rule.maxBytes)}`,
    `at least ${rule.minWidth} × ${rule.minHeight} px`,
    rule.shape,
  ].join(' · ');
};

// The rule in a JSON-safe form for GET /website/admin/schema.
export const publicRule = (ruleKey) => {
  const rule = UPLOAD_RULES[ruleKey];
  if (!rule) return null;
  return {
    key: ruleKey,
    label: rule.label,
    mimeTypes: rule.formats.map((f) => IMAGE_FORMATS[f].mime),
    extensions: rule.formats.flatMap((f) => IMAGE_FORMATS[f].extensions),
    maxBytes: rule.maxBytes,
    minWidth: rule.minWidth,
    minHeight: rule.minHeight,
    ratio: rule.ratio,
    shape: rule.shape,
    hint: describeRule(ruleKey),
  };
};
