// Instagram insights → the Socials module: the pure rules (no database, no network). services/metaIgSync.js does the work.
//
// What it reads, for each Instagram business account (Graph API through Facebook Login — the same system user as the rest of Meta):
//   • the account: username, followers → the Socials account (status 'connected', followers and their dated history);
//   • its posts of the last N days (/media, newest first; stories are left out) and each post's insights: reach, views, likes,
//     comments, shares, saved. Meta retired "impressions" and "plays" for new media in 2025 ("views" replaced them), so impressions
//     typed by hand are left as they are.
// A post is matched to its Socials post by Instagram's id (already linked), else its link, else THE one Instagram post planned for that
// brand that day with no link yet (two candidates are never guessed). Anything else is listed for the team to add, link or hide — the
// same rule as the ad spend sync: nothing is created unasked.
//
// Settings from the server's environment (with META_APP_SECRET and META_ACCESS_TOKEN — the token also needs instagram_basic,
// instagram_manage_insights and pages_read_engagement):
//   META_IG_ACCOUNTS  the Instagram business account ids with their brand: "17841400000000001:main, 17841400000000002:kerala"
//                     ("Find my Instagram accounts" on the Meta screen shows the ids of the Pages' accounts)
import { metaConfig } from './metaLeads.js';

export const IG_SYNC_DAYS = 30; // an automatic run refreshes the last 30 days' posts
export const IG_SYNC_MAX_DAYS = 90;
export const IG_SYNC_EVERY_HOURS = 6;
export const IG_BRANDS = ['main', 'kerala'];
export const IG_MEDIA_FIELDS = 'id,caption,media_type,media_product_type,permalink,timestamp,thumbnail_url,media_url,like_count,comments_count';
export const IG_METRICS = 'reach,views,likes,comments,shares,saved';
export const IG_METRICS_FALLBACK = 'reach,saved'; // when Meta refuses the full set for an older post
export const IG_UNMATCHED_MAX = 200;

const trim = (v) => String(v ?? '').trim();

/** "17841400000000001:main, 17841400000000002" → [{ id, brand }] (no brand = main); anything unreadable is left out. */
export const igAccountsFrom = (text) => {
  const out = [];
  for (const part of trim(text).split(/[\s,;]+/).filter(Boolean)) {
    const [rawId, rawBrand = ''] = part.split(':');
    const id = trim(rawId);
    if (!/^\d{5,30}$/.test(id)) continue;
    const brand = IG_BRANDS.includes(trim(rawBrand).toLowerCase()) ? trim(rawBrand).toLowerCase() : 'main';
    if (!out.some((a) => a.id === id)) out.push({ id, brand });
  }
  return out;
};

export const igConfig = (env = process.env) => {
  const c = metaConfig(env);
  const accounts = igAccountsFrom(env.META_IG_ACCOUNTS);
  return {
    appSecret: c.appSecret,
    token: c.token,
    version: c.version,
    pageIds: c.pageIds,
    accounts,
    has: { appSecret: c.has.appSecret, token: c.has.token, accounts: accounts.length > 0 },
    // finding the accounts needs only the secret and the token
    canFind: !!(c.appSecret && c.token),
    ready: !!(c.appSecret && c.token && accounts.length),
  };
};

export const IG_NOT_CONFIGURED = {
  code: 'not_configured',
  retry: false,
  text: 'The Instagram sync is not set up on the server (META_APP_SECRET, META_ACCESS_TOKEN and META_IG_ACCOUNTS).',
};

/** The words for a permission refusal here (Lead Ads' wording names a lead). */
export const IG_PERMISSION_TEXT =
  'The token may not read this Instagram account. Give the system user the Facebook Page the account belongs to, and the instagram_basic, instagram_manage_insights and pages_read_engagement permissions (App Review).';

// ── posts ───────────────────────────────────────────────────────────────────

/** Instagram's kind of post → the Socials content type. */
export const contentTypeOf = (m) => {
  const product = trim(m?.media_product_type).toUpperCase();
  const type = trim(m?.media_type).toUpperCase();
  if (product === 'REELS') return 'reel';
  if (product === 'STORY') return 'story';
  if (type === 'CAROUSEL_ALBUM') return 'carousel';
  if (type === 'VIDEO') return 'video';
  return 'post';
};

/** A planned post this Instagram post could be (same day, same brand, no link yet) — of a type that fits. */
const FITS = {
  reel: ['reel', 'trial_reel', 'video', 'collab'],
  carousel: ['carousel', 'post', 'image', 'collab'],
  post: ['post', 'image', 'carousel', 'collab'],
  video: ['video', 'reel', 'collab'],
};
export const typeFits = (igType, contentType) => (FITS[igType] ?? [igType]).includes(trim(contentType));

