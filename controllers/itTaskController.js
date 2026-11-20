import ITTask from '../models/ITTask.js';
import Project from '../models/Project.js';
import Employee from '../models/Employee.js';
import {
  buildProjectScope,
  canViewProject,
  escapeRegex,
  loadAccessContext,
  canCreateTaskIn,
  taskRights,
} from '../utils/projectAccess.js';
import { activeDepartmentNames, eqCI } from '../utils/projectDepartments.js';
import { structureChanges } from '../utils/taskPermissions.js';
import { COST_MOVING_KEYS } from '../utils/taskCost.js';
import { prepareTaskCost, finishTaskCost, redactTaskCosts } from '../services/taskCost.js';
import {
  buildExtension, checkExtension, cleanReason, dayDiff, extensionMessage, fmtDay, isDone as taskIsDone, isOverdue, overdueDays, parseDay,
} from '../utils/taskExtension.js';
import { recordActivity } from '../utils/projectActivity.js';
import { notify, NOTIFICATION_TYPES, getUserIdsByEmployeeIds } from '../utils/notify.js';

// Load a project and confirm the caller may view it. Returns the project on
// success (with the caller's access context on `req.accessCtx`), or sends the
// 404/403 response and returns null (caller must stop).
const loadViewableProject = async (req, res, projectId) => {
  if (!projectId) {
    res.status(400).json({ message: 'projectId is required' });
    return null;
  }
  const project = await Project.findById(projectId);
  if (!project) {
    res.status(404).json({ message: 'Project not found' });
    return null;
  }
  req.accessCtx = req.accessCtx ?? (await loadAccessContext(req.user));
  if (!(await canViewProject(req.user, project, req.accessCtx))) {
    res.status(403).json({ message: 'You do not have access to this project' });
    return null;
  }
  return project;
};

/// The task's department as the project spells it, or an error: it has to be one of
/// the departments actually on the project (blank = the owning department).
const resolveDepartment = (project, wanted) => {
  const name = String(wanted ?? '').trim();
  if (!name) return { value: '' };
  const match = activeDepartmentNames(project).find((n) => eqCI(n, name));
  return match
    ? { value: eqCI(match, project.targetDepartment) ? '' : match }
    : { error: `${name} is not on this project. Invite it to the project first.` };
};

const forbid = (res, message) => res.status(403).json({ message, code: 'TASK_FORBIDDEN' });

/// Apply what the caller may do to an existing task: `all` edits the plan, `progress`
/// only how it is going. Returns an error message, or null when the change is fine.
const checkTaskEdit = (project, ctx, task, body) => {
  const rights = taskRights(project, ctx, task);
  if (rights.all) return null;
  if (!rights.progress) {
    return 'Only the project manager, or the lead of the task\'s department, can change this task. You can edit tasks given to you.';
  }
  const plan = structureChanges(task, body);
  return plan.length === 0
    ? null
    : `You can update how your task is going (status, % complete, hours, notes). Changing ${plan.join(', ')} is for the project manager.`;
};

