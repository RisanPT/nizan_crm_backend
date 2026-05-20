import TimeBlock from '../models/TimeBlock.js';

export const getTimeBlocks = async (req, res) => {
  try {
    const { employeeId, projectId, startDate, endDate } = req.query;
    const query = {};

    if (employeeId) query.employeeId = employeeId;
    if (projectId) query.projectId = projectId;
    if (startDate && endDate) {
      query.startTime = { $gte: new Date(startDate), $lte: new Date(endDate) };
    }

    const timeBlocks = await TimeBlock.find(query)
      .populate('employeeId', 'name')
      .populate('projectId', 'name')
      .populate('taskId', 'title')
      .sort({ startTime: 1 });
    res.json(timeBlocks);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createTimeBlock = async (req, res) => {
  try {
    const timeBlock = await TimeBlock.create(req.body);
    res.status(201).json(timeBlock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateTimeBlock = async (req, res) => {
  try {
    const timeBlock = await TimeBlock.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!timeBlock) return res.status(404).json({ message: 'Time block not found' });
    res.json(timeBlock);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteTimeBlock = async (req, res) => {
  try {
    const timeBlock = await TimeBlock.findByIdAndDelete(req.params.id);
    if (!timeBlock) return res.status(404).json({ message: 'Time block not found' });
    res.json({ message: 'Time block deleted' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
