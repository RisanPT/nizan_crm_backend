// Meta ad spend sync: the pure rules (no database, no network). services/metaAdsSync.js does the work.
//
// What it reads: the Insights API of each ad account, one row per day (time_increment=1) at three levels — per campaign (the figure the
// Campaigns hub shows), per ad (Creatives & Ads), and per audience segment (age + gender, platform + placement: the Audiences view).
// Each row is turned into the SAME row a Meta Ads Manager export gives (utils/marketingCampaignInput.js cleanImportInput), and written
// by the same code (services/campaignMetricsImport.js), so a synced day and an imported day can never be told apart except by source.
//
// Settings from the server's environment (shared with Lead Ads: META_APP_SECRET, META_ACCESS_TOKEN — the token also needs ads_read):
//   META_AD_ACCOUNTS  the ad accounts to read, each with the brand its new campaigns belong to: "act_123:kerala, act_456:main"
//                     (no brand = kerala, the account the ads run on)
// Days are the ad account's own days: the account should be set to India's time zone, like the CRM.
import { metaConfig } from './metaLeads.js';

export const META_SYNC_MAX_DAYS = 92; // one "Sync now" reaches back at most this far
export const META_SYNC_CHUNK_DAYS = 15; // one Graph call asks for at most this many days (big ranges are slow for Meta)
export const META_SYNC_DAYS_BACK = 3; // an automatic run: today and the 2 days before (Meta keeps adjusting recent days)
export const META_SYNC_EVERY_HOURS = 6;
export const META_SYNC_BRANDS = ['main', 'kerala'];

const trim = (v) => String(v ?? '').trim();

/** "act_123:kerala, 456:main" → [{ id: 'act_123', brand: 'kerala' }, { id: 'act_456', brand: 'main' }]; anything unreadable is left out. */
export const adAccountsFrom = (text) => {
  const out = [];
  for (const part of trim(text).split(/[\s,;]+/).filter(Boolean)) {
    const [rawId, rawBrand = ''] = part.split(':');
    const digits = trim(rawId).replace(/^act_/i, '');
    if (!/^\d{1,30}$/.test(digits)) continue;
    const brand = META_SYNC_BRANDS.includes(trim(rawBrand).toLowerCase()) ? trim(rawBrand).toLowerCase() : 'kerala';
    const id = `act_${digits}`;
    if (!out.some((a) => a.id === id)) out.push({ id, brand });
  }
  return out;
};

/** What the environment provides for the sync. `ready` = figures can be read. Hand only `has` and `accounts` to the app. */
export const adsConfig = (env = process.env) => {
  const c = metaConfig(env);
  const accounts = adAccountsFrom(env.META_AD_ACCOUNTS);
  return {
    appSecret: c.appSecret,
    token: c.token,
    version: c.version,
    accounts,
    has: { appSecret: c.has.appSecret, token: c.has.token, accounts: accounts.length > 0 },
    ready: !!(c.appSecret && c.token && accounts.length),
  };
};

export const ADS_NOT_CONFIGURED = {
  code: 'not_configured',
  retry: false,
  text: 'The ad spend sync is not set up on the server (META_APP_SECRET, META_ACCESS_TOKEN and META_AD_ACCOUNTS).',
};

// ── days ────────────────────────────────────────────────────────────────────

const IST_MS = 330 * 60 * 1000;
export const istToday = (now = new Date()) => new Date(now.getTime() + IST_MS).toISOString().slice(0, 10);
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const span = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 864e5) + 1;

/**
 * The days a sync covers: { days } = the last N days up to today, or { from, to }. At most META_SYNC_MAX_DAYS, never past today.
 * → { from, to } or { error }
 */
export const syncRange = ({ days, from, to } = {}, today = istToday()) => {
  if (days !== undefined && days !== null && days !== '') {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > META_SYNC_MAX_DAYS) return { error: `Choose 1 to ${META_SYNC_MAX_DAYS} days.` };
    return { from: addDays(today, -(n - 1)), to: today };
  }
  if (!isDay(trim(from)) || !isDay(trim(to))) return { error: 'Choose the days to bring in.' };
  if (from > to) return { error: 'The first day is after the last.' };
  if (to > today) return { error: 'The days have not happened yet.' };
  if (span(from, to) > META_SYNC_MAX_DAYS) return { error: `Bring in at most ${META_SYNC_MAX_DAYS} days at a time.` };
  return { from, to };
};

/** from..to in pieces of at most [size] days: [{ since, until }]. */
export const chunkRange = (from, to, size = META_SYNC_CHUNK_DAYS) => {
  const out = [];
  for (let since = from; since <= to; since = addDays(since, size)) {
    const end = addDays(since, size - 1);
    out.push({ since, until: end < to ? end : to });
  }
  return out;
};

/** Is an automatic run due: never run, or the last run started at least META_SYNC_EVERY_HOURS ago. */
export const autoSyncDue = (lastRunAt, now = new Date()) => !lastRunAt || now - new Date(lastRunAt) >= META_SYNC_EVERY_HOURS * 3600 * 1000 - 60 * 1000;

// ── Meta's rows → the import's rows ─────────────────────────────────────────

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
const actionValue = (actions, type) => num((Array.isArray(actions) ? actions : []).find((a) => a?.action_type === type)?.value);
const firstOf = (actions, types) => {
  for (const t of types) {
    const v = actionValue(actions, t);
    if (v > 0) return v;
  }
  return 0;
};
const LEAD_ACTIONS = ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'];
const MESSAGE_ACTIONS = ['onsite_conversion.messaging_conversation_started_7d'];

