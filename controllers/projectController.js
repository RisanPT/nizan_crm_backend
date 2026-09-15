import Project from '../models/Project.js';
import ITTask from '../models/ITTask.js';
import {
  seesAllProjects,
  buildProjectScope,
  canManageProject,
  canViewProject,
  escapeRegex,
} from '../utils/projectAccess.js';
import { resolveUserDeptName } from '../utils/departmentScope.js';

const POPULATE = [
  { path: 'managerId', select: 'name email role category' },
  { path: 'members', select: 'name email role category' },
];

export const getProjects = async (req, res) => {
  try {
    const { status, priority, search, department } = req.query;

    // Department-scoped visibility (see utils/projectAccess.js). Any signed-in
    // user may call — they simply get the projects they're allowed to see.
    const query = { ...(await buildProjectScope(req.user)) };
    if (status && status !== 'all') query.status = status;
    if (priority && priority !== 'all') query.priority = priority;
    if (search) query.name = { $regex: search, $options: 'i' };
    if (department && department !== 'all') {
      query.targetDepartment = new RegExp(`^${escapeRegex(department)}$`, 'i');
    }

    const projects = await Project.aggregate([
      { $match: query },
      {
        $lookup: { from: 'ittasks', localField: '_id', foreignField: 'projectId', as: 'tasks' },
      },
      {
        $addFields: {
          totalTasks: { $size: '$tasks' },
          completedTasks: {
            $size: {
              $filter: { input: '$tasks', as: 'task', cond: { $eq: ['$$task.status', 'completed'] } },
            },
          },
        },
      },
      { $project: { tasks: 0 } },
      { $sort: { createdAt: -1 } },
    ]);

    const populatedProjects = await Project.populate(projects, POPULATE);
    res.json(populatedProjects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getProjectById = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('managerId', 'name email role category')
      .populate('members', 'name email role category');
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canViewProject(req.user, project))) {
      return res.status(403).json({ message: 'Access denied: you cannot view this project' });
    }
    res.json(project);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createProject = async (req, res) => {
  try {
    const full = await seesAllProjects(req.user);
    if (!full && !req.user?.isDepartmentHead) {
      return res.status(403).json({ message: 'Only managers or department heads can create projects' });
    }

    const body = { ...req.body, createdBy: req.user._id };
    // A department head can only create projects for their own department.
    if (!full && req.user?.isDepartmentHead) {
      const dept = await resolveUserDeptName(req.user);
      if (dept) body.targetDepartment = dept;
    }

    const project = await Project.create(body);
    const populated = await Project.findById(project._id)
      .populate('managerId', 'name email role category')
      .populate('members', 'name email role category');
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateProject = async (req, res) => {
  try {
    const existing = await Project.findById(req.params.id);
    if (!existing) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManageProject(req.user, existing))) {
      return res.status(403).json({ message: 'You cannot edit this project' });
    }

    const project = await Project.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    })
      .populate('managerId', 'name email role category')
      .populate('members', 'name email role category');
    res.json(project);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });

    if (!(await canManageProject(req.user, project))) {
      return res.status(403).json({ message: 'You cannot delete this project' });
    }

    await project.deleteOne();
    // Cascade: remove the project's tasks so they aren't orphaned.
    await ITTask.deleteMany({ projectId: req.params.id });
    res.json({ message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
