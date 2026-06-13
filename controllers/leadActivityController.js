import LeadActivity from '../models/LeadActivity.js';
import Lead from '../models/Lead.js';

// Get all activities for a lead
export const getLeadActivities = async (req, res) => {
  try {
    const activities = await LeadActivity.find({ leadId: req.params.leadId })
      .populate('createdBy', 'name role')
      .sort({ scheduledDate: -1, createdAt: -1 });
    res.json(activities);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Create a new activity and update the lead's status/follow-up date
export const createLeadActivity = async (req, res) => {
  try {
    const activity = await LeadActivity.create({
      ...req.body,
      leadId: req.params.leadId,
      createdBy: req.user._id,
    });

    const updateFields = {};
    if (req.body.leadStatus) {
      updateFields.status = req.body.leadStatus;
    }

    if (req.body.type === 'followup') {
      updateFields.followUpDate = req.body.scheduledDate;
      if (!updateFields.status) {
        updateFields.status = 'Follow-up';
      }
    }

    if (Object.keys(updateFields).length > 0) {
      await Lead.findByIdAndUpdate(req.params.leadId, updateFields);
    }

    res.status(201).json(activity);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Update an activity (e.g. mark follow-up as Completed)
export const updateLeadActivity = async (req, res) => {
  try {
    const activity = await LeadActivity.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true }
    );
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    res.json(activity);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Delete an activity
export const deleteLeadActivity = async (req, res) => {
  try {
    const activity = await LeadActivity.findByIdAndDelete(req.params.id);
    if (!activity) {
      return res.status(404).json({ message: 'Activity not found' });
    }
    res.json({ message: 'Activity deleted successfully' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
