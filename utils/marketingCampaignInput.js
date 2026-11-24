import mongoose from 'mongoose';
import { CAMPAIGN_BRANDS, CAMPAIGN_PLATFORMS, CAMPAIGN_OBJECTIVES } from '../models/Campaign.js';
import { AD_FORMATS, AD_STATUSES } from '../models/CampaignAd.js';
import { isDay } from './marketingActivityInput.js';
import { httpUrl } from './marketingSocialsInput.js';

// Checking what the app sends for a campaign, an ad, a day's figures and a Meta Ads Manager import (pure — tests/marketingCampaignInput.test.js).
// The controller adds the checks that need the database (does the campaign exist, is the Meta ID already used).

const str = (v, max) => String(v ?? '').trim().slice(0, max);
const fail = (message, field) => ({ ok: false, message, field });
const idOrNull = (v) => (v && mongoose.isValidObjectId(String(v)) ? String(v) : null);
const MAX_MONEY = 1e9;
const MAX_COUNT = 1e10;
const META_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** At most this many rows in one import request (the app sends big files in several requests of 250, kept under express.json's 100 KB). */
export const MAX_IMPORT_ROWS = 500;

/** A new campaign's brand when none is chosen: the ads run only on the Kerala account. */
export const DEFAULT_CAMPAIGN_BRAND = 'kerala';

/**
 * What a file holds, one row per…: 'campaign' — campaign per day; 'ad' — AD per day (Ads Manager's ad-level export: ad ID / name, ad set ID
 * / name, campaign ID / name); 'breakdown' — audience or placement segment per day (Breakdown → By delivery: age, gender, platform /
 * placement).
 */
export const IMPORT_LEVELS = ['campaign', 'ad', 'breakdown'];

/** A number ≥ 0 within a limit, as typed (blank = 0): { ok, value } | { ok: false }. Money keeps 2 decimals; counts are whole numbers. */
const amount = (v, { max, whole }) => {
  if (v === undefined || v === null || v === '') return { ok: true, value: 0 };
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, '').trim());
  if (!Number.isFinite(n) || n < 0 || n > max) return { ok: false };
  return { ok: true, value: whole ? Math.round(n) : Math.round(n * 100) / 100 };
};

/** A day as a request names it: 'YYYY-MM-DD' that really exists. */
const dayOf = (v) => (typeof v === 'string' && isDay(v.trim()) ? v.trim() : null);

/** The IST midnight at the start of a day, as a Date (how campaign start / end dates are stored). */
export const dayToDate = (day) => new Date(`${day}T00:00:00+05:30`);

