import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import ContentItem from '../models/ContentItem.js';
import MarketingAsset from '../models/MarketingAsset.js';
import MarketingShoot from '../models/MarketingShoot.js';
import { permissionsForRole } from './roleController.js';
import { isUsableAsset, platformOf } from '../utils/marketingSocialsInput.js';

// Marketing access — role fast-path plus the permission-driven check, so a
// custom role granted the `marketing` feature also works (see the IT module).
const MARKETING_ROLE_KEYS = new Set(['admin', 'manager', 'marketing_admin']);
export const canManageMarketing = async (u) => {
  if (!u) return false;
  if (MARKETING_ROLE_KEYS.has(u.role)) return true;
  try {
    return (await permissionsForRole(u.role)).includes('marketing');
  } catch {
    return false;
  }
};

const STATUSES = ['idea', 'planned', 'in-progress', 'in-review', 'scheduled', 'published', 'cancelled'];
const BRANDS = ['main', 'kerala'];
const METRIC_KEYS = ['reach', 'impressions', 'views', 'likes', 'comments', 'reposts', 'shares', 'saves', 'linkClicks'];
/** A metrics object from a request body: only the known counts, each a whole number ≥ 0. */
export const cleanMetrics = (m) => {
  const out = {};
  if (!m || typeof m !== 'object') return out;
  for (const k of METRIC_KEYS) {
    if (m[k] === undefined || m[k] === null || m[k] === '') continue;
    const n = Number(m[k]);
    if (Number.isFinite(n) && n >= 0) out[k] = Math.round(n);
  }
  return out;
};
const TYPES = ['reel', 'trial_reel', 'post', 'story', 'carousel', 'collab', 'video', 'image', 'blog', 'other'];

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

const bad = (res, message, status = 400) => {
  res.status(status);
  throw new Error(message);
};

/**
 * The asset and shoot a post is linked to, checked. A post can only be made from an APPROVED or FINAL asset, and it then belongs to
 * that asset's shoot (the server decides — what the app sends as the shoot is ignored while there is an asset). A post with no asset
 * can name the shoot it was planned for. A post already on an asset keeps it even if the asset was later sent back for changes; only
 * a new link is checked. → {} (nothing sent) | { assetId, shootId } | { error }
 */
const postLinks = async (b, current = null) => {
  const sentAsset = b.assetId !== undefined;
  const sentShoot = b.shootId !== undefined;
  if (!sentAsset && !sentShoot) return {};
  const curAsset = current?.assetId ? String(current.assetId) : '';
  const assetId = sentAsset ? (b.assetId ? String(b.assetId) : '') : curAsset;
  if (assetId) {
    if (!mongoose.isValidObjectId(assetId)) return { error: 'That asset was not found.' };
    const asset = await MarketingAsset.findById(assetId).select('stage isFinal shootId').lean();
    if (!asset && assetId === curAsset) return { assetId: current.assetId, shootId: current.shootId ?? null }; // its own link: never blocks an edit
    if (!asset) return { error: 'That asset was not found.' };
    if (assetId !== curAsset && !isUsableAsset(asset)) return { error: 'Only an approved or final asset can be posted. Approve it in Content & Assets first.' };
    return { assetId: asset._id, shootId: asset.shootId ?? null };
  }
  // no asset: the shoot it was planned for, when one is named (taking the asset off a post also takes off the shoot it brought)
  const shootId = sentShoot ? (b.shootId ? String(b.shootId) : '') : '';
  if (!shootId) return { assetId: null, shootId: null };
  if (!mongoose.isValidObjectId(shootId) || !(await MarketingShoot.exists({ _id: shootId }))) return { error: 'That shoot was not found.' };
  return { assetId: null, shootId: new mongoose.Types.ObjectId(shootId) };
};

// @route GET /api/content — list content, optionally within a [from,to] window.
export const getContentItems = asyncHandler(async (req, res) => {
  if (!(await canManageMarketing(req.user))) { res.status(403); throw new Error('Only marketing can view content'); }
  const { from, to, status, platform, brand } = req.query;
  const q = {};
  if (from || to) {
    q.scheduledDate = {};
    if (from) q.scheduledDate.$gte = new Date(from);
    if (to) { const e = new Date(to); e.setHours(23, 59, 59, 999); q.scheduledDate.$lte = e; }
  }
  if (status) q.status = status;
  if (platform) q.platform = platform;
  if (BRANDS.includes(brand)) q.brand = brand;
  const items = await ContentItem.find(q)
    .populate('assignedTo', 'name')
    .sort({ scheduledDate: 1 })
    .limit(3000)
    .lean();
  res.json(items);
});