export const getITTasks = async (req, res) => {
  try {
    const { projectId, status, assignedTo, mine, ticketType, severity, subTeam, search } = req.query;
    const query = {};

    if (projectId) {
      // Scoped to one project: the caller must be able to view it.
      if (!(await loadViewableProject(req, res, projectId))) return;
      query.projectId = projectId;
    } else if (mine !== 'true') {
      // Cross-project view (e.g. the Roadmap): restrict to projects the caller
      // can see, so tasks never leak from projects outside their scope.
      const scope = await buildProjectScope(req.user);
      const ids = await Project.find(scope).distinct('_id');
      query.projectId = { $in: ids };
    }

    if (status) query.status = status;
    if (ticketType) query.ticketType = ticketType;
    if (severity) query.severity = severity;
    if (subTeam) query.subTeam = subTeam;
    if (search) {
      query.title = { $regex: escapeRegex(search), $options: 'i' };
    }

    // `mine=true` scopes to the caller's own tasks (User → linked Employee id or User id).
    // Tasks are assigned to them, so they are always within their access.
    if (mine === 'true') {
      const matchIds = [];
      if (req.user?.employeeId) matchIds.push(req.user.employeeId);
      if (req.user?._id) matchIds.push(req.user._id);

      // If user has no employeeId directly linked, try finding linked Employee by email
      if (!req.user?.employeeId && req.user?.email) {
        try {
          const emp = await Employee.findOne({ email: req.user.email }).select('_id');
          if (emp && !matchIds.some((id) => String(id) === String(emp._id))) {
            matchIds.push(emp._id);
          }
        } catch (_) {}
      }

      if (matchIds.length === 0) return res.json([]);
      query.assignedTo = { $in: matchIds };
    } else if (assignedTo) {
      query.assignedTo = assignedTo;
    }

    // order first so the WBS tree numbers deterministically (1, 1.1, 1.2 …).
    const tasks = await ITTask.find(query)
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType')
      .sort({ order: 1, createdAt: 1 });
    // what a task costs is money: only those who may see a project's cost see it on its tasks
    res.json(await redactTaskCosts(tasks, req.accessCtx ?? (await loadAccessContext(req.user))));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const bulkUpdateTasks = async (req, res) => {
  try {
    const { taskIds, updates } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ message: 'taskIds array is required' });
    }
    if (!updates || typeof updates !== 'object' || Array.isArray(updates) || Object.keys(updates).length === 0) {
      return res.status(400).json({ message: 'Nothing to update' });
    }

    // Every affected task must belong to a project the caller can access — and the
    // caller must be allowed to make this change to each of them.
    const existing = await ITTask.find({ _id: { $in: taskIds } });
    const projectIds = [...new Set(existing.map((t) => String(t.projectId)))];
    const ctx = await loadAccessContext(req.user);
    const projects = new Map();
    for (const pid of projectIds) {
      const project = await Project.findById(pid);
      if (!project || !(await canViewProject(req.user, project, ctx)))
        return res.status(403).json({ message: 'You do not have access to one or more of these tasks' });
      projects.set(pid, project);
    }
    for (const t of existing) {
      const problem = checkTaskEdit(projects.get(String(t.projectId)), ctx, t, updates);
      if (problem) return forbid(res, problem);
    }

    if ('departmentName' in updates) {
      return res.status(400).json({ message: 'Set a task\'s department one task at a time.' });
    }
    // a cost (and the hours an hours-based cost is worked out from) is held against the project's budget, task by task
    if (['plannedCost', ...COST_MOVING_KEYS].some((k) => k in updates)) {
      return res.status(400).json({ message: 'Set a task\'s cost and hours one task at a time.', code: 'TASK_COST_ONE_AT_A_TIME' });
    }

    const updateData = { ...updates };
    delete updateData.extensions; // the history is the server's alone
    const isDone = (st) => ['completed', 'closed', 'deployed', 'done'].includes(String(st ?? '').toLowerCase().trim());
    if (isDone(updateData.status)) {
      updateData.completedAt = new Date();
      if (updateData.percentComplete === undefined) updateData.percentComplete = 100;
    } else if (Number(updateData.percentComplete) >= 100) {
      if (!updateData.status) updateData.status = 'completed';
      updateData.completedAt = new Date();
    }

    await ITTask.updateMany({ _id: { $in: taskIds } }, { $set: updateData });
    const updated = await ITTask.find({ _id: { $in: taskIds } })
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType');
    res.json({ message: 'Tasks updated successfully', count: updated.length, tasks: await redactTaskCosts(updated, ctx) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createITTask = async (req, res) => {
  try {
    // A task can only be created against a project the caller can access.
    const project = await loadViewableProject(req, res, req.body.projectId);
    if (!project) return;

    const dept = resolveDepartment(project, req.body.departmentName);
    if (dept.error) return res.status(400).json({ message: dept.error });
    if (!canCreateTaskIn(project, req.accessCtx, dept.value)) {
      return forbid(res, 'Only the project manager, or the lead of the department a task belongs to, can add tasks to this project.');
    }

    // what the task costs is checked against the project's budget BEFORE anything is written
    const body = { ...req.body };
    delete body.extensions; // the extension history is the server's alone
    delete body.extensionReason;
    const prepared = await prepareTaskCost({ project, ctx: req.accessCtx, existing: null, body });
    if (prepared.error) return res.status(prepared.error.status).json(prepared.error.body);

    const task = await ITTask.create({ ...body, ...prepared.fields, departmentName: dept.value });
    const costRequest = await finishTaskCost({ project, prepared, user: req.user });
    const populated = await ITTask.findById(task._id)
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType');
    res.status(201).json({ ...(await redactTaskCosts(populated, req.accessCtx)), ...(costRequest ? { costRequest } : {}) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateITTask = async (req, res) => {
  try {
    const existing = await ITTask.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Task not found' });
    const project = await loadViewableProject(req, res, existing.projectId);
    if (!project) return;

    const updateData = { ...req.body };
    delete updateData.extensions; // the extension history is the server's alone
    const extensionReason = cleanReason(updateData.extensionReason);
    delete updateData.extensionReason;

    if (updateData.departmentName !== undefined) {
      const dept = resolveDepartment(project, updateData.departmentName);
      if (dept.error) return res.status(400).json({ message: dept.error });
      updateData.departmentName = dept.value;
    }
    const problem = checkTaskEdit(project, req.accessCtx, existing, updateData);
    if (problem) return forbid(res, problem);

    // what the task costs is checked against the project's budget BEFORE anything is written
    const prepared = await prepareTaskCost({ project, ctx: req.accessCtx, existing, body: updateData });
    if (prepared.error) return res.status(prepared.error.status).json(prepared.error.body);
    Object.assign(updateData, prepared.fields);

    // Keep status and percentComplete consistent across the Board and WBS views.
    const isDone = (st) => ['completed', 'closed', 'deployed', 'done'].includes(String(st ?? '').toLowerCase().trim());
    if (isDone(updateData.status)) {
      updateData.completedAt = new Date();
      if (updateData.percentComplete === undefined) updateData.percentComplete = 100;
    } else if (Number(updateData.percentComplete) >= 100) {
      if (!isDone(updateData.status)) {
        updateData.status = isDone(existing.status) ? existing.status : 'completed';
      }
      updateData.completedAt = new Date();
    } else if (updateData.status && !isDone(updateData.status)) {
      // Re-opened: clear the completion timestamp.
      updateData.completedAt = null;
    }

    // Moving the due date of an OVERDUE task later is an extension by another door: it is written down too (with the reason when the
    // person gave one), so the count cannot be kept low by editing the date instead of using "extend".
    const now = new Date();
    let autoExtension = null;
    if (updateData.deadline && existing.deadline && !taskIsDone(existing) && isOverdue(existing, now)) {
      const to = parseDay(updateData.deadline);
      const days = to ? dayDiff(to, existing.deadline) : NaN;
      if (Number.isFinite(days) && days > 0) {
        autoExtension = buildExtension({
          task: existing, to, days, reason: extensionReason, overdue: overdueDays(existing, now), user: req.user, at: now, viaEdit: true,
        });
      }
    }
    let change = updateData;
    if (autoExtension) {
      const line = { message: extensionMessage(autoExtension), author: req.user?.name || 'Team Member', type: 'extension', timestamp: now };
      // a client that sends the whole log back gets the line added to it (a $push beside a $set of the same path is a conflict)
      change = Array.isArray(updateData.activityLogs)
        ? { ...updateData, activityLogs: [...updateData.activityLogs, line], $push: { extensions: autoExtension } }
        : { ...updateData, $push: { extensions: autoExtension, activityLogs: line } };
    }

    const task = await ITTask.findByIdAndUpdate(req.params.id, change, {
      new: true,
      runValidators: true,
    })
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType');
    if (!task) return res.status(404).json({ message: 'Task not found' });
    const costRequest = await finishTaskCost({ project, prepared, user: req.user });
    if (autoExtension) await afterExtension({ project, task, entry: autoExtension, user: req.user });
    res.json({ ...(await redactTaskCosts(task, req.accessCtx)), ...(costRequest ? { costRequest } : {}) });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

/// What follows an extension, best effort (it must never undo the extension): the project's activity feed and the assignee are told.
const afterExtension = async ({ project, task, entry, user }) => {
  try {
    recordActivity(
      project,
      'deadline',
      `“${task.title}” extended by ${entry.days} day${entry.days === 1 ? '' : 's'} to ${fmtDay(entry.to)}${entry.overdueDays > 0 ? ` (it was ${entry.overdueDays} day${entry.overdueDays === 1 ? '' : 's'} overdue)` : ''}`,
      user,
      entry.at,
    );
    await project.save();
  } catch (err) {
    console.error('extension: project activity not written:', err.message);
  }
  try {
    const assignee = task.assignedTo?._id ?? task.assignedTo;
    if (!assignee) return;
    await notify({
      recipients: await getUserIdsByEmployeeIds([assignee]),
      type: NOTIFICATION_TYPES.TASK_DEADLINE_EXTENDED,
      title: `Due date extended: ${task.title}`,
      body: `${user?.name ?? 'The project manager'} moved it from ${fmtDay(entry.from)} to ${fmtDay(entry.to)}${entry.reason ? ` — ${entry.reason}` : ''}.`,
      link: `/projects/${project._id}`,
      createdBy: user?._id ?? null,
      excludeUserId: user?._id ?? null,
    });
  } catch (err) {
    console.error('extension: assignee not told:', err.message);
  }
};

// @desc   Extend a task's due date: a new, later day and a reason. Written into the task's history for good (who, when, from, to, how many
//         days, how overdue it already was, why), its log and the project's activity; the assignee is told.
// @route  POST /api/it-tasks/:id/extend   { newDeadline: 'YYYY-MM-DD', reason }
// @access Those who plan the task: the project manager, the owning department's head, a department lead for their own tasks, an admin
export const extendITTask = async (req, res) => {
  try {
    const existing = await ITTask.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Task not found' });
    const project = await loadViewableProject(req, res, existing.projectId);
    if (!project) return;
    if (req.accessCtx.viewOnly || !taskRights(project, req.accessCtx, existing).all) {
      return forbid(res, 'Only the project manager, or the lead of the task\'s department, can extend a due date.');
    }

    const now = new Date();
    const check = checkExtension({ task: existing, newDeadline: req.body?.newDeadline, reason: req.body?.reason, now });
    if (check.error) return res.status(check.code === 'TASK_DONE' ? 409 : 400).json({ message: check.error, code: check.code });

    const entry = buildExtension({ task: existing, to: check.to, days: check.days, reason: check.reason, overdue: check.overdueDays, user: req.user, at: now });
    const line = { message: extensionMessage(entry), author: req.user?.name || 'Team Member', type: 'extension', timestamp: now };
    // only if the due date is still the one we read: two people extending at once must not both be written down against the same date
    const updated = await ITTask.findOneAndUpdate(
      { _id: existing._id, deadline: existing.deadline },
      { $set: { deadline: check.to }, $push: { extensions: entry, activityLogs: line } },
      { new: true },
    )
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType');
    if (!updated) {
      return res.status(409).json({ message: 'Someone changed this task\'s due date a moment ago. Open it again to see where it stands.', code: 'DEADLINE_CHANGED' });
    }
    await afterExtension({ project, task: updated, entry, user: req.user });
    res.json(await redactTaskCosts(updated, req.accessCtx));
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteITTask = async (req, res) => {
  try {
    const task = await ITTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    const project = await loadViewableProject(req, res, task.projectId);
    if (!project) return;
    if (!taskRights(project, req.accessCtx, task).delete) {
      return forbid(res, 'Only the project manager, or the lead of the task\'s department, can delete this task.');
    }

    // Cascade-delete the whole subtree so deleting a phase never orphans its
    // children. Walk descendants breadth-first within the same project.
    const toDelete = [String(task._id)];
    const siblings = await ITTask.find({ projectId: task.projectId })
      .select('_id parentTaskId')
      .lean();
    const childrenOf = new Map();
    for (const t of siblings) {
      const p = t.parentTaskId ? String(t.parentTaskId) : null;
      if (!p) continue;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      childrenOf.get(p).push(String(t._id));
    }
    for (let i = 0; i < toDelete.length; i++) {
      const kids = childrenOf.get(toDelete[i]);
      if (kids) toDelete.push(...kids);
    }

    await ITTask.deleteMany({ _id: { $in: toDelete } });
    res.json({ message: 'Task deleted', deletedCount: toDelete.length });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