/** A campaign from a request body. `existing` set = an update (only what was sent changes). */
export const cleanCampaignInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (has('title') || !existing) {
    out.title = str(b.title, 160);
    if (out.title.length < 2) return fail('Give the campaign a name.', 'title');
  }
  if (has('brand')) {
    if (!CAMPAIGN_BRANDS.includes(b.brand)) return fail('Choose Main or Kerala.', 'brand');
    out.brand = b.brand;
  } else if (!existing) {
    out.brand = DEFAULT_CAMPAIGN_BRAND; // the ads run only on the Kerala account
  }
  if (has('platform')) {
    const p = str(b.platform, 20);
    if (p && !CAMPAIGN_PLATFORMS.includes(p)) return fail('Unknown platform.', 'platform');
    out.platform = p;
    // the old Campaigns screen shows the typed `channel`: keep it in step unless the sender typed one
    if (!has('channel') && p) out.channel = p.charAt(0).toUpperCase() + p.slice(1);
  }
  if (has('channel')) out.channel = str(b.channel, 80);
  if (has('objective')) {
    const o = str(b.objective, 30);
    if (o && !CAMPAIGN_OBJECTIVES.includes(o)) return fail('Unknown objective.', 'objective');
    out.objective = o;
  }
  if (has('status')) {
    if (!['planned', 'active', 'paused', 'completed'].includes(b.status)) return fail('Unknown campaign status.', 'status');
    out.status = b.status;
  }
  for (const k of ['startDate', 'endDate']) {
    if (!has(k)) continue;
    if (b[k] === null || b[k] === '') {
      out[k] = null;
      continue;
    }
    const day = dayOf(b[k]);
    if (!day) return fail(`${k === 'startDate' ? 'The start' : 'The end'} date must be a real day (YYYY-MM-DD).`, k);
    out[k] = dayToDate(day);
  }
  const start = out.startDate !== undefined ? out.startDate : existing?.startDate;
  const end = out.endDate !== undefined ? out.endDate : existing?.endDate;
  if (start && end && end < start) return fail('The end date is before the start date.', 'endDate');
  for (const k of ['budget', 'dailyBudget']) {
    if (!has(k)) continue;
    const n = amount(b[k], { max: MAX_MONEY, whole: false });
    if (!n.ok) return fail(`${k === 'budget' ? 'The budget' : 'The daily budget'} must be an amount in rupees, zero or more.`, k);
    out[k] = n.value;
  }
  if (has('metaCampaignId')) {
    const id = String(b.metaCampaignId ?? '').trim(); // not cut: a pasted ID that is too long is refused, not silently shortened
    if (id && !META_ID_RE.test(id)) return fail('A Meta campaign ID is made of letters, numbers, - and _ only (up to 40).', 'metaCampaignId');
    out.metaCampaignId = id;
  }
  if (has('audienceNote')) out.audienceNote = str(b.audienceNote, 500);
  if (has('notes')) out.notes = str(b.notes, 1000);
  return { ok: true, value: out };
};

/** An ad from a request body. */
export const cleanAdInput = (b = {}, existing = null) => {
  const out = {};
  const has = (k) => b[k] !== undefined;
  if (has('campaignId') || !existing) {
    const id = idOrNull(b.campaignId);
    if (!id) return fail('Choose the campaign this ad belongs to.', 'campaignId');
    out.campaignId = id;
  }
  if (has('name') || !existing) {
    out.name = str(b.name, 200);
    if (out.name.length < 2) return fail('Give the ad a name.', 'name');
  }
  if (has('adSetName')) out.adSetName = str(b.adSetName, 160);
  if (has('format')) {
    if (!AD_FORMATS.includes(b.format)) return fail('Unknown ad format.', 'format');
    out.format = b.format;
  }
  if (has('status')) {
    if (!AD_STATUSES.includes(b.status)) return fail('Unknown ad status.', 'status');
    out.status = b.status;
  }
  for (const [k, what] of [['creativeUrl', 'The creative'], ['thumbUrl', 'The thumbnail']]) {
    if (!has(k)) continue;
    out[k] = httpUrl(b[k]);
    if (str(b[k], 1000) && !out[k]) return fail(`${what} must be a link starting with https://.`, k);
  }
  for (const [k, whole, label] of [['impressions', true, 'Impressions'], ['clicks', true, 'Clicks'], ['spend', false, 'Spend'], ['results', true, 'Results']]) {
    if (!has(k)) continue;
    const n = amount(b[k], { max: k === 'spend' ? MAX_MONEY : MAX_COUNT, whole });
    if (!n.ok) return fail(`${label} must be a number, zero or more.`, k);
    out[k] = n.value;
  }
  const impressions = out.impressions ?? existing?.impressions ?? 0;
  const clicks = out.clicks ?? existing?.clicks ?? 0;
  if (clicks > impressions) return fail('Clicks cannot be more than impressions.', 'clicks');
  return { ok: true, value: out };
};

/**
 * One day's figures for a campaign, typed by hand: { campaignId, day, spend, reach, impressions, clicks, results }. `today` = the IST
 * day now (a day cannot be in the future). The platform cannot reach more people than it showed the ad to, nor get more clicks than
 * impressions, so those are refused.
 */
