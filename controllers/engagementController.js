import asyncHandler from 'express-async-handler';
import Announcement from '../models/Announcement.js';

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  if (user?.isDepartmentHead) return true;
  const perms = user?.permissions || [];
  return perms.includes('engagement') || perms.includes('staff');
};

const guard = (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage the engagement feed');
  }
};

// @route GET /api/engagement  — the feed (everyone reads active items)
const getAnnouncements = asyncHandler(async (req, res) => {
  const filter = { active: true };
  if (req.query.category && req.query.category !== 'all') filter.category = req.query.category;
  const rows = await Announcement.find(filter).sort({ pinned: -1, createdAt: -1 }).limit(200).lean();
  res.json(rows);
});

const createAnnouncement = asyncHandler(async (req, res) => {
  guard(req, res);
  const title = String(req.body.title || '').trim();
  if (!title) { res.status(400); throw new Error('Please add a title'); }
  const row = await Announcement.create({
    title,
    body: String(req.body.body || '').trim(),
    category: req.body.category || 'announcement',
    eventDate: req.body.eventDate ? new Date(req.body.eventDate) : null,
    audience: String(req.body.audience || 'all').trim() || 'all',
    pinned: Boolean(req.body.pinned),
    postedBy: req.user?._id || null,
    postedByName: req.user?.name || '',
  });
  res.status(201).json(row);
});

const updateAnnouncement = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await Announcement.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Announcement not found'); }
  const b = req.body;
  if (b.title !== undefined && String(b.title).trim()) row.title = String(b.title).trim();
  if (b.body !== undefined) row.body = String(b.body).trim();
  if (b.category !== undefined) row.category = b.category;
  if (b.eventDate !== undefined) row.eventDate = b.eventDate ? new Date(b.eventDate) : null;
  if (b.audience !== undefined) row.audience = String(b.audience).trim() || 'all';
  if (b.pinned !== undefined) row.pinned = Boolean(b.pinned);
  if (b.active !== undefined) row.active = Boolean(b.active);
  await row.save();
  res.json(row);
});

const deleteAnnouncement = asyncHandler(async (req, res) => {
  guard(req, res);
  const row = await Announcement.findByIdAndDelete(req.params.id);
  if (!row) { res.status(404); throw new Error('Announcement not found'); }
  res.json({ message: 'Announcement removed', id: req.params.id });
});

export { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement };
