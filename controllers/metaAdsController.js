import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import MetaAdsSync from '../models/MetaAdsSync.js';
import MetaImportLog from '../models/MetaImportLog.js';
import { isManagerOrAdmin } from './marketingEodController.js';
import { META_SYNC_DAYS_BACK, META_SYNC_EVERY_HOURS, META_SYNC_MAX_DAYS, adsConfig, istToday, syncRange } from '../utils/metaAds.js';
import { MetaProblem } from '../services/metaGraph.js';
import { LinkRefusal, addMetaCampaigns, ignoreMetaCampaign, linkMetaCampaign, loadAdsState, restoreMetaCampaign, runAdsSync } from '../services/metaAdsSync.js';

// /api/meta/ads — the live Meta ad spend sync (behind login + the Marketing gate in routes/metaLeadRoutes.js). Anyone on the Marketing
// team can sync and link campaigns (they already add and change campaigns); switching the automatic sync is the Marketing Manager's /
// admin's. The secrets are never sent: only whether each one is set, and the ad accounts' ids and brands.

const isMetaId = (v) => /^\d{1,30}$/.test(String(v ?? ''));
const STALE_MS = 30 * 60 * 1000;

const runView = (r) =>
  r?.at
    ? {
        at: r.at,
        doneAt: r.doneAt ?? null,
        trigger: r.trigger || '',
        byName: r.byName || '',
        from: r.from || '',
        to: r.to || '',
        ok: !!r.ok,
        problemCode: r.problemCode || '',
        problem: r.problem || '',
        accounts: r.accounts ?? 0,
        campaigns: r.campaigns ?? 0,
        campaignDays: r.campaignDays ?? 0,
        adDays: r.adDays ?? 0,
        segments: r.segments ?? 0,
        adsCreated: r.adsCreated ?? 0,
        spend: r.spend ?? 0,
        unlinkedSpend: r.unlinkedSpend ?? 0,
      }
    : null;

// @route GET /api/meta/ads/status
export const getAdsStatus = async (req, res) => {
  const cfg = adsConfig();
  const s = await loadAdsState();
  const running = !!s.running && !!s.runningSince && Date.now() - new Date(s.runningSince) < STALE_MS;
  const [history, choices] = await Promise.all([
    MetaImportLog.find({ source: 'api' }).sort({ createdAt: -1 }).limit(5).lean(),
    Campaign.find({ $or: [{ metaCampaignId: '' }, { metaCampaignId: null }, { metaCampaignId: { $exists: false } }] }).select('title brand').sort({ createdAt: -1 }).limit(500).lean(),
  ]);
  const lastAt = s.lastRun?.at ? new Date(s.lastRun.at) : null;
  res.json({
    config: { appSecret: cfg.has.appSecret, token: cfg.has.token, accounts: cfg.accounts, ready: cfg.ready, version: cfg.version },
    settings: { autoSync: s.autoSync !== false, everyHours: META_SYNC_EVERY_HOURS, daysBack: META_SYNC_DAYS_BACK, maxDays: META_SYNC_MAX_DAYS, updatedByName: s.updatedByName || '' },
    canManage: isManagerOrAdmin(req.user),
    running,
    lastRun: runView(s.lastRun),
    lastOkAt: s.lastOkAt ?? null,
    nextAutoAt: cfg.ready && s.autoSync !== false ? new Date((lastAt ?? new Date()).getTime() + META_SYNC_EVERY_HOURS * 3600 * 1000) : null,
    unlinked: (s.unlinked ?? []).map((u) => ({ metaId: u.metaId, name: u.name, accountId: u.accountId, brand: u.brand, reason: u.reason, firstDay: u.firstDay, lastDay: u.lastDay, spend: u.spend, runFrom: u.runFrom, runTo: u.runTo })),
    ignored: s.ignored ?? [],
    campaignChoices: choices.map((c) => ({ id: String(c._id), title: c.title, brand: c.brand || '' })),
    history: history.map((l) => ({ id: String(l._id), at: l.createdAt, byName: l.byName || '', from: l.from || '', to: l.to || '', written: l.written ?? 0, created: l.created ?? 0, adsCreated: l.adsCreated ?? 0 })),
  });
};