export const cleanMetricInput = (b = {}, { today } = {}) => {
  const campaignId = idOrNull(b.campaignId);
  if (!campaignId) return fail('Choose the campaign.', 'campaignId');
  const day = dayOf(b.day);
  if (!day) return fail('Choose the day these figures are for.', 'day');
  if (today && day > today) return fail('That day has not happened yet.', 'day');
  const value = { campaignId, day };
  for (const [k, whole, label] of [['spend', false, 'Spend'], ['reach', true, 'Reach'], ['impressions', true, 'Impressions'], ['clicks', true, 'Clicks'], ['results', true, 'Results']]) {
    const n = amount(b[k], { max: k === 'spend' ? MAX_MONEY : MAX_COUNT, whole });
    if (!n.ok) return fail(`${label} must be a number, zero or more.`, k);
    value[k] = n.value;
  }
  if (value.reach > value.impressions) return fail('Reach cannot be more than impressions.', 'reach');
  if (value.clicks > value.impressions) return fail('Clicks cannot be more than impressions.', 'clicks');
  return { ok: true, value };
};

/**
 * A Meta Ads Manager import: { level, rows: [{ campaign, campaignId?, day, spend, reach, impressions, clicks, results,
 *   (level 'ad') adId?, ad?, adSetId?, adSet?, (level 'breakdown') age?, gender?, platform?, position? }], createMissing, brand, dryRun,
 * fileName, importId }. A bad ROW is skipped with its reason (so one stray line does not lose a whole month); only a request that is not
 * an import at all is refused. `today`: the IST day now (the platform has no figures for tomorrow).
 * → { ok: true, value: { level, rows, skipped: [{ index, reason }], createMissing, brand, dryRun, fileName, importId } }
 *   A breakdown row comes back with `placement` = "platform · position" (whichever were given) and `dimension` = its fields joined.
 */
export const cleanImportInput = (b = {}, { today } = {}) => {
  if (!Array.isArray(b.rows) || !b.rows.length) return fail('The file has no rows to import.', 'rows');
  if (b.rows.length > MAX_IMPORT_ROWS) return fail(`Send at most ${MAX_IMPORT_ROWS} rows at a time.`, 'rows');
  const level = b.level === undefined || b.level === null ? 'campaign' : b.level;
  if (!IMPORT_LEVELS.includes(level)) return fail('The file must be one row per campaign, per ad, or per audience segment, per day.', 'level');
  const createMissing = b.createMissing === true;
  const brand = b.brand === undefined || b.brand === null ? 'kerala' : b.brand;
  if (!CAMPAIGN_BRANDS.includes(brand)) return fail('Choose Main or Kerala for the campaigns to create.', 'brand');
  const rows = [];
  const skipped = [];
  b.rows.forEach((r, index) => {
    const skip = (reason) => skipped.push({ index, reason });
    if (!r || typeof r !== 'object') return skip('Not a row.');
    const campaign = str(r.campaign, 200);
    const metaId = String(r.campaignId ?? '').trim();
    if (!campaign && !metaId) return skip('No campaign name.');
    if (metaId && !META_ID_RE.test(metaId)) return skip('The campaign ID is not valid.');
    const day = dayOf(r.day);
    if (!day) return skip('The day is missing or not a real date.');
    if (today && day > today) return skip('The day has not happened yet.');
    const v = { campaign, metaId, day };
    for (const [k, whole] of [['spend', false], ['reach', true], ['impressions', true], ['clicks', true], ['results', true]]) {
      const n = amount(r[k], { max: k === 'spend' ? MAX_MONEY : MAX_COUNT, whole });
      if (!n.ok) return skip(`${k[0].toUpperCase()}${k.slice(1)} is not a number, zero or more.`);
      v[k] = n.value;
    }
    if (v.reach > v.impressions) return skip('Reach is higher than impressions.');
    if (v.clicks > v.impressions) return skip('Clicks are higher than impressions.');
    if (level === 'ad') {
      v.ad = str(r.ad, 200);
      v.adId = String(r.adId ?? '').trim();
      v.adSet = str(r.adSet, 160);
      v.adSetId = String(r.adSetId ?? '').trim();
      if (!v.ad && !v.adId) return skip('No ad name or ad ID.');
      if (v.adId && !META_ID_RE.test(v.adId)) return skip('The ad ID is not valid.');
      if (v.adSetId && !META_ID_RE.test(v.adSetId)) v.adSetId = '';
    }
    if (level === 'breakdown') {
      v.age = str(r.age, 40);
      v.gender = str(r.gender, 40);
      v.placement = [str(r.platform, 60), str(r.position, 60)].filter(Boolean).join(' · ');
      v.dimension = ['age', 'gender', 'placement'].filter((k) => v[k]).join('+');
      if (!v.dimension) return skip('No age, gender or placement.');
    }
    rows.push(v);
  });
  return { ok: true, value: { level, rows, skipped, createMissing, brand, dryRun: b.dryRun === true, fileName: str(b.fileName, 200), importId: idOrNull(b.importId) } };
};

