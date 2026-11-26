import mongoose from 'mongoose';
import Employee from '../models/Employee.js';
import ITTask from '../models/ITTask.js';
import ProjectAllocation from '../models/ProjectAllocation.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';
import { isDone } from '../utils/taskExtension.js';
import { idStr, listNames } from '../utils/projectPeople.js';
import { hrUserIds } from './hrPeople.js';

// The writing side of a change to a project's people: who has work on it (open tasks, an HR placement) before they are taken
// off, what happens to that work, and telling the people concerned.

const oids = (ids) => ids.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
const startOfToday = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate());

/// Everyone the checks may need (name, department, category, status).
export const loadStaff = () => Employee.find({}).select('name department category status').lean();

/// What each of [ids] still has on the project: open tasks and an HR placement that has not ended. Only people with something.
export const workOf = async (projectId, ids, { now = new Date() } = {}) => {
  if (!ids.length) return [];
  const [tasks, placements] = await Promise.all([
    ITTask.find({ projectId, assignedTo: { $in: oids(ids) } }).select('assignedTo status percentComplete').lean(),
    ProjectAllocation.find({ projectId, employeeId: { $in: oids(ids) }, status: 'active', to: { $gte: startOfToday(now) } })
      .select('employeeId to percent')
      .lean(),
  ]);
  return ids
    .map((id) => {
      const open = tasks.filter((t) => idStr(t.assignedTo) === id && !isDone(t)).length;
      const p = placements.find((a) => idStr(a.employeeId) === id);
      return { id, openTasks: open, placement: p ? { to: p.to, percent: p.percent } : null };
    })
    .filter((w) => w.openTasks > 0 || w.placement);
};

/// The people taken off: their open tasks lose their assignee when [unassignTasks], and their HR placement ends today.
export const settleRemovals = async (projectId, ids, { unassignTasks = false, now = new Date() } = {}) => {
  if (!ids.length) return { unassigned: 0, unassignedById: {}, ended: 0, endedIds: [] };
  let unassigned = 0;
  const unassignedById = {};
  if (unassignTasks) {
    const open = (await ITTask.find({ projectId, assignedTo: { $in: oids(ids) } }).select('assignedTo status percentComplete').lean()).filter((t) => !isDone(t));
    if (open.length) {
      for (const t of open) unassignedById[idStr(t.assignedTo)] = (unassignedById[idStr(t.assignedTo)] ?? 0) + 1;
      const r = await ITTask.updateMany({ _id: { $in: open.map((t) => t._id) } }, { $set: { assignedTo: null } });
      unassigned = r.modifiedCount ?? open.length;
    }
  }
  const placements = await ProjectAllocation.find({ projectId, employeeId: { $in: oids(ids) }, status: 'active', to: { $gte: startOfToday(now) } }).lean();
  for (const a of placements) {
    await ProjectAllocation.updateOne({ _id: a._id }, { $set: { status: 'ended', to: a.to > now ? now : a.to } });
  }
  return { unassigned, unassignedById, ended: placements.length, endedIds: [...new Set(placements.map((a) => idStr(a.employeeId)))] };
};

const link = (project) => `/projects/${project._id}`;

/// Tells the people concerned: the new manager, those who joined, those taken off (and HR when a placement ended).
export const notifyTeamChange = async (project, change, actor, nameOf, work = {}) => {
  const by = actor?.name ?? 'A colleague';
  const base = { link: link(project), createdBy: actor?._id ?? null, excludeUserId: actor?._id ?? null, type: NOTIFICATION_TYPES.PROJECT_TEAM };
  if (change.managerChanged && change.to) {
    await notify({
      ...base,
      recipients: await getUserIdsByEmployeeIds([change.to]),
      title: `You now manage ${project.name}`,
      body: `${by} made you the project manager of ${project.name} (${project.targetDepartment}).`,
    });
  }
  const joined = change.added.filter((id) => id !== change.to);
  if (joined.length) {
    await notify({
      ...base,
      recipients: await getUserIdsByEmployeeIds(joined),
      title: `You're on the team of ${project.name}`,
      body: `${by} added you to ${project.name} (${project.targetDepartment}). You can open it, and its tasks can be given to you.`,
    });
  }
  for (const id of change.removed) {
    const tasksGone = work.unassignedById?.[id] ?? 0;
    await notify({
      ...base,
      recipients: await getUserIdsByEmployeeIds([id]),
      title: `You were taken off ${project.name}`,
      body: `${by} took you off the team of ${project.name}.${work.unassigned && tasksGone ? ` Your ${tasksGone} open task${tasksGone === 1 ? '' : 's'} on it no longer have you as assignee.` : ''}`,
    });
  }
  if (work.endedIds?.length) {
    await notify({
      recipients: await hrUserIds(),
      type: NOTIFICATION_TYPES.MANPOWER_UPDATE,
      title: `${listNames(work.endedIds.map(nameOf))} taken off ${project.name}`,
      body: `${by} took ${listNames(work.endedIds.map(nameOf))} off ${project.name}, so ${work.endedIds.length === 1 ? 'the placement' : 'their placements'} ended today. Their time is free for other work.`,
      link: '/manpower',
      createdBy: actor?._id ?? null,
      excludeUserId: actor?._id ?? null,
    });
  }
};
