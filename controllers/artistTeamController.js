import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import ArtistTeam from '../models/ArtistTeam.js';
import { cleanTeamInput, loadTeams, teamCandidates, teamWarnings, _resetTeamCache } from '../services/artistTeams.js';
import { teamsDayLoad } from '../services/artistAllocation.js';
import { mayManageTeams } from '../utils/allocationAccess.js';
import { isDay, todayIst } from '../utils/istDate.js';

// /api/artist-teams — the CRM's Artist Management: the in-house teams the allocation shares new works between.

const MANAGE_ONLY = 'Only the CRM team, the Artist Head or a manager can change the teams.';

// @route GET /api/artist-teams?day=YYYY-MM-DD&inactive=1 — the teams (with that day's load)
export const listTeams = asyncHandler(async (req, res) => {
  const all = await loadTeams({ includeInactive: req.query.inactive === '1', fresh: true });
  const day = isDay(req.query.day) ? String(req.query.day) : todayIst();
  let load = new Map();
  try {
    load = await teamsDayLoad(day, req.user);
  } catch (e) {
    console.error('[artist-teams] day load failed:', e?.message ?? e);
  }
  res.json({ day, canManage: mayManageTeams(req.user), teams: all.map((t) => ({ ...t, load: load.get(t.id) ?? null, warnings: teamWarnings(t, all) })) });
});

// @route GET /api/artist-teams/candidates — who can lead or assist
export const listCandidates = asyncHandler(async (_req, res) => {
  res.json({ people: await teamCandidates() });
});

const guard = (req, res) => {
  if (mayManageTeams(req.user)) return true;
  res.status(403).json({ message: MANAGE_ONLY });
  return false;
};

// @route POST /api/artist-teams
export const createTeam = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  const v = await cleanTeamInput(req.body ?? {}, null);
  if (!v.ok) return res.status(v.status).json({ message: v.message });
  const last = await ArtistTeam.findOne({ active: true }).sort({ rotationOrder: -1 }).select('rotationOrder').lean();
  try {
    await ArtistTeam.create({ ...v.value, rotationOrder: (last?.rotationOrder ?? 0) + 1, updatedBy: req.user._id, updatedByName: req.user.name ?? '' });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ message: 'She already leads a team.' });
    throw e;
  }
  _resetTeamCache();
  res.status(201).json({ teams: await loadTeams({ fresh: true }) });
});

// @route PUT /api/artist-teams/:id
export const updateTeam = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'That team was not found.' });
  const team = await ArtistTeam.findById(req.params.id).lean();
  if (!team) return res.status(404).json({ message: 'That team was not found.' });
  const v = await cleanTeamInput(req.body ?? {}, team);
  if (!v.ok) return res.status(v.status).json({ message: v.message });
  try {
    await ArtistTeam.updateOne({ _id: team._id }, { $set: { ...v.value, updatedBy: req.user._id, updatedByName: req.user.name ?? '' } });
  } catch (e) {
    if (e?.code === 11000) return res.status(409).json({ message: 'She already leads a team.' });
    throw e;
  }
  _resetTeamCache();
  res.json({ teams: await loadTeams({ fresh: true, includeInactive: true }) });
});

// @route PUT /api/artist-teams/order { ids } — the rotation, top to bottom
export const reorderTeams = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(String);
  const active = await ArtistTeam.find({ active: true }).select('_id').lean();
  const set = new Set(active.map((t) => String(t._id)));
  if (ids.length !== set.size || ids.some((x) => !set.has(x)) || new Set(ids).size !== ids.length) return res.status(400).json({ message: 'Send every active team once, in the new order.' });
  await ArtistTeam.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id }, update: { $set: { rotationOrder: i + 1 } } } })));
  _resetTeamCache();
  res.json({ teams: await loadTeams({ fresh: true }) });
});

// @route DELETE /api/artist-teams/:id — the team stops taking new works (kept, inactive)
export const deactivateTeam = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ message: 'That team was not found.' });
  const r = await ArtistTeam.updateOne({ _id: req.params.id }, { $set: { active: false, updatedBy: req.user._id, updatedByName: req.user.name ?? '' } });
  if (!r.matchedCount) return res.status(404).json({ message: 'That team was not found.' });
  _resetTeamCache();
  res.json({ teams: await loadTeams({ fresh: true, includeInactive: true }) });
});
