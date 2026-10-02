import LeadActivity from '../models/LeadActivity.js';
import Lead from '../models/Lead.js';
import { applyLostRequest } from './leadController.js';

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
    // A lead can only be marked Lost with a recorded reason.
    if (req.body.leadStatus === 'Lost') {
      const reason = String(req.body.reason ?? req.body.remark ?? '').trim();
      if (!reason) {
        return res
          .status(400)
          .json({ message: 'A reason is required to mark a lead as Lost' });
      }
    }

    // Don't create orphan log entries for a lead that doesn't exist.
    const lead = await Lead.findById(req.params.leadId);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // "Lost" (and the system state "Pending Lost Approval") must never be set
    // directly from an activity — that skipped the manager's accept/decline.
    // Route it through the same approval workflow as the Leads outcome dialog.
    const wantsLost =
      req.body.leadStatus === 'Lost' ||
      req.body.leadStatus === 'Pending Lost Approval';
    if (wantsLost && lead.status === 'Lost') {
      return res.status(400).json({ message: 'Lead is already Lost.' });
    }

    const activity = await LeadActivity.create({
      ...req.body,
      leadId: req.params.leadId,
      createdBy: req.user._id,
    });

    if (wantsLost) {
      const text = String(req.body.reason ?? req.body.remark ?? '').trim();
      await applyLostRequest(lead, req, {
        reason: text,
        remarks: String(req.body.remark ?? '').trim() || text,
      });
    }

    const updateFields = {};
    const incFields = {};
    if (req.body.leadStatus && !wantsLost) {
      updateFields.status = req.body.leadStatus;
    }

    if (req.body.type === 'followup') {
      updateFields.followUpDate = req.body.scheduledDate;
      if (!updateFields.status && !wantsLost) {
        updateFields.status = 'Follow-up';
      }
      // Logging a follow-up counts as one.
      incFields.followUpCount = 1;
    }

    if (Object.keys(updateFields).length > 0 || Object.keys(incFields).length > 0) {
      const update = { ...updateFields };
      if (Object.keys(incFields).length > 0) update.$inc = incFields;
      await Lead.findByIdAndUpdate(req.params.leadId, update);
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
      { new: true, runValidators: true }
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
