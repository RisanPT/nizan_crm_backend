import asyncHandler from 'express-async-handler';
import OKR from '../models/OKR.js';
import Employee from '../models/Employee.js';
import { canViewOKR, canManageOKR, filterViewableOKRs } from '../utils/okrAccess.js';

// @desc    Get all OKRs with optional filters
// @route   GET /api/okrs
// @access  Private
export const getOKRs = asyncHandler(async (req, res) => {
  const { projectId, department, status, completed, search, scope } = req.query;
  const filter = {};

  // scope=company → only planning OKRs (company + department level), i.e. those
  // NOT tied to a specific project. Powers the Company Planning Dashboard.
  if (scope === 'company') {
    filter.projectId = null;
  } else if (projectId && projectId !== 'all') {
    filter.projectId = projectId;
  }
  if (department) {
    filter.department = department;
  }
  if (status) {
    filter.status = status;
  }
  if (completed === 'true') {
    filter.status = 'completed';
  } else if (completed === 'false') {
    filter.status = { $ne: 'completed' };
  }
  if (search) {
    filter.objective = { $regex: search, $options: 'i' };
  }

  const okrs = await OKR.find(filter)
    .populate('projectHeadId', 'name email role department')
    .sort({ order: 1, createdAt: 1 })
    .lean();

  // Scope results to what the caller may view: project OKRs follow project
  // access; company-wide are visible to all; department OKRs to that department.
  res.json(await filterViewableOKRs(req.user, okrs));
});

// @desc    Get single OKR by ID
// @route   GET /api/okrs/:id
// @access  Private
export const getOKRById = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id)
    .populate('projectHeadId', 'name email role department')
    .lean();

  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }

  if (!(await canViewOKR(req.user, okr))) {
    res.status(403);
    throw new Error('You do not have access to this objective');
  }

  res.json(okr);
});

// @desc    Create new OKR / Key Result
// @route   POST /api/okrs
// @access  Private
export const createOKR = asyncHandler(async (req, res) => {
  const {
    projectId,
    department,
    objective,
    description,
    projectHeadId,
    projectHeadName,
    startDate,
    deadline,
    status,
    priority,
    progress,
    keyResults,
    documents,
    parentObjectiveId,
    order,
  } = req.body;

  if (!objective || !objective.trim()) {
    res.status(400);
    throw new Error('Objective title is required');
  }

  // Authorize against the TARGET scope: a project OKR needs project access; a
  // company-wide OKR needs leadership; a department OKR needs that dept's head.
  const canCreate = await canManageOKR(req.user, {
    projectId: projectId || null,
    department: department || 'research-and-development',
  });
  if (!canCreate) {
    res.status(403);
    throw new Error('You are not authorized to create an objective in this scope');
  }

  let headName = projectHeadName || '';
  if (projectHeadId && !headName) {
    const emp = await Employee.findById(projectHeadId);
    if (emp) headName = emp.name;
  }

  const okr = await OKR.create({
    projectId: projectId || null,
    department: department || 'research-and-development',
    objective: objective.trim(),
    description: description || '',
    projectHeadId: projectHeadId || null,
    projectHeadName: headName,
    startDate: startDate ? new Date(startDate) : null,
    deadline: deadline ? new Date(deadline) : null,
    status: status || 'in-progress',
    priority: priority || 'high',
    progress: typeof progress === 'number' ? Math.min(100, Math.max(0, progress)) : 0,
    keyResults: Array.isArray(keyResults) ? keyResults : [],
    documents: Array.isArray(documents) ? documents : [],
    parentObjectiveId: parentObjectiveId || null,
    order: typeof order === 'number' ? order : 0,
  });

  res.status(201).json(okr);
});

// @desc    Update OKR / Key Result
// @route   PUT /api/okrs/:id
// @access  Private
export const updateOKR = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id);

  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }

  if (!(await canManageOKR(req.user, okr))) {
    res.status(403);
    throw new Error('You are not authorized to edit this objective');
  }

  const updates = req.body;

  if (updates.projectHeadId !== undefined) {
    okr.projectHeadId = updates.projectHeadId || null;
    if (updates.projectHeadName !== undefined) {
      okr.projectHeadName = updates.projectHeadName;
    } else if (updates.projectHeadId) {
      const emp = await Employee.findById(updates.projectHeadId);
      if (emp) okr.projectHeadName = emp.name;
    } else {
      okr.projectHeadName = '';
    }
  }

  if (updates.objective !== undefined) okr.objective = updates.objective.trim();
  if (updates.description !== undefined) okr.description = updates.description;
  if (updates.startDate !== undefined) okr.startDate = updates.startDate ? new Date(updates.startDate) : null;
  if (updates.deadline !== undefined) okr.deadline = updates.deadline ? new Date(updates.deadline) : null;
  if (updates.status !== undefined) okr.status = updates.status;
  if (updates.priority !== undefined) okr.priority = updates.priority;
  if (updates.progress !== undefined) okr.progress = Math.min(100, Math.max(0, Number(updates.progress)));
  if (updates.keyResults !== undefined) okr.keyResults = updates.keyResults;
  if (updates.documents !== undefined) okr.documents = updates.documents;
  if (updates.order !== undefined) okr.order = updates.order;
  if (updates.parentObjectiveId !== undefined) okr.parentObjectiveId = updates.parentObjectiveId;

  const saved = await okr.save();
  res.json(saved);
});

// @desc    Delete OKR / Key Result
// @route   DELETE /api/okrs/:id
// @access  Private
export const deleteOKR = asyncHandler(async (req, res) => {
  const okr = await OKR.findById(req.params.id);

  if (!okr) {
    res.status(404);
    throw new Error('OKR not found');
  }

  if (!(await canManageOKR(req.user, okr))) {
    res.status(403);
    throw new Error('You are not authorized to delete this objective');
  }

  // Also clean up any sub-objectives that referenced this one
  await OKR.deleteMany({ parentObjectiveId: req.params.id });
  await okr.deleteOne();

  res.json({ message: 'OKR removed successfully' });
});