/**
 * The campaign's "Results" as Ads Manager counts them, from Meta's actions and the campaign's objective: leads for a leads campaign,
 * conversations started for a messages / engagement one, link clicks for a traffic one; an awareness campaign's result is its reach,
 * which is shown on its own, so 0. With no objective known: leads, else conversations. (Shown beside the CRM's own leads, never mixed in.)
 */
export const resultsOf = (actions, objective = '') => {
  const o = trim(objective).toUpperCase();
  if (/LEAD/.test(o)) return firstOf(actions, LEAD_ACTIONS);
  if (/MESSAGE|ENGAGEMENT/.test(o)) return firstOf(actions, MESSAGE_ACTIONS) || firstOf(actions, LEAD_ACTIONS);
  if (/TRAFFIC|LINK_CLICK/.test(o)) return actionValue(actions, 'link_click');
  if (/AWARENESS|REACH|BRAND|VIDEO/.test(o)) return 0;
  return firstOf(actions, LEAD_ACTIONS) || firstOf(actions, MESSAGE_ACTIONS);
};

/** "instagram_reels" → "Instagram Reels" (the words Ads Manager shows in its exports). */
export const metaLabel = (v) =>
  trim(v)
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** The fields each level asks Meta for. */
export const INSIGHT_FIELDS = {
  campaign: 'campaign_id,campaign_name,objective,spend,reach,impressions,inline_link_clicks,actions,date_start',
  ad: 'campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,reach,impressions,inline_link_clicks,actions,date_start',
  breakdown: 'campaign_id,campaign_name,spend,reach,impressions,inline_link_clicks,actions,date_start',
};
/** The two breakdowns read for the Audiences view (each its own call: Meta does not combine these). */
export const INSIGHT_BREAKDOWNS = ['age,gender', 'publisher_platform,platform_position'];

/**
 * One Insights row → the row a Meta Ads Manager export gives for that level, or null when it is not one day of one campaign.
 * [objectiveOf]: campaign id → its objective (from the campaign rows), for the results.
 */
export const importRowOf = (level, r, objectiveOf = new Map()) => {
  const day = trim(r?.date_start);
  const campaignId = trim(r?.campaign_id);
  if (!isDay(day) || !/^\d{1,30}$/.test(campaignId)) return null;
  const impressions = Math.round(num(r.impressions));
  const row = {
    campaign: trim(r.campaign_name).slice(0, 200),
    campaignId,
    day,
    spend: Math.round(num(r.spend) * 100) / 100,
    reach: Math.min(Math.round(num(r.reach)), impressions),
    impressions,
    clicks: Math.min(Math.round(num(r.inline_link_clicks)), impressions),
    results: Math.round(resultsOf(r.actions, r.objective || objectiveOf.get(campaignId) || '')),
  };
  if (level === 'ad') {
    if (!/^\d{1,30}$/.test(trim(r.ad_id))) return null;
    Object.assign(row, { ad: trim(r.ad_name).slice(0, 200), adId: trim(r.ad_id), adSet: trim(r.adset_name).slice(0, 160), adSetId: /^\d{1,30}$/.test(trim(r.adset_id)) ? trim(r.adset_id) : '' });
  }
  if (level === 'breakdown') {
    Object.assign(row, {
      age: trim(r.age).slice(0, 40),
      gender: trim(r.gender).slice(0, 40),
      platform: r.publisher_platform ? metaLabel(r.publisher_platform).slice(0, 60) : '',
      position: r.platform_position ? metaLabel(r.platform_position).slice(0, 60) : '',
    });
    if (!row.age && !row.gender && !row.platform && !row.position) return null;
  }
  return row;
};

/** Rows in batches of at most [size] (the import's own limit per write). */
export const batches = (rows, size = 500) => {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
};

/**
 * The Meta campaigns no CRM campaign matched, kept between runs (keyed by Meta's id): the newest name, account and brand; the earliest
 * day seen (a link or add brings everything from there); the spend of the latest run that saw it, with that run's days.
 */
export const mergeUnlinked = (kept = [], seen = [], { ignored = [], linked = [] } = {}) => {
  const out = new Map(kept.filter((u) => !ignored.includes(u.metaId) && !linked.includes(u.metaId)).map((u) => [u.metaId, { ...u }]));
  for (const s of seen) {
    if (!s.metaId || ignored.includes(s.metaId) || linked.includes(s.metaId)) continue;
    const was = out.get(s.metaId);
    out.set(s.metaId, {
      metaId: s.metaId,
      name: s.name || was?.name || '',
      accountId: s.accountId || was?.accountId || '',
      brand: s.brand || was?.brand || 'kerala',
      reason: s.reason || 'no_match',
      firstDay: [was?.firstDay, s.from].filter(Boolean).sort()[0] ?? '',
      lastDay: [was?.lastDay, s.to].filter(Boolean).sort().at(-1) ?? '',
      spend: s.spend ?? 0,
      runFrom: s.runFrom ?? '',
      runTo: s.runTo ?? '',
    });
  }
  return [...out.values()].sort((a, b) => (b.lastDay || '').localeCompare(a.lastDay || '') || b.spend - a.spend);
};
