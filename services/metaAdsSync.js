// The live Meta ad spend sync: Insights API → the Campaigns hub's daily figures. The rules are in utils/metaAds.js; the writing is the
// file import's own (services/campaignMetricsImport.js, source 'api').
//
//  • runAdsSync: one run at a time (across processes, MetaAdsSync.running). It READS every account and level first — a run that fails
//    half-way writes nothing — then writes campaign days (Meta's own figure; a campaign found by its title takes Meta's id), ad days and
//    audience segments. Re-running the same days replaces them, so nothing is counted twice. Meta campaigns no CRM campaign matches are
//    listed (unlinked) and their spend is not counted until someone links or adds them.
//  • startMetaAdsSync: when the server is set up, every 30 minutes it checks whether an automatic run is due (6 hours since the last
//    run) and brings in the last 3 days again.
// Nothing here returns or logs the token.
import Campaign from '../models/Campaign.js';
import Lead from '../models/Lead.js';
import MetaImportLog from '../models/MetaImportLog.js';
import MetaAdsSync from '../models/MetaAdsSync.js';
import MetaLeadEvent from '../models/MetaLeadEvent.js';
import { MetaProblem, graphList } from './metaGraph.js';
import { r2, writeImportRows } from './campaignMetricsImport.js';
import { cleanImportInput } from '../utils/marketingCampaignInput.js';
import {
  ADS_NOT_CONFIGURED,
  INSIGHT_BREAKDOWNS,
  INSIGHT_FIELDS,
  META_SYNC_DAYS_BACK,
  META_SYNC_MAX_DAYS,
  addDays,
  adsConfig,
  autoSyncDue,
  batches,
  chunkRange,
  importRowOf,
  istToday,
  mergeUnlinked,
  syncRange,
} from '../utils/metaAds.js';

const RUN_STALE_MS = 30 * 60 * 1000;
const INSIGHTS_TIMEOUT_MS = 60_000;
const SAVE_FAILED = { code: 'save_failed', retry: true, text: 'The figures could not be saved in the CRM. Try again.' };

