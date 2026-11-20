import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import ContentItem from '../models/ContentItem.js';
import MarketingAsset, { ASSET_STAGES } from '../models/MarketingAsset.js';
import SocialAccount from '../models/SocialAccount.js';
import MarketingShoot from '../models/MarketingShoot.js';
import SocialsTarget from '../models/SocialsTarget.js';
import MarketingActivity from '../models/MarketingActivity.js';
import MarketingTask from '../models/MarketingTask.js';
import { MarketingTeamMember, MarketingMetric, MarketingGroup } from '../models/MarketingEod.js';
import Lead from '../models/Lead.js';
import User from '../models/User.js';
import { toDateStr, isManagerOrAdmin, canViewTeam, findOwnMember } from './marketingEodController.js';
import { isDay } from '../utils/marketingActivityInput.js';
import { cleanAssetInput, cleanAccountInput, cleanTargetInput, assetFromShoot, approvedAtFor, isUsableAsset } from '../utils/marketingSocialsInput.js';
import * as S from '../utils/marketingSocialsStats.js';
import * as T from '../utils/marketingTeamStats.js';
import { withBrands } from '../services/marketingLeadReportData.js';
import { parseAssetSearch, assetClauses, combineClauses, rankAssets, termRegex } from '../utils/assetSearch.js';
import { cleanKeywords, keywordAsStored, normalizeKeyword, renameKeyword, applyKeywordChange, rankKeywordSuggestions, MAX_KEYWORDS } from '../utils/assetKeywords.js';

// The Socials module — Overview, Content Calendar, Content & Assets, Publishing & Accounts, Performance, Reports & Insights
// (the marketing team's document, "Socials Module — UX Screens 01 to 06"). Routes: routes/marketingSocialsRoutes.js, /api/marketing/socials.
//
// Nothing here is typed twice: posts are the Content records (planned on the calendar, moved through the pipeline, numbers typed on
// the post once it is out); the activity tracker counts what members LOGGED (Log Activity); leads are the CRM's leads. Every number is
// defined in utils/marketingSocialsStats.js.

const IST = 5.5 * 60 * 60 * 1000;
const istStart = (day) => new Date(Date.parse(`${day}T00:00:00Z`) - IST);
const istEnd = (day) => istStart(T.addDays(day, 1));
const idOf = (v) => (v == null ? '' : String(v._id ?? v));

const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

const weekOf = (day) => {
  const dow = new Date(Date.parse(`${day}T00:00:00Z`)).getUTCDay();
  const monday = T.addDays(day, -((dow + 6) % 7));
  return { from: monday, to: T.addDays(monday, 6) };
};

/** ?from=&to=&brand= (this week, all brands by default) → the checked range. */
const readRange = (req, res) => {
  const today = toDateStr();
  const dflt = weekOf(today);
  const from = req.query.from ?? dflt.from;
  const to = req.query.to ?? dflt.to;
  if (!isDay(from) || !isDay(to)) bad(res, 'The dates must be YYYY-MM-DD.');
  if (to < from) bad(res, 'The end date is before the start date.');
  if (T.daysBetween(from, to) > 366) bad(res, 'Choose a range of a year or less.');
  const brand = String(req.query.brand ?? 'all').toLowerCase();
  if (!['all', 'main', 'kerala'].includes(brand)) bad(res, 'Choose All, Main or Kerala.');
  return { from, to, brand, today };
};

/** An optional ?from=&to= (both, or neither) → the checked range, or null when none was asked for. */
const readOptionalRange = (req, res) => {
  const { from, to } = req.query;
  if (from === undefined && to === undefined) return null;
  if (!isDay(from) || !isDay(to)) bad(res, 'The dates must be YYYY-MM-DD.');
  if (to < from) bad(res, 'The end date is before the start date.');
  return { from, to };
};

const escapeRx = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The items that can matter for a range and the period before it: scheduled or published in the window. */
const loadItems = (range) => {
  const prev = T.previousRange(range);
  const a = istStart(prev.from);
  const z = istEnd(range.to);
  return ContentItem.find({ $or: [{ scheduledDate: { $gte: a, $lt: z } }, { publishedDate: { $gte: a, $lt: z } }] }).sort({ scheduledDate: 1 }).limit(5000).lean();
};

const shapeItem = (it) => ({
  id: idOf(it),
  title: it.title,
  platform: it.platform,
  contentType: it.contentType,
  status: it.status,
  brand: it.brand ?? 'main',
  scheduledDate: it.scheduledDate,
  publishedDate: it.publishedDate ?? null,
  thumbUrl: it.thumbUrl ?? '',
  permalink: it.permalink ?? '',
  assignedToName: it.assignedToName ?? '',
  caption: it.caption ?? '',
  campaign: it.campaign ?? '',
  metrics: it.metrics ?? {},
  // 'instagram' = the figures come from the Instagram sync (services/metaIgSync.js) and are replaced at each sync
  metricsSource: it.metricsSource ?? '',
  metricsSyncedAt: it.metricsSyncedAt ?? null,
  assetId: it.assetId ? idOf(it.assetId) : null,
  shootId: it.shootId ? idOf(it.shootId) : null,
});

