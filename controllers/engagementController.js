import asyncHandler from 'express-async-handler';
import Announcement from '../models/Announcement.js';
import { isHrWide } from '../utils/hrDeptScope.js';
import { resolveUserDeptName } from '../utils/departmentScope.js';
import { escapeRegex } from '../utils/escapeRegex.js';

// Department heads may post, but only HR-wide callers may edit/delete posts
// they did not create (owner decision 2026-11-06).
const HR_KEYS = ['engagement'];
const assertCanEdit = async (req, res, row) => {
  if (await isHrWide(req, HR_KEYS)) return;
  if (row.postedBy && req.user?._id && String(row.postedBy) === String(req.user._id)) return;
  res.status(403);
  throw new Error('You can only change posts you created');
};

const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager' || role === 'hr') return true;
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

// HR (role or HR-wide scope) sees every post; everyone else sees posts for
// 'all', for their own department, and the ones they posted themselves.
const seesAllAudiences = async (req) =>
  String(req.user?.role || '').trim().toLowerCase() === 'hr' || (await isHrWide(req, HR_KEYS));

const audienceFilter = async (req) => {
  if (await seesAllAudiences(req)) return null;
  const or = [{ audience: { $in: [null, ''] } }, { audience: /^\s*all\s*$/i }];
  const dept = await resolveUserDeptName(req.user);
  if (dept) or.push({ audience: new RegExp(`^\\s*${escapeRegex(dept)}\\s*$`, 'i') });
  if (req.user?._id) or.push({ postedBy: req.user._id });
  return or;
};

// @route GET /api/engagement  — the feed (everyone reads active items meant for them)
const getAnnouncements = asyncHandler(async (req, res) => {
  const filter = { active: true };
  if (req.query.category && req.query.category !== 'all') filter.category = req.query.category;
  const or = await audienceFilter(req);
  if (or) filter.$or = or;
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
  await assertCanEdit(req, res, row);
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
  const row = await Announcement.findById(req.params.id);
  if (!row) { res.status(404); throw new Error('Announcement not found'); }
  await assertCanEdit(req, res, row);
  await row.deleteOne();
  res.json({ message: 'Announcement removed', id: req.params.id });
});

export { getAnnouncements, createAnnouncement, updateAnnouncement, deleteAnnouncement };
