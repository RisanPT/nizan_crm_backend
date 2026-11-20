import mongoose from 'mongoose';
import ContentItem from '../models/ContentItem.js';
import MetaIgSync from '../models/MetaIgSync.js';
import SocialAccount from '../models/SocialAccount.js';
import { isManagerOrAdmin } from './marketingEodController.js';
import { IG_SYNC_DAYS, IG_SYNC_EVERY_HOURS, IG_SYNC_MAX_DAYS, igConfig, igDays } from '../utils/metaIg.js';
import { MetaProblem } from '../services/metaGraph.js';
import { IgRefusal, addIgMedia, findIgAccounts, ignoreIgMedia, linkIgMedia, loadIgState, restoreIgMedia, runIgSync } from '../services/metaIgSync.js';

// /api/meta/ig — the Instagram insights sync (behind login + the Marketing gate in routes/metaLeadRoutes.js). Anyone on the Marketing
// team can sync and add or link posts (they already edit posts); switching the automatic sync is the Marketing Manager's / admin's. The
// token is never sent: only whether each setting is set, and the accounts' ids, brands and (once synced) names and followers.

const isMediaId = (v) => /^\d{1,30}$/.test(String(v ?? ''));
const STALE_MS = 30 * 60 * 1000;

const runView = (r) =>
  r?.at
    ? { at: r.at, doneAt: r.doneAt ?? null, trigger: r.trigger || '', byName: r.byName || '', days: r.days ?? 0, ok: !!r.ok, problemCode: r.problemCode || '', problem: r.problem || '', accounts: r.accounts ?? 0, media: r.media ?? 0, updated: r.updated ?? 0, linked: r.linked ?? 0, unmatched: r.unmatched ?? 0, gaps: r.gaps ?? 0 }
    : null;

// @route GET /api/meta/ig/status
export const getIgStatus = async (req, res) => {
  const cfg = igConfig();
  const s = await loadIgState();
  const now = Date.now();
  const [accounts, synced, choices] = await Promise.all([
    cfg.accounts.length ? SocialAccount.find({ igUserId: { $in: cfg.accounts.map((a) => a.id) } }).select('igUserId handle followers syncedAt').lean() : [],
    ContentItem.countDocuments({ metricsSource: 'instagram' }),
    ContentItem.find({
      platform: 'instagram',
      status: { $ne: 'cancelled' },
      $or: [{ igMediaId: '' }, { igMediaId: null }, { igMediaId: { $exists: false } }],
      scheduledDate: { $gte: new Date(now - IG_SYNC_MAX_DAYS * 864e5), $lte: new Date(now + 7 * 864e5) },
    })
      .select('title brand contentType status scheduledDate')
      .sort({ scheduledDate: -1 })
      .limit(300)
      .lean(),
  ]);
  const byId = new Map(accounts.map((a) => [a.igUserId, a]));
  const lastAt = s.lastRun?.at ? new Date(s.lastRun.at) : null;
  res.json({
    config: {
      appSecret: cfg.has.appSecret,
      token: cfg.has.token,
      accounts: cfg.accounts.map((a) => ({ id: a.id, brand: a.brand, username: byId.get(a.id)?.handle ?? '', followers: byId.get(a.id)?.followers ?? null, syncedAt: byId.get(a.id)?.syncedAt ?? null })),
      ready: cfg.ready,
      canFind: cfg.canFind,
      version: cfg.version,
    },
    settings: { autoSync: s.autoSync !== false, everyHours: IG_SYNC_EVERY_HOURS, days: IG_SYNC_DAYS, maxDays: IG_SYNC_MAX_DAYS, updatedByName: s.updatedByName || '' },
    canManage: isManagerOrAdmin(req.user),
    running: !!s.running && !!s.runningSince && now - new Date(s.runningSince) < STALE_MS,
    lastRun: runView(s.lastRun),
    lastOkAt: s.lastOkAt ?? null,
    nextAutoAt: cfg.ready && s.autoSync !== false ? new Date((lastAt ?? new Date()).getTime() + IG_SYNC_EVERY_HOURS * 3600 * 1000) : null,
    syncedPosts: synced,
    unmatched: (s.unmatched ?? []).map((u) => ({ mediaId: u.mediaId, username: u.username, brand: u.brand, contentType: u.contentType, caption: String(u.caption ?? '').slice(0, 300), permalink: u.permalink, at: u.at, metrics: u.metrics })),
    ignored: s.ignored ?? [],
    postChoices: choices.map((p) => ({ id: String(p._id), title: p.title, brand: p.brand, contentType: p.contentType, status: p.status, scheduledDate: p.scheduledDate })),
  });
};