// ── Overview ──────────────────────────────────────────────────────────────────

const socialsGroup = async () => {
  const groups = await MarketingGroup.find({ name: /social/i }).lean();
  const ids = groups.map(idOf);
  const metrics = ids.length ? await MarketingMetric.find({ isActive: true, groupId: { $in: ids } }).sort({ sortOrder: 1, code: 1 }).lean() : [];
  return { groups, ids, metrics: metrics.map((m) => ({ id: idOf(m), name: m.name })) };
};

/** What members logged for each Socials metric in the range (and brand): the tracker's "completed". */
const loggedByMetric = async (metricIds, { from, to, brand }) => {
  if (!metricIds.length) return new Map();
  const match = { entryDate: { $gte: from, $lte: to }, 'values.metricId': { $in: metricIds.map((id) => new mongoose.Types.ObjectId(id)) } };
  if (brand !== 'all') match.brand = brand;
  const rows = await MarketingActivity.aggregate([{ $match: match }, { $unwind: '$values' }, { $match: { 'values.metricId': { $in: metricIds.map((id) => new mongoose.Types.ObjectId(id)) } } }, { $group: { _id: '$values.metricId', total: { $sum: '$values.value' } } }]);
  return new Map(rows.map((r) => [idOf(r._id), r.total]));
};

const targetRows = (range) => SocialsTarget.find({ scope: 'socials', period: { $lte: range.to } }).lean();

export const getOverview = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const [items, soc, leadsRaw] = await Promise.all([
    loadItems(range),
    socialsGroup(),
    (() => {
      const prev = T.previousRange(range);
      const a = istStart(prev.from);
      const z = istEnd(range.to);
      return Lead.find({ source: /\b(instagram|ig)\b/i, $or: [{ leadDate: { $gte: a, $lt: z } }, { leadDate: null, createdAt: { $gte: a, $lt: z } }, { leadDate: { $exists: false }, createdAt: { $gte: a, $lt: z } }] }).select('source region district leadDate createdAt campaignId').lean().then(withBrands); // a campaign's lead under the campaign's brand, as on the Lead Report and the Campaigns hub
    })(),
  ]);

  const [logged, targets] = await Promise.all([loggedByMetric(soc.metrics.map((m) => m.id), range), targetRows(range)]);
  const tracker = S.trackerRows({
    metrics: soc.metrics,
    targets: new Map(soc.metrics.map((m) => [m.id, S.rangeTarget(targets, { brand: range.brand, from: range.from, to: range.to, metricId: m.id })]).filter(([, t]) => t !== null)),
    logged,
  });

  // the week in view for the calendar strip: the week that holds the end of the range
  const week = weekOf(range.to);
  const inWeek = items.filter((it) => S.stageOf(it.status) && (range.brand === 'all' || (it.brand ?? 'main') === range.brand) && S.countedDay(it) >= week.from && S.countedDay(it) <= week.to);
  const calendar = T.eachDay(week.from, week.to).map((day) => ({ day, items: inWeek.filter((it) => S.countedDay(it) === day).map(shapeItem) }));

  // today's logged work by member, for the Socials team (a log under a Socials group or of kind "post"). A manager (or management)
  // sees the whole team's; a member sees only their own — as everywhere logs are shown.
  const day = range.to < range.today ? range.to : range.today;
  const teamView = canViewTeam(req.user);
  const own = teamView ? null : await findOwnMember(req.user);
  const acts = teamView || own
    ? await MarketingActivity.find({ entryDate: day, ...(teamView ? {} : { memberId: own._id }), ...(range.brand === 'all' ? {} : { brand: range.brand }), $or: [{ kind: 'post' }, ...(soc.ids.length ? [{ groupId: { $in: soc.ids } }] : [])] }).sort({ loggedAt: 1 }).lean()
    : [];
  const members = acts.length ? await MarketingTeamMember.find({ _id: { $in: [...new Set(acts.map((a) => idOf(a.memberId)))] } }).select('name shortName').lean() : [];
  const nameOf = new Map(members.map((m) => [idOf(m), m.name]));
  const byMember = new Map();
  for (const a of acts) {
    const k = idOf(a.memberId);
    if (!byMember.has(k)) byMember.set(k, { memberId: k, name: nameOf.get(k) ?? '', activities: [], allDone: true });
    const e = byMember.get(k);
    e.activities.push(a.workedOn);
    if (a.status !== 'completed') e.allDone = false;
  }
  const teamActivities = [...byMember.values()].map((e) => ({ memberId: e.memberId, name: e.name, activities: e.activities, status: e.allDone ? 'completed' : 'in_progress' }));

  // this week's focus: the Socials team's open tasks and the ones done in the range
  const focusTasks = soc.ids.length
    ? await MarketingTask.find({ groupId: { $in: soc.ids }, ...(range.brand === 'all' ? {} : { brand: range.brand }), $or: [{ status: { $ne: 'completed' } }, { completedAt: { $gte: istStart(range.from), $lt: istEnd(range.to) } }], dueDate: { $lte: week.to } }).sort({ dueDate: 1 }).limit(6).lean()
    : [];

  const leads = leadsRaw.map((l) => ({ source: l.source, region: l.region, district: l.district, campaignBrand: l.campaignBrand, day: T.istDay(l.leadDate ?? l.createdAt) }));
  const posted = S.postedItems(items, range).sort((a, b) => new Date(b.publishedDate ?? b.scheduledDate) - new Date(a.publishedDate ?? a.scheduledDate));

  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    kpis: S.kpis(items, range),
    pipeline: S.pipeline(items, range),
    platforms: S.platformDistribution(items, range),
    tracker: { rows: tracker, hasMetrics: soc.metrics.length > 0 },
    calendar,
    weekFrom: week.from,
    teamActivities,
    teamDay: day,
    teamScope: teamView ? 'team' : 'own',
    engagement: S.engagementOverview(items, range),
    recentPosts: posted.slice(0, 3).map((it) => ({ ...shapeItem(it), views: it.metrics?.views || it.metrics?.reach || 0 })),
    leads: S.organicLeads(leads, range),
    focus: focusTasks.map((t) => ({ id: idOf(t), title: t.title, progress: t.progress ?? 0, done: t.status === 'completed' })),
    insights: S.insights(items, range),
  });
});

