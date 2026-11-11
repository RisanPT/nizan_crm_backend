import asyncHandler from 'express-async-handler';
import StrategicVision from '../models/StrategicVision.js';
import Project from '../models/Project.js';
import OKR from '../models/OKR.js';
import { seesAllProjects } from '../utils/projectAccess.js';

// Helper: Ensure one active strategic vision exists
export const getOrCreateVision = async () => {
  let vision = await StrategicVision.findOne({ status: 'active' }).populate('milestones.linkedProjectIds', 'name status progress targetDepartment');
  if (!vision) {
    vision = await StrategicVision.create({});
    vision = await StrategicVision.findById(vision._id).populate('milestones.linkedProjectIds', 'name status progress targetDepartment');
  }
  return vision;
};

// @desc    Get active 15-Year Strategic Vision and Milestones
// @route   GET /api/strategic-vision
// @access  Private
export const getStrategicVision = asyncHandler(async (req, res) => {
  const vision = await getOrCreateVision();
  res.json(vision);
});

// @desc    Update Strategic Vision (statement, pillars, horizons)
// @route   PUT /api/strategic-vision
// @access  Private (Leadership only)
export const updateStrategicVision = asyncHandler(async (req, res) => {
  if (!(await seesAllProjects(req.user))) {
    res.status(403);
    throw new Error('Only leadership may modify the strategic vision.');
  }

  const vision = await getOrCreateVision();
  const { title, visionStatement, startYear, targetYear, horizons, pillars } = req.body;

  if (title !== undefined) vision.title = title;
  if (visionStatement !== undefined) vision.visionStatement = visionStatement;
  if (startYear !== undefined) vision.startYear = startYear;
  if (targetYear !== undefined) vision.targetYear = targetYear;
  if (horizons !== undefined) vision.horizons = horizons;
  if (pillars !== undefined) vision.pillars = pillars;
  vision.updatedBy = req.user._id;

  const saved = await vision.save();
  res.json(saved);
});

// @desc    Create or update a Gateway Milestone
// @route   POST /api/strategic-vision/milestones
// @access  Private
export const addOrUpdateMilestone = asyncHandler(async (req, res) => {
  if (!(await seesAllProjects(req.user))) {
    res.status(403);
    throw new Error('Only leadership may configure strategic milestones.');
  }

  const vision = await getOrCreateVision();
  const data = req.body;

  if (!data.title || !data.pillarId || !data.targetYear) {
    res.status(400);
    throw new Error('Title, pillar, and target year are required.');
  }

  const existingIdx = vision.milestones.findIndex((m) => m.id === data.id);
  if (existingIdx >= 0) {
    vision.milestones[existingIdx] = {
      ...vision.milestones[existingIdx].toObject(),
      ...data,
    };
  } else {
    vision.milestones.push(data);
  }

  vision.updatedBy = req.user._id;
  await vision.save();

  const refreshed = await StrategicVision.findById(vision._id).populate('milestones.linkedProjectIds', 'name status progress targetDepartment');
  res.json(refreshed);
});

// @desc    Delete a Gateway Milestone
// @route   DELETE /api/strategic-vision/milestones/:id
// @access  Private
export const deleteMilestone = asyncHandler(async (req, res) => {
  if (!(await seesAllProjects(req.user))) {
    res.status(403);
    throw new Error('Only leadership may remove strategic milestones.');
  }

  const vision = await getOrCreateVision();
  vision.milestones = vision.milestones.filter((m) => m.id !== req.params.id);
  vision.updatedBy = req.user._id;
  await vision.save();

  const refreshed = await StrategicVision.findById(vision._id).populate('milestones.linkedProjectIds', 'name status progress targetDepartment');
  res.json(refreshed);
});

// @desc    Get Strategic Alignment Overview (Projects & OKRs mapped by Horizon)
// @route   GET /api/strategic-vision/alignment
// @access  Private
export const getStrategicAlignment = asyncHandler(async (req, res) => {
  const vision = await getOrCreateVision();
  const projects = await Project.find({ status: { $ne: 'cancelled' } })
    .select('name status progress targetDepartment horizonNumber strategicPillar targetYear startDate endDate')
    .lean();

  const okrs = await OKR.find({})
    .select('objective progress status department level projectId')
    .lean();

  // Dynamically categorize projects across configured horizons
  const projectsByHorizon = {};
  const horizonStats = [];
  for (const h of vision.horizons) {
    const list = projects.filter((p) => (p.horizonNumber || 1) === h.horizonNumber);
    projectsByHorizon[`h${h.horizonNumber}`] = list;
    horizonStats.push({
      horizonNumber: h.horizonNumber,
      name: h.name,
      startYear: h.startYear,
      endYear: h.endYear,
      count: list.length,
      avgProgress: list.length ? Math.round(list.reduce((s, p) => s + (p.progress || 0), 0) / list.length) : 0,
    });
  }

  res.json({
    vision: {
      title: vision.title,
      startYear: vision.startYear,
      targetYear: vision.targetYear,
      visionStatement: vision.visionStatement,
    },
    horizons: vision.horizons,
    pillars: vision.pillars,
    milestones: vision.milestones,
    distribution: {
      totalProjects: projects.length,
      horizonStats,
      totalOkrs: okrs.length,
    },
    projectsByHorizon,
  });
});

