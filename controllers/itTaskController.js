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
    res.json(tasks);
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

    const updateData = { ...updates };
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
    res.json({ message: 'Tasks updated successfully', count: updated.length, tasks: updated });
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

    const task = await ITTask.create({ ...req.body, departmentName: dept.value });
    const populated = await ITTask.findById(task._id)
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType');
    res.status(201).json(populated);
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

    if (updateData.departmentName !== undefined) {
      const dept = resolveDepartment(project, updateData.departmentName);
      if (dept.error) return res.status(400).json({ message: dept.error });
      updateData.departmentName = dept.value;
    }
    const problem = checkTaskEdit(project, req.accessCtx, existing, updateData);
    if (problem) return forbid(res, problem);

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

    const task = await ITTask.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    })
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .populate('predecessorIds', 'title status startDate deadline ticketType');
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json(task);
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