// ── Calendar ──────────────────────────────────────────────────────────────────
// The calendar's records are the Content items themselves (GET /api/content with ?brand=); this returns the same set for a window,
// shaped for the month / week / list views, with the counts above the grid.
export const getCalendar = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const platform = req.query.platform && req.query.platform !== 'all' ? String(req.query.platform) : null;
  const items = (await loadItems({ ...range, from: range.from })).filter((it) => {
    const d = S.countedDay(it);
    return S.stageOf(it.status) && d >= range.from && d <= range.to && (range.brand === 'all' || (it.brand ?? 'main') === range.brand) && (!platform || it.platform === platform);
  });
  res.json({ from: range.from, to: range.to, items: items.map(shapeItem), pipeline: S.pipeline(items, { ...range, brand: 'all' }) });
});

// ── Assets (shared with the Creative Portfolio gallery) ───────────────────────

const assetShape = (a, uploaderName = new Map()) => ({
  id: idOf(a),
  title: a.title,
  brand: a.brand,
  kind: a.kind,
  media: a.media,
  stage: a.stage,
  url: a.url,
  thumbUrl: a.thumbUrl || '',
  portfolio: a.portfolio,
  page: a.page,
  tags: a.tags ?? [],
  durationSec: a.durationSec ?? 0,
  sizeMb: a.sizeMb ?? 0,
  shootId: a.shootId ? idOf(a.shootId) : null,
  isFinal: !!a.isFinal,
  ownerName: a.ownerName ?? '',
  // who it belongs to: the named owner, else the person who added it
  owner: a.ownerName || uploaderName.get(idOf(a.createdBy)) || '',
  approvedAt: a.approvedAt ?? null,
  createdAt: a.createdAt,
});

/** The names of the people who added the assets that name no owner. */
const uploaderNames = async (assets) => {
  const ids = [...new Set(assets.filter((a) => !a.ownerName && a.createdBy).map((a) => idOf(a.createdBy)))];
  if (!ids.length) return new Map();
  const users = await User.find({ _id: { $in: ids } }).select('name').lean();
  return new Map(users.map((u) => [idOf(u), u.name ?? '']));
};

// the most matches "Best match" ranks (beyond it the newest come first — a library this size is searched with more words)
const RANK_CAP = 5000;

/** What each search word finds outside the asset: shoots (title, location, category, pillar, type, crew) and the people who added assets. */
const searchHits = async (terms) => {
  const hits = new Map();
  await Promise.all(
    terms.map(async (t) => {
      const rx = termRegex(t);
      const [shoots, users] = await Promise.all([
        MarketingShoot.find({ $or: [{ title: rx }, { location: rx }, { category: rx }, { pillar: rx }, { shootType: rx }, { 'crew.name': rx }] }).select('_id').limit(1000).lean(),
        User.find({ name: rx }).select('_id').limit(200).lean(),
      ]);
      hits.set(t.key, { shootIds: shoots.map((x) => x._id), userIds: users.map((u) => u._id) });
    }),
  );
  return hits;
};

/** The logins named like each owner asked for (lower-case name → ids): their assets that name no owner are theirs. */
const ownerUsersOf = async (owners) => {
  const out = new Map();
  if (!owners.length) return out;
  const users = await User.find({ name: { $in: owners.map((n) => new RegExp(`^\\s*${escapeRx(n)}\\s*$`, 'i')) } }).select('_id name').lean();
  for (const u of users) {
    const k = String(u.name ?? '').trim().toLowerCase();
    out.set(k, [...(out.get(k) ?? []), u._id]);
  }
  return out;
};

const sumIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
const tally = (rows) => Object.fromEntries(rows.filter((r) => r._id != null && r._id !== '').sort((a, b) => b.n - a.n || String(a._id).localeCompare(String(b._id))).map((r) => [r._id, r.n]));

/**
 * The asset library (Socials → Content & Assets and the Creative Portfolio gallery) — the search and filters are read by
 * utils/assetSearch.js. Each filter takes one value or several (?media=video&media=image = either); keywords (?kw=, the older ?tag=)
 * all at once or ?kwMode=any, ?notKw= leaves some out; ?final=1, ?usable=1 (approved or final), ?untagged=1 (no keyword yet); ?q= the
 * words searched; ?sort=relevance|newest|oldest|title; ?pageNo=&limit= a page of the results; ?from=&to= the days it was added.
 *
 * `counts` (the KPI strip) describe the library in the brand and dates; `total` is how many match everything asked. Each facet is
 * counted with every filter but its own, so "Videos 40 · Photos 120" stays readable after picking Videos.
 */
export const listAssets = asyncHandler(async (req, res) => {
  const base = {};
  if (['main', 'kerala'].includes(req.query.brand)) base.brand = req.query.brand;
  const period = readOptionalRange(req, res);
  if (period) base.createdAt = { $gte: istStart(period.from), $lt: istEnd(period.to) };
  const spec = parseAssetSearch(req.query);
  const [hits, ownerUsers] = await Promise.all([searchHits(spec.text.terms), ownerUsersOf(spec.owner)]);
  const clauses = assetClauses(spec, { hits, ownerUsers });
  const match = { ...base, ...combineClauses(clauses) };
  const facetOf = (key) => [{ $match: combineClauses(clauses, [key]) }, { $group: { _id: `$${key}`, n: { $sum: 1 } } }];
  // keywords asked as "all of these" narrow, so their list counts within the results; asked as "any of these" they are a choice
  const kwExcept = spec.kwMode === 'any' ? ['keywords'] : [];
  const chosenKw = [...spec.keywords, ...spec.notKeywords];
  const [agg] = await MarketingAsset.aggregate([
    { $match: base },
    {
      $facet: {
        kpis: [{ $group: { _id: null, total: { $sum: 1 }, photos: sumIf({ $eq: ['$media', 'image'] }), videos: sumIf({ $eq: ['$media', 'video'] }), finals: sumIf({ $eq: ['$isFinal', true] }), approved: sumIf({ $eq: ['$stage', 'approved'] }), postProduced: sumIf({ $in: ['$stage', ['post_produced', 'in_review', 'approved']] }) } }],
        matched: [{ $match: combineClauses(clauses) }, { $count: 'n' }],
        stage: facetOf('stage'),
        kind: facetOf('kind'),
        media: facetOf('media'),
        portfolio: facetOf('portfolio'),
        page: facetOf('page'),
        owner: [{ $match: combineClauses(clauses, ['owner']) }, { $group: { _id: { o: '$ownerName', c: '$createdBy' }, n: { $sum: 1 } } }],
        tags: [{ $match: combineClauses(clauses, kwExcept) }, { $unwind: '$tags' }, { $group: { _id: '$tags', n: { $sum: 1 } } }, { $sort: { n: -1, _id: 1 } }, { $limit: 60 }],
        // the keywords picked, counted even when they are not among the most used
        chosen: chosenKw.length ? [{ $match: combineClauses(clauses, [...kwExcept, 'notKeywords']) }, { $unwind: '$tags' }, { $match: { tags: { $in: chosenKw } } }, { $group: { _id: '$tags', n: { $sum: 1 } } }] : [{ $match: { _id: { $exists: false } } }],
        untagged: [{ $match: combineClauses(clauses, ['untagged']) }, { $match: { $or: [{ tags: { $exists: false } }, { tags: { $size: 0 } }] } }, { $count: 'n' }],
      },
    },
  ]);
  const total = agg.matched[0]?.n ?? 0;
  const pages = Math.max(Math.ceil(total / spec.limit), 1);
  const skip = (spec.pageNo - 1) * spec.limit;
  let items;
  if (spec.sort === 'relevance') {
    const found = await MarketingAsset.find(match).select('title tags page portfolio ownerName shootId createdAt').sort({ createdAt: -1, _id: -1 }).limit(RANK_CAP).lean();
    const ids = rankAssets(found, spec.text, hits).slice(skip, skip + spec.limit).map((a) => idOf(a));
    const docs = await MarketingAsset.find({ _id: { $in: ids } }).lean();
    const byId = new Map(docs.map((d) => [idOf(d), d]));
    items = ids.map((id) => byId.get(id)).filter(Boolean);
  } else {
    const sort = spec.sort === 'oldest' ? { createdAt: 1, _id: 1 } : spec.sort === 'title' ? { title: 1, _id: 1 } : { createdAt: -1, _id: -1 };
    let cursor = MarketingAsset.find(match).sort(sort).skip(skip).limit(spec.limit);
    if (spec.sort === 'title') cursor = cursor.collation({ locale: 'en', strength: 2 });
    items = await cursor.lean();
  }
  const ownerRows = agg.owner.map((r) => ({ ownerName: r._id?.o ?? '', createdBy: r._id?.c ?? null, n: r.n }));
  const names = await uploaderNames([...items, ...ownerRows]);
  const owners = {};
  for (const r of ownerRows.sort((a, b) => b.n - a.n)) {
    const o = r.ownerName || names.get(idOf(r.createdBy)) || '';
    if (o) owners[o] = (owners[o] ?? 0) + r.n;
  }
  const keywordRows = [...agg.tags];
  for (const r of agg.chosen) if (!keywordRows.some((x) => x._id === r._id)) keywordRows.push(r);
  for (const k of chosenKw) if (!keywordRows.some((x) => x._id === k)) keywordRows.push({ _id: k, n: 0 });
  const k = agg.kpis[0] ?? { total: 0, photos: 0, videos: 0, finals: 0, approved: 0, postProduced: 0 };
  res.json({
    items: items.map((a) => assetShape(a, names)),
    total,
    pageNo: spec.pageNo,
    pages,
    limit: spec.limit,
    sort: spec.sort,
    counts: { total: k.total, photos: k.photos, videos: k.videos, finals: k.finals, approved: k.approved, approvedPct: k.total ? Math.round((k.approved / k.total) * 100) : null, postProducedPct: k.total ? Math.round((k.postProduced / k.total) * 100) : null },
    facets: {
      portfolios: tally(agg.portfolio),
      pages: tally(agg.page),
      stages: tally(agg.stage),
      media: tally(agg.media),
      kinds: tally(agg.kind),
      // the 60 most used keywords among the results (most used first) — as a map (older app builds) and as a list (order kept)
      tags: Object.fromEntries(keywordRows.map((r) => [r._id, r.n])),
      keywords: keywordRows.map((r) => ({ keyword: r._id, count: r.n })),
      owners,
      // assets with no keyword yet (to find and fix)
      untagged: agg.untagged[0]?.n ?? 0,
    },
    // what the search box was read as — shown under it so a typo or a left-out word is visible
    search: { terms: spec.text.terms.map((t) => (t.phrase ? `"${t.text}"` : t.text)), exclude: spec.text.exclude.map((t) => t.text), keywords: spec.text.keywords, notKeywords: spec.text.notKeywords },
    rankedOnly: spec.sort === 'relevance' && total > RANK_CAP ? RANK_CAP : null,
    // this login may approve, reject and mark final outputs
    canManage: isManagerOrAdmin(req.user),
    period,
  });
});

