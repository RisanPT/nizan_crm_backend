import mongoose from 'mongoose';
import Competitor from '../models/Competitor.js';
import CompetitorSnapshot from '../models/CompetitorSnapshot.js';
import ScoringConfig from '../models/ScoringConfig.js';

// Only the digital-marketing admin (and full-access managers) manage this module.
const MARKETING_ROLES = ['admin', 'manager', 'marketing_admin'];
const canManageMarketing = (user) => MARKETING_ROLES.includes(user?.role);

// SRS §4.2 default weights (sum to exactly 25).
const SRS_DEFAULT_WEIGHTS = {
  newCampaign: 5,
  viralContent: 5,
  qualityCreative: 5,
  followerGrowth: 3,
  engagementIncrease: 3,
  newService: 2,
  newPartnership: 2,
};
const SIGNAL_KEYS = Object.keys(SRS_DEFAULT_WEIGHTS);
const SIGNAL_LABELS = {
  newCampaign: 'New Campaign',
  viralContent: 'Viral Content',
  qualityCreative: 'Quality Creative',
  followerGrowth: 'Follower Growth',
  engagementIncrease: 'Engagement Increase',
  newService: 'New Service',
  newPartnership: 'New Partnership',
};

// Load the active scoring config (weights + version), falling back to SRS defaults.
const getActiveScoring = async () => {
  const cfg = await ScoringConfig.findOne({ active: true }).sort({ version: -1 });
  if (!cfg) return { weights: { ...SRS_DEFAULT_WEIGHTS }, version: 1 };
  const w = cfg.weights?.toObject ? cfg.weights.toObject() : cfg.weights;
  return { weights: { ...SRS_DEFAULT_WEIGHTS, ...w }, version: cfg.version };
};

// GS = Σ(points of triggered signals), clamped [1,25] (FR-2.1: zero signals => 1).
const computeScoreAndSignals = (flags, evidence, weights) => {
  const signals = [];
  let total = 0;
  for (const key of SIGNAL_KEYS) {
    if (flags[key]) {
      const points = Number(weights[key]) || 0;
      total += points;
      signals.push({
        key,
        label: SIGNAL_LABELS[key],
        points,
        evidence: String(evidence?.[key] ?? '').trim(),
      });
    }
  }
  const score = Math.max(1, Math.min(25, total));
  return { score, signals };
};

// Normalise any date to the Monday 00:00 of its week (UTC).
const mondayOf = (input) => {
  const d = input ? new Date(input) : new Date();
  if (Number.isNaN(d.getTime())) return mondayOf(new Date());
  const day = (d.getUTCDay() + 6) % 7; // 0 => Monday
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)
  );
  return monday;
};

const toBool = (v) =>
  v === true ||
  v === 1 ||
  ['1', 'true', 'yes', 'y'].includes(String(v ?? '').trim().toLowerCase());

