// Writing Meta figures into the Campaigns hub — ONE place, used by the Meta Ads Manager file import (controllers/
// marketingCampaignHubController.js importMetrics, source 'csv') and by the live sync (services/metaAdsSync.js, source 'api'), so the two
// can never disagree about matching or replacing. The rows are the import's own shape (utils/marketingCampaignInput.js cleanImportInput).
//
//  • 'campaign' rows — a campaign's day: each campaign-day record is REPLACED (writing the same rows twice changes nothing).
//  • 'ad' rows — an AD's day: the ad is found by its Meta ad ID, else by its name in the campaign, else ADDED; its day is replaced (a row
//    with no ad ID whose name two of the campaign's ads carry is NOT written — another ad would count those days twice); then
//    (file import) the campaign's day becomes the sum of its ads' days. The live sync keeps Meta's own campaign day instead (reach does not
//    add up across ads), so it passes campaignDaysFromAds: false.
//  • 'breakdown' rows — an audience / placement segment's day: stored per campaign, day and segment; a campaign-day with no figure of its
//    own gets the segments' total (file import only).
// Campaigns are matched by Meta campaign ID, else exact title (utils/marketingCampaignInput.js matchImportGroups says when a title is not
// trusted); one that is not found is created only when asked (createMissing). A campaign that gets a Meta ID here takes the Meta Lead
// Ads leads that came before it (services/metaLeadTags.js).
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignDailyMetric from '../models/CampaignDailyMetric.js';
import CampaignAd from '../models/CampaignAd.js';
import CampaignAdDailyMetric from '../models/CampaignAdDailyMetric.js';
import CampaignBreakdownMetric from '../models/CampaignBreakdownMetric.js';
import MetaImportLog from '../models/MetaImportLog.js';
import { groupImportRows, matchImportGroups, adMatchOf } from '../utils/marketingCampaignInput.js';
import { tagMetaLeads } from './metaLeadTags.js';

const idOf = (v) => (v == null ? '' : String(v._id ?? v));
export const r2 = (n) => Math.round(n * 100) / 100;
const FIG = ['spend', 'reach', 'impressions', 'clicks', 'results'];
const figuresOnly = (d) => Object.fromEntries(FIG.map((k) => [k, k === 'spend' ? r2(d[k] ?? 0) : Math.round(d[k] ?? 0)]));
const sumDays = (g) => [...g.days.values()].reduce((t, d) => t + d.spend, 0);
const oid = (v) => new mongoose.Types.ObjectId(String(v));

const metaIdTaken = async (metaCampaignId, exceptId) => !!metaCampaignId && !!(await Campaign.exists({ metaCampaignId, ...(exceptId ? { _id: { $ne: exceptId } } : {}) }));

/**
 * After an ad-level write: each touched ad's own (lifetime) figures become the sum of all its days; with [campaignDays], each touched
 * campaign-day also becomes the sum of ALL its ads' stored days (so a file sent in several requests still adds up).
 */
const recomputeFromAds = async (pairs, adIds, actorId, importId, campaignDays) => {
  if (campaignDays && pairs.length) {
    const sums = await CampaignAdDailyMetric.aggregate([
      { $match: { $or: pairs.map((p) => ({ campaignId: oid(p.campaignId), day: p.day })) } },
      { $group: { _id: { campaignId: '$campaignId', day: '$day' }, spend: { $sum: '$spend' }, reach: { $sum: '$reach' }, impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, results: { $sum: '$results' } } },
    ]);
    if (sums.length) {
      await CampaignDailyMetric.bulkWrite(sums.map((x) => ({ updateOne: { filter: { campaignId: x._id.campaignId, day: x._id.day }, update: { $set: { ...figuresOnly(x), source: 'csv_ads', importId, updatedBy: actorId } }, upsert: true } })));
    }
  }
  if (adIds.length) {
    const life = await CampaignAdDailyMetric.aggregate([
      { $match: { adId: { $in: adIds.map(oid) } } },
      { $group: { _id: '$adId', spend: { $sum: '$spend' }, impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, results: { $sum: '$results' } } },
    ]);
    if (life.length) {
      await CampaignAd.bulkWrite(life.map((x) => ({ updateOne: { filter: { _id: x._id }, update: { $set: { spend: r2(x.spend), impressions: Math.round(x.impressions), clicks: Math.min(Math.round(x.clicks), Math.round(x.impressions)), results: Math.round(x.results), dailyFigures: true } } } })));
    }
  }
};