/** The library's keywords and how many assets carry each: suggestions while typing (?q=) or the whole list (?limit= up to 1000). */
export const listAssetKeywords = asyncHandler(async (req, res) => {
  const typed = normalizeKeyword(req.query.q);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 1000);
  const rows = await MarketingAsset.aggregate([{ $unwind: '$tags' }, ...(typed ? [{ $match: { tags: new RegExp(escapeRx(typed), 'i') } }] : []), { $group: { _id: '$tags', n: { $sum: 1 } } }]);
  const all = rows.map((r) => ({ keyword: r._id, count: r.n }));
  res.json({ items: rankKeywordSuggestions(all, typed, limit), total: all.length, canManage: isManagerOrAdmin(req.user) });
});

/** Rename a keyword on every asset — into one that already exists = a merge ("bride" into "bridal"). Marketing Manager. */
export const renameAssetKeyword = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can rename or merge keywords.', 403);
  const from = keywordAsStored(req.body?.from);
  if (!from) bad(res, 'Choose the keyword to rename.');
  const to = cleanKeywords(req.body?.to ?? '');
  if (!to.ok) bad(res, to.message);
  if (to.value.length !== 1) bad(res, to.value.length ? 'Type one new keyword (without commas).' : 'Type the new keyword.');
  const target = to.value[0];
  if (target === from) bad(res, 'That is the same keyword.');
  const assets = await MarketingAsset.find({ tags: from }).select('tags').lean();
  if (!assets.length) bad(res, `No asset carries the keyword "${from}".`, 404);
  const merged = (await MarketingAsset.countDocuments({ tags: target })) > 0;
  await MarketingAsset.bulkWrite(assets.map((a) => ({ updateOne: { filter: { _id: a._id }, update: { $set: { tags: renameKeyword(a.tags, from, target) } } } })));
  res.json({ from, to: target, updated: assets.length, merged });
});

/** Take a keyword off every asset. Marketing Manager. */
export const removeAssetKeyword = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can remove a keyword from the library.', 403);
  const k = keywordAsStored(req.body?.keyword);
  if (!k) bad(res, 'Choose the keyword to remove.');
  const r = await MarketingAsset.updateMany({ tags: k }, { $pull: { tags: k } });
  if (!r.matchedCount) bad(res, `No asset carries the keyword "${k}".`, 404);
  res.json({ keyword: k, updated: r.modifiedCount });
});

/**
 * Add and/or remove keywords on many assets at once ({ ids, add, remove }). An asset that would carry more than the most keywords is
 * left as it was and listed with the reason; the others change.
 */
