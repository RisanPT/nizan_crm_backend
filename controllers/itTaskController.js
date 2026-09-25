import ITTask from '../models/ITTask.js';
import Project from '../models/Project.js';
import { buildProjectScope, canViewProject, escapeRegex } from '../utils/projectAccess.js';

// Load a project and confirm the caller may view it. Returns the project on
// success, or sends the 404/403 response and returns null (caller must stop).
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
  if (!(await canViewProject(req.user, project))) {
    res.status(403).json({ message: 'You do not have access to this project' });
    return null;
  }
  return project;
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

    // `mine=true` scopes to the caller's own tasks (User → linked Employee id).
    // Tasks are assigned to them, so they are always within their access.
    if (mine === 'true') {
      if (!req.user?.employeeId) return res.json([]);
      query.assignedTo = req.user.employeeId;
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

    // Every affected task must belong to a project the caller can access.
    const existing = await ITTask.find({ _id: { $in: taskIds } }).select('projectId');
    const projectIds = [...new Set(existing.map((t) => String(t.projectId)))];
    for (const pid of projectIds) {
      const project = await Project.findById(pid);
      if (!project || !(await canViewProject(req.user, project)))
        return res.status(403).json({ message: 'You do not have access to one or more of these tasks' });
    }

    const updateData = { ...updates };
    if (updateData.status === 'completed') {
      updateData.completedAt = new Date();
      if (updateData.percentComplete === undefined) updateData.percentComplete = 100;
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
    if (!(await loadViewableProject(req, res, req.body.projectId))) return;

    const task = await ITTask.create(req.body);
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
    if (!(await loadViewableProject(req, res, existing.projectId))) return;

    const updateData = { ...req.body };

    // Keep status and percentComplete consistent across the Board and WBS views.
    if (updateData.status === 'completed') {
      updateData.completedAt = new Date();
      if (updateData.percentComplete === undefined) updateData.percentComplete = 100;
    } else if (Number(updateData.percentComplete) >= 100) {
      updateData.status = 'completed';
      updateData.completedAt = new Date();
    } else if (updateData.status && updateData.status !== 'completed') {
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
    if (!(await loadViewableProject(req, res, task.projectId))) return;

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
