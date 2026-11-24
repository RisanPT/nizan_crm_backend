// Pure helpers (no database) for website CMS content: validate a section's data
// against config/websiteSections.js before it is saved or published.
import { WEBSITE_SECTIONS, isSectionKey } from '../config/websiteSections.js';

// Remove control characters except newline and tab.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9\s-]{7,17}$/;
const SITE_PATH_RE = /^\/[A-Za-z0-9\-._~/?#=&%]*$/;

const cleanText = (v, { multiline = false } = {}) => {
  let s = String(v ?? '').replace(CONTROL_CHARS, '');
  if (!multiline) s = s.replace(/[\r\n\t]+/g, ' ');
  return s.trim();
};

const isBlank = (v) =>
  v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

const isHttpsUrl = (s) => {
  try {
    const u = new URL(s);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Validates one field value. Returns { value, error }.
 * `value` is undefined when the field should be dropped (blank).
 */
function validateField(def, raw, path, opts) {
  if (def.type === 'boolean' && raw === false) return { value: false, error: null };
  if (isBlank(raw)) {
    return { value: undefined, error: opts.forPublish && def.required ? `${path} is required` : null };
  }

  switch (def.type) {
    case 'text':
    case 'textarea': {
      const value = cleanText(raw, { multiline: def.type === 'textarea' });
      if (!value) return validateField(def, '', path, opts);
      if (def.maxLength && value.length > def.maxLength) {
        return { value, error: `${path} must be at most ${def.maxLength} characters (now ${value.length})` };
      }
      return { value, error: null };
    }
    case 'url': {
      const value = cleanText(raw);
      if (!(isHttpsUrl(value) || SITE_PATH_RE.test(value))) {
        return { value, error: `${path} must be an https:// link or a site path like /book` };
      }
      if (def.maxLength && value.length > def.maxLength) {
        return { value, error: `${path} must be at most ${def.maxLength} characters` };
      }
      return { value, error: null };
    }
    case 'email': {
      const value = cleanText(raw).toLowerCase();
      return { value, error: EMAIL_RE.test(value) && value.length <= 120 ? null : `${path} is not a valid email` };
    }
    case 'phone': {
      const value = cleanText(raw);
      return { value, error: PHONE_RE.test(value) ? null : `${path} is not a valid phone number` };
    }
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) return { value: undefined, error: `${path} must be a number` };
      if (def.min != null && value < def.min) return { value, error: `${path} must be at least ${def.min}` };
      if (def.max != null && value > def.max) return { value, error: `${path} must be at most ${def.max}` };
      return { value, error: null };
    }
    case 'image': {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { value: undefined, error: `${path} must be an uploaded image` };
      }
      const url = cleanText(raw.url);
      // Only images that went through the website upload (and its checks) are accepted.
      if (
        !url ||
        !isHttpsUrl(url) ||
        (opts.imageUrlPrefix && !url.startsWith(opts.imageUrlPrefix)) ||
        (opts.imageFolder && !url.includes(`/${opts.imageFolder}/`))
      ) {
        return { value: undefined, error: `${path} must be uploaded through Team N Website` };
      }
      const alt = cleanText(raw.alt);
      const value = {
        url,
        publicId: cleanText(raw.publicId),
        width: Number(raw.width) || null,
        height: Number(raw.height) || null,
        alt,
      };
      if (!alt) return { value, error: `${path} needs a short description (alt text)` };
      if (alt.length > 150) return { value, error: `${path} alt text must be at most 150 characters` };
      return { value, error: null };
    }
    case 'boolean':
      return { value: raw === true || raw === 'true', error: null };
    case 'textList': {
      if (!Array.isArray(raw)) return { value: undefined, error: `${path} must be a list` };
      const value = raw.map((v) => cleanText(v)).filter(Boolean);
      if (def.maxItems && value.length > def.maxItems) {
        return { value, error: `${path} can have at most ${def.maxItems} items` };
      }
      const long = value.findIndex((v) => def.maxLength && v.length > def.maxLength);
      if (long >= 0) return { value, error: `${path}[${long + 1}] must be at most ${def.maxLength} characters` };
      return { value, error: null };
    }
    case 'keyedText': {
      if (typeof raw !== 'object' || Array.isArray(raw)) {
        return { value: undefined, error: `${path} must be a set of values` };
      }
      const value = {};
      for (const [k, v] of Object.entries(raw)) {
        if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) continue;
        const text = cleanText(v);
        if (!text) continue;
        if (def.maxLength && text.length > def.maxLength) {
          return { value, error: `${path}.${k} must be at most ${def.maxLength} characters` };
        }
        value[k] = text;
      }
      return { value, error: null };
    }
    case 'list': {
      if (!Array.isArray(raw)) return { value: undefined, error: `${path} must be a list` };
      if (def.maxItems && raw.length > def.maxItems) {
        return { value: undefined, error: `${path} can have at most ${def.maxItems} items` };
      }
      const errors = [];
      const value = raw.map((item, i) => {
        const r = validateObject(def.fields, item, `${path}[${i + 1}]`, opts);
        errors.push(...r.errors);
        return r.value;
      });
      return { value, error: errors.length ? errors : null };
    }
    default:
      return { value: undefined, error: `${path} has an unknown field type` };
  }
}