export const loadAdsState = () =>
  MetaAdsSync.findOneAndUpdate({ key: 'ads' }, { $setOnInsert: { key: 'ads' } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean();

/** Take the one running slot (or a slot whose run died over 30 minutes ago). → the state, or null when a run is going. */
const claim = async () => {
  await loadAdsState();
  const now = new Date();
  return MetaAdsSync.findOneAndUpdate(
    { key: 'ads', $or: [{ running: false }, { runningSince: null }, { runningSince: { $lt: new Date(now.getTime() - RUN_STALE_MS) } }] },
    { $set: { running: true, runningSince: now } },
    { new: true },
  ).lean();
};

const readInsights = (cfg, account, level, w, breakdowns = '') =>
  graphList(
    cfg,
    `${account.id}/insights`,
    {
      level: level === 'ad' ? 'ad' : 'campaign',
      time_increment: 1,
      time_range: JSON.stringify({ since: w.since, until: w.until }),
      fields: INSIGHT_FIELDS[level],
      limit: 500,
      ...(breakdowns ? { breakdowns } : {}),
    },
    cfg.token,
    { timeoutMs: INSIGHTS_TIMEOUT_MS, maxPages: 100 },
  );

/** One level's rows through the import's writer, in batches of 500. */
const writeLevel = async (level, rows, { log, actor, today }, opts) => {
  const total = { written: 0, adsCreated: 0, unmatched: [], spend: 0, campaigns: new Set() };
  for (const batch of batches(rows)) {
    const v = cleanImportInput({ level, rows: batch }, { today });
    if (!v.ok) continue;
    const r = await writeImportRows({ ...v.value, actor, source: 'api', log, ...opts });
    total.written += r.written;
    total.adsCreated += r.adsCreated;
    total.unmatched.push(...r.unmatched);
    for (const m of r.matched) {
      total.spend += m.spend;
      total.campaigns.add(m.campaignId);
    }
  }
  return total;
};

/** The same Meta campaign seen in several batches → one entry: spend added, earliest and latest day. */
const combineUnmatched = (list) => {
  const by = new Map();
  for (const u of list) {
    const key = u.metaId || `name:${u.name}`;
    const was = by.get(key);
    by.set(key, was ? { ...was, spend: r2(was.spend + u.spend), from: [was.from, u.from].filter(Boolean).sort()[0], to: [was.to, u.to].filter(Boolean).sort().at(-1) } : { ...u });
  }
  return [...by.values()].filter((u) => u.metaId);
};

/**
 * Bring in [range] ({ from, to }; default the last 3 days). → the run's summary (lastRun), or { busy: true } when a run is going.
 * Throws a MetaProblem only when the server is not set up; any other failure is returned as lastRun.ok = false with its reason.
 */
export const runAdsSync = async ({ range = null, trigger = 'manual', actor = null } = {}) => {
  const cfg = adsConfig();
  if (!cfg.ready) throw new MetaProblem(ADS_NOT_CONFIGURED);
  const today = istToday();
  const { from, to } = range ?? syncRange({ days: META_SYNC_DAYS_BACK }, today);
  const state = await claim();
  if (!state) return { busy: true };
  const lastRun = {
    at: new Date(),
    doneAt: null,
    trigger,
    byName: actor?.name ?? (trigger === 'auto' ? 'Automatic sync' : ''),
    from,
    to,
    ok: false,
    problemCode: '',
    problem: '',
    accounts: cfg.accounts.length,
    campaigns: 0,
    campaignDays: 0,
    adDays: 0,
    segments: 0,
    adsCreated: 0,
    spend: 0,
    unlinkedSpend: 0,
    importId: null,
  };
  let log = null;
  try {
    // 1. read everything (nothing is written if Meta refuses any of it)
    const read = { campaign: [], ad: [], breakdown: [] };
    const accountOf = new Map(); // Meta campaign id → its ad account
    for (const account of cfg.accounts) {
      for (const w of chunkRange(from, to)) {
        const campaignRows = await readInsights(cfg, account, 'campaign', w);
        const objectiveOf = new Map(campaignRows.map((r) => [String(r.campaign_id ?? ''), String(r.objective ?? '')]));
        for (const r of campaignRows) {
          const row = importRowOf('campaign', r);
          if (!row) continue;
          read.campaign.push(row);
          accountOf.set(row.campaignId, account);
        }
        for (const r of await readInsights(cfg, account, 'ad', w)) {
          const row = importRowOf('ad', r, objectiveOf);
          if (row) read.ad.push(row);
        }
        for (const b of INSIGHT_BREAKDOWNS) {
          for (const r of await readInsights(cfg, account, 'breakdown', w, b)) {
            const row = importRowOf('breakdown', r, objectiveOf);
            if (row) read.breakdown.push(row);
          }
        }
      }
    }
    const ignored = new Set(state.ignored ?? []);
    for (const k of Object.keys(read)) read[k] = read[k].filter((r) => !ignored.has(r.campaignId));

    // 2. write, as one history entry
    log = await MetaImportLog.create({ source: 'api', level: 'campaign', fileName: `Meta sync ${from} to ${to}`, by: actor?._id ?? null, byName: lastRun.byName, from, to });
    const ctx = { log, actor, today };
    const c = await writeLevel('campaign', read.campaign, ctx, { stampMetaIds: true });
    const a = await writeLevel('ad', read.ad, ctx, { campaignDaysFromAds: false });
    const b = await writeLevel('breakdown', read.breakdown, ctx, { fillFromBreakdown: false });

    // 3. Meta campaigns that match no CRM campaign
    const seen = combineUnmatched(c.unmatched).map((u) => ({ ...u, accountId: accountOf.get(u.metaId)?.id ?? '', brand: accountOf.get(u.metaId)?.brand ?? 'kerala', runFrom: from, runTo: to }));
    const fresh = await MetaAdsSync.findOne({ key: 'ads' }).select('unlinked ignored').lean();
    const kept = fresh?.unlinked ?? [];
    const linkedNow = (await Campaign.find({ metaCampaignId: { $in: [...kept.map((u) => u.metaId), ...seen.map((u) => u.metaId)] } }).select('metaCampaignId').lean()).map((x) => x.metaCampaignId);
    const unlinked = mergeUnlinked(kept, seen, { ignored: fresh?.ignored ?? [], linked: linkedNow });

    Object.assign(lastRun, {
      ok: true,
      doneAt: new Date(),
      campaigns: c.campaigns.size,
      campaignDays: c.written,
      adDays: a.written,
      segments: b.written,
      adsCreated: a.adsCreated,
      spend: r2(c.spend),
      unlinkedSpend: r2(seen.reduce((t, u) => t + u.spend, 0)),
      importId: log._id,
    });
    await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { lastRun, lastOkAt: lastRun.doneAt, unlinked, running: false, runningSince: null } });
    return lastRun;
  } catch (err) {
    let p = err instanceof MetaProblem ? err.problem : SAVE_FAILED;
    // Lead Ads' wording names a lead's rights; here it is the ad accounts'
    if (p.code === 'permission') p = { ...p, text: 'The token may not read the ad accounts. Give the system user the ad accounts and the ads_read permission (and finish App Review).' };
    if (!(err instanceof MetaProblem)) console.error('[Meta sync] failed:', err?.message ?? err);
    Object.assign(lastRun, { ok: false, doneAt: new Date(), problemCode: p.code, problem: p.text });
    if (log && !(log.written > 0)) await MetaImportLog.deleteOne({ _id: log._id }).catch(() => {});
    await MetaAdsSync.updateOne({ key: 'ads' }, { $set: { lastRun, running: false, runningSince: null } });
    return lastRun;
  }
};

// ── linking a Meta campaign ──────────────────────────────────────────────────

