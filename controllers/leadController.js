import Lead from '../models/Lead.js';

export const getLeads = async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const skip = (page - 1) * limit;
  const { search, status, source, salesperson, month, priority } = req.query;

  const query = {};
  if (req.user && req.user.role === 'sales') {
    query.assignedTo = req.user._id;
  } else if (salesperson && salesperson !== 'All') {
    if (salesperson === 'Unassigned') {
      query.$or = [{ assignedTo: null }, { assignedTo: { $exists: false } }];
    } else {
      query.assignedTo = salesperson;
    }
  }

  if (search) {
    query.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { location: { $regex: search, $options: 'i' } },
    ];
  }
  if (priority && priority !== 'All') {
    query.priority = priority;
  }

  if (status && status !== 'All') {
    query.status = status;
  }
  if (source && source !== 'All') {
    if (source === 'Other') {
      query.source = { $nin: ['Instagram', 'YouTube', 'Reference', 'Walk-in'] };
    } else {
      query.source = source;
    }
  }
  
  if (month && month !== 'All') {
    const [year, monthStr] = month.split('-');
    const startDate = new Date(Date.UTC(parseInt(year), parseInt(monthStr) - 1, 1));
    const endDate = new Date(Date.UTC(parseInt(year), parseInt(monthStr), 1));
    
    // We use an $and to combine the existing $or (from search) with the date filter
    const dateQuery = {
      $or: [
        { leadDate: { $gte: startDate, $lt: endDate } },
        { leadDate: { $exists: false }, createdAt: { $gte: startDate, $lt: endDate } },
        { leadDate: null, createdAt: { $gte: startDate, $lt: endDate } }
      ]
    };
    
    if (query.$or) {
      query.$and = [{ $or: query.$or }, dateQuery];
      delete query.$or;
    } else {
      query.$or = dateQuery.$or;
    }
  }

  try {
    const totalItems = await Lead.countDocuments(query);
    const leads = await Lead.find(query)
      .populate('assignedTo', 'name email role')
      .sort({ leadDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limit);

    // Calculate accurate stats for the dashboard based on the filtered query
    const statsAgg = await Lead.aggregate([
      { $match: query },
      { 
        $group: { 
          _id: "$status", 
          count: { $sum: 1 } 
        } 
      }
    ]);

    const now = new Date();
    // For missed count, we need to match followUpDate < now AND status not converted/lost
    const missedQuery = { ...query };
    missedQuery.followUpDate = { $lt: now };
    missedQuery.status = { $nin: ['Converted', 'Lost'] };
    const missedCount = await Lead.countDocuments(missedQuery);

    const stats = {
      New: 0,
      'Follow-up': 0,
      Closed: 0,
      Missed: missedCount,
    };

    statsAgg.forEach(s => {
      if (s._id === 'New') stats.New = s.count;
      else if (s._id === 'Follow-up') stats['Follow-up'] = s.count;
      else if (['Converted', 'Lost'].includes(s._id)) stats.Closed += s.count;
    });

    res.json({
      items: leads,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      page,
      limit,
      stats,
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

// Assign all leads that have no assignedTo → a specific user
export const bulkAssignLeads = async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) {
      return res.status(400).json({ message: 'userId is required' });
    }
    const result = await Lead.updateMany(
      { $or: [{ assignedTo: null }, { assignedTo: { $exists: false } }] },
      { $set: { assignedTo: userId } }
    );
    res.json({
      message: `${result.modifiedCount} unassigned lead(s) assigned successfully.`,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

