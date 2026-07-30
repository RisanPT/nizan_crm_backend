import Lead from '../models/Lead.js';
import {
  notify,
  getUserIdsByRoles,
  MANAGER_AND_ADMIN_ROLES,
  NOTIFICATION_TYPES,
} from '../utils/notify.js';

// Roles allowed to approve/reject a lost-lead request. Mirrors
// `kLostReviewerRoles` in the Flutter sales_leads_screen — keep the two in sync.
const LOST_REVIEWER_ROLES = ['admin', 'manager', 'sales_manager', 'regional_manager'];

const isLostReviewer = (role) => LOST_REVIEWER_ROLES.includes(role);

// Last 10 digits of a phone number, for tolerant matching regardless of the
// spaces / +91 prefix a user typed.
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const last10 = (v) => digits(v).slice(-10);

// Fields the client must never set directly — they are owned by the lost
// workflow / server. Stripping them stops a plain create/update from spoofing
// an approval or forging the audit trail.
const SERVER_OWNED = [
  'previousStatus',
  'lostRequestedBy',
  'lostRequestedAt',
  'lostReviewedBy',
  'lostReviewedAt',
  'lostDecision',
  'lostReviewNote',
  'auditLog',
];

const stripServerOwned = (data) => {
  for (const key of SERVER_OWNED) delete data[key];
  return data;
};