// @route POST /api/content
export const createContentItem = asyncHandler(async (req, res) => {
  if (!(await canManageMarketing(req.user))) { res.status(403); throw new Error('Only marketing can add content'); }
  const b = req.body;
  if (!b.title || !String(b.title).trim()) { res.status(400); throw new Error('Title is required'); }
  if (!b.scheduledDate) { res.status(400); throw new Error('A scheduled date is required'); }
  const status = STATUSES.includes(b.status) ? b.status : 'idea';
  // a platform that is not on the list is refused — never quietly saved as Instagram
  const platform = b.platform === undefined || b.platform === null || b.platform === '' ? 'instagram' : platformOf(b.platform);
  if (!platform) bad(res, 'Choose a platform from the list.');
  const links = await postLinks(b);
  if (links.error) bad(res, links.error);
  const item = await ContentItem.create({
    title: String(b.title).trim(),
    description: String(b.description ?? '').trim(),
    platform,
    contentType: TYPES.includes(b.contentType) ? b.contentType : 'reel',
    status,
    scheduledDate: new Date(b.scheduledDate),
    publishedDate: b.publishedDate ? new Date(b.publishedDate) : (status === 'published' ? new Date() : null),
    assignedTo: b.assignedTo || null,
    assignedToName: b.assignedToName || '',
    brand: BRANDS.includes(b.brand) ? b.brand : 'main',
    permalink: String(b.permalink ?? '').trim(),
    thumbUrl: String(b.thumbUrl ?? '').trim(),
    metrics: cleanMetrics(b.metrics),
    assetId: links.assetId ?? null,
    shootId: links.shootId ?? null,
    campaign: String(b.campaign ?? '').trim(),
    caption: String(b.caption ?? ''),
    hashtags: Array.isArray(b.hashtags) ? b.hashtags.filter((h) => String(h ?? '').trim()) : [],
    mediaUrls: Array.isArray(b.mediaUrls) ? b.mediaUrls.filter((u) => String(u ?? '').trim()) : [],
    notes: String(b.notes ?? ''),
    createdBy: req.user._id,
  });
  res.status(201).json(item);
});

// @route PUT /api/content/:id
export const updateContentItem = asyncHandler(async (req, res) => {
  if (!(await canManageMarketing(req.user))) { res.status(403); throw new Error('Only marketing can edit content'); }
  const item = await ContentItem.findById(req.params.id);
  if (!item) { res.status(404); throw new Error('Content not found'); }
  const b = req.body;
  if (b.platform !== undefined) {
    const platform = platformOf(b.platform);
    if (!platform) bad(res, 'Choose a platform from the list.');
    item.platform = platform;
  }
  const links = await postLinks(b, item);
  if (links.error) bad(res, links.error);
  if (links.assetId !== undefined) {
    item.assetId = links.assetId;
    item.shootId = links.shootId;
  }
  if (b.title !== undefined) item.title = String(b.title).trim();
  if (b.description !== undefined) item.description = String(b.description);
  if (b.contentType !== undefined && TYPES.includes(b.contentType)) item.contentType = b.contentType;
  if (b.scheduledDate !== undefined) item.scheduledDate = new Date(b.scheduledDate);
  if (b.assignedTo !== undefined) { item.assignedTo = b.assignedTo || null; item.assignedToName = b.assignedToName || ''; }
  if (b.brand !== undefined && BRANDS.includes(b.brand)) item.brand = b.brand;
  if (b.permalink !== undefined) item.permalink = String(b.permalink).trim();
  if (b.thumbUrl !== undefined) item.thumbUrl = String(b.thumbUrl).trim();
  if (b.metrics !== undefined) item.metrics = { ...(item.metrics?.toObject?.() ?? item.metrics ?? {}), ...cleanMetrics(b.metrics) };
  if (b.campaign !== undefined) item.campaign = String(b.campaign);
  if (b.caption !== undefined) item.caption = String(b.caption);
  if (b.hashtags !== undefined) item.hashtags = Array.isArray(b.hashtags) ? b.hashtags.filter((h) => String(h ?? '').trim()) : [];
  if (b.mediaUrls !== undefined) item.mediaUrls = Array.isArray(b.mediaUrls) ? b.mediaUrls.filter((u) => String(u ?? '').trim()) : [];
  if (b.notes !== undefined) item.notes = String(b.notes);
  if (b.status !== undefined && STATUSES.includes(b.status)) {
    item.status = b.status;
    if (b.status === 'published' && !item.publishedDate) item.publishedDate = new Date();
  }
  if (b.publishedDate !== undefined) item.publishedDate = b.publishedDate ? new Date(b.publishedDate) : null;
  await item.save();
  res.json(item);
});

// @route DELETE /api/content/:id
export const deleteContentItem = asyncHandler(async (req, res) => {
  if (!(await canManageMarketing(req.user))) { res.status(403); throw new Error('Only marketing can delete content'); }
  const item = await ContentItem.findByIdAndDelete(req.params.id);
  if (!item) { res.status(404); throw new Error('Content not found'); }
  res.json({ message: 'Content deleted' });
});

// @route GET /api/content/stats — dashboard counters.
export const getContentStats = asyncHandler(async (req, res) => {
  if (!(await canManageMarketing(req.user))) { res.status(403); throw new Error('Only marketing can view content stats'); }
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);

  const [total, byStatusAgg, byPlatformAgg, scheduledThisMonth, publishedThisMonth, dueThisWeek, overdue] =
    await Promise.all([
      ContentItem.countDocuments({}),
      ContentItem.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
      ContentItem.aggregate([{ $group: { _id: '$platform', n: { $sum: 1 } } }]),
      ContentItem.countDocuments({ scheduledDate: { $gte: monthStart, $lte: monthEnd } }),
      ContentItem.countDocuments({ status: 'published', scheduledDate: { $gte: monthStart, $lte: monthEnd } }),
      ContentItem.countDocuments({ scheduledDate: { $gte: weekStart, $lte: weekEnd }, status: { $nin: ['published', 'cancelled'] } }),
      ContentItem.countDocuments({ scheduledDate: { $lt: dayStart(now) }, status: { $nin: ['published', 'cancelled'] } }),
    ]);

  res.json({
    total,
    byStatus: Object.fromEntries(byStatusAgg.map((x) => [x._id, x.n])),
    byPlatform: Object.fromEntries(byPlatformAgg.map((x) => [x._id, x.n])),
    scheduledThisMonth,
    publishedThisMonth,
    dueThisWeek,
    overdue,
  });
});