/**
 * After a breakdown write: a campaign-day that has NO figure yet (or only one summed from an earlier breakdown) becomes the sum of the
 * segments of the dimension just written — a day from a campaign or ad file, the sync or typed by hand is never overwritten by a breakdown.
 */
const fillDaysFromBreakdown = async (pairs, dimensionOfPair, actorId, importId) => {
  if (!pairs.length) return;
  const existing = await CampaignDailyMetric.find({ $or: pairs.map((p) => ({ campaignId: p.campaignId, day: p.day })) }).select('campaignId day source').lean();
  const keep = new Set(existing.filter((m) => m.source !== 'csv_breakdown').map((m) => `${idOf(m.campaignId)}|${m.day}`));
  const todo = pairs.filter((p) => !keep.has(`${idOf(p.campaignId)}|${p.day}`));
  if (!todo.length) return;
  const sums = await CampaignBreakdownMetric.aggregate([
    { $match: { $or: todo.map((p) => ({ campaignId: oid(p.campaignId), day: p.day, dimension: dimensionOfPair.get(`${idOf(p.campaignId)}|${p.day}`) })) } },
    { $group: { _id: { campaignId: '$campaignId', day: '$day' }, spend: { $sum: '$spend' }, reach: { $sum: '$reach' }, impressions: { $sum: '$impressions' }, clicks: { $sum: '$clicks' }, results: { $sum: '$results' } } },
  ]);
  if (sums.length) {
    await CampaignDailyMetric.bulkWrite(sums.map((x) => ({ updateOne: { filter: { campaignId: x._id.campaignId, day: x._id.day }, update: { $set: { ...figuresOnly(x), reach: Math.min(Math.round(x.reach), Math.round(x.impressions)), clicks: Math.min(Math.round(x.clicks), Math.round(x.impressions)), source: 'csv_breakdown', importId, updatedBy: actorId } }, upsert: true } })));
  }
};

/**
 * Write one batch of import rows. → the import's report: { dryRun, level, rows, skipped, skippedRows, matched, unmatched, created, written,
 * adsCreated, importId, from, to }.
 *  actor:    { _id, name } of who brought the figures in (null for the automatic sync)
 *  source:   'csv' (file import) | 'api' (live sync) — the history entry's source and the campaign-days' source
 *  log:      an open MetaImportLog document to add to (the sync keeps one per run); else importId (a file sent in several requests) or new
 *  campaignDaysFromAds / fillFromBreakdown: false for the live sync (Meta's own campaign day is the figure)
 *  stampMetaIds: a campaign matched by its TITLE that has no Meta ID yet takes this one (the live sync: the next sync, and Lead Ads
 *  leads, then find it by ID)
 */
