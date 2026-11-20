// The Instagram insights sync: each Instagram business account's followers and its recent posts' figures → the Socials module. The
// rules are in utils/metaIg.js.
//
//  • runIgSync: one run at a time (across processes). It READS every account first — profile, posts of the last N days, each post's
//    insights — so a run Meta refuses part-way writes nothing; then writes the accounts (followers + today's history) and the posts.
//    A post whose insights Meta will not give (an old post, a missing right on that post) keeps its like and comment counts and the
//    run goes on; a refused token, a missing right on the account, Meta busy or down stops the run and says why.
//  • addIgMedia / linkIgMedia / ignore: what the team does with a post no Socials post matched.
//  • startMetaIgSync: when set up, every 30 minutes it checks whether an automatic run is due (6 hours) and reads the last 30 days.
// Nothing here returns or logs the token.
import ContentItem from '../models/ContentItem.js';
import SocialAccount from '../models/SocialAccount.js';
import MetaIgSync from '../models/MetaIgSync.js';
import { MetaProblem, graphGet } from './metaGraph.js';
import { knownPageIds } from './metaLeads.js';
import { isGraphUrl } from '../utils/metaLeads.js';
import {
  IG_MEDIA_FIELDS,
  IG_METRICS,
  IG_METRICS_FALLBACK,
  IG_NOT_CONFIGURED,
  IG_PERMISSION_TEXT,
  IG_SYNC_DAYS,
  IG_UNMATCHED_MAX,
  contentTypeOf,
  hashtagsOf,
  igConfig,
  igSyncDue,
  igTime,
  insightValues,
  istDayOf,
  matchMedia,
  mediaMetrics,
  titleFromCaption,
} from '../utils/metaIg.js';

