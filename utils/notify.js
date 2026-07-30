import Notification from '../models/Notification.js';
import User from '../models/User.js';

// Role groups used by the notification matrix. `role` on User holds a Role.key,
// so these are the keys management/admin accounts use. Keep the manager set in
// sync with LOST_REVIEWER_ROLES in leadController.js.
export const ADMIN_ROLES = ['admin'];
export const MANAGER_ROLES = ['manager', 'sales_manager', 'regional_manager'];
export const MANAGER_AND_ADMIN_ROLES = [...MANAGER_ROLES, ...ADMIN_ROLES];

// Canonical event keys (mirrored by the Flutter notification model).
export const NOTIFICATION_TYPES = {
  NEW_LEAD: 'new_lead',
  FOLLOWUP_ASSIGNED: 'followup_assigned',
  FOLLOWUP_DUE: 'followup_due',
  FOLLOWUP_MISSED: 'followup_missed',
  FOLLOWUP_COMPLETED: 'followup_completed',
  LOST_REQUESTED: 'lost_requested',
  LOST_RESULT: 'lost_result',
  BOOKING_CREATED: 'booking_created',
};

const idStr = (v) => (v == null ? '' : String(v._id ?? v));

/// Resolve the active user ids that hold any of [roles].
export const getUserIdsByRoles = async (roles) => {
  if (!roles || roles.length === 0) return [];
  const users = await User.find({
    role: { $in: roles },
    active: { $ne: false },
  }).select('_id');
  return users.map((u) => u._id);
};

/**
 * Fan-out create one Notification per recipient. Never throws — a notification
 * failure must not break the business action that triggered it.
 *
 * @param {Object} opts
 * @param {Array}  opts.recipients   User ids (or docs) to notify.
 * @param {string} opts.type         One of NOTIFICATION_TYPES.
 * @param {string} opts.title
 * @param {string} opts.body
 * @param {*}      [opts.leadId]
 * @param {*}      [opts.bookingId]
 * @param {Date}   [opts.forDate]    Dedup key for time-based follow-up events.
 * @param {*}      [opts.createdBy]  Actor who triggered the event.
 * @param {*}      [opts.excludeUserId] Recipient to drop (usually the actor).
 * @param {boolean}[opts.dedupe]     Skip if an identical (recipient,type,lead,forDate) exists.
 */
export const notify = async ({
  recipients = [],
  type,
  title = '',
  body = '',
  leadId = null,
  bookingId = null,
  forDate = null,
  createdBy = null,
  excludeUserId = null,
  dedupe = false,
} = {}) => {
  try {
    const exclude = idStr(excludeUserId);
    // Unique, non-empty recipient ids, minus the excluded actor.
    const ids = [...new Set(recipients.map(idStr).filter(Boolean))].filter(
      (id) => id !== exclude
    );
    if (ids.length === 0) return;

    let targets = ids;
    if (dedupe) {
      const existing = await Notification.find({
        recipient: { $in: ids },
        type,
        leadId,
        forDate,
      }).select('recipient');
      const seen = new Set(existing.map((e) => String(e.recipient)));
      targets = ids.filter((id) => !seen.has(id));
    }
    if (targets.length === 0) return;

    const docs = targets.map((recipient) => ({
      recipient,
      type,
      title,
      body,
      leadId,
      bookingId,
      forDate,
      createdBy,
    }));
    await Notification.insertMany(docs, { ordered: false });
  } catch (err) {
    // Swallow — notifications are best-effort.
    console.error('notify() failed:', err.message);
  }
};

/// Convenience: notify everyone holding any of [roles].
export const notifyRoles = async ({ roles, ...rest }) => {
  const ids = await getUserIdsByRoles(roles);
  await notify({ ...rest, recipients: ids });
};