export const writeImportRows = async ({
  level,
  rows,
  skipped = [],
  createMissing = false,
  brand = 'kerala',
  dryRun = false,
  fileName = '',
  importId = null,
  actor = null,
  source = 'csv',
  log = null,
  campaignDaysFromAds = true,
  fillFromBreakdown = true,
  stampMetaIds = false,
}) => {
  const actorId = actor?._id ?? null;
  const campaigns = await Campaign.find().select('title metaCampaignId').limit(2000).lean();
  const groups = groupImportRows(rows);
  const { matched, unmatched } = matchImportGroups(groups, campaigns);
  const report = {
    level,
    rows: rows.length,
    skipped: skipped.length,
    skippedRows: skipped.slice(0, 20),
    matched: matched.map(({ group, campaign }) => ({ name: group.name, metaId: group.metaId, campaignId: idOf(campaign), title: campaign.title, rows: group.rowCount, days: group.days.size, ads: group.ads.size, segments: group.segments.size, spend: r2(sumDays(group)) })),
    unmatched: unmatched.map(({ group, reason }) => ({ name: group.name, metaId: group.metaId, reason, rows: group.rowCount, days: group.days.size, ads: group.ads.size, segments: group.segments.size, spend: r2(sumDays(group)) })),
  };
  if (dryRun) return { dryRun: true, ...report, created: 0, written: 0, adsCreated: 0 };

  if (stampMetaIds) {
    for (const { group, campaign } of matched) {
      if (group.metaId && !campaign.metaCampaignId && !(await metaIdTaken(group.metaId, campaign._id))) {
        const r = await Campaign.updateOne({ _id: campaign._id, $or: [{ metaCampaignId: '' }, { metaCampaignId: null }, { metaCampaignId: { $exists: false } }] }, { $set: { metaCampaignId: group.metaId } });
        campaign.metaCampaignId = group.metaId;
        // the Meta leads of this campaign that came before it was known
        if (r.modifiedCount) await tagMetaLeads(group.metaId, campaign._id);
      }
    }
  }

  // campaigns to create: only when asked, and only ones with a name (an ID alone gives no title)
  const targets = matched.map((m) => ({ group: m.group, campaignId: m.campaign._id }));
  let created = 0;
  if (createMissing) {
    for (const u of unmatched) {
      if (u.reason !== 'no_match' || !u.group.name) continue;
      const taken = u.group.metaId && (await metaIdTaken(u.group.metaId));
      const c = await Campaign.create({ title: u.group.name, brand, platform: 'meta', channel: 'Meta', status: 'active', metaCampaignId: taken ? '' : u.group.metaId, createdBy: actorId });
      if (!taken && u.group.metaId) await tagMetaLeads(u.group.metaId, c._id);
      created += 1;
      targets.push({ group: u.group, campaignId: c._id });
    }
  }
  let first = null;
  let last = null;
  for (const t of targets) {
    for (const day of t.group.days.keys()) {
      if (!first || day < first) first = day;
      if (!last || day > last) last = day;
    }
  }
  let writes = level === 'ad' ? targets.reduce((n, t) => n + [...t.group.ads.values()].reduce((m, a) => m + a.days.size, 0), 0) : level === 'breakdown' ? targets.reduce((n, t) => n + t.group.segments.size, 0) : targets.reduce((n, t) => n + t.group.days.size, 0);
  const stillUnmatched = unmatched.filter((u) => !(createMissing && u.reason === 'no_match' && u.group.name));
  const unmatchedList = stillUnmatched.map((u) => ({ name: u.group.name, metaId: u.group.metaId, reason: u.reason, rows: u.group.rowCount, days: u.group.days.size, spend: r2(sumDays(u.group)), from: [...u.group.days.keys()].sort()[0] ?? '', to: [...u.group.days.keys()].sort().at(-1) ?? '' }));
  const matchedRows = targets.reduce((n, t) => n + t.group.rowCount, 0);
  const unmatchedRows = stillUnmatched.reduce((n, u) => n + u.group.rowCount, 0);
  const unmatchedNames = stillUnmatched.map((u) => u.group.name || u.group.metaId);
  let adsCreated = 0;
  const adsSkipped = []; // [{ campaign, ad }] rows not written: the ad's name is shared and the file has no ad ID to tell them apart
  if (writes) {
    if (!log) {
      // the importer may send a big file in several requests: they share one log entry
      const existing = importId ? await MetaImportLog.findOne({ _id: importId, by: actorId, source }) : null;
      log = existing ?? (await MetaImportLog.create({ source, level, fileName, by: actorId, byName: actor?.name ?? '', rows: 0, matched: 0, unmatched: 0, unmatchedNames: [], created: 0, written: 0, skipped: 0, from: first, to: last }));
    }
    const stamp = { importId: log._id, updatedBy: actorId };
    if (level === 'campaign') {
      // one record per campaign per day: a day already there is REPLACED, so writing the same rows twice changes nothing
      const days = targets.flatMap((t) => [...t.group.days].map(([day, d]) => ({ campaignId: t.campaignId, day, figures: d })));
      await CampaignDailyMetric.bulkWrite(days.map((d) => ({ updateOne: { filter: { campaignId: d.campaignId, day: d.day }, update: { $set: { ...figuresOnly(d.figures), source, ...stamp } }, upsert: true } })));
    } else if (level === 'ad') {
      const pairs = new Map();
      const touchedAds = [];
      const adDays = [];
      for (const t of targets) {
        const have = await CampaignAd.find({ campaignId: t.campaignId }).select('name metaAdId').lean();
        for (const fileAd of t.group.ads.values()) {
          const found = adMatchOf(fileAd, have);
          if (found.ambiguous) {
            adsSkipped.push({ campaign: t.group.name, ad: fileAd.name, days: fileAd.days.size, spend: r2([...fileAd.days.values()].reduce((s, d) => s + d.spend, 0)) });
            continue;
          }
          let ad = found.ad;
          if (!ad) {
            ad = (await CampaignAd.create({ campaignId: t.campaignId, name: fileAd.name || `Ad ${fileAd.metaId}`, adSetName: fileAd.adSetName, metaAdId: fileAd.metaId, metaAdSetId: fileAd.adSetId, format: 'other', status: 'active', dailyFigures: true, createdBy: actorId })).toObject();
            have.push(ad);
            adsCreated += 1;
          } else {
            const set = { dailyFigures: true };
            if (fileAd.metaId && !ad.metaAdId) set.metaAdId = fileAd.metaId;
            if (fileAd.adSetId) set.metaAdSetId = fileAd.adSetId;
            if (fileAd.adSetName) set.adSetName = fileAd.adSetName;
            await CampaignAd.updateOne({ _id: ad._id }, { $set: set });
          }
          touchedAds.push(ad._id);
          for (const [day, d] of fileAd.days) {
            adDays.push({ adId: ad._id, campaignId: t.campaignId, day, figures: d });
            pairs.set(`${idOf(t.campaignId)}|${day}`, { campaignId: t.campaignId, day });
          }
        }
      }
      writes -= adsSkipped.reduce((n, s) => n + s.days, 0); // what was not written is not counted
      if (adDays.length) await CampaignAdDailyMetric.bulkWrite(adDays.map((d) => ({ updateOne: { filter: { adId: d.adId, day: d.day }, update: { $set: { campaignId: d.campaignId, ...figuresOnly(d.figures), ...stamp } }, upsert: true } })));
      await recomputeFromAds([...pairs.values()], touchedAds, actorId, log._id, campaignDaysFromAds);
    } else {
      const pairs = new Map();
      const dimOf = new Map();
      const segs = [];
      for (const t of targets) {
        for (const sg of t.group.segments.values()) {
          segs.push({ campaignId: t.campaignId, ...sg });
          const k = `${idOf(t.campaignId)}|${sg.day}`;
          pairs.set(k, { campaignId: t.campaignId, day: sg.day });
          // one dimension per campaign-day for its total (the first the rows give)
          if (!dimOf.has(k)) dimOf.set(k, sg.dimension);
        }
      }
      await CampaignBreakdownMetric.bulkWrite(segs.map((x) => ({ updateOne: { filter: { campaignId: x.campaignId, day: x.day, dimension: x.dimension, age: x.age, gender: x.gender, placement: x.placement }, update: { $set: { ...figuresOnly(x), ...stamp } }, upsert: true } })));
      if (fillFromBreakdown) await fillDaysFromBreakdown([...pairs.values()], dimOf, actorId, log._id);
    }
    log.rows += rows.length;
    log.matched += matchedRows;
    log.unmatched += unmatchedRows;
    log.unmatchedNames = [...new Set([...log.unmatchedNames, ...unmatchedNames])].slice(0, 50);
    log.created += created;
    log.written += writes;
    log.adsCreated = (log.adsCreated ?? 0) + adsCreated;
    log.skipped += skipped.length;
    log.from = !log.from || (first && first < log.from) ? first : log.from;
    log.to = !log.to || (last && last > log.to) ? last : log.to;
    await log.save();
  }
  return { dryRun: false, ...report, unmatched: unmatchedList, created, written: writes, adsCreated, adsSkipped, importId: log ? idOf(log) : null, from: first, to: last };
};