const RUN_STALE_MS = 30 * 60 * 1000;
const STOPS_THE_RUN = new Set(['token', 'rate_limit', 'unreachable', 'meta_down']); // one post's refusal never does
const SAVE_FAILED = { code: 'save_failed', retry: true, text: 'The figures could not be saved in the CRM. Try again.' };
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const loadIgState = () =>
  MetaIgSync.findOneAndUpdate({ key: 'ig' }, { $setOnInsert: { key: 'ig' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();

const claim = async () => {
  await loadIgState();
  const now = new Date();
  return MetaIgSync.findOneAndUpdate(
    { key: 'ig', $or: [{ running: false }, { runningSince: null }, { runningSince: { $lt: new Date(now.getTime() - RUN_STALE_MS) } }] },
    { $set: { running: true, runningSince: now } },
    { new: true },
  ).lean();
};

const withIgWords = (p) => (p.code === 'permission' ? { ...p, text: IG_PERMISSION_TEXT } : p);

/** One post's insights; a refusal for this post alone falls back to fewer metrics, then to none. → { values, gap } */
const insightsOf = async (cfg, mediaId) => {
  try {
    return { values: insightValues(await graphGet(cfg, `${mediaId}/insights`, { metric: IG_METRICS }, cfg.token)), gap: false };
  } catch (e) {
    if (STOPS_THE_RUN.has(e.problem?.code)) throw e;
  }
  try {
    return { values: insightValues(await graphGet(cfg, `${mediaId}/insights`, { metric: IG_METRICS_FALLBACK }, cfg.token)), gap: true };
  } catch (e) {
    if (STOPS_THE_RUN.has(e.problem?.code)) throw e;
    return { values: {}, gap: true };
  }
};

/** Read one account: its profile, its posts since [since] (newest first; stories left out) and each post's figures. */
const readAccount = async (cfg, account, since) => {
  const profile = await graphGet(cfg, account.id, { fields: 'id,username,followers_count,media_count' }, cfg.token);
  const media = [];
  let body = await graphGet(cfg, `${account.id}/media`, { fields: IG_MEDIA_FIELDS, limit: 50 }, cfg.token);
  for (let page = 1; page <= 20; page += 1) {
    let older = false;
    for (const m of Array.isArray(body.data) ? body.data : []) {
      const at = igTime(m?.timestamp);
      if (!at || !/^\d{1,30}$/.test(String(m?.id ?? ''))) continue;
      if (at < since) {
        older = true;
        continue;
      }
      if (contentTypeOf(m) === 'story') continue;
      media.push({ ...m, id: String(m.id), at, brand: account.brand, accountId: account.id, username: String(profile.username ?? '') });
    }
    const next = body.paging?.next;
    if (older || !next || !isGraphUrl(next)) break;
    body = await graphGet(cfg, next, {}, cfg.token);
  }
  let gaps = 0;
  for (const m of media) {
    const { values, gap } = await insightsOf(cfg, m.id);
    if (gap) gaps += 1;
    m.metrics = mediaMetrics(m, values);
  }
  return { profile, media, gaps };
};

/** The Socials account of an Instagram account: by Instagram's id, else brand + handle; added when there is none. */
const writeAccount = async (account, profile, now) => {
  const username = String(profile.username ?? '').trim().replace(/^@/, '');
  const followers = Math.max(0, Math.round(Number(profile.followers_count) || 0));
  let acc = await SocialAccount.findOne({ igUserId: account.id });
  if (!acc && username) acc = await SocialAccount.findOne({ platform: 'instagram', brand: account.brand, handle: new RegExp(`^@?${escapeRx(username)}$`, 'i') });
  if (!acc) acc = new SocialAccount({ brand: account.brand, platform: 'instagram', handle: username || account.id });
  const today = istDayOf(now);
  acc.set({ igUserId: account.id, status: 'connected', followers, syncedAt: now });
  acc.history = [...(acc.history ?? []).filter((h) => h.day !== today), { day: today, followers }].slice(-400);
  await acc.save();
};

const figures = (metrics) => ({
  'metrics.reach': metrics.reach ?? 0,
  'metrics.views': metrics.views ?? 0,
  'metrics.likes': metrics.likes ?? 0,
  'metrics.comments': metrics.comments ?? 0,
  'metrics.shares': metrics.shares ?? 0,
  'metrics.saves': metrics.saves ?? 0,
});

/** A Socials post becomes (or stays) this Instagram post: its figures, and — when missing — its link, published state and day. */
const linkSet = (post, m, now) => ({
  igMediaId: m.id ?? m.mediaId,
  metricsSource: 'instagram',
  metricsSyncedAt: now,
  ...figures(m.metrics ?? {}),
  ...(post.permalink ? {} : { permalink: m.permalink ?? '' }),
  ...(post.status === 'published' ? {} : { status: 'published' }),
  ...(post.publishedDate ? {} : { publishedDate: m.at }),
});

/** Write the posts read. → { updated, linked, unmatched: [media] } */
const writeMedia = async (media, now) => {
  if (!media.length) return { updated: 0, linked: 0, unmatched: [] };
  const ids = media.map((m) => m.id);
  const codes = [...new Set(media.map((m) => /\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(String(m.permalink ?? ''))?.[1]).filter(Boolean))];
  const first = media.reduce((d, m) => (m.at < d ? m.at : d), now);
  const posts = await ContentItem.find({
    $or: [
      { igMediaId: { $in: ids } },
      { platform: 'instagram', scheduledDate: { $gte: new Date(first.getTime() - 2 * 864e5), $lte: new Date(now.getTime() + 2 * 864e5) } },
      ...(codes.length ? [{ permalink: { $regex: `/(?:p|reel|reels|tv)/(?:${codes.map(escapeRx).join('|')})(?:[/?#]|$)` } }] : []),
    ],
  })
    .select('brand platform contentType status permalink igMediaId scheduledDate publishedDate')
    .lean();
  const matched = matchMedia(media, posts);
  const ops = [];
  let linked = 0;
  for (const m of media) {
    const p = matched.get(m.id);
    if (!p) continue;
    if (!p.igMediaId) linked += 1;
    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: linkSet(p, m, now) } } });
  }
  if (ops.length) await ContentItem.bulkWrite(ops, { ordered: false });
  return { updated: ops.length, linked, unmatched: media.filter((m) => !matched.has(m.id)) };
};