const notSetUp = (res) => res.status(409).json({ message: 'The Instagram sync is not set up on the server yet (META_APP_SECRET, META_ACCESS_TOKEN and META_IG_ACCOUNTS).', code: 'not_configured' });

// @route POST /api/meta/ig/sync {days}
export const igSyncNow = async (req, res) => {
  if (!igConfig().ready) return notSetUp(res);
  const days = igDays(req.body?.days);
  if (days == null) return res.status(400).json({ message: `Choose 1 to ${IG_SYNC_MAX_DAYS} days.` });
  try {
    const run = await runIgSync({ days, trigger: 'manual', actor: req.user });
    if (run.busy) return res.status(409).json({ message: 'A sync is already running. Try again in a minute.', code: 'busy' });
    res.json({ run: runView(run) });
  } catch (err) {
    if (err instanceof MetaProblem) return res.status(409).json({ message: err.problem.text, code: err.problem.code });
    throw err;
  }
};

// @route PUT /api/meta/ig/settings {autoSync}
export const updateIgSettings = async (req, res) => {
  if (!isManagerOrAdmin(req.user)) return res.status(403).json({ message: 'Only the Marketing Manager or Admin can switch the automatic sync.' });
  if (typeof req.body?.autoSync !== 'boolean') return res.status(400).json({ message: 'Say whether the sync runs on its own.' });
  await loadIgState();
  await MetaIgSync.updateOne({ key: 'ig' }, { $set: { autoSync: req.body.autoSync, updatedBy: req.user._id, updatedByName: req.user.name || '' } });
  return getIgStatus(req, res);
};

// @route POST /api/meta/ig/find — the Instagram account of each known Facebook Page.
export const findAccounts = async (_req, res) => {
  try {
    res.json(await findIgAccounts());
  } catch (err) {
    if (err instanceof MetaProblem) return res.status(409).json({ message: err.problem.text, code: err.problem.code });
    throw err;
  }
};

const refused = (res, err) => {
  if (err instanceof IgRefusal) return res.status(err.status).json({ message: err.message });
  throw err;
};

// @route POST /api/meta/ig/unmatched/:mediaId/add
export const addPost = async (req, res) => {
  if (!isMediaId(req.params.mediaId)) return res.status(404).json({ message: 'No such Instagram post.' });
  try {
    const added = await addIgMedia({ mediaIds: [req.params.mediaId], actor: req.user });
    res.json({ added });
  } catch (err) {
    return refused(res, err);
  }
};

// @route POST /api/meta/ig/unmatched/add-all
export const addAllPosts = async (req, res) => {
  const s = await loadIgState();
  const ids = (s.unmatched ?? []).map((u) => u.mediaId);
  if (!ids.length) return res.status(409).json({ message: 'There is no Instagram post to add.' });
  try {
    res.json({ added: await addIgMedia({ mediaIds: ids, actor: req.user }) });
  } catch (err) {
    return refused(res, err);
  }
};

// @route POST /api/meta/ig/unmatched/:mediaId/link {contentId}
export const linkPost = async (req, res) => {
  if (!isMediaId(req.params.mediaId)) return res.status(404).json({ message: 'No such Instagram post.' });
  if (!mongoose.isValidObjectId(String(req.body?.contentId ?? ''))) return res.status(400).json({ message: 'Choose the post it is.' });
  try {
    await linkIgMedia({ mediaId: req.params.mediaId, contentId: req.body.contentId });
    res.json({ linked: true });
  } catch (err) {
    return refused(res, err);
  }
};

// @route POST /api/meta/ig/unmatched/:mediaId/ignore
export const ignorePost = async (req, res) => {
  if (!isMediaId(req.params.mediaId)) return res.status(404).json({ message: 'No such Instagram post.' });
  await loadIgState();
  await ignoreIgMedia(req.params.mediaId);
  return getIgStatus(req, res);
};

// @route POST /api/meta/ig/ignored/:mediaId/restore
export const restorePost = async (req, res) => {
  if (!isMediaId(req.params.mediaId)) return res.status(404).json({ message: 'No such Instagram post.' });
  await loadIgState();
  await restoreIgMedia(req.params.mediaId);
  return getIgStatus(req, res);
};