const FIGURES = ['spend', 'reach', 'impressions', 'clicks', 'results'];
const addInto = (map, key, r, base = {}) => {
  const d = map.get(key) ?? { ...base, spend: 0, reach: 0, impressions: 0, clicks: 0, results: 0 };
  for (const k of FIGURES) d[k] += r[k];
  d.spend = Math.round(d.spend * 100) / 100;
  map.set(key, d);
};

/**
 * One entry per campaign in the file, its days merged: two rows for the same campaign and day are ADDED (the day's total), so
 * re-importing the same file gives the same totals. For an ad-level file each campaign also carries its ADS (by Meta ad ID, else by name),
 * each with its days; for a breakdown file, its SEGMENTS (day + dimension + age / gender / placement), each added up.
 * → [{ name, metaId, rowCount, days: Map(day → totals), ads: Map(key → { name, metaId, adSetName, adSetId, days: Map }),
 *      segments: Map(key → { day, dimension, age, gender, placement, …totals }) }]
 */
export const groupImportRows = (rows) => {
  const groups = new Map();
  for (const r of rows) {
    const key = r.metaId ? `id:${r.metaId}` : `name:${r.campaign.toLowerCase()}`;
    const g = groups.get(key) ?? { name: r.campaign, metaId: r.metaId, rowCount: 0, days: new Map(), ads: new Map(), segments: new Map() };
    if (!g.name && r.campaign) g.name = r.campaign;
    g.rowCount += 1;
    addInto(g.days, r.day, r);
    if (r.ad !== undefined || r.adId !== undefined) {
      const ak = r.adId ? `id:${r.adId}` : `name:${String(r.ad).toLowerCase()}`;
      const a = g.ads.get(ak) ?? { name: r.ad || '', metaId: r.adId || '', adSetName: r.adSet || '', adSetId: r.adSetId || '', days: new Map() };
      if (!a.name && r.ad) a.name = r.ad;
      if (!a.adSetName && r.adSet) a.adSetName = r.adSet;
      if (!a.adSetId && r.adSetId) a.adSetId = r.adSetId;
      addInto(a.days, r.day, r);
      g.ads.set(ak, a);
    }
    if (r.dimension) {
      addInto(g.segments, `${r.day}|${r.dimension}|${r.age}|${r.gender}|${r.placement}`, r, { day: r.day, dimension: r.dimension, age: r.age, gender: r.gender, placement: r.placement });
    }
    groups.set(key, g);
  }
  return [...groups.values()];
};

/**
 * Which existing ad each ad of the file is: by Meta ad ID first, else by the exact name (any case) inside the same campaign — a name used by
 * two ads of the campaign is not guessed (a new ad is made for it). `existing`: the campaign's ads [{ _id, name, metaAdId }].
 * → the matching ad, or null
 */
