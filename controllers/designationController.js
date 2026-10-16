import asyncHandler from 'express-async-handler';
import Designation from '../models/Designation.js';
import Employee from '../models/Employee.js';

// Managing designations is an HR-admin action: full access (admin/manager) or a
// user carrying the `staff` permission key. Reading is open to any authenticated
// user (designations are organisational labels, surfaced in pickers/org charts).
const canManage = (user) => {
  const role = String(user?.role || '').toLowerCase();
  if (role === 'admin' || role === 'manager') return true;
  const perms = user?.permissions || [];
  return perms.includes('staff') || perms.includes('settings');
};

// @route GET /api/designations
const getDesignations = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.departmentId) filter.departmentId = req.query.departmentId;
  if (req.query.active === 'true') filter.active = true;
  const items = await Designation.find(filter)
    .populate('departmentId', 'name')
    .sort({ order: 1, level: 1, name: 1 })
    .lean();
  res.json(items);
});

// @route POST /api/designations
const createDesignation = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage designations');
  }
  const name = String(req.body.name || '').trim();
  if (!name) {
    res.status(400);
    throw new Error('Please provide a designation name');
  }
  const doc = await Designation.create({
    name,
    code: String(req.body.code || '').trim(),
    departmentId: req.body.departmentId || null,
    level: Number(req.body.level) || 1,
    description: String(req.body.description || '').trim(),
    order: Number(req.body.order) || 0,
    active: req.body.active !== false,
    createdBy: req.user?._id || null,
  });
  await doc.populate('departmentId', 'name');
  res.status(201).json(doc);
});

// @route PUT /api/designations/:id
const updateDesignation = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage designations');
  }
  const doc = await Designation.findById(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Designation not found');
  }
  const b = req.body;
  if (b.name !== undefined && String(b.name).trim()) doc.name = String(b.name).trim();
  if (b.code !== undefined) doc.code = String(b.code).trim();
  if (b.departmentId !== undefined) doc.departmentId = b.departmentId || null;
  if (b.level !== undefined) doc.level = Number(b.level) || 1;
  if (b.description !== undefined) doc.description = String(b.description).trim();
  if (b.order !== undefined) doc.order = Number(b.order) || 0;
  if (b.active !== undefined) doc.active = Boolean(b.active);
  await doc.save();
  await doc.populate('departmentId', 'name');
  res.json(doc);
});

// @route DELETE /api/designations/:id — blocked while employees still reference it.
const deleteDesignation = asyncHandler(async (req, res) => {
  if (!canManage(req.user)) {
    res.status(403);
    throw new Error('You are not allowed to manage designations');
  }
  const inUse = await Employee.countDocuments({ designationId: req.params.id });
  if (inUse > 0) {
    res.status(409);
    throw new Error(`Cannot delete: ${inUse} employee(s) still have this designation`);
  }
  const doc = await Designation.findByIdAndDelete(req.params.id);
  if (!doc) {
    res.status(404);
    throw new Error('Designation not found');
  }
  res.json({ message: 'Designation removed', id: req.params.id });
});

export { getDesignations, createDesignation, updateDesignation, deleteDesignation };