/** A link as it is compared: https, host lower case, no query or fragment, no trailing slash, www. dropped. '' when not a link. */
export const normLink = (v) => {
  try {
    const u = new URL(trim(v));
    if (!/^https?:$/.test(u.protocol)) return '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return `https://${host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
};

/** Graph's "2026-11-18T05:30:00+0000" → a Date, or null. */
export const igTime = (v) => {
  const s = trim(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = s ? new Date(s) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

const IST_MS = 330 * 60 * 1000;
export const istDayOf = (d) => (d ? new Date(new Date(d).getTime() + IST_MS).toISOString().slice(0, 10) : '');

/** A title for a post added from Instagram: its caption's first line (no hashtags), at most 80 characters. */
export const titleFromCaption = (caption, when) => {
  const line = trim(caption).split('\n').map((l) => l.replace(/#[\p{L}\p{N}_]+/gu, '').trim()).find(Boolean) ?? '';
  if (line) return line.length > 80 ? `${line.slice(0, 77).trimEnd()}…` : line;
  return `Instagram post ${istDayOf(when)}`;
};

/** The hashtags of a caption, without the #, at most 30. */
export const hashtagsOf = (caption) => [...new Set([...trim(caption).matchAll(/#([\p{L}\p{N}_]+)/gu)].map((m) => m[1]))].slice(0, 30);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/** Meta's insights answer → { reach, views, likes, comments, shares, saves } (a value may come as values[0].value or total_value.value). */
export const insightValues = (body) => {
  const out = {};
  for (const m of Array.isArray(body?.data) ? body.data : []) {
    const v = m?.total_value?.value ?? (Array.isArray(m?.values) ? m.values[0]?.value : undefined);
    const key = m?.name === 'saved' ? 'saves' : m?.name;
    if (['reach', 'views', 'likes', 'comments', 'shares', 'saves'].includes(key)) out[key] = num(v);
  }
  return out;
};

/** A post's figures: its insights, with the post's own like and comment counts when the insights did not give them. */
export const mediaMetrics = (media, insights = {}) => ({
  reach: insights.reach ?? 0,
  views: insights.views ?? 0,
  likes: insights.likes ?? num(media?.like_count),
  comments: insights.comments ?? num(media?.comments_count),
  shares: insights.shares ?? 0,
  saves: insights.saves ?? 0,
});

/** The sync's window: whole days, 1–90 (default 30). */
export const igDays = (v) => {
  const n = Number(v ?? IG_SYNC_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= IG_SYNC_MAX_DAYS ? n : null;
};

/** Is an automatic run due: never run, or the last run started at least 6 hours ago. */
export const igSyncDue = (lastRunAt, now = new Date()) => !lastRunAt || now - new Date(lastRunAt) >= IG_SYNC_EVERY_HOURS * 3600 * 1000 - 60 * 1000;

/**
 * Pick each Instagram post's Socials post. `posts`: candidate Socials posts [{ _id, brand, platform, contentType, status, permalink,
 * igMediaId, scheduledDate }]. → Map(mediaId → post) — by Instagram id, else link, else the ONE same-day post that fits when no other
 * Instagram post of that day fits it too (each post taken once; nothing ambiguous is guessed).
 */
export const matchMedia = (media, posts) => {
  const out = new Map();
  const taken = new Set();
  const byIg = new Map(posts.filter((p) => p.igMediaId).map((p) => [p.igMediaId, p]));
  const byLink = new Map();
  for (const p of posts) {
    const l = normLink(p.permalink);
    if (l) byLink.set(l, [...(byLink.get(l) ?? []), p]);
  }
  const take = (m, p) => {
    out.set(m.id, p);
    taken.add(String(p._id));
  };
  for (const m of media) {
    const p = byIg.get(m.id);
    if (p) take(m, p);
  }
  for (const m of media) {
    if (out.has(m.id)) continue;
    const same = (byLink.get(normLink(m.permalink)) ?? []).filter((p) => !taken.has(String(p._id)) && (!p.igMediaId || p.igMediaId === m.id));
    if (same.length === 1) take(m, same[0]);
  }
  // by the day: only when the post has ONE planned post that fits AND that planned post fits no other post of the day
  const want = new Map();
  const demand = new Map();
  for (const m of media) {
    if (out.has(m.id)) continue;
    const day = istDayOf(m.at);
    const type = contentTypeOf(m);
    const cands = posts.filter(
      (p) =>
        !taken.has(String(p._id)) &&
        !p.igMediaId &&
        !normLink(p.permalink) &&
        p.platform === 'instagram' &&
        p.brand === m.brand &&
        p.status !== 'cancelled' &&
        istDayOf(p.scheduledDate) === day &&
        typeFits(type, p.contentType),
    );
    want.set(m.id, cands);
    for (const p of cands) demand.set(String(p._id), (demand.get(String(p._id)) ?? 0) + 1);
  }
  for (const m of media) {
    const cands = want.get(m.id);
    if (cands?.length === 1 && demand.get(String(cands[0]._id)) === 1) take(m, cands[0]);
  }
  return out;
};