export const bulkAssetKeywords = asyncHandler(async (req, res) => {
  const b = req.body ?? {};
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((x) => String(x)))].filter((x) => mongoose.isValidObjectId(x));
  if (!ids.length) bad(res, 'Choose the assets to change.');
  if (ids.length > 500) bad(res, 'Change up to 500 assets at a time.');
  const add = cleanKeywords(b.add ?? []);
  if (!add.ok) bad(res, add.message);
  const remove = [...new Set((Array.isArray(b.remove) ? b.remove : [b.remove]).map(keywordAsStored).filter(Boolean))];
  if (!add.value.length && !remove.length) bad(res, 'Type the keywords to add or remove.');
  const assets = await MarketingAsset.find({ _id: { $in: ids } }).select('title tags').lean();
  const ops = [];
  const skipped = [];
  let unchanged = 0;
  for (const a of assets) {
    const before = a.tags ?? [];
    const next = applyKeywordChange(before, add.value, remove);
    if (next.length > MAX_KEYWORDS) {
      skipped.push({ id: idOf(a), title: a.title, reason: `It would carry ${next.length} keywords; the most is ${MAX_KEYWORDS}.` });
      continue;
    }
    if (next.length === before.length && next.every((t, i) => t === before[i])) {
      unchanged += 1;
      continue;
    }
    ops.push({ updateOne: { filter: { _id: a._id }, update: { $set: { tags: next } } } });
  }
  if (ops.length) await MarketingAsset.bulkWrite(ops);
  res.json({ updated: ops.length, unchanged, skipped, missing: ids.length - assets.length });
});

export const getAsset = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) bad(res, 'That asset was not found.', 404);
  const a = await MarketingAsset.findById(req.params.id).lean();
  if (!a) bad(res, 'That asset was not found.', 404);
  res.json(assetShape(a, await uploaderNames([a])));
});

const shootForAsset = async (res, shootId) => {
  const shoot = await MarketingShoot.findById(shootId).select('brand category').lean();
  if (!shoot) bad(res, 'That shoot no longer exists.');
  return shoot;
};

// approving, rejecting and marking a final output are a manager's call: each makes an asset postable (or not) and counts it as delivered
const MANAGER_ONLY_ASSET = 'Only a Marketing Manager can approve, reject or mark an asset as a final output.';

export const createAsset = asyncHandler(async (req, res) => {
  const v = cleanAssetInput(req.body);
  if (!v.ok) bad(res, v.message);
  if (!isManagerOrAdmin(req.user) && (['approved', 'rejected'].includes(v.value.stage) || v.value.isFinal === true)) bad(res, MANAGER_ONLY_ASSET, 403);
  let fields = { ...v.value };
  // an upload attached to a shoot takes the shoot's brand, portfolio and tags — the shoot decides, whatever the form sent
  if (fields.shootId) fields = { ...fields, ...assetFromShoot(await shootForAsset(res, fields.shootId), fields) };
  if (!fields.ownerName) fields.ownerName = String(req.user?.name ?? '').trim().slice(0, 100);
  fields.approvedAt = approvedAtFor({}, { stage: fields.stage ?? 'raw', isFinal: fields.isFinal === true });
  const asset = await MarketingAsset.create({ ...fields, createdBy: req.user._id });
  res.status(201).json(assetShape(asset.toObject()));
});

export const updateAsset = asyncHandler(async (req, res) => {
  const asset = await MarketingAsset.findById(req.params.id);
  if (!asset) bad(res, 'That asset was not found.', 404);
  const v = cleanAssetInput(req.body, asset);
  if (!v.ok) bad(res, v.message);
  // approving, rejecting and the final-output mark are a manager's call; anyone on the team moves an asset through the production stages
  const manager = isManagerOrAdmin(req.user);
  if (!manager && v.value.stage && ['approved', 'rejected'].includes(v.value.stage) && v.value.stage !== asset.stage) bad(res, 'Only a Marketing Manager can approve or reject an asset.', 403);
  if (!manager && v.value.isFinal !== undefined && v.value.isFinal !== !!asset.isFinal) bad(res, MANAGER_ONLY_ASSET, 403);
  const before = { stage: asset.stage, isFinal: asset.isFinal, approvedAt: asset.approvedAt, shootId: asset.shootId ? idOf(asset.shootId) : null };
  let fields = { ...v.value };
  // a new file behind an approved (or final) asset is not what was approved: it goes back for review unless a manager changed it
  if (!manager && fields.url && fields.url !== asset.url && isUsableAsset(asset)) {
    fields.stage = 'in_review';
    fields.isFinal = false;
  }
  const shootId = fields.shootId !== undefined ? fields.shootId : before.shootId;
  // an asset that belongs to a shoot is filed under the shoot's brand and portfolio, carries its tag (the shoot decides)
  if (shootId) fields = { ...fields, ...assetFromShoot(await shootForAsset(res, shootId), { page: fields.page ?? asset.page, tags: fields.tags ?? asset.tags }) };
  Object.assign(asset, fields);
  asset.approvedAt = approvedAtFor(before, { stage: asset.stage, isFinal: asset.isFinal });
  await asset.save();
  // the posts made from it follow it to its new shoot
  if ((shootId ?? null) !== before.shootId) await ContentItem.updateMany({ assetId: asset._id }, { $set: { shootId: shootId ?? null } });
  res.json(assetShape(asset.toObject(), await uploaderNames([asset])));
});