const unmatchedEntry = (m) => ({
  mediaId: m.id,
  accountId: m.accountId,
  username: m.username,
  brand: m.brand,
  contentType: contentTypeOf(m),
  caption: String(m.caption ?? '').slice(0, 2200),
  permalink: String(m.permalink ?? ''),
  at: m.at,
  metrics: m.metrics,
});

/**
 * Read the last [days] days. → the run's summary (lastRun), or { busy: true }. Throws a MetaProblem only when not set up.
 */
export const runIgSync = async ({ days = IG_SYNC_DAYS, trigger = 'manual', actor = null } = {}) => {
  const cfg = igConfig();
  if (!cfg.ready) throw new MetaProblem(IG_NOT_CONFIGURED);
  const state = await claim();
  if (!state) return { busy: true };
  const now = new Date();
  const since = new Date(now.getTime() - days * 864e5);
  const lastRun = { at: now, doneAt: null, trigger, byName: actor?.name ?? (trigger === 'auto' ? 'Automatic sync' : ''), days, ok: false, problemCode: '', problem: '', accounts: cfg.accounts.length, media: 0, updated: 0, linked: 0, unmatched: 0, gaps: 0 };
  try {
    const read = [];
    for (const account of cfg.accounts) read.push({ account, ...(await readAccount(cfg, account, since)) });

    for (const r of read) await writeAccount(r.account, r.profile, now);
    const media = read.flatMap((r) => r.media);
    const w = await writeMedia(media, now);

    const fresh = await MetaIgSync.findOne({ key: 'ig' }).select('unmatched ignored').lean();
    const ignored = new Set(fresh?.ignored ?? []);
    const seenNow = new Set(media.map((m) => m.id));
    const linkedNow = new Set((await ContentItem.find({ igMediaId: { $in: (fresh?.unmatched ?? []).map((u) => u.mediaId) } }).select('igMediaId').lean()).map((p) => p.igMediaId));
    const kept = (fresh?.unmatched ?? []).filter((u) => !seenNow.has(u.mediaId) && !ignored.has(u.mediaId) && !linkedNow.has(u.mediaId));
    const unmatched = [...w.unmatched.filter((m) => !ignored.has(m.id)).map(unmatchedEntry), ...kept]
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, IG_UNMATCHED_MAX);

    Object.assign(lastRun, { ok: true, doneAt: new Date(), media: media.length, updated: w.updated, linked: w.linked, unmatched: unmatched.length, gaps: read.reduce((t, r) => t + r.gaps, 0) });
    await MetaIgSync.updateOne({ key: 'ig' }, { $set: { lastRun, lastOkAt: lastRun.doneAt, unmatched, running: false, runningSince: null } });
    return lastRun;
  } catch (err) {
    const p = err instanceof MetaProblem ? withIgWords(err.problem) : SAVE_FAILED;
    if (!(err instanceof MetaProblem)) console.error('[Instagram sync] failed:', err?.message ?? err);
    Object.assign(lastRun, { ok: false, doneAt: new Date(), problemCode: p.code, problem: p.text });
    await MetaIgSync.updateOne({ key: 'ig' }, { $set: { lastRun, running: false, runningSince: null } });
    return lastRun;
  }
};

// ── posts no Socials post matched ────────────────────────────────────────────

export class IgRefusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const forget = (mediaIds) => MetaIgSync.updateOne({ key: 'ig' }, { $pull: { unmatched: { mediaId: { $in: mediaIds } }, ignored: { $in: mediaIds } } });