const auditEntry = (req, action, note = '') => ({
  action,
  by: req.user?._id ?? null,
  byName: req.user?.name ?? '',
  note,
  at: new Date(),
});

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
      { alternateNumber: { $regex: search, $options: 'i' } },
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

    // ── Follow-up management widgets (Today's / Pending / Completed / Overdue) ──
    // Scoped to the same `query` so a Sales Executive only sees their own numbers.
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(now);
    endToday.setHours(23, 59, 59, 999);

    const [todayCount, pendingCount, overdueCount, completedAgg] = await Promise.all([
      // Due at any point today (still open).
      Lead.countDocuments({
        ...query,
        status: 'Follow-up',
        followUpDate: { $gte: startToday, $lte: endToday },
      }),
      // Upcoming / not yet due.
      Lead.countDocuments({
        ...query,
        status: 'Follow-up',
        followUpDate: { $gte: now },
      }),
      // Past due, still on the Follow-up stage.
      Lead.countDocuments({
        ...query,
        status: 'Follow-up',
        followUpDate: { $lt: now },
      }),
      // Sum of actioned follow-ups across the scoped leads.
      Lead.aggregate([
        { $match: query },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$followUpCompletedCount', 0] } } } },
      ]),
    ]);

    // Kept flat (all integer values) because the Flutter PaginatedResponse parses
    // `stats` as Map<String,int> — a nested object would break that cast.
    const stats = {
      New: 0,
      'Follow-up': 0,
      Closed: 0,
      Missed: missedCount,
      followUpsToday: todayCount,
      followUpsPending: pendingCount,
      followUpsCompleted: completedAgg[0]?.total || 0,
      followUpsOverdue: overdueCount,
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
    const leadData = stripServerOwned({ ...req.body });
    // The client sets this when the user chose to create a lead despite a
    // duplicate warning. It's a control flag, not a stored field.
    const allowDuplicate = leadData.allowDuplicate === true || leadData.allowDuplicate === 'true';
    delete leadData.allowDuplicate;
    if (req.user && req.user.role === 'sales') {
      leadData.assignedTo = req.user._id;
    }

    // Duplicate validation must consider BOTH the primary and the alternate
    // number, on either side (a new lead's primary might already exist as
    // someone's alternate). Match on the last 10 digits so formatting differs.
    const keys = [last10(leadData.phone), last10(leadData.alternateNumber)]
      .filter((k) => k.length === 10);
    if (!allowDuplicate && keys.length) {
      const rx = keys.map((k) => new RegExp(`${k}$`));
      const dupe = await Lead.findOne({
        $or: [{ phone: { $in: rx } }, { alternateNumber: { $in: rx } }],
      });
      if (dupe) {
        return res.status(409).json({
          message: 'A lead with this phone number already exists.',
          duplicateId: dupe._id,
        });
      }
    }

    const lead = await Lead.create({ ...leadData, leadDate: new Date() });

    // Notify managers + admins that a new lead arrived (matrix: New Lead).
    const managerAdminIds = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);
    await notify({
      recipients: managerAdminIds,
      type: NOTIFICATION_TYPES.NEW_LEAD,
      title: 'New lead',
      body: `${lead.name} was added${lead.source ? ` via ${lead.source}` : ''}.`,
      leadId: lead._id,
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    res.status(201).json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const updateLead = async (req, res) => {
  try {
    const leadData = stripServerOwned({ ...req.body });
    if (req.user && req.user.role === 'sales') {
      leadData.assignedTo = req.user._id;
    }

    const existing = await Lead.findById(req.params.id);
    if (!existing) {
      return res.status(404).json({ message: 'Lead not found' });
    }

    // Closing a lead as Lost (or putting it into pending review) must go through
    // the approval workflow so the reason/remarks are captured and audited — a
    // plain edit can't set these states directly.
    if (
      (leadData.status === 'Lost' || leadData.status === 'Pending Lost Approval') &&
      existing.status !== leadData.status
    ) {
      return res.status(400).json({
        message: 'Use the lost-approval workflow to mark a lead Lost.',
      });
    }

    // followUpCount / followUpCompletedCount are server-owned — ignore whatever
    // the client sent and derive them from the actual transition.
    delete leadData.followUpCount;
    delete leadData.followUpCompletedCount;

    let followUpScheduled = false; // a new/rescheduled follow-up was saved
    if (leadData.status === 'Follow-up' && leadData.followUpDate) {
      const incoming = new Date(leadData.followUpDate).getTime();
      const previous = existing.followUpDate
        ? new Date(existing.followUpDate).getTime()
        : null;
      if (incoming !== previous) {
        leadData.followUpCount = (existing.followUpCount || 0) + 1;
        followUpScheduled = true;
      }
    }

    // A pending follow-up was actioned when the lead leaves the Follow-up stage
    // while a follow-up date was set on it.
    const followUpCompleted =
      existing.status === 'Follow-up' &&
      !!existing.followUpDate &&
      typeof leadData.status === 'string' &&
      leadData.status !== 'Follow-up';
    if (followUpCompleted) {
      leadData.followUpCompletedCount = (existing.followUpCompletedCount || 0) + 1;
    }

    const lead = await Lead.findByIdAndUpdate(req.params.id, leadData, {
      new: true,
      runValidators: true,
    });

    // ── Follow-up notifications (matrix: assigned / rescheduled / completed) ──
    if (followUpScheduled && lead.assignedTo) {
      await notify({
        recipients: [lead.assignedTo],
        type: NOTIFICATION_TYPES.FOLLOWUP_ASSIGNED,
        title: 'Follow-up scheduled',
        body: `A follow-up for ${lead.name} is set. Check the lead for details.`,
        leadId: lead._id,
        createdBy: req.user?._id ?? null,
        excludeUserId: req.user?._id ?? null,
      });
    }
    if (followUpCompleted) {
      const managerAdminIds = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);
      await notify({
        recipients: managerAdminIds,
        type: NOTIFICATION_TYPES.FOLLOWUP_COMPLETED,
        title: 'Follow-up completed',
        body: `${lead.name}'s follow-up was actioned (now ${lead.status}).`,
        leadId: lead._id,
        createdBy: req.user?._id ?? null,
        excludeUserId: req.user?._id ?? null,
      });
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

// A Sales Executive requests marking a lead Lost. Reason + remarks are
// mandatory; competitor + attachment are optional. Executives put the lead into
// 'Pending Lost Approval'; reviewers (managers/admin) close it as Lost outright.
export const requestLostApproval = async (req, res) => {
  try {
    const { reason, remarks, competitorName = '', lostAttachment = '' } = req.body;
    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ message: 'A Lost reason is required.' });
    }
    if (!remarks || !String(remarks).trim()) {
      return res.status(400).json({ message: 'Remarks are required.' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    if (lead.status === 'Lost') {
      return res.status(400).json({ message: 'Lead is already Lost.' });
    }

    // Remember where the lead was so a rejection can restore it. Don't overwrite
    // it if a request is already pending (keeps the original stage).
    if (lead.status !== 'Pending Lost Approval') {
      lead.previousStatus = lead.status;
    }
    lead.reason = String(reason).trim();
    lead.remarks = String(remarks).trim();
    lead.competitorName = String(competitorName ?? '').trim();
    lead.lostAttachment = String(lostAttachment ?? '').trim();
    lead.lostRequestedBy = req.user?._id ?? null;
    lead.lostRequestedAt = new Date();
    lead.lostDecision = '';
    lead.lostReviewNote = '';
    lead.lostReviewedBy = null;
    lead.lostReviewedAt = null;

    const reviewer = isLostReviewer(req.user?.role);
    if (reviewer) {
      // Managers/admins close it immediately and self-approve for the record.
      lead.status = 'Lost';
      lead.lostDecision = 'approved';
      lead.lostReviewedBy = req.user?._id ?? null;
      lead.lostReviewedAt = new Date();
      lead.auditLog.push(auditEntry(req, 'lost_marked', lead.reason));
    } else {
      lead.status = 'Pending Lost Approval';
      lead.auditLog.push(auditEntry(req, 'lost_requested', lead.reason));
    }

    await lead.save();

    // Matrix: Lost Approval. A pending request pings the reviewers; a direct
    // close by a reviewer is an FYI to the other managers/admins.
    const managerAdminIds = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);
    await notify({
      recipients: managerAdminIds,
      type: NOTIFICATION_TYPES.LOST_REQUESTED,
      title: reviewer ? 'Lead marked Lost' : 'Lost approval requested',
      body: reviewer
        ? `${lead.name} was closed as Lost by ${req.user?.name ?? 'a manager'}.`
        : `${req.user?.name ?? 'A sales executive'} requested to mark ${lead.name} as Lost.`,
      leadId: lead._id,
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// A reviewer approves (→ Lost) or rejects (→ restore previous stage) a pending
// lost request.
export const reviewLostApproval = async (req, res) => {
  try {
    if (!isLostReviewer(req.user?.role)) {
      return res.status(403).json({ message: 'Not authorised to review lost requests.' });
    }
    const { decision, note = '' } = req.body;
    if (!['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ message: 'decision must be "approved" or "rejected".' });
    }

    const lead = await Lead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ message: 'Lead not found' });
    }
    if (lead.status !== 'Pending Lost Approval') {
      return res.status(400).json({ message: 'This lead has no pending lost request.' });
    }

    lead.lostDecision = decision;
    lead.lostReviewNote = String(note ?? '').trim();
    lead.lostReviewedBy = req.user?._id ?? null;
    lead.lostReviewedAt = new Date();

    if (decision === 'approved') {
      lead.status = 'Lost';
      lead.auditLog.push(auditEntry(req, 'lost_approved', lead.lostReviewNote));
    } else {
      // Restore the stage the lead was in before the request (fallback: Contacted).
      lead.status = lead.previousStatus && lead.previousStatus !== 'Pending Lost Approval'
        ? lead.previousStatus
        : 'Contacted';
      lead.auditLog.push(auditEntry(req, 'lost_rejected', lead.lostReviewNote));
    }

    await lead.save();

    // Matrix: Lost Approval Result. Tell the executive who requested it (and
    // keep the other managers/admins informed).
    const managerAdminIds = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);
    const approved = decision === 'approved';
    await notify({
      recipients: [lead.lostRequestedBy, ...managerAdminIds],
      type: NOTIFICATION_TYPES.LOST_RESULT,
      title: approved ? 'Lost request approved' : 'Lost request rejected',
      body: approved
        ? `${lead.name} was approved as Lost and closed.`
        : `The Lost request for ${lead.name} was rejected — it is back to ${lead.status}.`,
      leadId: lead._id,
      createdBy: req.user?._id ?? null,
      excludeUserId: req.user?._id ?? null,
    });

    res.json(lead);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

