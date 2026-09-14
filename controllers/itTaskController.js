import ITTask from '../models/ITTask.js';
import { isITStaff } from '../utils/itAccess.js';

export const getITTasks = async (req, res) => {
  try {
    if (!(await isITStaff(req.user)))
      return res.status(403).json({ message: 'IT access required' });

    const { projectId, status, assignedTo, mine, ticketType, severity, subTeam, search } = req.query;
    const query = {};

    if (projectId) query.projectId = projectId;
    if (status) query.status = status;
    if (ticketType) query.ticketType = ticketType;
    if (severity) query.severity = severity;
    if (subTeam) query.subTeam = subTeam;
    if (search) {
      query.title = { $regex: search, $options: 'i' };
    }

    // `mine=true` scopes to the caller's own tasks (User → linked Employee id).
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
    if (!(await isITStaff(req.user)))
      return res.status(403).json({ message: 'IT access required' });

    const { taskIds, updates } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ message: 'taskIds array is required' });
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
    if (!(await isITStaff(req.user)))
      return res.status(403).json({ message: 'IT access required' });

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
    if (!(await isITStaff(req.user)))
      return res.status(403).json({ message: 'IT access required' });

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
    if (!(await isITStaff(req.user)))
      return res.status(403).json({ message: 'IT access required' });

    const task = await ITTask.findById(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });

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