/** Add listed Instagram posts as published Socials posts, with their figures. → how many were added */
export const addIgMedia = async ({ mediaIds, actor }) => {
  const s = await loadIgState();
  const entries = (s.unmatched ?? []).filter((u) => mediaIds.includes(u.mediaId));
  if (!entries.length) throw new IgRefusal(404, 'That Instagram post is not in the list any more.');
  const now = new Date();
  let added = 0;
  for (const e of entries) {
    if (await ContentItem.exists({ igMediaId: e.mediaId })) continue;
    await ContentItem.create({
      title: titleFromCaption(e.caption, e.at),
      caption: e.caption,
      hashtags: hashtagsOf(e.caption),
      platform: 'instagram',
      contentType: e.contentType || 'post',
      status: 'published',
      brand: e.brand || 'main',
      scheduledDate: e.at,
      publishedDate: e.at,
      permalink: e.permalink,
      igMediaId: e.mediaId,
      metrics: { reach: e.metrics?.reach ?? 0, views: e.metrics?.views ?? 0, likes: e.metrics?.likes ?? 0, comments: e.metrics?.comments ?? 0, shares: e.metrics?.shares ?? 0, saves: e.metrics?.saves ?? 0 },
      metricsSource: 'instagram',
      metricsSyncedAt: now,
      createdBy: actor?._id ?? null,
    });
    added += 1;
  }
  await forget(entries.map((e) => e.mediaId));
  return added;
};

/** This Instagram post IS that Socials post: link them and give it the post's figures. */
export const linkIgMedia = async ({ mediaId, contentId }) => {
  const s = await loadIgState();
  const e = (s.unmatched ?? []).find((u) => u.mediaId === mediaId);
  if (!e) throw new IgRefusal(404, 'That Instagram post is not in the list any more.');
  const post = await ContentItem.findById(contentId).select('title platform status permalink igMediaId publishedDate').lean();
  if (!post) throw new IgRefusal(404, 'That post no longer exists.');
  if (post.platform !== 'instagram') throw new IgRefusal(409, `"${post.title}" is not an Instagram post.`);
  if (post.igMediaId && post.igMediaId !== mediaId) throw new IgRefusal(409, `"${post.title}" is already linked to another Instagram post.`);
  if (await ContentItem.exists({ igMediaId: mediaId, _id: { $ne: post._id } })) throw new IgRefusal(409, 'Another post is already linked to this Instagram post.');
  await ContentItem.updateOne({ _id: post._id }, { $set: linkSet(post, { ...e, id: e.mediaId }, new Date()) });
  await forget([mediaId]);
};

export const ignoreIgMedia = (mediaId) => MetaIgSync.updateOne({ key: 'ig' }, { $pull: { unmatched: { mediaId } }, $addToSet: { ignored: mediaId } });
export const restoreIgMedia = (mediaId) => MetaIgSync.updateOne({ key: 'ig' }, { $pull: { ignored: mediaId } });

// ── finding the accounts ─────────────────────────────────────────────────────

/** The Instagram business account of each known Facebook Page (to copy into META_IG_ACCOUNTS). */
export const findIgAccounts = async () => {
  const cfg = igConfig();
  if (!cfg.canFind) throw new MetaProblem(IG_NOT_CONFIGURED);
  const pages = await knownPageIds(cfg);
  const out = [];
  for (const pageId of pages.slice(0, 20)) {
    try {
      const p = await graphGet(cfg, pageId, { fields: 'name,instagram_business_account{id,username,followers_count}' }, cfg.token);
      const ig = p.instagram_business_account;
      out.push({ pageId, pageName: String(p.name ?? ''), igId: ig?.id ? String(ig.id) : '', username: String(ig?.username ?? ''), followers: Number(ig?.followers_count) || 0, problem: ig?.id ? '' : 'No Instagram business account is linked to this Page.' });
    } catch (e) {
      out.push({ pageId, pageName: '', igId: '', username: '', followers: 0, problem: e.problem ? withIgWords(e.problem).text : 'Meta refused the request.' });
    }
  }
  return { pages: pages.length, accounts: out };
};

// ── the automatic run ────────────────────────────────────────────────────────

export const igAutoSyncTick = async (now = new Date()) => {
  if (!igConfig().ready) return null;
  const s = await loadIgState();
  if (!s.autoSync || !igSyncDue(s.lastRun?.at, now)) return null;
  return runIgSync({ trigger: 'auto' });
};

let timer = null;
export const startMetaIgSync = () => {
  if (timer || !igConfig().ready) return;
  const tick = () => igAutoSyncTick().catch((err) => console.error('[Instagram sync] automatic run failed:', err?.message ?? err));
  setTimeout(tick, 90_000).unref?.();
  timer = setInterval(tick, 30 * 60 * 1000);
  timer.unref?.();
};
