import Lead from '../models/Lead.js';

export const getLeads = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const { search, status } = req.query;

  const query = {};
  if (req.user && req.user.role === 'sales') {
    query.assignedTo = req.user._id;
  }

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }
  if (status && status !== 'All') {
    query.status = status;
  }

  try {
    const totalItems = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .populate('assignedTo', 'name email role')
      .sort({ leadDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({
      items: leads,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      page,
      limit,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const createLead = async (req, res) => {
  try {
    // Store current UTC time — Flutter's .toLocal() converts to IST on the device.
    // Do NOT add a manual IST offset (that would cause double-counting: stored as UTC+5:30,
    // then Flutter adds another +5:30 = displayed as UTC+11).
    const leadData = { ...req.body };
    if (req.user && req.user.role === 'sales') {
      leadData.assignedTo = req.user._id;
    }
    const lead = await Lead.create({ ...leadData, leadDate: new Date() });
    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateLead = async (req, res) => {
  try {
    const leadData = { ...req.body };
    if (req.user && req.user.role === 'sales') {
      leadData.assignedTo = req.user._id;
    }
    const lead = await Lead.findByIdAndUpdate(req.params.id, leadData, {
      new: true,
      runValidators: true,
    });
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const deleteLead = async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    res.json({ message: 'Lead deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