export const matchImportAd = (fileAd, existing = []) => adMatchOf(fileAd, existing).ad;

/**
 * [matchImportAd] with the reason when there is no match: → { ad } | { ad: null, ambiguous: true } (a file row WITHOUT a Meta ad ID whose
 * name two or more of the campaign's ads carry — making yet another ad would count those days twice, so it is not written) |
 * { ad: null } (a new ad).
 */
export const adMatchOf = (fileAd, existing = []) => {
  if (fileAd.metaId) {
    const byId = existing.find((a) => a.metaAdId && a.metaAdId === fileAd.metaId);
    if (byId) return { ad: byId };
  }
  if (!fileAd.name) return { ad: null };
  const same = existing.filter((a) => String(a.name ?? '').trim().toLowerCase() === fileAd.name.trim().toLowerCase() && (!fileAd.metaId || !a.metaAdId));
  if (same.length === 1) return { ad: same[0] };
  return same.length > 1 && !fileAd.metaId ? { ad: null, ambiguous: true } : { ad: null };
};

/**
 * Which campaign each group of the file belongs to: by the Meta campaign ID first, else by the exact title (any case). Never guessed:
 *  • 'ambiguous'    — two of our campaigns share the title;
 *  • 'other_meta_id' — the campaign of that title is linked to ANOTHER Meta campaign (Meta lets two campaigns share a name: writing this
 *                     one's days onto it would overwrite the other's spend);
 *  • 'same_name'    — two Meta campaigns of the file (different IDs) share the title of one campaign of ours: neither is guessed.
 * A row without a Meta campaign ID (an export without the ID column) still matches by title. `campaigns`: [{ _id, title, metaCampaignId }].
 * → { matched: [{ group, campaign }], unmatched: [{ group, reason: 'no_match' | 'ambiguous' | 'other_meta_id' | 'same_name' }] }
 */
export const matchImportGroups = (groups, campaigns) => {
  const byMeta = new Map();
  const byTitle = new Map();
  for (const c of campaigns) {
    if (c.metaCampaignId) byMeta.set(String(c.metaCampaignId), c);
    const t = String(c.title ?? '').trim().toLowerCase();
    byTitle.set(t, [...(byTitle.get(t) ?? []), c]);
  }
  // each group's verdict, in the file's order
  const verdicts = groups.map((g) => {
    const viaId = g.metaId ? byMeta.get(g.metaId) : null;
    if (viaId) return { group: g, campaign: viaId };
    const sameTitle = g.name ? byTitle.get(g.name.trim().toLowerCase()) ?? [] : [];
    if (sameTitle.length > 1) return { group: g, reason: 'ambiguous' };
    if (!sameTitle.length) return { group: g, reason: 'no_match' };
    if (g.metaId && sameTitle[0].metaCampaignId) return { group: g, reason: 'other_meta_id' };
    return { group: g, campaign: sameTitle[0], byTitle: true };
  });
  // two Meta campaigns (different IDs) landing on one campaign of ours by its title: which is ours cannot be told
  const keyOf = (c) => String(c._id ?? c.title);
  const metaIdsOn = new Map();
  for (const v of verdicts) {
    if (!v.byTitle || !v.group.metaId) continue;
    metaIdsOn.set(keyOf(v.campaign), new Set([...(metaIdsOn.get(keyOf(v.campaign)) ?? []), v.group.metaId]));
  }
  const matched = [];
  const unmatched = [];
  for (const v of verdicts) {
    if (v.byTitle && v.group.metaId && metaIdsOn.get(keyOf(v.campaign)).size > 1) unmatched.push({ group: v.group, reason: 'same_name' });
    else if (v.campaign) matched.push({ group: v.group, campaign: v.campaign });
    else unmatched.push({ group: v.group, reason: v.reason });
  }
  return { matched, unmatched };
};
