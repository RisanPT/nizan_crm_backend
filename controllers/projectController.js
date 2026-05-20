import Project from '../models/Project.js';

export const getProjects = async (req, res) => {
  try {
    const { status, priority, search } = req.query;
    const query = {};

    if (status && status !== 'all') query.status = status;
    if (priority && priority !== 'all') query.priority = priority;
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    const projects = await Project.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'ittasks',
          localField: '_id',
          foreignField: 'projectId',
          as: 'tasks',
        },
      },
      {
        $addFields: {
          totalTasks: { $size: '$tasks' },
          completedTasks: {
            $size: {
              $filter: {
                input: '$tasks',
                as: 'task',
                cond: { $eq: ['$$task.status', 'completed'] },
              },
            },
          },
        },
      },
      { $project: { tasks: 0 } },
      { $sort: { createdAt: -1 } }
    ]);

    // Populate managerId manually after aggregation if needed, or use $lookup for it too
    // For now, let's just use the aggregated result and ensure managerId is populated
    const populatedProjects = await Project.populate(projects, { path: 'managerId', select: 'name' });
    
    res.json(populatedProjects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getProjectById = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).populate('managerId', 'name');
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createProject = async (req, res) => {
  try {
    const project = await Project.create(req.body);
    res.status(201).json(project);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateProject = async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json(project);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteProject = async (req, res) => {
  try {
    const project = await Project.findByIdAndDelete(req.params.id);
    if (!project) return res.status(404).json({ message: 'Project not found' });
    res.json({ message: 'Project deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
