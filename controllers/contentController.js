import asyncHandler from 'express-async-handler';
import ContentItem from '../models/ContentItem.js';
import { permissionsForRole } from './roleController.js';

// Marketing access — role fast-path plus the permission-driven check, so a
// custom role granted the `marketing` feature also works (see the IT module).
const MARKETING_ROLE_KEYS = new Set(['admin', 'manager', 'marketing_admin']);
const canManageMarketing = async (u) => {
  if (!u) return false;
  if (MARKETING_ROLE_KEYS.has(u.role)) return true;
  try {
    return (await permissionsForRole(u.role)).includes('marketing');
  } catch {
    return false;
  }
};

const STATUSES = ['idea', 'planned', 'in-progress', 'scheduled', 'published', 'cancelled'];
const PLATFORMS = ['instagram', 'youtube', 'facebook', 'whatsapp', 'website', 'other'];
const TYPES = ['reel', 'post', 'story', 'carousel', 'video', 'blog', 'other'];

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// @route GET /api/content — list content, optionally within a [from,to] window.
export const getContentItems = asyncHandler(async (req, res) => {
  if (!(await canManageMarketing(req.user))) { res.status(403); throw new Error('Only marketing can view content'); }
  const { from, to, status, platform } = req.query;
  const q = {};
  if (from || to) {
    q.scheduledDate = {};
    if (from) q.scheduledDate.$gte = new Date(from);
    if (to) { const e = new Date(to); e.setHours(23, 59, 59, 999); q.scheduledDate.$lte = e; }
  }
  if (status) q.status = status;
  if (platform) q.platform = platform;
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
  const item = await ContentItem.create({
    title: String(b.title).trim(),
    description: String(b.description ?? '').trim(),
    platform: PLATFORMS.includes(b.platform) ? b.platform : 'instagram',
    contentType: TYPES.includes(b.contentType) ? b.contentType : 'reel',
    status,
    scheduledDate: new Date(b.scheduledDate),
    publishedDate: b.publishedDate ? new Date(b.publishedDate) : (status === 'published' ? new Date() : null),
    assignedTo: b.assignedTo || null,
    assignedToName: b.assignedToName || '',
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
  if (b.title !== undefined) item.title = String(b.title).trim();
  if (b.description !== undefined) item.description = String(b.description);
  if (b.platform !== undefined && PLATFORMS.includes(b.platform)) item.platform = b.platform;
  if (b.contentType !== undefined && TYPES.includes(b.contentType)) item.contentType = b.contentType;
  if (b.scheduledDate !== undefined) item.scheduledDate = new Date(b.scheduledDate);
  if (b.assignedTo !== undefined) { item.assignedTo = b.assignedTo || null; item.assignedToName = b.assignedToName || ''; }
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