const notSetUp = (res) => res.status(409).json({ message: 'The ad spend sync is not set up on the server yet (META_APP_SECRET, META_ACCESS_TOKEN and META_AD_ACCOUNTS).', code: 'not_configured' });

// @route POST /api/meta/ads/sync {days} | {from, to} — bring the days in now.
export const syncNow = async (req, res) => {
  if (!adsConfig().ready) return notSetUp(res);
  const range = syncRange(req.body ?? {}, istToday());
  if (range.error) return res.status(400).json({ message: range.error });
  try {
    const run = await runAdsSync({ range, trigger: 'manual', actor: req.user });
    if (run.busy) return res.status(409).json({ message: 'A sync is already running. Try again in a minute.', code: 'busy' });
    res.json({ run: runView(run) });
  } catch (err) {
    if (err instanceof MetaProblem) return res.status(409).json({ message: err.problem.text, code: err.problem.code });
    throw err;
  }
};

// @route PUT /api/meta/ads/settings {autoSync}
export const updateAdsSettings = async (req, res) => {
  if (!isManagerOrAdmin(req.user)) return res.status(403).json({ message: 'Only the Marketing Manager or Admin can switch the automatic sync.' });
  if (typeof req.body?.autoSync !== 'boolean') return res.status(400).json({ message: 'Say whether the sync runs on its own.' });
  await loadAdsState();
  await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { autoSync: req.body.autoSync, updatedBy: req.user._id, updatedByName: req.user.name || '' } });
  return getAdsStatus(req, res);
};

const linkResult = (res, out) => res.json({ linked: out.linked, leadsTagged: out.leadsTagged, run: out.run?.busy ? { busy: true } : runView(out.run) });

const refused = (res, err) => {
  if (err instanceof LinkRefusal) return res.status(err.status).json({ message: err.message });
  throw err;
};

// @route POST /api/meta/ads/unlinked/:metaId/link {campaignId} — this Meta campaign IS that CRM campaign.
export const linkCampaign = async (req, res) => {
  if (!isMetaId(req.params.metaId)) return res.status(404).json({ message: 'No such Meta campaign.' });
  if (!mongoose.isValidObjectId(String(req.body?.campaignId ?? ''))) return res.status(400).json({ message: 'Choose the campaign it belongs to.' });
  try {
    return linkResult(res, await linkMetaCampaign({ metaId: req.params.metaId, campaignId: req.body.campaignId, actor: req.user }));
  } catch (err) {
    return refused(res, err);
  }
};

// @route POST /api/meta/ads/unlinked/:metaId/add — add it as a new CRM campaign.
export const addCampaign = async (req, res) => {
  if (!isMetaId(req.params.metaId)) return res.status(404).json({ message: 'No such Meta campaign.' });
  try {
    return linkResult(res, await addMetaCampaigns({ metaIds: [req.params.metaId], actor: req.user }));
  } catch (err) {
    return refused(res, err);
  }
};

// @route POST /api/meta/ads/unlinked/add-all — add every listed Meta campaign as a new CRM campaign.
export const addAllCampaigns = async (req, res) => {
  const s = await loadAdsState();
  const ids = (s.unlinked ?? []).map((u) => u.metaId);
  if (!ids.length) return res.status(409).json({ message: 'There is no Meta campaign to add.' });
  try {
    return linkResult(res, await addMetaCampaigns({ metaIds: ids, actor: req.user }));
  } catch (err) {
    return refused(res, err);
  }
};

// @route POST /api/meta/ads/unlinked/:metaId/ignore — stop listing it (a test campaign). Its spend stays out.
export const ignoreCampaign = async (req, res) => {
  if (!isMetaId(req.params.metaId)) return res.status(404).json({ message: 'No such Meta campaign.' });
  await loadAdsState();
  await ignoreMetaCampaign(req.params.metaId);
  return getAdsStatus(req, res);
};

// @route POST /api/meta/ads/ignored/:metaId/restore — list it again (from the next sync that sees it).
export const restoreCampaign = async (req, res) => {
  if (!isMetaId(req.params.metaId)) return res.status(404).json({ message: 'No such Meta campaign.' });
  await loadAdsState();
  await restoreMetaCampaign(req.params.metaId);
  return getAdsStatus(req, res);
};
