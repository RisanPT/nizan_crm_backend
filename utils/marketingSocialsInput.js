import mongoose from 'mongoose';
import { ASSET_KINDS, ASSET_MEDIA, ASSET_STAGES } from '../models/MarketingAsset.js';
import { ACCOUNT_STATUSES } from '../models/SocialAccount.js';
import { CONTENT_PLATFORMS } from '../models/ContentItem.js';
import { isDay } from './marketingActivityInput.js';
import { cleanKeywords, normalizeKeyword, MAX_KEYWORDS } from './assetKeywords.js';

// Checking what the app sends for assets, accounts and targets (pure — tests/marketingSocialsInput.test.js).
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (message, field) => ({ ok: false, message, field });
const BRANDS = ['main', 'kerala'];

/** Only http(s) links: a "link" can never be a script or a file path. '' when it is not one. */
export const httpUrl = (v) => {
  const s = str(v, 1000);
  if (!s) return '';
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:' ? s : '';
  } catch {
    return '';
  }
};

/** A platform from a request: its key when it is one the Socials screens offer, else null (never a quiet Instagram). */
export const platformOf = (v) => {
  const k = String(v ?? '').trim().toLowerCase();
  return CONTENT_PLATFORMS.includes(k) ? k : null;
};

/** An asset a post can be made from: approved, or marked as a final output. */
export const isUsableAsset = (a) => !!a && (a.stage === 'approved' || a.isFinal === true);

/**
 * When an asset became approved / final, for the turnaround: set to [now] the moment it becomes one, kept while it stays one, cleared
 * when it stops being one (sent back, or rejected and not final). An asset approved before this was recorded keeps null — the reports
 * then use the day it was added, as they always did. `before` = the asset as it was ({} for a new one).
 */
export const approvedAtFor = (before, after, now = new Date()) => {
  if (!isUsableAsset(after)) return null;
  return isUsableAsset(before) ? before.approvedAt ?? null : now;
};

/** The portfolio a brand's work is filed under in the gallery. */
export const portfolioOfBrand = (brand) => (brand === 'kerala' ? 'Kerala' : 'Main (Company)');

/**
 * What an asset takes from its shoot: the shoot's brand and that brand's portfolio (always — the shoot decides, whatever the form
 * sent), the shoot's category as a tag (added to the asset's own tags), and the category as the page when the asset names no page.
 * `fields` = the asset's { page, tags } as they will be saved.
 */
export const assetFromShoot = (shoot, fields = {}) => {
  const category = String(shoot?.category ?? '').trim();
  const page = String(fields.page ?? '').trim();
  return {
    brand: shoot?.brand === 'kerala' ? 'kerala' : 'main',
    portfolio: portfolioOfBrand(shoot?.brand),
    page: page || category,
    tags: [...new Set([...(fields.tags ?? []), ...(category ? [normalizeKeyword(category)] : [])])].filter(Boolean).slice(0, MAX_KEYWORDS),
  };
};

const nonNeg = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

