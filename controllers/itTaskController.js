import ITTask from '../models/ITTask.js';

export const getITTasks = async (req, res) => {
  try {
    const { projectId, status, assignedTo } = req.query;
    const query = {};

    if (projectId) query.projectId = projectId;
    if (status) query.status = status;
    if (assignedTo) query.assignedTo = assignedTo;

    const tasks = await ITTask.find(query)
      .populate('assignedTo', 'name')
      .populate('projectId', 'name')
      .sort({ createdAt: -1 });
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createITTask = async (req, res) => {
  try {
    const task = await ITTask.create(req.body);
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateITTask = async (req, res) => {
  try {
    const updateData = { ...req.body };
    if (updateData.status === 'completed') {
      updateData.completedAt = new Date();
    }
    
    const task = await ITTask.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
      runValidators: true,
    });
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json(task);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteITTask = async (req, res) => {
  try {
    const task = await ITTask.findByIdAndDelete(req.params.id);
    if (!task) return res.status(404).json({ message: 'Task not found' });
    res.json({ message: 'Task deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