function validateObject(fields, raw, prefix, opts) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = {};
  const errors = [];
  // Only registry fields are kept; anything else in the input is dropped.
  for (const [name, def] of Object.entries(fields)) {
    const path = prefix ? `${prefix}.${name}` : name;
    const r = validateField(def, source[name], path, opts);
    if (r.value !== undefined) value[name] = r.value;
    if (r.error) errors.push(...(Array.isArray(r.error) ? r.error : [r.error]));
  }
  return { value, errors };
}

/**
 * validateSectionData('hero', body, { forPublish, imageUrlPrefix })
 *   → { ok, value, errors: string[] }
 * Drafts may be incomplete; `forPublish: true` also enforces required fields.
 */
export function validateSectionData(sectionKey, data, opts = {}) {
  if (!isSectionKey(sectionKey)) {
    return { ok: false, value: {}, errors: [`Unknown section "${sectionKey}"`] };
  }
  return validateFields(WEBSITE_SECTIONS[sectionKey].fields, data, opts);
}

/** Validate any object against a field map (same rules as sections). */
export function validateFields(fields, data, opts = {}) {
  const { value, errors } = validateObject(fields, data, '', {
    forPublish: Boolean(opts.forPublish),
    imageUrlPrefix: opts.imageUrlPrefix || null,
    imageFolder: opts.imageFolder || null,
  });
  return { ok: errors.length === 0, value, errors };
}

// The website block on a CRM Package (Team N Website → Packages on Website).
export const PACKAGE_WEBSITE_FIELDS = {
  show: { type: 'boolean', label: 'Show on website' },
  sortOrder: { type: 'number', label: 'Order on website', min: 0, max: 999 },
  tagline: { type: 'text', label: 'Tagline', maxLength: 100 },
  description: { type: 'textarea', label: 'Website description', maxLength: 400 },
  idealFor: { type: 'textarea', label: 'Ideal for', maxLength: 200 },
  features: { type: 'textList', label: "What's included", maxItems: 12, maxLength: 120 },
  durationLabel: { type: 'text', label: 'Duration (e.g. 4 hours)', maxLength: 30 },
  highlighted: { type: 'boolean', label: 'Mark as most popular' },
  priceFrom: { type: 'boolean', label: 'Show price as "from"' },
  coverImage: { type: 'image', label: 'Cover image', rule: 'packageCover' },
};

export const ADDON_WEBSITE_FIELDS = {
  show: { type: 'boolean', label: 'Show on website' },
  sortOrder: { type: 'number', label: 'Order on website', min: 0, max: 999 },
  description: { type: 'textarea', label: 'Website description', maxLength: 200 },
};

// Value stored when a field is cleared.
export const WEBSITE_FIELD_DEFAULTS = {
  show: false,
  sortOrder: null,
  tagline: '',
  description: '',
  idealFor: '',
  features: [],
  durationLabel: '',
  highlighted: false,
  priceFrom: false,
  coverImage: null,
};

/**
 * Which upload rule and Cloudinary subfolder an upload target uses, or null.
 *   ('hero', 'imageDesktop') → { rule: 'heroDesktop', folder: 'hero' }
 *   ('gallery', 'image')     → { rule: 'gallery', folder: 'gallery' }
 *   ('package', 'coverImage')→ { rule: 'packageCover', folder: 'packages' }
 */
export function uploadTargetFor(section, field) {
  if (section === 'gallery' && field === 'image') return { rule: 'gallery', folder: 'gallery', area: 'gallery' };
  if (section === 'package' && field === 'coverImage') {
    return { rule: 'packageCover', folder: 'packages', area: 'packages' };
  }
  if (!isSectionKey(section)) return null;
  const def = WEBSITE_SECTIONS[section].fields[field];
  if (!def || def.type !== 'image') return null;
  return { rule: def.rule, folder: section, area: 'content' };
}

// Cloudinary delivery prefix for this account, e.g. https://res.cloudinary.com/<cloud>/
export const cloudinaryUrlPrefix = (cloudName) =>
  cloudName ? `https://res.cloudinary.com/${cloudName}/` : null;
