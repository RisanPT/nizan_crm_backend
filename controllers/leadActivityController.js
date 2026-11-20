import LeadActivity, { FOLLOWUP_CHANNELS } from '../models/LeadActivity.js';
import Lead from '../models/Lead.js';
import { applyLostRequest } from './leadController.js';
import { stampFirstContact } from '../services/leadResponse.js';

/** The follow-up channel as sent: '' when not given, the lower-case key when it is one of the list, null when it is not. */
export const channelOf = (v) => {
  if (v === undefined || v === null || v === '') return '';
  const k = String(v).trim().toLowerCase();
  return FOLLOWUP_CHANNELS.includes(k) ? k : null;
};

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

    // How a follow-up is done (call / WhatsApp / visit / meeting / other) — optional; anything else is refused in plain words.
    const channel = channelOf(req.body.channel);
    if (channel === null) {
      return res.status(400).json({ message: `Choose how the follow-up is done: ${FOLLOWUP_CHANNELS.join(', ')}.`, field: 'channel' });
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
      channel,
      leadId: req.params.leadId,
      createdBy: req.user._id,
    });

    // speed to lead: the first call / message / follow-up logged is the lead's first contact (stamped once)
    await stampFirstContact(req.params.leadId, { at: activity.createdAt ?? new Date(), user: req.user, via: channel || req.body.type || 'activity' });

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
    if (req.body.channel !== undefined) {
      const channel = channelOf(req.body.channel);
      if (channel === null) {
        return res.status(400).json({ message: `Choose how the follow-up is done: ${FOLLOWUP_CHANNELS.join(', ')}.`, field: 'channel' });
      }
      req.body.channel = channel;
    }
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