export const deleteAsset = asyncHandler(async (req, res) => {
  const asset = await MarketingAsset.findById(req.params.id);
  if (!asset) bad(res, 'That asset was not found.', 404);
  const used = await ContentItem.countDocuments({ assetId: asset._id });
  if (used) bad(res, `This asset is used by ${used} post${used === 1 ? '' : 's'}. Remove it from them first.`, 409);
  await asset.deleteOne();
  res.json({ message: 'Asset deleted' });
});

// ── Accounts and the publishing queue ─────────────────────────────────────────

const accountShape = (a) => ({ id: idOf(a), brand: a.brand, platform: a.platform, handle: a.handle, status: a.status, followers: a.followers, note: a.note, updatedAt: a.updatedAt, syncedAt: a.syncedAt ?? null });

export const listAccounts = asyncHandler(async (_req, res) => {
  res.json((await SocialAccount.find().sort({ brand: 1, platform: 1 }).lean()).map(accountShape));
});

export const createAccount = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can add an account.', 403);
  const v = cleanAccountInput(req.body);
  if (!v.ok) bad(res, v.message);
  // checked here as well as by the unique index, so the answer does not depend on the index having been built
  const rx = new RegExp(`^${(v.value.handle ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  if (await SocialAccount.exists({ brand: v.value.brand ?? 'main', platform: v.value.platform, handle: rx })) bad(res, 'That account is already listed.', 409);
  try {
    const a = await SocialAccount.create({ ...v.value, history: v.value.followers ? [{ day: toDateStr(), followers: v.value.followers }] : [] });
    res.status(201).json(accountShape(a));
  } catch (e) {
    if (e?.code === 11000) bad(res, 'That account is already listed.', 409);
    throw e;
  }
});

export const updateAccount = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can change an account.', 403);
  const a = await SocialAccount.findById(req.params.id);
  if (!a) bad(res, 'That account was not found.', 404);
  const v = cleanAccountInput(req.body, a);
  if (!v.ok) bad(res, v.message);
  const today = toDateStr();
  Object.assign(a, v.value);
  if (v.value.brand !== undefined || v.value.platform !== undefined || v.value.handle !== undefined) {
    const rx = new RegExp(`^${(a.handle ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (await SocialAccount.exists({ _id: { $ne: a._id }, brand: a.brand, platform: a.platform, handle: rx })) bad(res, 'That account is already listed.', 409);
  }
  if (v.value.followers !== undefined) {
    // one followers figure per day: today's replaces today's, an earlier day's stays
    a.history = [...a.history.filter((h) => h.day !== today), { day: today, followers: v.value.followers }].slice(-400);
  }
  try {
    await a.save();
  } catch (e) {
    if (e?.code === 11000) bad(res, 'That account is already listed.', 409);
    throw e;
  }
  res.json(accountShape(a));
});

export const deleteAccount = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can remove an account.', 403);
  const a = await SocialAccount.findByIdAndDelete(req.params.id);
  if (!a) bad(res, 'That account was not found.', 404);
  res.json({ message: 'Account removed' });
});

/**
 * Publishing & Accounts: the accounts and the queue of what is waiting to go out (scheduled or in review), soonest first, and what went
 * out lately. With ?from=&to= the queue is what is scheduled in those days and the published list what went out in them.
 */
export const getPublishing = asyncHandler(async (req, res) => {
  const brand = ['main', 'kerala'].includes(req.query.brand) ? req.query.brand : null;
  const period = readOptionalRange(req, res);
  const within = period ? { $gte: istStart(period.from), $lt: istEnd(period.to) } : null;
  const q = { status: { $in: ['scheduled', 'in-review'] }, ...(brand ? { brand } : {}), ...(within ? { scheduledDate: within } : {}) };
  const [accounts, queue, recent] = await Promise.all([
    SocialAccount.find(brand ? { brand } : {}).sort({ brand: 1, platform: 1 }).lean(),
    ContentItem.find(q).sort({ scheduledDate: 1 }).limit(60).lean(),
    ContentItem.find({ status: 'published', ...(brand ? { brand } : {}), ...(within ? { publishedDate: within } : {}) }).sort({ publishedDate: -1 }).limit(period ? 50 : 10).lean(),
  ]);
  res.json({ accounts: accounts.map(accountShape), queue: queue.map(shapeItem), recent: recent.map(shapeItem), period });
});

// ── Targets for the activity tracker ──────────────────────────────────────────

export const getTargets = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const soc = await socialsGroup();
  const rows = await targetRows(range);
  const week = weekOf(range.from).from;
  res.json({
    week,
    brand: range.brand,
    metrics: soc.metrics.map((m) => ({ ...m, target: S.weekTarget(rows, { brand: range.brand, week, metricId: m.id }) })),
  });
});