/** Meta leads that came from this Meta campaign take the CRM campaign (only those with none yet). → how many leads were tagged */
const tagLeads = async (metaId, campaignId) => {
  await MetaLeadEvent.updateMany({ metaCampaignId: metaId }, { $set: { campaignId } });
  const ids = (await MetaLeadEvent.find({ metaCampaignId: metaId, leadId: { $ne: null }, status: 'created' }).select('leadId').lean()).map((e) => e.leadId);
  if (!ids.length) return 0;
  const r = await Lead.updateMany({ _id: { $in: ids }, campaignId: null }, { $set: { campaignId } });
  return r.modifiedCount ?? 0;
};

/** The days to bring in once a Meta campaign is linked: from the first day it was seen (at most 92 days back) to today. */
const rangeFor = (entries, today = istToday()) => {
  const first = entries.map((e) => e.firstDay).filter(Boolean).sort()[0];
  const earliest = addDays(today, -(META_SYNC_MAX_DAYS - 1));
  const from = !first ? addDays(today, -(META_SYNC_DAYS_BACK - 1)) : first < earliest ? earliest : first;
  return { from, to: today };
};

const forget = (metaIds) => MetaAdsSync.updateOne({ key: 'ads' }, { $pull: { unlinked: { metaId: { $in: metaIds } }, ignored: { $in: metaIds } } });

export class LinkRefusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Link a Meta campaign to an existing CRM campaign, then bring in its days. → { campaignId, leadsTagged, run } */
export const linkMetaCampaign = async ({ metaId, campaignId, actor }) => {
  const state = await loadAdsState();
  const entry = (state.unlinked ?? []).find((u) => u.metaId === metaId) ?? { metaId, firstDay: '' };
  const campaign = await Campaign.findById(campaignId).select('title metaCampaignId').lean();
  if (!campaign) throw new LinkRefusal(404, 'That campaign no longer exists.');
  if (campaign.metaCampaignId && campaign.metaCampaignId !== metaId) throw new LinkRefusal(409, `"${campaign.title}" is already linked to another Meta campaign.`);
  if (await Campaign.exists({ metaCampaignId: metaId, _id: { $ne: campaign._id } })) throw new LinkRefusal(409, 'Another campaign is already linked to this Meta campaign.');
  await Campaign.updateOne({ _id: campaign._id }, { $set: { metaCampaignId: metaId } });
  return afterLink([entry], [{ metaId, campaignId: campaign._id }], actor);
};

/** Add a Meta campaign as a new CRM campaign (its name, its account's brand), then bring in its days. */
export const addMetaCampaigns = async ({ metaIds, actor }) => {
  const state = await loadAdsState();
  const entries = (state.unlinked ?? []).filter((u) => metaIds.includes(u.metaId));
  if (!entries.length) throw new LinkRefusal(404, 'That Meta campaign is not in the list any more.');
  const made = [];
  for (const e of entries) {
    if (await Campaign.exists({ metaCampaignId: e.metaId })) continue;
    const c = await Campaign.create({ title: e.name || `Meta campaign ${e.metaId}`, brand: e.brand || 'kerala', platform: 'meta', channel: 'Meta', status: 'active', metaCampaignId: e.metaId, createdBy: actor?._id ?? null });
    made.push({ metaId: e.metaId, campaignId: c._id });
  }
  return afterLink(entries, made, actor);
};

const afterLink = async (entries, links, actor) => {
  let leadsTagged = 0;
  for (const l of links) leadsTagged += await tagLeads(l.metaId, l.campaignId);
  await forget(entries.map((e) => e.metaId));
  const run = adsConfig().ready ? await runAdsSync({ range: rangeFor(entries), trigger: 'link', actor }) : null;
  return { linked: links.map((l) => ({ metaId: l.metaId, campaignId: String(l.campaignId) })), leadsTagged, run };
};

/** Hide a Meta campaign from the list (a test campaign); restore brings it back with the next run that sees it. */
export const ignoreMetaCampaign = (metaId) =>
  MetaAdsSync.updateOne({ key: 'ads' }, { $pull: { unlinked: { metaId } }, $addToSet: { ignored: metaId } });
export const restoreMetaCampaign = (metaId) => MetaAdsSync.updateOne({ key: 'ads' }, { $pull: { ignored: metaId } });

// ── the automatic run ────────────────────────────────────────────────────────

/** Run now if the automatic sync is on and due. → the run, or null. */
export const autoSyncTick = async (now = new Date()) => {
  if (!adsConfig().ready) return null;
  const s = await loadAdsState();
  if (!s.autoSync || !autoSyncDue(s.lastRun?.at, now)) return null;
  return runAdsSync({ trigger: 'auto' });
};

let timer = null;
/** Called once at server start: when the sync is set up, check every 30 minutes (and a minute after start) whether a run is due. */
export const startMetaAdsSync = () => {
  if (timer || !adsConfig().ready) return;
  const tick = () => autoSyncTick().catch((err) => console.error('[Meta sync] automatic run failed:', err?.message ?? err));
  setTimeout(tick, 60_000).unref?.();
  timer = setInterval(tick, 30 * 60 * 1000);
  timer.unref?.();
};
