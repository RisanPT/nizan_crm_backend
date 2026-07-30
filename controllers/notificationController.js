import Notification from '../models/Notification.js';
import Lead from '../models/Lead.js';
import {
  notify,
  getUserIdsByRoles,
  MANAGER_AND_ADMIN_ROLES,
  NOTIFICATION_TYPES,
} from '../utils/notify.js';

// Format a stored (UTC) date as IST text for notification bodies, matching how
// the rest of the app renders times to the user.
const fmt = (d) => {
  const ist = new Date(new Date(d).getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${ist.getUTCDate()} ${months[ist.getUTCMonth()]}, ${h}:${String(m).padStart(2, '0')} ${ap}`;
};

// Time-based follow-up notifications (due today / missed) have no user action to
// hang off, so we generate them lazily whenever notifications are fetched. The
// sweep is global and throttled in-memory so many polling clients don't each pay
// for it, and `dedupe` guarantees the same scheduled follow-up is never
// announced twice.
let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 60 * 1000;

const sweepFollowUps = async () => {
  const nowMs = Date.now();
  if (nowMs - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = nowMs;

  try {
    const now = new Date();
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);
    const endToday = new Date(now);
    endToday.setHours(23, 59, 59, 999);
    // Don't resurface follow-ups older than 30 days — keeps the inbox relevant.
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const leads = await Lead.find({
      status: 'Follow-up',
      followUpDate: { $gte: windowStart, $lte: endToday },
    })
      .select('_id name assignedTo followUpDate')
      .limit(500);

    if (leads.length === 0) return;
    const managerAdminIds = await getUserIdsByRoles(MANAGER_AND_ADMIN_ROLES);

    for (const lead of leads) {
      const fu = lead.followUpDate;
      if (!fu) continue;
      const assigned = lead.assignedTo ? [lead.assignedTo] : [];

      if (fu < now) {
        // Missed: notify the assigned executive AND managers/admins.
        await notify({
          recipients: [...assigned, ...managerAdminIds],
          type: NOTIFICATION_TYPES.FOLLOWUP_MISSED,
          title: 'Missed follow-up',
          body: `Follow-up for ${lead.name} was missed (was due ${fmt(fu)}).`,
          leadId: lead._id,
          forDate: fu,
          dedupe: true,
        });
      } else if (fu >= startToday) {
        // Due later today: remind the assigned executive.
        await notify({
          recipients: assigned,
          type: NOTIFICATION_TYPES.FOLLOWUP_DUE,
          title: 'Follow-up due today',
          body: `You have a follow-up for ${lead.name} today at ${fmt(fu)}.`,
          leadId: lead._id,
          forDate: fu,
          dedupe: true,
        });
      }
    }
  } catch (err) {
    console.error('sweepFollowUps failed:', err.message);
  }
};

export const getNotifications = async (req, res) => {
  try {
    await sweepFollowUps();

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 30;
    const skip = (page - 1) * limit;

    const filter = { recipient: req.user._id };
    if (req.query.unread === 'true') filter.read = false;

    const [items, totalItems, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('leadId', 'name')
        .populate('createdBy', 'name'),
      Notification.countDocuments(filter),
      Notification.countDocuments({ recipient: req.user._id, read: false }),
    ]);

    res.json({
      items,
      totalItems,
      totalPages: Math.ceil(totalItems / limit),
      page,
      limit,
      unreadCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const getUnreadCount = async (req, res) => {
  try {
    const count = await Notification.countDocuments({
      recipient: req.user._id,
      read: false,
    });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markRead = async (req, res) => {
  try {
    const n = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user._id },
      { read: true, readAt: new Date() },
      { new: true }
    );
    if (!n) return res.status(404).json({ message: 'Notification not found' });
    res.json(n);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

export const markAllRead = async (req, res) => {
  try {
    const result = await Notification.updateMany(
      { recipient: req.user._id, read: false },
      { read: true, readAt: new Date() }
    );
    res.json({
      message: 'All notifications marked as read',
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