export const setTargets = asyncHandler(async (req, res) => {
  if (!isManagerOrAdmin(req.user)) bad(res, 'Only a Marketing Manager can set targets.', 403);
  const v = cleanTargetInput(req.body);
  if (!v.ok) bad(res, v.message);
  const soc = await socialsGroup();
  const allowed = new Set(soc.metrics.map((m) => m.id));
  if (v.value.rows.some((r) => !allowed.has(r.metricId))) bad(res, 'A target names an activity that is not under Socials.');
  // a target is stored FOR its week and never rewrites another week's
  await SocialsTarget.bulkWrite(
    v.value.rows.map((r) => ({
      updateOne: {
        filter: { scope: 'socials', brand: v.value.brand, period: v.value.period, metricId: new mongoose.Types.ObjectId(r.metricId) },
        update: { $set: { target: r.target, setBy: req.user._id } },
        upsert: true,
      },
    })),
  );
  res.json({ week: v.value.period, saved: v.value.rows.length });
});

// ── Performance and Reports ───────────────────────────────────────────────────

export const getPerformance = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  const platform = req.query.platform && req.query.platform !== 'all' ? String(req.query.platform) : null;
  const all = await loadItems(range);
  const items = platform ? all.filter((it) => it.platform === platform) : all;
  const eng = S.engagementOverview(items, range);
  const before = S.engagementOverview(items, { ...T.previousRange(range), brand: range.brand });
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    totals: {
      reach: eng.reach,
      impressions: eng.impressions,
      engagements: eng.engagements,
      engagementRate: eng.engagementRate,
      videoViews: eng.views,
      linkClicks: eng.linkClicks,
      change: { reach: eng.change.reach, impressions: eng.change.impressions, engagements: eng.engagementsChange, videoViews: eng.change.views, linkClicks: eng.change.linkClicks },
      engagementRateBefore: before.engagementRate,
    },
    trend: S.reachTrend(items, range),
    platforms: S.platformPerformance(items, range),
    top: S.topContent(items, range, 5),
    contentStatus: S.pipeline(items, range),
  });
});

export const getReports = asyncHandler(async (req, res) => {
  const range = readRange(req, res);
  // everything the figures compare: the period, the period before it (as long as the period — a year for a year), and the six months
  // of the growth trend; a post counts on the day it went out, so it is found by either date
  const prev = T.previousRange(range);
  const [ty, tm] = range.to.split('-').map(Number);
  const trendStart = new Date(Date.UTC(ty, tm - 1 - 5, 1)).toISOString().slice(0, 10);
  const a = prev.from < trendStart ? prev.from : trendStart;
  const items = await ContentItem.find({ $or: [{ scheduledDate: { $gte: istStart(a), $lt: istEnd(range.to) } }, { publishedDate: { $gte: istStart(a), $lt: istEnd(range.to) } }] }).limit(20000).lean();
  // what is planned for the next seven days (for "Next actions")
  const upcoming = await ContentItem.countDocuments({ status: { $in: ['idea', 'planned', 'in-progress', 'in-review', 'scheduled'] }, scheduledDate: { $gte: istStart(T.addDays(range.today, 1)), $lt: istEnd(T.addDays(range.today, 7)) }, ...(range.brand === 'all' ? {} : { brand: range.brand }) });
  const now = S.engagementOverview(items, range);
  const before = S.engagementOverview(items, { ...T.previousRange(range), brand: range.brand });
  const accounts = await SocialAccount.find(range.brand === 'all' ? {} : { brand: range.brand }).lean();
  const followersNow = accounts.reduce((s, a) => s + (a.followers ?? 0), 0);
  const followersAt = (a, day) => [...(a.history ?? [])].filter((h) => h.day <= day).sort((x, y) => (x.day < y.day ? 1 : -1))[0]?.followers ?? null;
  const prior = accounts.map((a) => followersAt(a, T.previousRange(range).to));
  const followersBefore = prior.every((v) => v !== null) && prior.length ? prior.reduce((s, v) => s + v, 0) : null;
  const followersChange = followersBefore ? T.changePct(followersNow, followersBefore) : null;
  res.json({
    from: range.from,
    to: range.to,
    brand: range.brand,
    summary: {
      overallGrowth: S.overallGrowth(now, before),
      reach: { value: now.reach, change: now.change.reach },
      impressions: { value: now.impressions, change: now.change.impressions },
      engagements: { value: now.engagements, change: now.engagementsChange },
      followers: { value: followersNow, change: followersChange },
    },
    growthTrend: S.monthlyTrend(items, range.to, 6, range.brand),
    insights: S.insights(items, range),
    nextActions: S.nextActions(items, range, { followers: followersChange, upcoming }),
    platforms: S.platformPerformance(items, range),
    top: S.topContent(items, range, 5),
    kpis: S.kpis(items, range),
  });
});

export const ASSET_STAGE_LIST = ASSET_STAGES;