/** An asset from a request body. `existing` set = an update (only what was sent changes). */
export const cleanAssetInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (has('title') || !existing) {
    out.title = str(b.title, 200);
    if (out.title.length < 2) return fail('Give the asset a title.', 'title');
  }
  if (has('url') || !existing) {
    out.url = httpUrl(b.url);
    if (!out.url) return fail('Paste the link to the file (a Drive or cloud link starting with https://).', 'url');
  }
  if (has('thumbUrl')) {
    out.thumbUrl = httpUrl(b.thumbUrl);
    if (str(b.thumbUrl, 1000) && !out.thumbUrl) return fail('The thumbnail must be a link starting with https://.', 'thumbUrl');
  }
  if (has('brand')) {
    if (!BRANDS.includes(b.brand)) return fail('Choose Main or Kerala.', 'brand');
    out.brand = b.brand;
  }
  if (has('kind')) {
    if (!ASSET_KINDS.includes(b.kind)) return fail('Unknown asset type.', 'kind');
    out.kind = b.kind;
  }
  if (has('media')) {
    if (!ASSET_MEDIA.includes(b.media)) return fail('Unknown media type.', 'media');
    out.media = b.media;
  }
  if (has('stage')) {
    if (!ASSET_STAGES.includes(b.stage)) return fail('Unknown production stage.', 'stage');
    out.stage = b.stage;
  }
  if (has('portfolio')) out.portfolio = str(b.portfolio, 80) || 'Main (Company)';
  if (has('page')) out.page = str(b.page, 80);
  if (has('tags')) {
    // keywords: one spelling each, however they were typed or pasted (utils/assetKeywords.js); too many or too long is said, not cut
    const k = cleanKeywords(b.tags);
    if (!k.ok) return k;
    out.tags = k.value;
  }
  if (has('durationSec')) out.durationSec = Math.round(nonNeg(b.durationSec));
  if (has('sizeMb')) out.sizeMb = Math.round(nonNeg(b.sizeMb) * 10) / 10;
  if (has('isFinal')) out.isFinal = b.isFinal === true;
  if (has('ownerName')) out.ownerName = str(b.ownerName, 100);
  if (has('shootId')) out.shootId = b.shootId && mongoose.isValidObjectId(String(b.shootId)) ? String(b.shootId) : null;
  // a video / reel / film / bts clip is video unless the sender said otherwise
  if (!has('media') && !existing && out.kind) out.media = ['reel', 'film', 'bts'].includes(out.kind) ? 'video' : out.kind === 'design' ? 'design' : out.kind === 'document' ? 'document' : 'image';
  return { ok: true, value: out };
};

/** A social account from a request body. */
export const cleanAccountInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (has('platform') || !existing) {
    out.platform = str(b.platform, 40).toLowerCase();
    if (!out.platform) return fail('Choose the platform.', 'platform');
  }
  if (has('brand')) {
    if (!BRANDS.includes(b.brand)) return fail('Choose Main or Kerala.', 'brand');
    out.brand = b.brand;
  }
  if (has('handle')) out.handle = str(b.handle, 120);
  if (has('status')) {
    if (!ACCOUNT_STATUSES.includes(b.status)) return fail('Unknown account status.', 'status');
    out.status = b.status;
  }
  if (has('followers')) {
    const n = Number(b.followers);
    if (!Number.isFinite(n) || n < 0 || n > 1e9) return fail('Followers must be a number, zero or more.', 'followers');
    out.followers = Math.round(n);
  }
  if (has('note')) out.note = str(b.note, 300);
  return { ok: true, value: out };
};

/** The Monday (IST day string) of the week containing [day]. */
export const mondayOf = (day) => {
  const t = Date.parse(`${day}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();
  return new Date(t - ((dow + 6) % 7) * 86400000).toISOString().slice(0, 10);
};

/** The targets body: { brand, period (any day of the week), values: [{ metricId, target }] } → rows to save. */
export const cleanTargetInput = (b = {}) => {
  const brand = b.brand === undefined ? 'all' : b.brand;
  if (!['all', ...BRANDS].includes(brand)) return fail('Choose All, Main or Kerala.', 'brand');
  if (!isDay(b.period)) return fail('Choose the week the targets are for.', 'period');
  if (!Array.isArray(b.values) || !b.values.length) return fail('Send at least one target.', 'values');
  const rows = [];
  for (const v of b.values) {
    if (!v || !mongoose.isValidObjectId(String(v.metricId))) return fail('A target does not name its activity.', 'values');
    const t = Number(v.target);
    if (!Number.isFinite(t) || t < 0 || t > 1e7) return fail('A target must be a number, zero or more.', 'values');
    rows.push({ metricId: String(v.metricId), target: Math.round(t * 100) / 100 });
  }
  return { ok: true, value: { brand, period: mondayOf(b.period), rows } };
};