const num = (v) => {
  const n = Number(String(v ?? '').toString().replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const snapshotFieldsFromBody = (b) => ({
  followers: num(b.followers),
  weeklyGrowthPct: num(b.weeklyGrowthPct),
  engagementRate: num(b.engagementRate),
  adCampaigns: num(b.adCampaigns),
  offers: num(b.offers),
  newServicesCount: num(b.newServicesCount),
  postingFrequency: num(b.postingFrequency),
  seoScore: num(b.seoScore),
  reviews: num(b.reviews),
  collaborations: num(b.collaborations),
  contentThemes: String(b.contentThemes ?? '').trim(),
  newCampaign: toBool(b.newCampaign),
  viralContent: toBool(b.viralContent),
  qualityCreative: toBool(b.qualityCreative),
  followerGrowth: toBool(b.followerGrowth),
  engagementIncrease: toBool(b.engagementIncrease),
  newService: toBool(b.newService),
  newPartnership: toBool(b.newPartnership),
  signalEvidence: {
    newCampaign: String(b.signalEvidence?.newCampaign ?? '').trim(),
    viralContent: String(b.signalEvidence?.viralContent ?? '').trim(),
    qualityCreative: String(b.signalEvidence?.qualityCreative ?? '').trim(),
    followerGrowth: String(b.signalEvidence?.followerGrowth ?? '').trim(),
    engagementIncrease: String(b.signalEvidence?.engagementIncrease ?? '').trim(),
    newService: String(b.signalEvidence?.newService ?? '').trim(),
    newPartnership: String(b.signalEvidence?.newPartnership ?? '').trim(),
  },
  notes: String(b.notes ?? '').trim(),
});

// ── Competitors ─────────────────────────────────────────────────────────────

// List competitors, each with their latest snapshot + score.
export const getCompetitors = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const competitors = await Competitor.find({}).sort({ name: 1 }).lean();
    const latest = await CompetitorSnapshot.aggregate([
      { $sort: { weekOf: -1 } },
      {
        $group: {
          _id: '$competitor',
          snapshot: { $first: '$$ROOT' },
        },
      },
    ]);
    const byId = new Map(
      latest.map((row) => [row._id.toString(), row.snapshot])
    );
    const result = competitors.map((c) => ({
      ...c,
      latestSnapshot: byId.get(c._id.toString()) ?? null,
    }));
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

const cleanCompetitor = (b) => ({
  name: String(b.name ?? '').trim(),
  city: String(b.city ?? '').trim(),
  website: String(b.website ?? '').trim(),
  category: String(b.category ?? '').trim(),
  instagram: String(b.instagram ?? '').trim(),
  facebook: String(b.facebook ?? '').trim(),
  youtube: String(b.youtube ?? '').trim(),
  linkedin: String(b.linkedin ?? '').trim(),
  notes: String(b.notes ?? '').trim(),
});

export const createCompetitor = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const data = cleanCompetitor(req.body);
    if (!data.name) {
      return res.status(400).json({ message: 'Competitor name is required' });
    }
    const competitor = await Competitor.create({
      ...data,
      active: req.body.active ?? true,
      owner: null,
    });
    res.status(201).json(competitor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateCompetitor = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const competitor = await Competitor.findById(req.params.id);
    if (!competitor) {
      return res.status(404).json({ message: 'Competitor not found' });
    }
    const data = cleanCompetitor(req.body);
    for (const key of Object.keys(data)) {
      if (req.body[key] !== undefined) competitor[key] = data[key];
    }
    if (req.body.active !== undefined) competitor.active = !!req.body.active;
    await competitor.save();
    res.json(competitor);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteCompetitor = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const competitor = await Competitor.findByIdAndDelete(req.params.id);
    if (!competitor) {
      return res.status(404).json({ message: 'Competitor not found' });
    }
    await CompetitorSnapshot.deleteMany({ competitor: req.params.id });
    res.json({ message: 'Competitor removed', id: req.params.id });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Snapshots (weekly data) ──────────────────────────────────────────────────

// Add / update the weekly snapshot for a competitor (upsert by competitor+week).
export const upsertSnapshot = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const competitorId = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(competitorId)) {
      return res.status(400).json({ message: 'Invalid competitor id' });
    }
    const competitor = await Competitor.findById(competitorId);
    if (!competitor) {
      return res.status(404).json({ message: 'Competitor not found' });
    }
    const weekOf = mondayOf(req.body.weekOf);
    const fields = snapshotFieldsFromBody(req.body);
    const { weights, version } = await getActiveScoring();
    const { score, signals } =
        computeScoreAndSignals(fields, fields.signalEvidence, weights);
    const snapshot = await CompetitorSnapshot.findOneAndUpdate(
      { competitor: competitorId, weekOf },
      {
        $set: {
          ...fields,
          score,
          signals,
          scoringVersion: version,
          competitor: competitorId,
          weekOf,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    res.status(201).json(snapshot);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getSnapshots = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const filter = {};
    if (req.query.competitor) filter.competitor = req.query.competitor;
    if (req.query.weekOf) filter.weekOf = mondayOf(req.query.weekOf);
    const snapshots = await CompetitorSnapshot.find(filter)
      .sort({ weekOf: -1 })
      .populate('competitor', 'name city');
    res.json(snapshots);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Bulk import (CSV parsed on the client → array of rows) ────────────────────

// Each row = competitor fields + optional weekly metrics/flags. Competitors are
// upserted by (name, city); a snapshot for `weekOf` is created when metrics exist.
export const importCompetitors = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (rows.length === 0) {
      return res.status(400).json({ message: 'No rows to import' });
    }
    const defaultWeek = mondayOf(req.body.weekOf);
    const { weights, version } = await getActiveScoring();
    let created = 0;
    let updated = 0;
    let snapshots = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i] ?? {};
      const data = cleanCompetitor(row);
      if (!data.name) {
        errors.push({ row: i + 1, message: 'Missing name' });
        continue;
      }
      let competitor = await Competitor.findOne({
        name: new RegExp(`^${data.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
        city: data.city,
      });
      if (competitor) {
        for (const key of Object.keys(data)) {
          if (row[key] !== undefined && data[key] !== '') competitor[key] = data[key];
        }
        await competitor.save();
        updated += 1;
      } else {
        competitor = await Competitor.create({ ...data, active: true, owner: null });
        created += 1;
      }

      // Create a snapshot only if the row carries any metric/flag column.
      const hasMetrics = [
        'followers', 'weeklyGrowthPct', 'engagementRate', 'adCampaigns',
        'offers', 'newServicesCount', 'postingFrequency', 'seoScore',
        'reviews', 'collaborations', 'contentThemes', 'newCampaign',
        'viralContent', 'qualityCreative', 'followerGrowth',
        'engagementIncrease', 'newService', 'newPartnership',
      ].some((k) => row[k] !== undefined && String(row[k]).trim() !== '');

      if (hasMetrics) {
        const weekOf = row.weekOf ? mondayOf(row.weekOf) : defaultWeek;
        const fields = snapshotFieldsFromBody(row);
        const { score, signals } =
            computeScoreAndSignals(fields, fields.signalEvidence, weights);
        await CompetitorSnapshot.findOneAndUpdate(
          { competitor: competitor._id, weekOf },
          {
            $set: {
              ...fields,
              score,
              signals,
              scoringVersion: version,
              competitor: competitor._id,
              weekOf,
            },
          },
          { upsert: true, setDefaultsOnInsert: true }
        );
        snapshots += 1;
      }
    }

    res.json({ created, updated, snapshots, errors });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Rankings (Weekly Growth Score board) ─────────────────────────────────────

// Competitors ranked by their score for a week, with movement vs the prior week.
export const getRankings = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const week = req.query.weekOf
      ? mondayOf(req.query.weekOf)
      : (await CompetitorSnapshot.findOne({}).sort({ weekOf: -1 }).select('weekOf'))
          ?.weekOf ?? mondayOf(new Date());
    const prevWeek = new Date(week.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [current, previous] = await Promise.all([
      CompetitorSnapshot.find({ weekOf: week }).populate(
        'competitor',
        'name city instagram category'
      ),
      CompetitorSnapshot.find({ weekOf: prevWeek }).select('competitor score'),
    ]);
    const prevById = new Map(
      previous.map((s) => [s.competitor.toString(), s.score])
    );

    const rows = current
      .filter((s) => s.competitor) // guard orphaned snapshots
      .map((s) => {
        const prevScore = prevById.get(s.competitor._id.toString());
        return {
          competitorId: s.competitor._id,
          name: s.competitor.name,
          city: s.competitor.city,
          category: s.competitor.category,
          instagram: s.competitor.instagram,
          score: s.score,
          engagementRate: s.engagementRate,
          weeklyGrowthPct: s.weeklyGrowthPct,
          seoScore: s.seoScore,
          collaborations: s.collaborations,
          signals: s.signals ?? [],
          previousScore: prevScore ?? null,
          movement: prevScore == null ? null : s.score - prevScore,
          snapshotId: s._id,
        };
      });

    // Overall ranking with SRS tie-breaks (FR-2.5): score, then engagement rate,
    // then follower growth, then alphabetical.
    const overall = [...rows].sort(
      (a, b) =>
        b.score - a.score ||
        b.engagementRate - a.engagementRate ||
        b.weeklyGrowthPct - a.weeklyGrowthPct ||
        String(a.name).localeCompare(String(b.name))
    );
    overall.forEach((r, i) => {
      r.rank = i + 1;
    });

    // Top-25 sub-leaderboards (FR-2.4). Reels ~ engagement, Websites ~ SEO,
    // Collaborations ~ partnership count.
    const board = (sortKey) =>
      [...rows]
        .sort((a, b) => (b[sortKey] || 0) - (a[sortKey] || 0) || b.score - a.score)
        .slice(0, 25)
        .map((r, i) => ({
          rank: i + 1,
          competitorId: r.competitorId,
          name: r.name,
          city: r.city,
          metric: r[sortKey] || 0,
          score: r.score,
        }));

    res.json({
      weekOf: week,
      previousWeekOf: prevWeek,
      rankings: overall,
      top25: overall.slice(0, 25),
      leaderboards: {
        reels: board('engagementRate'),
        websites: board('seoScore'),
        collaborations: board('collaborations'),
      },
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// ── Scoring config (versioned weights — FR-2.3) ──────────────────────────────

export const getScoringConfig = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const active = await ScoringConfig.findOne({ active: true }).sort({
      version: -1,
    });
    const weights = active
      ? { ...SRS_DEFAULT_WEIGHTS, ...(active.weights?.toObject?.() ?? active.weights) }
      : { ...SRS_DEFAULT_WEIGHTS };
    res.json({
      version: active?.version ?? 1,
      weights,
      max: 25,
      labels: SIGNAL_LABELS,
      defaults: SRS_DEFAULT_WEIGHTS,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// A weight change creates a NEW active version (applies from the next run only).
export const updateScoringConfig = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const incoming = req.body.weights ?? {};
    const weights = {};
    for (const key of SIGNAL_KEYS) {
      const v = Number(incoming[key]);
      weights[key] = Number.isFinite(v) && v >= 0 ? v : SRS_DEFAULT_WEIGHTS[key];
    }
    const last = await ScoringConfig.findOne({}).sort({ version: -1 });
    const version = (last?.version ?? 0) + 1;
    await ScoringConfig.updateMany({ active: true }, { $set: { active: false } });
    const cfg = await ScoringConfig.create({
      version,
      weights,
      active: true,
      createdBy: req.user?._id ?? null,
      note: String(req.body.note ?? '').trim(),
    });
    res.status(201).json({ version: cfg.version, weights: cfg.weights });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// 12-week Growth-Score trend for one competitor (FR-2.6).
export const getScoreTrend = async (req, res) => {
  if (!canManageMarketing(req.user)) {
    return res.status(403).json({ message: 'No access' });
  }
  try {
    const snaps = await CompetitorSnapshot.find({
      competitor: req.params.id,
    })
      .sort({ weekOf: -1 })
      .limit(12)
      .select('weekOf score signals');
    res.json({
      competitorId: req.params.id,
      trend: snaps
        .reverse()
        .map((s) => ({ weekOf: s.weekOf, score: s.score })),
      latestSignals: snaps.length ? snaps[snaps.length - 1].signals : [],
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
